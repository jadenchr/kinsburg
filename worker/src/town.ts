// Town life: houses that grow as residents comment, elections and decisions voted by comment,
// the mayor, sponsors, perk links and DM joins (with the follower badge).
//
// Following @kinsburgtown is encouraged, never required: a house never depends on it.
import { LEVEL_AT, levelFor } from '../../shared/residents-format.mjs';
import type { Row } from '../../shared/residents-format.mjs';
import { checkHandle, eventStmt, joinMany, toRow, writeSnapshots } from './city';
import { type Env, json, log } from './env';
import type { IgClient, IgComment } from './instagram';

// ---------------------------------------------------------------- settings in the meta table

export interface PerkLink {
  /** Stripe Payment Link URL */
  url: string;
  /** shown on the button, e.g. "$5" */
  price: string;
}
export interface TownSettings {
  perkLinks: Partial<Record<'star' | 'goldRoof' | 'monument' | 'street' | 'poster', PerkLink>>;
}
export interface Mayor {
  handle: string;
  sinceDay: number;
  pollId: string;
}

async function getMeta<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first<{ value: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}
const setMetaStmt = (env: Env, key: string, value: unknown) =>
  env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value));

const cityDay = (env: Env) => Math.max(1, Math.floor((Date.now() - Date.parse(env.CITY_FOUNDED_ISO + 'T00:00:00Z')) / 86_400_000) + 1);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------- polls

export interface PollOption {
  key: string;
  label: string;
  /** elections: the candidate's handle */
  handle?: string;
}
interface PollRow {
  id: string;
  kind: 'election' | 'decision';
  question: string;
  options: string;
  media_id: string | null;
  opens_at: string;
  closes_at: string;
  status: 'open' | 'closed';
  result: string | null;
}

/**
 * Which option a comment votes for: "A", "a!", "vote B", "vote for c", "@candidate" or the
 * option's label word ("Lighthouse"). Anything else is not a vote.
 */
export function parseVote(text: string, options: PollOption[]): string | null {
  const t = text.normalize('NFKC').toLowerCase().replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ').trim();
  const letter = /^(?:vote\s*(?:for\s*)?)?(?:option\s*)?([a-z])\s*[!.]*$/.exec(t);
  if (letter) {
    const k = letter[1].toUpperCase();
    return options.some((o) => o.key.toUpperCase() === k) ? options.find((o) => o.key.toUpperCase() === k)!.key : null;
  }
  const hits = options.filter((o) => {
    if (o.handle && new RegExp(`(^|\\s)@?${o.handle.replace(/[.]/g, '\\.')}(\\s|$)`, 'i').test(t)) return true;
    const word = o.label.toLowerCase().replace(/^@/, '');
    return word.length >= 3 && new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t);
  });
  return hits.length === 1 ? hits[0].key : null; // ambiguous comments don't count
}

async function tally(env: Env, pollId: string): Promise<Record<string, number>> {
  const r = await env.DB.prepare('SELECT option, COUNT(*) AS n FROM votes WHERE poll_id = ?1 GROUP BY option').bind(pollId).all<{ option: string; n: number }>();
  return Object.fromEntries(r.results.map((x) => [x.option, x.n]));
}

function publicPoll(p: PollRow, counts: Record<string, number>) {
  const options = JSON.parse(p.options) as PollOption[];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    id: p.id,
    kind: p.kind,
    question: p.question,
    status: p.status,
    closesAt: p.closes_at,
    total,
    options: options.map((o) => ({ ...o, votes: counts[o.key] ?? 0 })),
    result: p.result ? JSON.parse(p.result) : null,
  };
}

