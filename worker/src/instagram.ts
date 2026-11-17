// Instagram API (graph.facebook.com with a Business Manager system-user token from Meta's Unified
// login, or graph.instagram.com with an Instagram Login token): comment poller, comments webhook,
// optional public replies, token refresh (Instagram Login tokens only). IG_API_BASE is configurable so tests can
// point at a local mock.
import { matchesMoveIn } from '../../shared/residents-format.mjs';
import { eventStmt, joinMany, writeSnapshots, healSnapshots, type JoinResult, type JoinSource } from './city';
import { verifyMetaSignature } from './crypto';
import { closeDuePolls, handleDms, privateReply, processTownComments } from './town';
import { processCastComments } from './cast';
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
      throw new IgError(res.status, `${method} ${path}: ${res.status} ${data?.error?.message ?? text.slice(0, 120)}`);
    }
    return data;
  }

  get(path: string, params: Record<string, string> = {}) { return this.call('GET', path, params); }
  post(path: string, params: Record<string, string> = {}) { return this.call('POST', path, params); }
}

// ---------------------------------------------------------------- shared comment pipeline

// Line 1 of the welcome reply. Links in Instagram comments aren't tappable, so the house link
// lives in the bio; {n} is the resident number.
const REPLIES = [
  'Welcome to Kinsburg, neighbour #{n}! 🏡',
  'You live here now ✨ #{n}',
  'Keys are ready 🔑 House #{n} is yours',
  'Built! 🏠 Welcome home, #{n}',
  'Your house is up 🏡 #{n}',
  'Fresh paint, new neighbour 🎨 #{n}',
];

// A gentle reason to follow, never a condition (Instagram forbids rewarding follows).
const FOLLOW_NUDGES = [
  'Follow to watch your street light up 🌙',
  'Follow to catch your house in a Reel 🎬',
  'Follow to see the town grow ✨',
];

function replyText(_env: Env, handle: string, n: number | undefined): string {
  const i = n ?? handle.length;
  const greeting = REPLIES[i % REPLIES.length];
  const line1 = n ? greeting.replace('{n}', String(n)) : greeting.replace(/,? ?(House )?#\{n\}( is yours)?/, '');
  const nudge = FOLLOW_NUDGES[Math.floor(i / REPLIES.length) % FOLLOW_NUDGES.length];
  return `${line1}\n${nudge}`;
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
    if (r.status === 'joined' && env.IG_PRIVATE_REPLY_ENABLED === 'true' && client) {
      try {
        await privateReply(env, client, fresh[i].id, r.handle, r.number);
      } catch (err) {
        log('private_reply_failed', { comment: fresh[i].id, error: String(err) });
      }
    }
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
  const town = await processTownComments(env, comments);
  const cast = await processCastComments(env, comments);
  const closed = await closeDuePolls(env);
  const healed = await healSnapshots(env);
  const summary = { media: media.length, comments: comments.length, fetches: ig.fetches, errors: errors.length, healed, town, cast: cast.cast, pollsClosed: closed, ...report };
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
    const dms = messaging.length ? await handleDms(env, client, messaging) : null;
    return json({ ok: true, ...report, town, cast: cast.cast, dms });
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
