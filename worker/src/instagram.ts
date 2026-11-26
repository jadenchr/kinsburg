// Instagram API (graph.facebook.com with a Business Manager system-user token from Meta's Unified
// login, or graph.instagram.com with an Instagram Login token): comment poller, comments webhook,
// optional public replies, token refresh (Instagram Login tokens only). IG_API_BASE is configurable so tests can
// point at a local mock.
import { JOBS, matchesMoveIn } from '../../shared/residents-format.mjs';
import { eventStmt, joinMany, writeSnapshots, healSnapshots, type JoinResult, type JoinSource } from './city';
import { verifyMetaSignature } from './crypto';
import { closeDuePolls, handleDms, privateReply, processTownComments } from './town';
import { processCastComments } from './cast';
import { bestieAfterJoin, processBuildComments } from './builds';
import { parseBestie } from '../../shared/builds.mjs';
import type { Row } from '../../shared/residents-format.mjs';
import { processLifeComments } from './life';
import { processSimComments } from './sim';
import { processPoliticsComments } from './politics';
import { processHomeComments } from './homes';
import { recordFollowers } from './cash';
import { type Env, intVar, json, log } from './env';

export interface IgComment {
  id: string;
  text: string;
  username: string;
  mediaId: string;
  igUserId?: string;
  /** Instagram like count (comment checks only); ranks build requests. */
  likes?: number;
  /** The city account already replied under this comment (from the comment's `replies` field). */
  repliedByUs?: boolean;
}

/** Free plan: 50 external subrequests per invocation. Keep IG calls well under it. */
const FETCH_BUDGET = 40;
const MAX_PAGES_PER_MEDIA = 4;
const MAX_JOINS_PER_RUN = 300; // CPU guard; the rest waits for the next run (not marked processed)

class IgError extends Error {
  constructor(public status: number, message: string, public code?: number, public subcode?: number) {
    super(message);
  }
}

/**
 * Instagram refusing to let the account comment right now (anti-spam action block, rate limits).
 * Retrying makes the block longer, so replies pause instead (see pauseReplies).
 */
export function isCommentBlock(err: unknown): boolean {
  if (!(err instanceof IgError)) return false;
  return [4, 17, 20, 32, 368, 613].includes(err.code ?? -1) || err.subcode === 1772107;
}