/** Close a poll: count, pick the winner (ties go to the option listed first), crown the mayor. */
export async function closePoll(env: Env, id: string) {
  const p = await env.DB.prepare('SELECT * FROM polls WHERE id = ?1').bind(id).first<PollRow>();
  if (!p) return null;
  const counts = await tally(env, id);
  const options = JSON.parse(p.options) as PollOption[];
  let winner: PollOption | null = null;
  for (const o of options) if ((counts[o.key] ?? 0) > 0 && (!winner || (counts[o.key] ?? 0) > (counts[winner.key] ?? 0))) winner = o;
  const result = { winner: winner?.key ?? null, label: winner?.label ?? null, tally: counts, closedDay: cityDay(env) };
  const stmts = [
    env.DB.prepare(`UPDATE polls SET status = 'closed', result = ?2 WHERE id = ?1`).bind(id, JSON.stringify(result)),
    eventStmt(env, 'poll_closed', winner?.handle ?? null, { id, ...result }),
  ];
  if (p.kind === 'election' && winner?.handle) stmts.push(setMetaStmt(env, 'mayor', { handle: winner.handle, sinceDay: cityDay(env), pollId: id } satisfies Mayor));
  await env.DB.batch(stmts);
  log('poll_closed', { id, ...result });
  return result;
}

/** Close every poll whose time is up (cron). */
export async function closeDuePolls(env: Env) {
  const due = await env.DB.prepare(`SELECT id FROM polls WHERE status = 'open' AND closes_at <= ?1`).bind(nowIso()).all<{ id: string }>();
  for (const { id } of due.results) await closePoll(env, id);
  return due.results.length;
}

// ---------------------------------------------------------------- comments: engagement + votes

/**
 * Count every new comment by a resident (their house grows at LEVEL_AT comments) and record votes
 * on open polls. Comment text is never stored. Runs after MOVE IN joins, so a newcomer's first
 * comment already counts.
 */
export async function processTownComments(env: Env, comments: IgComment[]) {
  const db = env.DB;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const byId = new Map<string, IgComment>();
  for (const c of comments) if (c.id && c.username && c.username.toLowerCase() !== own) byId.set(c.id, c);
  const report = { counted: 0, levelUps: [] as string[], votes: 0 };
  if (!byId.size) return report;

  const ids = [...byId.keys()];
  const seen = new Set<string>();
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const c = ids.slice(i, i + 90);
    reads.push(db.prepare(`SELECT comment_id FROM seen_comments WHERE comment_id IN (${c.map(() => '?').join(',')})`).bind(...c));
  }
  for (const r of await db.batch<{ comment_id: string }>(reads)) for (const row of r.results) seen.add(row.comment_id);
  const fresh = ids.filter((id) => !seen.has(id)).map((id) => byId.get(id)!);
  if (!fresh.length) return report;

  const perHandle = new Map<string, IgComment[]>();
  for (const c of fresh) {
    const { handle, bad } = checkHandle(c.username);
    if (bad) continue;
    (perHandle.get(handle) ?? perHandle.set(handle, []).get(handle)!).push(c);
  }
  const handles = [...perHandle.keys()];
  const residents = new Map<string, { engagement: number; level: number }>();
  const rreads: D1PreparedStatement[] = [];
  for (let i = 0; i < handles.length; i += 90) {
    const c = handles.slice(i, i + 90);
    rreads.push(db.prepare(`SELECT handle, engagement, level FROM residents WHERE handle IN (${c.map(() => '?').join(',')})`).bind(...c));
  }
  for (const r of await db.batch<{ handle: string; engagement: number; level: number }>(rreads)) for (const x of r.results) residents.set(x.handle, x);

  const polls = (await db.prepare(`SELECT * FROM polls WHERE status = 'open' AND media_id IS NOT NULL AND closes_at > ?1`).bind(nowIso()).all<PollRow>()).results;
  const pollByMedia = new Map(polls.map((p) => [p.media_id!, { id: p.id, options: JSON.parse(p.options) as PollOption[] }]));

  const stmts: D1PreparedStatement[] = fresh.map((c) =>
    db.prepare('INSERT INTO seen_comments (comment_id, handle) VALUES (?1, ?2) ON CONFLICT(comment_id) DO NOTHING').bind(c.id, c.username.toLowerCase()),
  );
  const levelChanged: string[] = [];
  for (const [handle, cs] of perHandle) {
    const r = residents.get(handle);
    if (!r) continue; // not a resident: comments don't count until they move in
    const engagement = r.engagement + cs.length;
    const level = levelFor(engagement);
    stmts.push(db.prepare('UPDATE residents SET engagement = ?2, level = ?3 WHERE handle = ?1').bind(handle, engagement, level));
    report.counted += cs.length;
    if (level !== r.level) levelChanged.push(handle);
    for (const c of cs) {
      const poll = pollByMedia.get(c.mediaId);
      const option = poll && parseVote(c.text, poll.options);
      if (poll && option) {
        stmts.push(db.prepare('INSERT INTO votes (poll_id, handle, option, comment_id) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(poll_id, handle) DO NOTHING').bind(poll.id, handle, option, c.id));
        report.votes++;
      }
    }
  }
  await db.batch(stmts);

  if (levelChanged.length) {
    const rows: Row[] = [];
    const q = await db.prepare(`SELECT handle, number, joined_day, job, house_style, perks, level, follower FROM residents WHERE handle IN (${levelChanged.map(() => '?').join(',')})`).bind(...levelChanged).all<any>();
    for (const r of q.results) rows.push(toRow(r));
    await writeSnapshots(env, rows, levelChanged.map((h) => eventStmt(env, 'level_up', h, { level: residents.get(h) ? levelFor(residents.get(h)!.engagement + perHandle.get(h)!.length) : null })));
    report.levelUps = levelChanged;
  }
  return report;
}

