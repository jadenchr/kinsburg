// Politics (phase 3): automatic elections, the mayor's approval and treasury, protests and recalls,
// plus announcements that @kinsburgtown posts under its latest post (calls for help, elections).
// Rules and comment parsers live in shared/politics.mjs. Runs on the 15-minute cron.
import { cityDayAt } from '../../shared/residents-format.mjs';
import {
  FUND_BOOST,
  FUND_COST,
  MAX_CANDIDATES,
  MIN_RESIDENTS,
  NOMINATION_DAYS,
  PROTEST_WINDOW_DAYS,
  RECALL_NOMINATION_DAYS,
  TERM_DAYS,
  VOTING_DAYS,
  approvalOf,
  matchesProtest,
  matchesRunForMayor,
  parseFund,
  protestThreshold,
} from '../../shared/politics.mjs';
import { clampStat } from '../../shared/sim.mjs';
import { checkHandle, eventStmt } from './city';
import { type Env, json, log } from './env';
import { IgClient, getToken, isCommentBlock, noteReplies, pauseReplies, replyAllowance, type IgComment } from './instagram';
import { getState, putState } from './sim';
import { closePoll, type Mayor } from './town';

export interface Election {
  id: string;
  phase: 'nominations' | 'voting';
  recall: boolean;
  nomClosesAt: string;
  pollId?: string;
  extended?: number;
}

const MAX_PARAMS = 90;
const qs = (n: number) => new Array(n).fill('?').join(',');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const DAY = 86_400_000;

async function getMeta<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first<{ value: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}
const setMeta = (env: Env, key: string, value: unknown) =>
  env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value));
const delMeta = (env: Env, key: string) => env.DB.prepare('DELETE FROM meta WHERE key = ?1').bind(key);

export const termOf = (m: Mayor) => `${m.handle}:${m.sinceDay}`;

/** Queue something for @kinsburgtown to say under its latest post, worth posting until `expiresAt`. */
export const announceStmt = (env: Env, text: string, expiresAt?: string) =>
  env.DB.prepare('INSERT INTO announcements (text, expires_at) VALUES (?1, ?2)').bind(text.slice(0, 300), expiresAt ?? iso(Date.now() + 12 * 3_600_000));