/** Refreshed token in D1 wins over the IG_ACCESS_TOKEN secret (secrets can't be rewritten at runtime). */
export async function getToken(env: Env): Promise<string | undefined> {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'ig_token'`).first<{ value: string }>();
  return r?.value || env.IG_ACCESS_TOKEN || undefined;
}

export class IgClient {
  fetches = 0;
  constructor(private base: string, private token: string) {}

  private async call(method: 'GET' | 'POST', path: string, params: Record<string, string>): Promise<any> {
    if (this.fetches >= FETCH_BUDGET) throw new IgError(0, 'subrequest budget used up for this run');
    this.fetches++;
    const url = new URL(`${this.base.replace(/\/+$/, '')}/${path}`);
    const body = new URLSearchParams({ ...params, access_token: this.token });
    let res: Response;
    if (method === 'GET') {
      url.search = body.toString();
      res = await fetch(url.toString());
    } else {
      res = await fetch(url.toString(), { method, body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    }
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok || data?.error) {
      const e = data?.error;
      const codes = e ? ` [code ${e.code ?? '?'}${e.error_subcode ? `/${e.error_subcode}` : ''}${e.type ? ` ${e.type}` : ''}${e.error_user_title ? ` · ${e.error_user_title}` : ''}${e.error_user_msg ? ` · ${e.error_user_msg}` : ''}]` : '';
      throw new IgError(res.status, `${method} ${path}: ${res.status} ${e?.message ?? text.slice(0, 120)}${codes}`, e?.code, e?.error_subcode);
    }
    return data;
  }

  get(path: string, params: Record<string, string> = {}) { return this.call('GET', path, params); }
  post(path: string, params: Record<string, string> = {}) { return this.call('POST', path, params); }
}

// ---------------------------------------------------------------- shared comment pipeline

// Line 1 of the welcome reply. Links in Instagram comments aren't tappable, so the house link
// lives in the bio; {n} is the resident number.
// Welcome replies: 30 complete two-line messages, tailored with the person's @handle ({h}), house
// number ({n}) and job ({job}), dealt from a shuffled deck so nobody in a row gets the same text
// (Instagram treats many near-identical replies as spam). All 30 go out once per shuffle.
const WELCOMES = [
  'Welcome to Kinsburg, @{h}! 🏡\nHouse #{n} is all yours',
  "Keys are ready, @{h} 🔑\nYou're neighbour #{n}, our newest {job}",
  'You live here now, @{h} ✨\nKinsburg just got a new {job}',
  'Fresh paint, new neighbour 🎨\nWelcome home, @{h} (#{n})',
  'The lights are on at house #{n} 💡\nWelcome, @{h}!',
  "@{h} just moved in 📦\nKinsburg's newest {job}, house #{n}",
  'Your house is up, @{h} 🏠\nFollow to watch your street light up 🌙',
  'Welcome to the neighbourhood, @{h} 👋\nHouse #{n}, {job} on duty',
  'Moving day for @{h} 🚚\nHouse #{n} is ready',
  "A new window just lit up ✨\nThat one's yours, @{h} (#{n})",
  "Kinsburg says hi, @{h} 💛\nYou're resident #{n}",
  "The doormat's out, @{h} 🏡\nWelcome to house #{n}",
  'Built and ready, @{h} 🛠️\nOur newest {job} lives at #{n}',
  'Population +1 📈\nWelcome, @{h}! House #{n}',
  '@{h}, your street just got cosier 🌷\nHouse #{n} is yours',
  'Welcome home, @{h} 🔑\nFollow to catch your house in a Reel 🎬',
  'The neighbours are waving, @{h} 👋\nResident #{n}, welcome!',
  "Your chimney's already puffing, @{h} 🏠\nWelcome to #{n}",
  'A new {job} in town 🎉\nWelcome to Kinsburg, @{h}',
  'Housewarming for @{h} 🎈\nHouse #{n} is open',
  "You're officially a Kinsburger, @{h} 🏙️\nResident #{n}",
  'Mailbox labelled, @{h} 📬\nWelcome to house #{n}',
  "Fresh keys for @{h} 🗝️\nKinsburg's newest {job}",
  'Your porch light is on, @{h} 💡\nFollow to see the town grow ✨',
  'Welcome aboard, @{h} 🌟\nHouse #{n}, right in the neighbourhood',
  "A new {job} moved in 🏡\nGlad you're here, @{h} (#{n})",
  'The town just grew by one: @{h} 🌱\nHouse #{n} is yours',
  'You have a street address now, @{h} 🏡\nResident #{n}',
  'Unpacking boxes at #{n} 📦\nWelcome to Kinsburg, @{h}',
  "Hello neighbour @{h} 🙌\nYou're #{n} in Kinsburg",
];

// For a resident who comments MOVE IN again (no job: the comment only tells us they're here).
const ALREADY_HERE = [
  'You already live here, @{h} ✨\nHouse #{n} is waiting for you',
  'Still home sweet home, @{h} 🏡\nHouse #{n}',
  'Your keys still work, @{h} 🔑\nHouse #{n}',
  "Already a neighbour, @{h} 😄\nYou're resident #{n}",
  "No need to move twice, @{h} 😉\nHouse #{n} is still yours",
  'Welcome back, @{h} 💛\nHouse #{n} missed you',
  'Still here, still yours, @{h} 🏡\nResident #{n}',
  "You're in already, @{h} 🙌\nFind house #{n} on kinsburg.com",
];

/** Seeded Fisher-Yates: the deck order for one shuffle of `n` cards. */
function shuffled(n: number, seed: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  let x = seed >>> 0 || 1;
  for (let i = n - 1; i > 0; i--) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The next card from a shuffled deck kept in meta (`deck_<name>` = "<shuffle>:<next>"). */
async function nextCard(env: Env, name: string, size: number): Promise<number> {
  const key = `deck_${name}`;
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first<{ value: string }>();
  let [round, next] = String(row?.value ?? '0:0').split(':').map((v) => Number(v) | 0);
  if (next >= size) { round++; next = 0; }
  const card = shuffled(size, 0x9e3779b9 ^ (round * 2654435761) ^ size)[next];
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, `${round}:${next + 1}`).run();
  return card;
}

/** Fill a welcome template (pick one whose parts are all known; see replyText). */
export function fillWelcome(tpl: string, handle: string, n: number | undefined, job: string | undefined): string {
  return tpl.split('{h}').join(handle).split('{n}').join(String(n ?? '')).split('{job}').join(job ?? '');
}

async function replyText(env: Env, handle: string, n: number | undefined, already = false, jobIndex?: number): Promise<string> {
  const list = already ? ALREADY_HERE : WELCOMES;
  const job = jobIndex !== undefined && jobIndex !== null ? JOBS[jobIndex] : undefined;
  // a template needing a number or job we don't have hands over to the next one in the list that doesn't
  const fits = (t: string) => (n || !t.includes('{n}')) && (job || !t.includes('{job}'));
  const card = await nextCard(env, already ? 'already' : 'welcome', list.length);
  let tpl = list[card];
  for (let k = 1; !fits(tpl) && k < list.length; k++) tpl = list[(card + k) % list.length];
  if (!fits(tpl)) tpl = 'Welcome to Kinsburg, @{h} 🏡\nFollow to see the town grow ✨';
  return fillWelcome(tpl, handle, n, job);
}

/**
 * Join everyone who asked to MOVE IN in these comments, once. Used by the poller and the webhook.
 * Already-processed comment ids are skipped; one snapshot rewrite for the whole batch.
 */
export async function processComments(env: Env, comments: IgComment[], source: JoinSource, client?: IgClient) {
  const db = env.DB;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const matched = comments.filter((c) => c.id && c.username && c.username.toLowerCase() !== own && matchesMoveIn(c.text));
  const seenIds = new Set<string>();
  const unique = matched.filter((c) => !seenIds.has(c.id) && seenIds.add(c.id));
  // Drop comments handled before (by an earlier poll or the webhook).
  const done = new Set<string>();
  const ids = unique.map((c) => c.id);
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const c = ids.slice(i, i + 90);
    reads.push(db.prepare(`SELECT comment_id FROM processed_comments WHERE comment_id IN (${c.map(() => '?').join(',')})`).bind(...c));
  }
  if (reads.length) for (const r of await db.batch<{ comment_id: string }>(reads)) for (const row of r.results) done.add(row.comment_id);
  const fresh = unique.filter((c) => !done.has(c.id)).slice(0, MAX_JOINS_PER_RUN);

  const report = { matched: unique.length, fresh: fresh.length, joined: [] as string[], exists: 0, rejected: [] as string[], replies: 0, replyErrors: 0, besties: [] as Array<{ handle: string; friend: string; outcome: string }> };
  if (!fresh.length) return report;

  // "MOVE IN @friend" comments join one at a time, each followed by its bestie hold, so the held
  // plot is the one right after the commenter's. Everyone else joins in one batch.
  const bestieOf = fresh.map((c) => parseBestie(c.text, own));
  const results: JoinResult[] = new Array(fresh.length);
  const holdRows: Row[] = [];
  const bestieReport: Array<{ handle: string; friend: string; outcome: string }> = [];
  try {
    const plain = fresh.map((_, i) => i).filter((i) => !bestieOf[i]);
    const batch = await joinMany(env, plain.map((i) => ({ raw: fresh[i].username, source, igUserId: fresh[i].igUserId })));
    plain.forEach((i, k) => (results[i] = batch[k]));
    for (let i = 0; i < fresh.length; i++) {
      if (!bestieOf[i]) continue;
      const [r] = await joinMany(env, [{ raw: fresh[i].username, source, igUserId: fresh[i].igUserId }]);
      results[i] = r;
      if (r.status === 'joined' || r.status === 'exists') {
        // Existing residents only get paired (a hold would not be next to their house).
        const b = await bestieAfterJoin(env, r.handle, bestieOf[i]!, Date.now(), r.status === 'joined');
        bestieReport.push({ handle: r.handle, friend: bestieOf[i]!, outcome: b.outcome });
        if (b.row) holdRows.push(b.row);
      }
    }
  } catch (err) {
    log('join_batch_failed', { error: String(err) });
    throw err;
  }

  // Optional public reply, only to people who just got a house (never twice: the processed record
  // and the "joined" status both gate it).
  const replied = new Set<string>();
  const refused = new Set<string>(); // Instagram won't take a reply on these (see commentRefused)
  const replyOn = env.IG_REPLY_ENABLED === 'true' && client;
  let replyBudget = replyOn ? await replyAllowance(env) : 0;
  for (let i = 0; i < fresh.length; i++) {
    const r = results[i];
    if (r.status === 'joined') report.joined.push(r.handle);
    else if (r.status === 'exists') report.exists++;
    else report.rejected.push(`${r.handle}:${r.status}`);
    if (r.status === 'joined' && env.IG_PRIVATE_REPLY_ENABLED === 'true' && client) {
      try {
        await privateReply(env, client, fresh[i].id, r.handle, r.number);
      } catch (err) {
        log('private_reply_failed', { comment: fresh[i].id, error: String(err) });
      }
    }
    if (replyOn && r.status === 'joined' && replyBudget > 0) {
      try {
        if (report.replies) await humanPause();
        await client.post(`${fresh[i].id}/replies`, { message: await replyText(env, r.handle, r.number, false, r.row?.[3]) });
        replied.add(fresh[i].id);
        report.replies++;
        replyBudget--;
      } catch (err) {
        report.replyErrors++;
        log('reply_failed', { comment: fresh[i].id, error: String(err) });
        if (isCommentBlock(err)) {
          if ((await commentRefused(env, fresh[i].id, err)) === 'paused') replyBudget = 0;
          else refused.add(fresh[i].id);
        }
      }
    }
    // Comments that didn't get a reply now are picked up later by replyToMissed.
  }

  const extra: D1PreparedStatement[] = fresh.map((c, i) =>
    db
      .prepare('INSERT INTO processed_comments (comment_id, media_id, handle, result, replied) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(comment_id) DO NOTHING')
      .bind(c.id, c.mediaId, results[i].handle, results[i].status, replied.has(c.id) ? 1 : refused.has(c.id) ? -1 : 0),
  );
  for (const r of results) if (r.status === 'joined') extra.push(eventStmt(env, 'join', r.handle, { source, number: r.number }));
  report.besties = bestieReport;
  const rows = results.filter((r) => r.status === 'joined' && r.row).map((r) => r.row!);
  await writeSnapshots(env, [...rows, ...holdRows], extra);
  if (report.replies + refused.size) await noteReplies(env, report.replies + refused.size);
  return report;
}

// ---------------------------------------------------------------- poller (cron)

export async function pollComments(env: Env) {
  const token = await getToken(env);
  if (!token || !env.IG_USER_ID) {
    log('poll_skipped', { reason: 'IG_ACCESS_TOKEN / IG_USER_ID not set' });
    return { skipped: true };
  }
  const ig = new IgClient(env.IG_API_BASE, token);
  const errors: string[] = [];
  const comments: IgComment[] = [];
  let media: Array<{ id: string }> = [];
  let mediaTotal = 0;
  try {
    // Every Reel, not just the newest: the newest IG_MEDIA_LIMIT posts on every scan, plus a rotating
    // batch of the same size from the older ones (all of them are covered within a few scans)
    const res = await ig.get(`${env.IG_USER_ID}/media`, { fields: 'id,timestamp', limit: String(intVar(env.IG_MEDIA_SCAN_MAX, 100)) });
    const all: Array<{ id: string }> = Array.isArray(res?.data) ? res.data : [];
    mediaTotal = all.length;
    media = await scanSlice(env, all);
  } catch (err) {
    log('poll_failed', { stage: 'media', error: String(err) });
    await env.DB.batch([eventStmt(env, 'poll_failed', null, { stage: 'media', error: String(err) })]);
    return { error: String(err) };
  }
  for (const m of media) {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_MEDIA; page++) {
      try {
        const params: Record<string, string> = { fields: 'id,text,username,timestamp,like_count,replies{username}', limit: '50' };
        if (after) params.after = after;
        const res = await ig.get(`${m.id}/comments`, params);
        for (const c of Array.isArray(res?.data) ? res.data : []) {
          if (c && typeof c.id === 'string' && typeof c.username === 'string') {
            comments.push({ id: c.id, text: String(c.text ?? ''), username: c.username, mediaId: m.id, likes: Number(c.like_count ?? 0), repliedByUs: repliedByCity(env, c) });
          }
        }
        after = res?.paging?.next ? res?.paging?.cursors?.after : undefined;
        if (!after) break;
      } catch (err) {
        errors.push(String(err)); // one bad media/page never sinks the run
        log('poll_media_failed', { media: m.id, error: String(err) });
        break;
      }
    }
  }
  const report = await processComments(env, comments, 'comment', ig);
  const buildReqs = await processBuildComments(env, comments);
  const catchUp = await replyToMissed(env, comments, ig, await replyAllowance(env));
  const town = await processTownComments(env, comments);
  const cast = await processCastComments(env, comments);
  const life = await processLifeComments(env, comments);
  const sim = await processSimComments(env, comments);
  const politics = await processPoliticsComments(env, comments);
  const homes = await processHomeComments(env, comments);
  const follows = await recordFollowers(env, ig);
  const closed = await closeDuePolls(env);
  const healed = await healSnapshots(env);
  const summary = { media: media.length, mediaTotal, comments: comments.length, fetches: ig.fetches, errors: errors.length, healed, town, cast: cast.cast, life, sim, politics, homes, follows, pollsClosed: closed, ...report, catchUpReplies: catchUp.replied, buildRequests: buildReqs.requests };
  log('poll_done', summary);
  if (report.fresh || errors.length) await env.DB.batch([eventStmt(env, 'poll', null, { ...summary, errors: errors.slice(0, 5) })]);
  return summary;
}

// ---------------------------------------------------------------- webhook

/** GET: subscription handshake. POST: signed `comments` notifications (needs Advanced Access). */
export async function handleInstagramWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const ok = u.searchParams.get('hub.mode') === 'subscribe' && !!env.IG_VERIFY_TOKEN && u.searchParams.get('hub.verify_token') === env.IG_VERIFY_TOKEN;
    return ok ? new Response(u.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!env.IG_APP_SECRET) return new Response('webhook not configured', { status: 503 });
  const raw = await req.text();
  if (!(await verifyMetaSignature(env.IG_APP_SECRET, raw, req.headers.get('x-hub-signature-256')))) {
    log('ig_webhook_bad_signature');
    return new Response('bad signature', { status: 401 });
  }
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const comments: IgComment[] = [];
  const messaging: any[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value;
      if (ch?.field !== 'comments' || !v) continue;
      if (typeof v.id === 'string' && typeof v.from?.username === 'string') {
        comments.push({ id: v.id, text: String(v.text ?? ''), username: v.from.username, mediaId: String(v.media?.id ?? ''), igUserId: v.from.id ? String(v.from.id) : undefined });
      }
    }
    if (Array.isArray(entry?.messaging)) messaging.push(...entry.messaging);
  }
  try {
    const token = await getToken(env);
    const client = token ? new IgClient(env.IG_API_BASE, token) : undefined;
    const report = await processComments(env, comments, 'webhook', client);
    const town = await processTownComments(env, comments);
    const cast = await processCastComments(env, comments);
    const life = await processLifeComments(env, comments);
    const sim = await processSimComments(env, comments);
    const politics = await processPoliticsComments(env, comments);
    const homes = await processHomeComments(env, comments);
    const dms = messaging.length ? await handleDms(env, client, messaging) : null;
    return json({ ok: true, ...report, town, cast: cast.cast, life, sim, politics, homes, dms });
  } catch (err) {
    log('ig_webhook_failed', { error: String(err) });
    return new Response('retry later', { status: 500 }); // Meta retries for up to 36 h
  }
}

/**
 * TODO Phase 2 (needs Advanced Access via App Review): private reply to a commenter.
 * POST /<IG_USER_ID>/messages { recipient: { comment_id }, message: { text } }; one per commenter,
 * within 7 days of the comment, 750/hour. Keep the text to "Your house is ready <link>" (no sales).
 */
export async function sendPrivateReply(_env: Env, _commentId: string, _text: string): Promise<never> {
  throw new Error('private replies are Phase 2 (App Review required)');
}

// ---------------------------------------------------------------- token refresh (weekly cron)

/** Long-lived Instagram Login tokens last ~60 days; refresh weekly and keep the new one in D1. */
export async function refreshToken(env: Env) {
  const token = await getToken(env);
  if (!token) {
    log('token_refresh_skipped', { reason: 'no token' });
    return { skipped: true };
  }
  if (isFacebookHost(env.IG_API_BASE)) {
    // Business Manager system-user tokens (Unified login) never expire; nothing to refresh.
    log('token_refresh_skipped', { reason: 'facebook system-user token' });
    return { skipped: true };
  }
  const url = new URL('/refresh_access_token', env.IG_API_BASE); // unversioned endpoint on the API host
  url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }).toString();
  try {
    const res = await fetch(url.toString());
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) throw new Error(`HTTP ${res.status} ${data?.error?.message ?? ''}`.trim());
    const expiresAt = new Date(Date.now() + Number(data.expires_in ?? 0) * 1000).toISOString();
    const up = `INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    await env.DB.batch([
      env.DB.prepare(up).bind('ig_token', String(data.access_token)),
      env.DB.prepare(up).bind('ig_token_expires_at', expiresAt),
      env.DB.prepare(up).bind('ig_token_refreshed_at', new Date().toISOString()),
      eventStmt(env, 'token_refreshed', null, { expiresAt }),
    ]);
    log('token_refreshed', { expiresAt });
    return { ok: true, expiresAt };
  } catch (err) {
    log('token_refresh_failed', { error: String(err) });
    await env.DB.batch([eventStmt(env, 'token_refresh_failed', null, { error: String(err) })]);
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------- Reel publishing relay (admin only)

/**
 * The daily Reel job (GitHub Actions) posts through the Worker, so the Instagram token lives only in
 * Cloudflare and the weekly refresh keeps working for it. Only the three Reel-posting calls pass:
 *   POST me/media, POST me/media_publish, GET <container or media id> ?fields=status_code,status | permalink
 */
const RELAY_GET_FIELDS = new Set(['status_code,status', 'status_code', 'permalink']);

export async function igRelay(env: Env, body: any): Promise<Response> {
  const token = await getToken(env);
  const connected = !!(token && env.IG_USER_ID);
  if (body?.check) return json({ connected });
  if (body?.whoami) {
    // Confirms the stored token works and tells setup which account (and IG_USER_ID) it belongs to.
    if (!token) return json({ error: 'no Instagram token stored' }, 503);
    if (!isFacebookHost(env.IG_API_BASE)) {
      try {
        const me = await new IgClient(env.IG_API_BASE, token).get('me', { fields: 'user_id,username' });
        return json({ api: 'instagram', user_id: String(me.user_id ?? ''), username: me.username ?? null, matchesStoredUserId: env.IG_USER_ID ? String(me.user_id) === env.IG_USER_ID : null });
      } catch (err) {
        // Tokens from Meta's newer "Unified login" (EA...) only work on graph.facebook.com: try it below.
        if (!token.startsWith('EA')) return json({ error: String((err as Error).message ?? err) }, 502);
      }
    }
    return json(await facebookWhoami(env, token, body?.id), 200);
  }
  if (!connected) return json({ error: 'Instagram not connected (set IG_ACCESS_TOKEN and IG_USER_ID)' }, 503);
  const method = body?.method;
  const path = String(body?.path ?? '');
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(body?.params ?? {})) params[k] = String(v);
  let target: string | null = null;
  if (method === 'POST' && (path === 'me/media' || path === 'me/media_publish')) {
    if (path === 'me/media' && params.media_type !== 'REELS') return json({ error: 'only REELS containers' }, 400);
    target = `${env.IG_USER_ID}/${path.slice(3)}`;
  } else if (method === 'GET' && /^[A-Za-z0-9_]{1,40}$/.test(path) && RELAY_GET_FIELDS.has(params.fields ?? '') && Object.keys(params).length === 1) {
    target = path;
  }
  if (!target) return json({ error: 'call not allowed through the relay' }, 400);
  try {
    const ig = new IgClient(env.IG_API_BASE, token!);
    return json(method === 'GET' ? await ig.get(target, params) : await ig.post(target, params));
  } catch (err) {
    const status = err instanceof IgError && err.status >= 400 ? err.status : 502;
    log('ig_relay_failed', { path, error: String(err) });
    return json({ error: String((err as Error).message ?? err) }, status);
  }
}

