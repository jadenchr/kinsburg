// Instagram API with Instagram Login (graph.instagram.com): comment poller, comments webhook,
// optional public replies, long-lived token refresh. IG_API_BASE is configurable so tests can
// point at a local mock.
import { matchesMoveIn } from '../../shared/residents-format.mjs';
import { eventStmt, joinMany, writeSnapshots, healSnapshots, type JoinResult, type JoinSource } from './city';
import { verifyMetaSignature } from './crypto';
import { type Env, intVar, json, log } from './env';

export interface IgComment {
  id: string;
  text: string;
  username: string;
  mediaId: string;
  igUserId?: string;
}

/** Free plan: 50 external subrequests per invocation. Keep IG calls well under it. */
const FETCH_BUDGET = 40;
const MAX_PAGES_PER_MEDIA = 4;
const MAX_JOINS_PER_RUN = 300; // CPU guard; the rest waits for the next run (not marked processed)

class IgError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Refreshed token in D1 wins over the IG_ACCESS_TOKEN secret (secrets can't be rewritten at runtime). */
export async function getToken(env: Env): Promise<string | undefined> {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'ig_token'`).first<{ value: string }>();
  return r?.value || env.IG_ACCESS_TOKEN || undefined;
}

class IgClient {
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
      throw new IgError(res.status, `${method} ${path}: ${res.status} ${data?.error?.message ?? text.slice(0, 120)}`);
    }
    return data;
  }

  get(path: string, params: Record<string, string> = {}) { return this.call('GET', path, params); }
  post(path: string, params: Record<string, string> = {}) { return this.call('POST', path, params); }
}

// ---------------------------------------------------------------- shared comment pipeline

const REPLIES = [
  'Built! 🏠 Your house: {url}',
  'Welcome to Kinsburg, neighbour #{n}! 🏡 {url}',
  'Keys are ready 🔑 {url}',
  'You live here now ✨ #{n} → {url}',
  'Your house is up 🏡 Find it: {url}',
  'Fresh paint, new neighbour 🎨 {url}',
];

function replyText(env: Env, handle: string, n: number | undefined): string {
  const host = env.SITE_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const t = REPLIES[(n ?? handle.length) % REPLIES.length];
  return t.replace('{url}', `${host}/?r=${handle}`).replace('{n}', String(n ?? ''));
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

  const report = { matched: unique.length, fresh: fresh.length, joined: [] as string[], exists: 0, rejected: [] as string[], replies: 0, replyErrors: 0 };
  if (!fresh.length) return report;

  let results: JoinResult[];
  try {
    results = await joinMany(env, fresh.map((c) => ({ raw: c.username, source, igUserId: c.igUserId })));
  } catch (err) {
    log('join_batch_failed', { error: String(err) });
    throw err;
  }

  // Optional public reply, only to people who just got a house (never twice: the processed record
  // and the "joined" status both gate it).
  const replied = new Set<string>();
  const replyOn = env.IG_REPLY_ENABLED === 'true' && client;
  const maxReplies = intVar(env.IG_REPLY_MAX_PER_RUN, 5);
  for (let i = 0; i < fresh.length; i++) {
    const r = results[i];
    if (r.status === 'joined') report.joined.push(r.handle);
    else if (r.status === 'exists') report.exists++;
    else report.rejected.push(`${r.handle}:${r.status}`);
    if (replyOn && r.status === 'joined' && report.replies < maxReplies) {
      try {
        await client.post(`${fresh[i].id}/replies`, { message: replyText(env, r.handle, r.number) });
        replied.add(fresh[i].id);
        report.replies++;
      } catch (err) {
        report.replyErrors++;
        log('reply_failed', { comment: fresh[i].id, error: String(err) });
      }
    }
  }

  const extra: D1PreparedStatement[] = fresh.map((c, i) =>
    db
      .prepare('INSERT INTO processed_comments (comment_id, media_id, handle, result, replied) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(comment_id) DO NOTHING')
      .bind(c.id, c.mediaId, results[i].handle, results[i].status, replied.has(c.id) ? 1 : 0),
  );
  for (const r of results) if (r.status === 'joined') extra.push(eventStmt(env, 'join', r.handle, { source, number: r.number }));
  const rows = results.filter((r) => r.status === 'joined' && r.row).map((r) => r.row!);
  await writeSnapshots(env, rows, extra);
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
  try {
    const res = await ig.get(`${env.IG_USER_ID}/media`, { fields: 'id,timestamp', limit: String(intVar(env.IG_MEDIA_LIMIT, 10)) });
    media = Array.isArray(res?.data) ? res.data : [];
  } catch (err) {
    log('poll_failed', { stage: 'media', error: String(err) });
    await env.DB.batch([eventStmt(env, 'poll_failed', null, { stage: 'media', error: String(err) })]);
    return { error: String(err) };
  }
  for (const m of media) {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_MEDIA; page++) {
      try {
        const params: Record<string, string> = { fields: 'id,text,username,timestamp', limit: '50' };
        if (after) params.after = after;
        const res = await ig.get(`${m.id}/comments`, params);
        for (const c of Array.isArray(res?.data) ? res.data : []) {
          if (c && typeof c.id === 'string' && typeof c.username === 'string') {
            comments.push({ id: c.id, text: String(c.text ?? ''), username: c.username, mediaId: m.id });
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
  const healed = await healSnapshots(env);
  const summary = { media: media.length, comments: comments.length, fetches: ig.fetches, errors: errors.length, healed, ...report };
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
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value;
      if (ch?.field !== 'comments' || !v) continue;
      if (typeof v.id === 'string' && typeof v.from?.username === 'string') {
        comments.push({ id: v.id, text: String(v.text ?? ''), username: v.from.username, mediaId: String(v.media?.id ?? ''), igUserId: v.from.id ? String(v.from.id) : undefined });
      }
    }
    if (Array.isArray(entry?.messaging) && entry.messaging.length) {
      // TODO Phase 2 (needs instagram_business_manage_messages + Advanced Access): DM join.
      // DM payloads carry only sender.id (IGSID), not a username: look the user up
      // (GET /<IGSID>?fields=username), then joinMany([{ raw: username, source: 'dm', igUserId }])
      // and answer with one message (POST /<IG_USER_ID>/messages).
      log('ig_dm_ignored', { count: entry.messaging.length });
    }
  }
  try {
    const token = await getToken(env);
    const client = token ? new IgClient(env.IG_API_BASE, token) : undefined;
    const report = await processComments(env, comments, 'webhook', client);
    return json({ ok: true, ...report });
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
