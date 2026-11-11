// Kinsburg Worker. Static files (dist/) are served by Workers Static Assets before this code runs;
// only unmatched paths reach fetch() below:
//   GET  /api/city/manifest.json          compact manifest (max-age=60 + edge cache)
//   GET  /api/city/shard/<n>.json?v=rev   one shard, Row[] (immutable when v matches)
//   GET  /api/city/pack/<a>-<b>.json?v=   shards a..b as Row[][] (immutable when v matches)
//   GET|POST /webhooks/instagram          Meta webhook (verify handshake + signed comments)
//   POST /webhooks/stripe                 Stripe checkout.session.completed -> perk
//   GET  /media/<file>                    daily Reel MP4 / cover JPG (uploaded via PUT /admin/media/<file>)
//   /admin/*                              see admin.ts
// Cron: comment poller every 15 min, weekly token refresh.
import { handleAdmin } from './admin';
import { getManifest, getShardBodies } from './city';
import { type Env, json, log, packSize } from './env';
import { handleInstagramWebhook, pollComments, refreshToken } from './instagram';
import { handleStripeWebhook } from './stripe';
import { serveMedia } from './media';

const SHORT = 'public, max-age=60';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const CORS = { 'access-control-allow-origin': '*' };

/** Serve from the colo's Cache API when possible (no-op on *.workers.dev; works on a custom domain). */
async function edgeCached(req: Request, env: Env, ctx: ExecutionContext, key: string, build: () => Promise<Response>): Promise<Response> {
  if (env.EDGE_CACHE === 'false') return withConditional(req, await build());
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(key, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return withConditional(req, hit);
  const res = await build();
  if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withConditional(req, res);
}

function withConditional(req: Request, res: Response): Response {
  const etag = res.headers.get('etag');
  if (etag && req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: res.headers });
  return res;
}

function body(text: string, cacheControl: string, etag?: string): Response {
  const h: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl, ...CORS };
  if (etag) h.etag = etag;
  return new Response(text, { status: 200, headers: h });
}

async function cityApi(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const p = url.pathname;
  const v = url.searchParams.get('v');
  if (p === '/api/city/manifest.json') {
    return edgeCached(req, env, ctx, `${url.origin}${p}`, async () => {
      const m = await getManifest(env);
      return body(JSON.stringify(m), SHORT, `"m${m.rev}-${m.count}"`);
    });
  }
  let m = /^\/api\/city\/shard\/(\d+)\.json$/.exec(p);
  if (m) {
    const n = Number(m[1]);
    return edgeCached(req, env, ctx, `${url.origin}${p}?v=${v ?? ''}`, async () => {
      const s = await getShardBodies(env, n, n);
      if (!s) return json({ error: 'no such shard' }, 404, CORS);
      return body(s.bodies[0], v === String(s.rev) ? IMMUTABLE : SHORT, `"s${n}-${s.rev}"`);
    });
  }
  m = /^\/api\/city\/pack\/(\d+)-(\d+)\.json$/.exec(p);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (b < a || b - a >= packSize(env)) return json({ error: `pack must span 1..${packSize(env)} shards` }, 400, CORS);
    return edgeCached(req, env, ctx, `${url.origin}${p}?v=${v ?? ''}`, async () => {
      const s = await getShardBodies(env, a, b);
      if (!s) return json({ error: 'no such shards' }, 404, CORS);
      return body(`[${s.bodies.join(',')}]`, v === String(s.rev) ? IMMUTABLE : SHORT, `"p${a}-${b}-${s.rev}"`);
    });
  }
  return json({ error: 'not found' }, 404, CORS);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/api/city/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
        return await cityApi(req, env, ctx, url);
      }
      if (p.startsWith('/media/')) return await serveMedia(req, env, p);
      if (p === '/webhooks/instagram') return await handleInstagramWebhook(req, env);
      if (p === '/webhooks/stripe') return await handleStripeWebhook(req, env);
      if (p.startsWith('/admin/')) return await handleAdmin(req, env, p);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      log('request_failed', { path: p, error: String(err) });
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(controller, env): Promise<void> {
    try {
      if (controller.cron === '41 3 * * 1') await refreshToken(env);
      else await pollComments(env);
    } catch (err) {
      log('cron_failed', { cron: controller.cron, error: String(err) });
    }
  },
} satisfies ExportedHandler<Env>;