// ---------------------------------------------------------------- DMs (needs Advanced Access)

const MOVE_OUT = /^\s*move\s*out\b/i;

function followNudge(env: Env, follows: boolean | null) {
  return follows ? '' : ` Follow @${env.CITY_ACCOUNT} to watch it grow.`;
}

/**
 * Handle Instagram DMs: "MOVE IN" joins (and records the follower badge), "MOVE OUT" removes the
 * person (their lot stays as a vacant lot so nobody's address changes). Every reply is a plain
 * answer to their message; never a promotion. Only active when IG_DM_ENABLED is "true".
 */
export async function handleDms(env: Env, client: IgClient | undefined, messaging: any[]) {
  const report = { joined: 0, movedOut: 0, ignored: 0 };
  if (env.IG_DM_ENABLED !== 'true' || !client || !env.IG_USER_ID) {
    report.ignored = messaging.length;
    return report;
  }
  const { matchesMoveIn } = await import('../../shared/residents-format.mjs');
  for (const m of messaging) {
    const sender = String(m?.sender?.id ?? '');
    const text = String(m?.message?.text ?? '');
    if (!sender || sender === env.IG_USER_ID || m?.message?.is_echo) continue;
    const wantsIn = matchesMoveIn(text);
    const wantsOut = MOVE_OUT.test(text);
    if (!wantsIn && !wantsOut) { report.ignored++; continue; }
    let profile: any;
    try {
      profile = await client.get(sender, { fields: 'username,is_user_follow_business' });
    } catch (err) {
      log('dm_profile_failed', { error: String(err) });
      continue;
    }
    const username = String(profile?.username ?? '');
    const follows = typeof profile?.is_user_follow_business === 'boolean' ? profile.is_user_follow_business : null;
    const { handle, bad } = checkHandle(username);
    const host = env.SITE_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    let reply = '';
    if (bad) {
      reply = `Sorry, we couldn't build a house for that username.`;
    } else if (wantsOut) {
      const row = await env.DB.prepare(`UPDATE residents SET handle = 'vacant.lot.' || number, perks = 0, level = 0, follower = 0, engagement = 0 WHERE handle = ?1 RETURNING handle, number, joined_day, job, house_style, perks, level, follower`).bind(handle).first<any>();
      if (row) {
        await writeSnapshots(env, [toRow(row)], [eventStmt(env, 'move_out', handle, { source: 'dm' })]);
        report.movedOut++;
        reply = `Done. You've moved out of Kinsburg and your name is gone from the city. Send MOVE IN any time to come back.`;
      } else {
        reply = `You don't live in Kinsburg, so there's nothing to remove.`;
      }
    } else {
      const [j] = await joinMany(env, [{ raw: handle, source: 'dm', igUserId: sender }]);
      if (j.status === 'joined' || j.status === 'exists') {
        // record the follower badge, then republish this resident's row
        const stmts: D1PreparedStatement[] = [];
        if (follows !== null) stmts.push(env.DB.prepare('UPDATE residents SET follower = ?2 WHERE handle = ?1').bind(handle, follows ? 1 : 0));
        if (j.status === 'joined') stmts.push(eventStmt(env, 'join', handle, { source: 'dm', number: j.number, follower: follows }));
        if (stmts.length) await env.DB.batch(stmts);
        if (j.status === 'joined' || follows !== null) {
          const row = await env.DB.prepare('SELECT handle, number, joined_day, job, house_style, perks, level, follower FROM residents WHERE handle = ?1').bind(handle).first<any>();
          if (row) await writeSnapshots(env, [toRow(row)]);
        }
        if (j.status === 'joined') report.joined++;
        reply = j.status === 'joined'
          ? `Your house is ready, neighbour #${j.number}! ${host}/?r=${handle}${followNudge(env, follows)}`
          : `You already live here: ${host}/?r=${handle}${followNudge(env, follows)}`;
      } else {
        reply = `Sorry, we couldn't build a house for that username.`;
      }
    }
    try {
      await client.post(`${env.IG_USER_ID}/messages`, { recipient: JSON.stringify({ id: sender }), message: JSON.stringify({ text: reply }) });
    } catch (err) {
      log('dm_reply_failed', { error: String(err) });
    }
  }
  return report;
}

