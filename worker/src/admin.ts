// Admin API, protected by `Authorization: Bearer <ADMIN_TOKEN>`.
//   POST /admin/join    { handle, source? }             add a resident (idempotent)
//   POST /admin/block   { handle, reason?, evict? }      block future joins; evict renames an existing
//                                                        resident to "vacant.lot.<n>" (plots never shift)
//   POST /admin/perk    { handle, perk, remove? }        star | goldRoof | monument | street
//   POST /admin/rebuild { shard? }                       rebuild snapshot shard(s) from the residents table
//   POST /admin/check-comments                           run the comment poller now (/admin/poll is the vote poll)
//   POST /admin/replies { dryRun?, max? }               reply to MOVE IN comments that were missed
//   POST /admin/reply   { commentId, message, queue? }   one hand-picked reply (daily cap, honours pauses);
//                                                        queue: true waits in the reply queue for the cron
//   GET  /admin/reply-queue                              queued and recent replies; POST .../flush sends now
//   POST /admin/builds  { run?, remove? }                list builds; run today's builds now; hide one
//   POST /admin/ig      { method, path, params } | { check } | { whoami } relay the daily Reel's Instagram calls
//   GET  /admin/cash | POST /admin/cash { amount, note }  city cash balance and ledger; add or remove money
//   GET  /admin/cast | POST /admin/cast { handle, remove? }   who may appear in videos (CAST ME)
//   GET  /admin/stats
import { shardOf } from '../../shared/residents-format.mjs';
import { RESIDENT_COLS, checkHandle, eventStmt, healSnapshots, isPerk, joinOne, rebuildShards, setPerk, toRow, writeSnapshots } from './city';
import { safeEqual } from './crypto';
import { type Env, json, shardSize } from './env';
import { flushReplyQueue, handReply, igRelay, queueReply, replyQueueStatus, pollComments, repliesAdmin } from './instagram';
import { buildsAdmin } from './builds';
import { putMedia } from './media';
import { townAdmin } from './town';
import { castAdmin } from './cast';
import { cashAdmin } from './cash';
import { lifeAdmin } from './life';
import { simAdmin } from './sim';
import { politicsAdmin } from './politics';
import { homesAdmin } from './homes';