async function activeResidents(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(DISTINCT s.handle) AS n FROM seen_comments s JOIN residents r ON r.handle = s.handle WHERE s.at > ?1`,
  ).bind(iso(now - PROTEST_WINDOW_DAYS * DAY)).first<{ n: number }>();
  return r?.n ?? 0;
}

async function protestCount(env: Env, mayor: Mayor, now: number): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM protests WHERE term = ?1 AND at > ?2').bind(termOf(mayor), iso(now - PROTEST_WINDOW_DAYS * DAY)).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------- tick

function startNominations(env: Env, now: number, recall: boolean, why: string) {
  const e: Election = { id: `${recall ? 'recall' : 'election'}-${iso(now).slice(0, 13).replace(/[-T:]/g, '')}`, phase: 'nominations', recall, nomClosesAt: iso(now + (recall ? RECALL_NOMINATION_DAYS : NOMINATION_DAYS) * DAY) };
  const days = recall ? RECALL_NOMINATION_DAYS : NOMINATION_DAYS;
  const text = recall
    ? `📣 Enough residents protested: Kinsburg holds a recall election! Want the job? Comment RUN FOR MAYOR in the next ${days * 24} hours.`
    : `🗳️ Kinsburg needs a mayor! Want the job? Comment RUN FOR MAYOR in the next ${days} days. Then everyone votes.`;
  return { e, stmts: [setMeta(env, 'election', e), eventStmt(env, recall ? 'recall_started' : 'nominations_open', null, { id: e.id, why }), announceStmt(env, text, e.nomClosesAt)] };
}

/** One politics step: open/close nominations and votes, check protests. */
export async function politicsTick(env: Env, now = Date.now()) {
  const db = env.DB;
  const report: Record<string, unknown> = {};
  const [mayor, election, cooldown] = await Promise.all([getMeta<Mayor>(env, 'mayor'), getMeta<Election>(env, 'election'), getMeta<string>(env, 'election_cooldown')]);
  const day = cityDayAt(env.CITY_FOUNDED_ISO, now);

  if (election?.phase === 'voting') {
    const poll = await db.prepare('SELECT status, closes_at FROM polls WHERE id = ?1').bind(election.pollId ?? '').first<{ status: string; closes_at: string }>();
    if (poll && poll.status === 'open' && poll.closes_at <= iso(now)) await closePoll(env, election.pollId!);
    const after = await db.prepare('SELECT status, result FROM polls WHERE id = ?1').bind(election.pollId ?? '').first<{ status: string; result: string | null }>();
    if (!after || after.status === 'closed') {
      const winner = after?.result ? (JSON.parse(after.result).label as string | null) : null;
      const stmts = [delMeta(env, 'election'), setMeta(env, 'election_cooldown', iso(now + DAY))];
      if (winner) stmts.push(announceStmt(env, `🎉 ${winner} is the new mayor of Kinsburg! Think they're not doing the job? Comment PROTEST.`, iso(now + 3 * DAY)));
      await db.batch(stmts);
      report.electionClosed = winner ?? 'no votes';
    }
    return report;
  }

  if (election?.phase === 'nominations') {
    if (iso(now) < election.nomClosesAt) return report;
    const cands = (await db.prepare('SELECT c.handle FROM candidates c JOIN residents r ON r.handle = c.handle WHERE c.election_id = ?1 ORDER BY c.at LIMIT ?2').bind(election.id, MAX_CANDIDATES).all<{ handle: string }>()).results;
    if (cands.length >= 2) {
      const pollId = `${election.id}-vote`;
      const options = cands.map((c, i) => ({ key: String.fromCharCode(65 + i), label: `@${c.handle}`, handle: c.handle }));
      const question = election.recall ? 'Recall election: who should lead Kinsburg?' : 'Who should be mayor of Kinsburg?';
      const names = cands.map((c) => `@${c.handle}`).join(', ');
      await db.batch([
        db.prepare('INSERT INTO polls (id, kind, question, options, media_id, closes_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5) ON CONFLICT(id) DO NOTHING').bind(pollId, 'election', question, JSON.stringify(options), iso(now + VOTING_DAYS * DAY)),
        setMeta(env, 'election', { ...election, phase: 'voting', pollId } satisfies Election),
        eventStmt(env, 'voting_open', null, { id: election.id, candidates: cands.map((c) => c.handle) }),
        announceStmt(env, `🗳️ Voting is open! Candidates: ${names}. Comment VOTE and their @ on any post. One vote each, ${VOTING_DAYS} days.`, iso(now + VOTING_DAYS * DAY)),
      ]);
      report.votingOpen = cands.map((c) => c.handle);
    } else if (cands.length === 1) {
      const h = cands[0].handle;
      await db.batch([
        setMeta(env, 'mayor', { handle: h, sinceDay: day, pollId: election.id } satisfies Mayor),
        delMeta(env, 'election'),
        eventStmt(env, 'mayor_unopposed', h, { id: election.id }),
        announceStmt(env, `🎉 @${h} ran unopposed and is the new mayor of Kinsburg!`, iso(now + 3 * DAY)),
      ]);
      report.unopposed = h;
    } else if (election.recall || (election.extended ?? 0) >= 2) {
      // nobody stood: the sitting mayor (if any) carries on
      await db.batch([delMeta(env, 'election'), setMeta(env, 'election_cooldown', iso(now + 2 * DAY)), eventStmt(env, 'election_empty', null, { id: election.id })]);
      report.empty = election.id;
    } else {
      const e = { ...election, nomClosesAt: iso(now + NOMINATION_DAYS * DAY), extended: (election.extended ?? 0) + 1 };
      await db.batch([setMeta(env, 'election', e), announceStmt(env, `🗳️ Still no candidates for mayor. Comment RUN FOR MAYOR to stand. ${NOMINATION_DAYS} more days.`, e.nomClosesAt)]);
      report.extended = e.nomClosesAt;
    }
    return report;
  }

  // No election running: time for one? Or have enough residents protested?
  const residents = (await db.prepare(`SELECT COUNT(*) AS n FROM residents WHERE handle NOT LIKE 'vacant.lot.%'`).first<{ n: number }>())?.n ?? 0;
  if (residents < MIN_RESIDENTS) return report;
  const coolingDown = !!cooldown && iso(now) < cooldown; // only delays regular elections, never a recall
  if (!mayor || day >= mayor.sinceDay + TERM_DAYS) {
    if (coolingDown) return report;
    const { e, stmts } = startNominations(env, now, false, mayor ? 'term ended' : 'no mayor');
    await db.batch(stmts);
    report.nominations = e.id;
    return report;
  }
  const active = await activeResidents(env, now);
  const protesters = await protestCount(env, mayor, now);
  if (protesters >= protestThreshold(active)) {
    const { e, stmts } = startNominations(env, now, true, `${protesters} protesters of ${active} active`);
    await db.batch(stmts);
    report.recall = e.id;
  }
  return report;
}

// ---------------------------------------------------------------- comments