/** One private reply to a commenter who just moved in (needs Advanced Access). */
export async function privateReply(env: Env, client: IgClient, commentId: string, handle: string, number: number | undefined) {
  const host = env.SITE_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const text = `Your house in Kinsburg is ready${number ? `, neighbour #${number}` : ''}! ${host}/?r=${handle} Follow @${env.CITY_ACCOUNT} to watch it grow.`;
  await client.post(`${env.IG_USER_ID}/messages`, { recipient: JSON.stringify({ comment_id: commentId }), message: JSON.stringify({ text }) });
}

// ---------------------------------------------------------------- public town API

/** GET /api/town.json: mayor, current and recent polls with tallies, sponsors, perk links. */
export async function getTown(env: Env) {
  const now = nowIso();
  const [mayor, settings, polls, sponsors] = await Promise.all([
    getMeta<Mayor>(env, 'mayor'),
    getMeta<TownSettings>(env, 'town_settings'),
    env.DB.prepare(`SELECT * FROM polls WHERE status = 'open' OR id IN (SELECT id FROM polls WHERE status = 'closed' ORDER BY closes_at DESC LIMIT 1) ORDER BY closes_at`).all<PollRow>(),
    env.DB.prepare('SELECT name, message, url FROM sponsors WHERE starts_at <= ?1 AND ends_at > ?1 ORDER BY id DESC LIMIT 4').bind(now).all<{ name: string; message: string; url: string | null }>(),
  ]);
  const withCounts = await Promise.all(polls.results.map(async (p) => publicPoll(p, await tally(env, p.id))));
  return {
    day: cityDay(env),
    mayor,
    polls: withCounts,
    sponsors: sponsors.results,
    perkLinks: settings?.perkLinks ?? {},
    levelAt: LEVEL_AT,
    account: env.CITY_ACCOUNT,
  };
}

// ---------------------------------------------------------------- admin