export async function handleAdmin(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin disabled (set ADMIN_TOKEN)' }, 503);
  const auth = req.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) return json({ error: 'unauthorized' }, 401);

  if (req.method === 'GET' && path === '/admin/stats') return stats(env);
  if (req.method === 'GET' && path === '/admin/reply-queue') return json(await replyQueueStatus(env));
  if (req.method === 'POST' && path === '/admin/reply-queue/flush') return json(await flushReplyQueue(env));
  if (req.method === 'GET' && path === '/admin/sim') return (await simAdmin(env, req, path, null))!;
  if (req.method === 'GET' && path === '/admin/announcements') return (await politicsAdmin(env, req, path, null))!;
  if (req.method === 'GET' && path === '/admin/cast') return castAdmin(env, req, null);
  if (req.method === 'GET' && path === '/admin/cash') return cashAdmin(env, req, null);
  if (req.method === 'PUT' && path.startsWith('/admin/media/')) return putMedia(req, env, path);
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  let body: any;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  body ??= {};

  const life = await lifeAdmin(env, path, body);
  if (life) return life;
  const sim = await simAdmin(env, req, path, body);
  if (sim) return sim;
  const politics = await politicsAdmin(env, req, path, body);
  if (politics) return politics;
  const homes = await homesAdmin(env, path, body);
  if (homes) return homes;
  const town = await townAdmin(env, path, body);
  if (town) return town;

  switch (path) {
    case '/admin/join': {
      const r = await joinOne(env, { raw: String(body.handle ?? ''), source: 'admin' });
      const status = r.status === 'joined' || r.status === 'exists' ? 200 : r.status === 'blocked' ? 403 : 400;
      return json({ handle: r.handle, status: r.status, number: r.number ?? null }, status);
    }
    case '/admin/block': {
      const { handle } = checkHandle(String(body.handle ?? ''));
      if (!handle) return json({ error: 'handle required' }, 400);
      const stmts = [
        env.DB.prepare('INSERT INTO blocked (handle, reason) VALUES (?1, ?2) ON CONFLICT(handle) DO UPDATE SET reason = excluded.reason').bind(handle, body.reason ? String(body.reason) : null),
        eventStmt(env, 'block', handle, { reason: body.reason ?? null, evict: !!body.evict }),
      ];
      if (body.evict) {
        // Removing a resident would shift every later plot, so the slot stays and gets a neutral name.
        const row = await env.DB.prepare(
          `UPDATE residents SET handle = 'vacant.lot.' || number, perks = 0, pet = 0, pets_owned = 0, coins = 0, home = 0, home_no = NULL WHERE handle = ?1 RETURNING ${RESIDENT_COLS}`,
        ).bind(handle).first<any>();
        if (row) {
          await writeSnapshots(env, [toRow(row)], stmts);
          return json({ handle, blocked: true, evicted: row.number });
        }
      }
      await env.DB.batch(stmts);
      return json({ handle, blocked: true, evicted: null });
    }
    case '/admin/perk': {
      const { handle, bad } = checkHandle(String(body.handle ?? ''));
      if (bad) return json({ error: `handle ${bad}` }, 400);
      if (!isPerk(body.perk)) return json({ error: 'perk must be star | goldRoof | monument | street' }, 400);
      const row = await setPerk(env, handle, body.perk, !body.remove);
      if (!row) return json({ error: 'not a resident' }, 404);
      await writeSnapshots(env, [row], [eventStmt(env, 'perk', handle, { perk: body.perk, remove: !!body.remove, source: 'admin' })]);
      return json({ handle, perks: row[5], number: row[1] });
    }
    case '/admin/rebuild': {
      if (Number.isInteger(body.shard)) return json({ rebuilt: await rebuildShards(env, [body.shard]) });
      // Whole city: fine for small cities; past ~20k residents call it per shard to stay in 10 ms CPU.
      const max = await env.DB.prepare('SELECT MAX(number) AS n FROM residents').first<{ n: number | null }>();
      const last = max?.n ? shardOf(max.n, shardSize(env)) : -1;
      const ids: number[] = [];
      for (let s = 0; s <= last; s++) ids.push(s);
      await env.DB.prepare('DELETE FROM city_shards WHERE shard > ?1').bind(last).run();
      return json({ rebuilt: await rebuildShards(env, ids), healed: await healSnapshots(env) });
    }
    case '/admin/cash':
      return cashAdmin(env, req, body);
    case '/admin/cast':
      return castAdmin(env, req, body);
    case '/admin/check-comments':
      return json(await pollComments(env));
    case '/admin/replies':
      return json(await repliesAdmin(env, body));
    case '/admin/reply':
      return json(body?.queue ? await queueReply(env, body) : await handReply(env, body));
    case '/admin/builds':
      return json(await buildsAdmin(env, body));
    case '/admin/ig':
      return igRelay(env, body);
    default:
      return json({ error: 'not found' }, 404);
  }
}

async function stats(env: Env): Promise<Response> {
  const db = env.DB;
  const [res, shards, meta, blocked, processed, stripe, orders, events] = await db.batch<any>([
    db.prepare('SELECT MAX(number) AS residents FROM residents'),
    db.prepare('SELECT shard, rev, count, length(body) AS bytes, updated_at FROM city_shards ORDER BY shard'),
    db.prepare(`SELECT key, value FROM meta WHERE key IN ('rev', 'demo', 'ig_token_refreshed_at', 'ig_token_expires_at')`),
    db.prepare('SELECT COUNT(*) AS n FROM blocked'),
    db.prepare('SELECT result, COUNT(*) AS n FROM processed_comments GROUP BY result'),
    db.prepare('SELECT status, COUNT(*) AS n FROM stripe_events GROUP BY status'),
    db.prepare(`SELECT id, handle, item, status, at FROM orders WHERE status = 'new' ORDER BY id`),
    db.prepare('SELECT id, at, kind, handle, detail FROM events ORDER BY id DESC LIMIT 25'),
  ]);
  return json({
    residents: res.results[0]?.residents ?? 0,
    shards: shards.results,
    meta: Object.fromEntries(meta.results.map((r: any) => [r.key, r.value])),
    blocked: blocked.results[0]?.n ?? 0,
    processedComments: Object.fromEntries(processed.results.map((r: any) => [r.result, r.n])),
    stripeEvents: Object.fromEntries(stripe.results.map((r: any) => [r.status, r.n])),
    ordersToFulfil: orders.results,
    recentEvents: events.results,
  });
}