/** RUN FOR MAYOR (during nominations), PROTEST (against the sitting mayor), FUND <stat> (the mayor). */
export async function processPoliticsComments(env: Env, comments: IgComment[], now = Date.now()) {
  const db = env.DB;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const report = { candidates: [] as string[], protests: [] as string[], funded: null as null | string };
  const cmds = new Map<string, { id: string; handle: string; run: boolean; protest: boolean; fund: string | null }>();
  for (const c of comments) {
    if (!c.id || !c.username || c.username.toLowerCase() === own) continue;
    const run = matchesRunForMayor(c.text), protest = matchesProtest(c.text), fund = parseFund(c.text);
    if (!run && !protest && !fund) continue;
    const { handle, bad } = checkHandle(c.username);
    if (!bad) cmds.set(c.id, { id: c.id, handle, run, protest, fund });
  }
  if (!cmds.size) return report;
  const ids = [...cmds.keys()];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += MAX_PARAMS) {
    const c = ids.slice(i, i + MAX_PARAMS);
    const r = await db.prepare(`SELECT comment_id FROM politics_seen WHERE comment_id IN (${qs(c.length)})`).bind(...c).all<{ comment_id: string }>();
    for (const x of r.results) seen.add(x.comment_id);
  }
  const fresh = ids.filter((id) => !seen.has(id)).map((id) => cmds.get(id)!);
  if (!fresh.length) return report;

  const handles = [...new Set(fresh.map((f) => f.handle))];
  const isResident = new Set<string>();
  for (let i = 0; i < handles.length; i += MAX_PARAMS) {
    const c = handles.slice(i, i + MAX_PARAMS);
    const r = await db.prepare(`SELECT handle FROM residents WHERE handle IN (${qs(c.length)})`).bind(...c).all<{ handle: string }>();
    for (const x of r.results) isResident.add(x.handle);
  }
  const [mayor, election] = await Promise.all([getMeta<Mayor>(env, 'mayor'), getMeta<Election>(env, 'election')]);
  const nowIso = iso(now);
  const stmts: D1PreparedStatement[] = fresh.map((f) => db.prepare('INSERT INTO politics_seen (comment_id, handle) VALUES (?1, ?2) ON CONFLICT(comment_id) DO NOTHING').bind(f.id, f.handle));
  let candCount = election?.phase === 'nominations' ? ((await db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE election_id = ?1').bind(election.id).first<{ n: number }>())?.n ?? 0) : 0;
  let fundWanted: string | null = null;
  for (const f of fresh) {
    if (!isResident.has(f.handle)) continue;
    if (f.run && election?.phase === 'nominations' && candCount < MAX_CANDIDATES) {
      stmts.push(db.prepare('INSERT INTO candidates (election_id, handle, at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING').bind(election.id, f.handle, nowIso));
      if (!report.candidates.includes(f.handle)) { report.candidates.push(f.handle); candCount++; }
    }
    if (f.protest && mayor && f.handle !== mayor.handle) {
      stmts.push(db.prepare('INSERT INTO protests (term, handle, comment_id, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING').bind(termOf(mayor), f.handle, f.id, nowIso));
      report.protests.push(f.handle);
    }
    if (f.fund && mayor && f.handle === mayor.handle) fundWanted = f.fund;
  }
  if (report.candidates.length) stmts.push(eventStmt(env, 'candidates', null, { id: election?.id, handles: report.candidates }));
  await db.batch(stmts);

  // The mayor funds one stat a day from the treasury.
  if (fundWanted && mayor) {
    const day = cityDayAt(env.CITY_FOUNDED_ISO, now);
    const last = await getMeta<number>(env, 'mayor_fund_day');
    const s = await getState(env);
    const stat = fundWanted as 'health' | 'safety' | 'education' | 'happiness';
    if (last !== day && s.treasury >= FUND_COST) {
      s.treasury -= FUND_COST;
      s[stat] = clampStat(s[stat] + FUND_BOOST);
      await db.batch([putState(env, s), setMeta(env, 'mayor_fund_day', day), eventStmt(env, 'mayor_fund', mayor.handle, { stat, cost: FUND_COST })]);
      report.funded = stat;
    }
  }
  return report;
}

// ---------------------------------------------------------------- announcements

/**
 * Post the oldest queued announcement as a comment under @kinsburgtown's latest post, at most one
 * per run and only within the reply allowance (shared with welcome replies, so the account keeps a
 * human pace). Announcements past their own expiry (an incident's deadline, the end of a vote) are
 * skipped: news goes stale.
 */
export async function flushAnnouncements(env: Env, now = Date.now()) {
  const db = env.DB;
  await db.prepare(`UPDATE announcements SET status = 'skipped' WHERE status = 'queued' AND expires_at < ?1`).bind(iso(now)).run();
  if (env.IG_CALLS_ENABLED === 'false') return { posted: 0, reason: 'disabled' };
  const next = await db.prepare(`SELECT id, text FROM announcements WHERE status = 'queued' ORDER BY id LIMIT 1`).first<{ id: number; text: string }>();
  if (!next) return { posted: 0 };
  const token = await getToken(env);
  if (!token || !env.IG_USER_ID) return { posted: 0, reason: 'not connected' };
  if ((await replyAllowance(env)) < 1) return { posted: 0, reason: 'pacing' };
  const ig = new IgClient(env.IG_API_BASE, token);
  try {
    const media = await ig.get(`${env.IG_USER_ID}/media`, { fields: 'id', limit: '1' });
    const mediaId = media?.data?.[0]?.id;
    if (!mediaId) return { posted: 0, reason: 'no posts' };
    const res = await ig.post(`${mediaId}/comments`, { message: next.text });
    await db.batch([db.prepare(`UPDATE announcements SET status = 'posted', posted_at = ?2, detail = ?3 WHERE id = ?1`).bind(next.id, iso(now), JSON.stringify({ media: mediaId, comment: res?.id ?? null }))]);
    await noteReplies(env, 1);
    return { posted: 1, id: next.id };
  } catch (err) {
    log('announce_failed', { id: next.id, error: String(err) });
    if (isCommentBlock(err)) await pauseReplies(env, err);
    else await db.prepare(`UPDATE announcements SET status = 'failed', detail = ?2 WHERE id = ?1`).bind(next.id, String(err).slice(0, 300)).run();
    return { posted: 0, reason: 'error' };
  }
}

// ---------------------------------------------------------------- public view

/** The politics part of town.json. */
export async function getPolitics(env: Env, stats: { health: number; safety: number; education: number; happiness: number }, now = Date.now()) {
  const db = env.DB;
  const [mayor, election] = await Promise.all([getMeta<Mayor>(env, 'mayor'), getMeta<Election>(env, 'election')]);
  const active = await activeResidents(env, now);
  let protest = null;
  if (mayor) {
    const rows = (await db.prepare('SELECT handle FROM protests WHERE term = ?1 AND at > ?2 ORDER BY at DESC LIMIT 200').bind(termOf(mayor), iso(now - PROTEST_WINDOW_DAYS * DAY)).all<{ handle: string }>()).results;
    protest = { count: rows.length, threshold: protestThreshold(active), active, recent: rows.slice(0, 12).map((r) => r.handle) };
  }
  let candidates: string[] = [];
  if (election) candidates = (await db.prepare('SELECT handle FROM candidates WHERE election_id = ?1 ORDER BY at LIMIT ?2').bind(election.id, MAX_CANDIDATES).all<{ handle: string }>()).results.map((r) => r.handle);
  return {
    mayor: mayor ? { handle: mayor.handle, sinceDay: mayor.sinceDay, termEndsDay: mayor.sinceDay + TERM_DAYS, approval: approvalOf(stats, protest?.count ?? 0, active) } : null,
    election: election ? { id: election.id, phase: election.phase, recall: election.recall, nominationsCloseAt: election.nomClosesAt, pollId: election.pollId ?? null, candidates } : null,
    protest,
    fund: { cost: FUND_COST, boost: FUND_BOOST },
  };
}

// ---------------------------------------------------------------- admin

/**
 * POST /admin/politics/tick                       run one step now
 * POST /admin/election/start { recall? }          open nominations now
 * POST /admin/election/advance                    end the current phase now (nominations -> voting -> result)
 * POST /admin/announce { text }                   queue an announcement
 * GET  /admin/announcements                       the last 20 announcements
 */
export async function politicsAdmin(env: Env, req: Request, path: string, body: any): Promise<Response | null> {
  const db = env.DB;
  if (req.method === 'GET' && path === '/admin/announcements') {
    return json((await db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 20').all()).results);
  }
  if (req.method !== 'POST') return null;
  if (path === '/admin/politics/tick') return json(await politicsTick(env));
  if (path === '/admin/election/start') {
    if (await getMeta<Election>(env, 'election')) return json({ error: 'an election is already running' }, 409);
    const { e, stmts } = startNominations(env, Date.now(), !!body?.recall, 'admin');
    await db.batch([...stmts, delMeta(env, 'election_cooldown')]);
    return json(e);
  }
  if (path === '/admin/election/advance') {
    const e = await getMeta<Election>(env, 'election');
    if (!e) return json({ error: 'no election running' }, 409);
    const past = iso(Date.now() - 1000);
    if (e.phase === 'nominations') await db.batch([setMeta(env, 'election', { ...e, nomClosesAt: past })]);
    else await db.prepare('UPDATE polls SET closes_at = ?2 WHERE id = ?1').bind(e.pollId ?? '', past).run();
    return json(await politicsTick(env));
  }
  if (path === '/admin/announce') {
    const text = String(body?.text ?? '').trim();
    if (!text) return json({ error: 'text required' }, 400);
    await db.batch([announceStmt(env, text)]);
    return json({ queued: true });
  }
  return null;
}