export const isFacebookHost = (base: string) => /graph\.facebook\.com/.test(base);

/**
 * For Facebook-style (EA...) tokens from Meta's Unified login / Business Manager system users: which
 * Instagram professional accounts the token reaches, plus its type, expiry and scopes. Never returns
 * the token itself. Accounts come from the token's granted assets (needs IG_APP_SECRET, the app's
 * secret, to inspect it) or from Facebook Pages linked to Instagram.
 */
async function facebookWhoami(env: Env, token: string, candidate?: unknown) {
  const fbBase = isFacebookHost(env.IG_API_BASE) ? env.IG_API_BASE : 'https://graph.facebook.com/v27.0';
  const fb = new IgClient(fbBase, token);
  const out: any = { api: 'facebook', base: fbBase, accounts: [] as any[] };
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { (out.errors ??= {})[label] = String((err as Error).message ?? err).slice(0, 200); }
  };
  const igIds = new Set<string>();
  if (/^\d{5,25}$/.test(String(candidate ?? ''))) igIds.add(String(candidate)); // an ID copied from Business settings
  if (env.IG_USER_ID) igIds.add(env.IG_USER_ID);
  if (env.IG_APP_SECRET && env.META_APP_ID) {
    await attempt('token', async () => {
      const app = new IgClient(fbBase, `${env.META_APP_ID}|${env.IG_APP_SECRET}`);
      const d = (await app.get('debug_token', { input_token: token })).data ?? {};
      const granular = d.granular_scopes ?? [];
      out.token = { type: d.type, valid: d.is_valid, expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never', scopes: d.scopes };
      for (const g of granular) if (g.scope === 'instagram_basic') for (const id of g.target_ids ?? []) igIds.add(String(id));
      out.token.instagramAccountsGranted = igIds.size;
    });
  }
  await attempt('pages', async () => {
    const pages = await fb.get('me/accounts', { fields: 'name,instagram_business_account{id,username}' });
    for (const p of pages.data ?? []) {
      const ig = p.instagram_business_account;
      if (ig) out.accounts.push({ user_id: String(ig.id), username: ig.username ?? null, via: `page ${p.name}` });
    }
  });
  for (const id of igIds) {
    if (out.accounts.some((a: any) => a.user_id === id)) continue;
    await attempt(`account ${id}`, async () => {
      const a = await fb.get(id, { fields: 'id,username' });
      out.accounts.push({ user_id: String(a.id), username: a.username ?? null, via: 'granted asset' });
    });
  }
  const target = out.accounts.find((a: any) => a.username === 'kinsburgtown') ?? out.accounts[0];
  out.user_id = target?.user_id ?? '';
  out.username = target?.username ?? null;
  out.matchesStoredUserId = env.IG_USER_ID && target ? target.user_id === env.IG_USER_ID : null;
  if (out.user_id) {
    await attempt('media', async () => {
      const m = await fb.get(`${out.user_id}/media`, { fields: 'id', limit: '1' });
      out.canReadMedia = Array.isArray(m.data);
    });
  }
  if (!out.user_id) out.hint = 'The token reaches no Instagram account: assign @kinsburgtown to this system user in Meta Business settings.';
  return out;
}