/** /admin/poll, /admin/poll/close, /admin/sponsor, /admin/sponsor/end, /admin/town, /admin/order/done */
export async function townAdmin(env: Env, path: string, body: any): Promise<Response | null> {
  const db = env.DB;
  switch (path) {
    case '/admin/poll': {
      const id = String(body.id ?? '').trim();
      const kind = body.kind === 'election' ? 'election' : body.kind === 'decision' ? 'decision' : null;
      const options = Array.isArray(body.options) ? (body.options as PollOption[]) : [];
      const closes = Date.parse(String(body.closesISO ?? ''));
      if (!/^[a-z0-9-]{3,40}$/.test(id) || !kind || !body.question || options.length < 2 || options.length > 6 || !Number.isFinite(closes)) {
        return json({ error: 'need id (a-z0-9-), kind election|decision, question, 2–6 options [{key,label,handle?}], closesISO' }, 400);
      }
      const clean = options.map((o, i) => ({ key: String(o.key ?? String.fromCharCode(65 + i)).toUpperCase().slice(0, 1), label: String(o.label).slice(0, 60), ...(o.handle ? { handle: checkHandle(String(o.handle)).handle } : {}) }));
      if (new Set(clean.map((o) => o.key)).size !== clean.length) return json({ error: 'option keys must be unique letters' }, 400);
      await db.batch([
        db.prepare('INSERT INTO polls (id, kind, question, options, media_id, closes_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, kind, String(body.question).slice(0, 140), JSON.stringify(clean), body.mediaId ? String(body.mediaId) : null, new Date(closes).toISOString().replace(/\.\d+Z$/, 'Z')),
        eventStmt(env, 'poll_opened', null, { id, kind }),
      ]);
      return json({ ok: true, id, options: clean });
    }
    case '/admin/poll/media': {
      // attach the Instagram post once it's published
      await db.prepare('UPDATE polls SET media_id = ?2 WHERE id = ?1').bind(String(body.id), String(body.mediaId)).run();
      return json({ ok: true });
    }
    case '/admin/poll/close': {
      const r = await closePoll(env, String(body.id ?? ''));
      return r ? json({ ok: true, ...r }) : json({ error: 'no such poll' }, 404);
    }
    case '/admin/sponsor': {
      const days = Math.max(1, Math.min(90, Number(body.days) || 7));
      if (!body.name || !body.message) return json({ error: 'need name and message (and optional url, days)' }, 400);
      const url = body.url && /^https:\/\//.test(String(body.url)) ? String(body.url) : null;
      const ends = new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const r = await db.prepare('INSERT INTO sponsors (name, message, url, ends_at) VALUES (?1, ?2, ?3, ?4) RETURNING id').bind(String(body.name).slice(0, 40), String(body.message).slice(0, 60), url, ends).first<{ id: number }>();
      return json({ ok: true, id: r?.id, endsAt: ends });
    }
    case '/admin/sponsor/end': {
      await db.prepare('UPDATE sponsors SET ends_at = ?2 WHERE id = ?1').bind(Number(body.id), nowIso()).run();
      return json({ ok: true });
    }
    case '/admin/town': {
      const links = body.perkLinks && typeof body.perkLinks === 'object' ? body.perkLinks : {};
      const clean: TownSettings['perkLinks'] = {};
      for (const k of ['star', 'goldRoof', 'monument', 'street', 'poster'] as const) {
        const l = links[k];
        if (l && /^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//.test(String(l.url))) clean[k] = { url: String(l.url), price: String(l.price ?? '').slice(0, 12) };
      }
      await db.batch([setMetaStmt(env, 'town_settings', { perkLinks: clean } satisfies TownSettings)]);
      return json({ ok: true, perkLinks: clean });
    }
    case '/admin/order/done': {
      await db.prepare(`UPDATE orders SET status = ?2 WHERE id = ?1`).bind(Number(body.id), body.refunded ? 'refunded' : 'done').run();
      return json({ ok: true });
    }
    default:
      return null;
  }
}