// ---------------------------------------------------------------- missed replies

/** True when the city account already replied under this comment (Graph `replies{username}`). */
function repliedByCity(env: Env, c: any): boolean {
  const own = env.CITY_ACCOUNT.toLowerCase();
  return Array.isArray(c?.replies?.data) && c.replies.data.some((r: any) => String(r?.username ?? '').toLowerCase() === own);
}

/**
 * Replies to MOVE IN comments that were handled without a reply: comments from before replies
 * were switched on, the overflow past the per-run cap, and residents who commented MOVE IN again.
 * Gated twice: processed_comments.replied must be 0 and the comment must not already carry a
 * reply from the city account. Other comments never get an automatic reply.
 */
export async function replyToMissed(env: Env, comments: IgComment[], client: IgClient, budget: number, dryRun = false) {
  const out = { candidates: 0, replied: 0, errors: 0, planned: [] as Array<{ handle: string; text: string }> };
  if (env.IG_REPLY_ENABLED !== 'true' || budget <= 0) return out;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const moveIns = comments.filter((c) => c.username.toLowerCase() !== own && !c.repliedByUs && matchesMoveIn(c.text));
  if (!moveIns.length) return out;
  const ids = moveIns.map((c) => c.id).slice(0, 90);
  const rows = (await env.DB.prepare(
    `SELECT p.comment_id, p.handle, p.result, r.number, r.job FROM processed_comments p LEFT JOIN residents r ON r.handle = p.handle
     WHERE p.replied = 0 AND p.result IN ('joined', 'exists') AND p.comment_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ comment_id: string; handle: string; result: string; number: number | null; job: number | null }>()).results;
  out.candidates = rows.length;
  for (const row of rows.slice(0, budget)) {
    const text = await replyText(env, row.handle, row.number ?? undefined, row.result === 'exists', row.job ?? undefined);
    if (dryRun) { out.planned.push({ handle: row.handle, text }); continue; }
    try {
      if (out.replied) await humanPause();
      await client.post(`${row.comment_id}/replies`, { message: text });
      await env.DB.prepare('UPDATE processed_comments SET replied = 1 WHERE comment_id = ?1').bind(row.comment_id).run();
      out.replied++;
    } catch (err) {
      out.errors++;
      log('catch_up_reply_failed', { comment: row.comment_id, error: String(err) });
      if (isCommentBlock(err) && (await commentRefused(env, row.comment_id, err)) === 'paused') break;
    }
  }
  if (out.replied + out.errors) await noteReplies(env, out.replied + out.errors); // failed attempts count toward the pace too
  return out;
}

/** Admin: list (dryRun) or send the missed replies now, and show other comments still unanswered. */
export async function repliesAdmin(env: Env, body: any) {
  const token = await getToken(env);
  if (!token || !env.IG_USER_ID) return { error: 'Instagram not connected' };
  const ig = new IgClient(env.IG_API_BASE, token);
  const own = env.CITY_ACCOUNT.toLowerCase();
  // { offset, count }: which posts, newest first (default the newest 10); a request may only make
  // about 50 calls, so list all posts in batches of up to 25
  const all = (await ig.get(`${env.IG_USER_ID}/media`, { fields: 'id', limit: String(intVar(env.IG_MEDIA_SCAN_MAX, 100)) })).data ?? [];
  const offset = Math.max(0, Number(body?.offset ?? 0) | 0);
  const media = all.slice(offset, offset + Math.min(25, Math.max(1, Number(body?.count ?? intVar(env.IG_MEDIA_LIMIT, 10)) | 0)));
  const comments: IgComment[] = [];
  const perPost: Array<{ media: string; comments: number }> = [];
  for (const m of media) {
    const res = await ig.get(`${m.id}/comments`, { fields: 'id,text,username,replies{username}', limit: '50' });
    perPost.push({ media: m.id, comments: (res.data ?? []).length });
    for (const c of res.data ?? []) comments.push({ id: c.id, text: String(c.text ?? ''), username: c.username, mediaId: m.id, repliedByUs: repliedByCity(env, c) });
  }
  const allowance = body?.dryRun ? 25 : Math.min(Number(body?.max ?? 2), await replyAllowance(env));
  const missed = await replyToMissed(env, comments, ig, allowance, !!body?.dryRun);
  const otherUnanswered = comments
    .filter((c) => c.username.toLowerCase() !== own && !c.repliedByUs && !matchesMoveIn(c.text))
    .map((c) => ({ id: c.id, username: c.username, text: c.text.slice(0, 80) }));
  return { posts: all.length, offset, comments: comments.length, perPost, missed, otherUnanswered, pace: await replyStatus(env) };
}

// ---------------------------------------------------------------- reply pacing

/**
 * Instagram treats bursts of near-identical comments as spam and blocks the account from
 * commenting. Replies therefore go out at a human pace (a few per run, seconds apart, a daily
 * cap) and stop entirely for a while when Instagram says no, instead of retrying into the block.
 */
const PAUSE_FIRST_HOURS = 6;
const PAUSE_MAX_HOURS = 48;

async function metaGet(env: Env, keys: string[]): Promise<Record<string, string>> {
  const r = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value]));
}
const metaSet = (env: Env, key: string, value: string) =>
  env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);

/** Pacing window length (IG_REPLY_WINDOW_SECONDS, default 10 minutes: one per comment scan). It starts
 *  with the first reply sent in it, so a burst can never straddle two windows. */
const windowMs = (env: Env) => intVar(env.IG_REPLY_WINDOW_SECONDS, 600) * 1000;

export async function replyStatus(env: Env) {
  const m = await metaGet(env, ['replies_paused_until', 'replies_pause_hours', 'replies_day', 'replies_count', 'replies_window']);
  const today = new Date().toISOString().slice(0, 10);
  const pausedUntil = m.replies_paused_until && Date.parse(m.replies_paused_until) > Date.now() ? m.replies_paused_until : null;
  const [ws, wn] = String(m.replies_window ?? '').split(':');
  const windowOpen = Number(ws) > 0 && Date.now() - Number(ws) < windowMs(env);
  return {
    pausedUntil,
    lastPauseHours: Number(m.replies_pause_hours ?? 0),
    today: m.replies_day === today ? Number(m.replies_count ?? 0) : 0,
    /** replies sent in the current pacing window, by every sender (welcomes, catch-ups, queue, announcements) */
    thisWindow: windowOpen ? Number(wn ?? 0) : 0,
    windowStart: windowOpen ? Number(ws) : 0,
    perRun: intVar(env.IG_REPLY_MAX_PER_RUN, 2),
    perDay: intVar(env.IG_REPLY_MAX_PER_DAY, 80),
  };
}

/** How many replies may go out right now: per window (shared by every sender) and per day. */
export async function replyAllowance(env: Env): Promise<number> {
  const s = await replyStatus(env);
  if (s.pausedUntil) return 0;
  return Math.max(0, Math.min(s.perRun - s.thisWindow, s.perDay - s.today));
}

export async function noteReplies(env: Env, n: number) {
  const s = await replyStatus(env);
  const today = new Date().toISOString().slice(0, 10);
  const stmts = [
    metaSet(env, 'replies_day', today),
    metaSet(env, 'replies_count', String(s.today + n)),
    metaSet(env, 'replies_window', `${s.windowStart || Date.now()}:${s.thisWindow + n}`),
  ];
  // Replies are flowing again after a pause ended: the next block starts short. Not while a pause
  // set in this same run is active.
  if (!s.pausedUntil) stmts.push(metaSet(env, 'replies_pause_hours', '0'));
  await env.DB.batch(stmts);
}

export async function pauseReplies(env: Env, err: unknown) {
  const s = await replyStatus(env);
  const hours = s.lastPauseHours ? Math.min(PAUSE_MAX_HOURS, s.lastPauseHours * 2) : PAUSE_FIRST_HOURS;
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  await env.DB.batch([
    metaSet(env, 'replies_paused_until', until),
    metaSet(env, 'replies_pause_hours', String(hours)),
    eventStmt(env, 'replies_paused', null, { until, hours, error: String(err).slice(0, 300) }),
  ]);
  log('replies_paused', { until, hours });
}

/** A few seconds between replies, like a person typing. */
const humanPause = () => new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));

/**
 * A hand-picked reply (POST /admin/reply { commentId, message }). Counts toward the daily cap and
 * never goes out while replies are paused by an Instagram comment block.
 */
export async function handReply(env: Env, body: any) {
  const commentId = String(body?.commentId ?? '');
  const message = String(body?.message ?? '').trim();
  if (!/^\d{5,30}$/.test(commentId) || !message || message.length > 500) return { error: 'need commentId (digits) and message (1-500 chars)' };
  const status = await replyStatus(env);
  if (status.pausedUntil) return { error: `replies are paused until ${status.pausedUntil} (Instagram comment block)` };
  if (status.today >= status.perDay) return { error: `daily reply cap reached (${status.perDay})` };
  if (status.thisWindow >= status.perRun) return { error: `${status.perRun} replies already went out in the last few minutes: add "queue": true and it goes out at the next check` };
  const token = await getToken(env);
  if (!token) return { error: 'Instagram not connected' };
  try {
    const r = await new IgClient(env.IG_API_BASE, token).post(`${commentId}/replies`, { message });
    await noteReplies(env, 1);
    await env.DB.prepare('UPDATE processed_comments SET replied = 1 WHERE comment_id = ?1').bind(commentId).run();
    return { ok: true, id: r?.id ?? null };
  } catch (err) {
    if (isCommentBlock(err)) await commentRefused(env, commentId, err);
    return { error: String((err as Error).message ?? err) };
  }
}

// ---------------------------------------------------------------- reply queue

/**
 * Queue a hand-picked reply (POST /admin/reply { commentId, message, handle?, queue: true }); the
 * cron sends it when the pace allows (see flushReplyQueue). Queuing the same comment again updates
 * the message while it waits.
 */
export async function queueReply(env: Env, body: any) {
  const commentId = String(body?.commentId ?? '');
  const message = String(body?.message ?? '').trim();
  if (!/^\d{5,30}$/.test(commentId) || !message || message.length > 500) return { error: 'need commentId (digits) and message (1-500 chars)' };
  await env.DB.prepare(
    `INSERT INTO reply_queue (comment_id, handle, message) VALUES (?1, ?2, ?3)
     ON CONFLICT(comment_id) DO UPDATE SET message = excluded.message, handle = excluded.handle WHERE reply_queue.status = 'queued'`,
  ).bind(commentId, body?.handle ? String(body.handle).slice(0, 40) : null, message).run();
  const waiting = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status = 'queued'`).first<{ n: number }>();
  return { queued: true, waiting: waiting?.n ?? 0, pace: await replyStatus(env) };
}

/** GET /admin/reply-queue: what is waiting and what went out lately. */
export async function replyQueueStatus(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT comment_id, handle, message, status, detail, created_at, sent_at FROM reply_queue
     ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_at DESC LIMIT 100`,
  ).all();
  return { pace: await replyStatus(env), replies: rows.results };
}

/**
 * Send queued replies, oldest first, within the reply allowance (per run and per day, shared with
 * announcements) and never during an Instagram comment block. A comment that no longer exists or
 * can't take a reply is marked failed instead of blocking the queue.
 */
export async function flushReplyQueue(env: Env) {
  const allowance = await replyAllowance(env);
  if (allowance < 1) return { sent: 0, reason: 'pacing' };
  const token = await getToken(env);
  if (!token) return { sent: 0, reason: 'not connected' };
  const next = (await env.DB.prepare(`SELECT comment_id, message FROM reply_queue WHERE status = 'queued' ORDER BY created_at, comment_id LIMIT ?1`)
    .bind(allowance).all<{ comment_id: string; message: string }>()).results;
  const ig = new IgClient(env.IG_API_BASE, token);
  let sent = 0, refusedHere = 0;
  for (const r of next) {
    try {
      if (sent) await humanPause();
      await ig.post(`${r.comment_id}/replies`, { message: r.message });
      await env.DB.batch([
        env.DB.prepare(`UPDATE reply_queue SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE comment_id = ?1`).bind(r.comment_id),
        env.DB.prepare('UPDATE processed_comments SET replied = 1 WHERE comment_id = ?1').bind(r.comment_id),
      ]);
      sent++;
    } catch (err) {
      log('queued_reply_failed', { comment: r.comment_id, error: String(err) });
      if (isCommentBlock(err)) {
        // one comment that can't take a reply is skipped; two different ones in a row pause everything
        if ((await commentRefused(env, r.comment_id, err)) === 'paused') break;
        refusedHere++; // a refused attempt still counts toward the pace
        continue;
      }
      await env.DB.prepare(`UPDATE reply_queue SET status = 'failed', detail = ?2 WHERE comment_id = ?1`).bind(r.comment_id, String(err).slice(0, 300)).run();
    }
  }
  if (sent + refusedHere) await noteReplies(env, sent + refusedHere);
  return { sent, refused: refusedHere };
}

// ---------------------------------------------------------------- refused replies, scan rotation

/**
 * Instagram answered a reply with "comment not added" (code 20 / 1772107 and friends). That can mean
 * the whole account is blocked, or only that this one comment can't take replies (the commenter
 * restricted us, hid the comment, limits replies...). One refusal: skip this comment (it is not
 * retried) and carry on. A different comment refused within 3 hours as well: a real account block,
 * so both go back in line and replies pause (pauseReplies).
 */
export async function commentRefused(env: Env, commentId: string, err: unknown): Promise<'skipped' | 'paused'> {
  const db = env.DB;
  const prev = await db.prepare(`SELECT value FROM meta WHERE key = 'reply_refused_last'`).first<{ value: string }>();
  const [prevId, prevAt] = String(prev?.value ?? '').split('|');
  const mark = (id: string) => [
    db.prepare(`UPDATE reply_queue SET status = 'failed', detail = ?2 WHERE comment_id = ?1 AND status = 'queued'`).bind(id, `Instagram won't take a reply on this comment: ${String(err).slice(0, 200)}`),
    db.prepare('UPDATE processed_comments SET replied = -1 WHERE comment_id = ?1 AND replied = 0').bind(id),
  ];
  const unmark = (id: string) => [
    db.prepare(`UPDATE reply_queue SET status = 'queued', detail = NULL WHERE comment_id = ?1 AND status = 'failed'`).bind(id),
    db.prepare('UPDATE processed_comments SET replied = 0 WHERE comment_id = ?1 AND replied = -1').bind(id),
  ];
  const setLast = (v: string) => db.prepare(`INSERT INTO meta (key, value) VALUES ('reply_refused_last', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(v);
  if (prevId && prevId !== commentId && Date.now() - Number(prevAt) < 3 * 3600_000) {
    await db.batch([...unmark(prevId), setLast(''), eventStmt(env, 'reply_refused', null, { comment: commentId, also: prevId, verdict: 'account block' })]);
    await pauseReplies(env, err);
    return 'paused';
  }
  await db.batch([...mark(commentId), setLast(`${commentId}|${Date.now()}`), eventStmt(env, 'reply_refused', null, { comment: commentId, verdict: 'skipped this comment' })]);
  log('reply_refused_skip', { comment: commentId });
  return 'skipped';
}

/** The posts to scan this time: the newest IG_MEDIA_LIMIT, plus the next batch of older ones in rotation. */
async function scanSlice(env: Env, all: Array<{ id: string }>) {
  const n = intVar(env.IG_MEDIA_LIMIT, 10);
  const newest = all.slice(0, n);
  const older = all.slice(n);
  if (!older.length) return newest;
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'scan_cursor'`).first<{ value: string }>();
  const start = (Number(row?.value ?? 0) | 0) % older.length;
  const batch = older.slice(start, start + n);
  if (batch.length < n) batch.push(...older.slice(0, Math.min(n - batch.length, start)));
  await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('scan_cursor', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String((start + n) % older.length)).run();
  return [...newest, ...batch];
}
