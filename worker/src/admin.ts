// Admin API, protected by `Authorization: Bearer <ADMIN_TOKEN>`.
//   POST /admin/join    { handle, source? }             add a resident (idempotent)
//   POST /admin/block   { handle, reason?, evict? }      block future joins; evict renames an existing
//                                                        resident to "vacant.lot.<n>" (plots never shift)
//   POST /admin/perk    { handle, perk, remove? }        star | goldRoof | monument | street
//   POST /admin/rebuild { shard? }                       rebuild snapshot shard(s) from the residents table
//   POST /admin/poll                                     run the comment poller now
//   GET  /admin/stats
import { shardOf } from '../../shared/residents-format.mjs';
import { checkHandle, eventStmt, healSnapshots, isPerk, joinOne, rebuildShards, setPerk, toRow, writeSnapshots } from './city';
import { safeEqual } from './crypto';
import { type Env, json, shardSize } from './env';
import { pollComments } from './instagram';
import { putMedia } from './media';

export async function handleAdmin(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin disabled (set ADMIN_TOKEN)' }, 503);
  const auth = req.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) return json({ error: 'unauthorized' }, 401);

  if (req.method === 'GET' && path === '/admin/stats') return stats(env);
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
          `UPDATE residents SET handle = 'vacant.lot.' || number, perks = 0 WHERE handle = ?1 RETURNING handle, number, joined_day, job, house_style, perks`,
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
    case '/admin/poll':
      return json(await pollComments(env));
    default:
      return json({ error: 'not found' }, 404);
  }
}

async function stats(env: Env): Promise<Response> {
  const db = env.DB;
  const [res, shards, meta, blocked, processed, stripe, events] = await db.batch<any>([
    db.prepare('SELECT MAX(number) AS residents FROM residents'),
    db.prepare('SELECT shard, rev, count, length(body) AS bytes, updated_at FROM city_shards ORDER BY shard'),
    db.prepare(`SELECT key, value FROM meta WHERE key IN ('rev', 'demo', 'ig_token_refreshed_at', 'ig_token_expires_at')`),
    db.prepare('SELECT COUNT(*) AS n FROM blocked'),
    db.prepare('SELECT result, COUNT(*) AS n FROM processed_comments GROUP BY result'),
    db.prepare('SELECT status, COUNT(*) AS n FROM stripe_events GROUP BY status'),
    db.prepare('SELECT id, at, kind, handle, detail FROM events ORDER BY id DESC LIMIT 25'),
  ]);
  return json({
    residents: res.results[0]?.residents ?? 0,
    shards: shards.results,
    meta: Object.fromEntries(meta.results.map((r: any) => [r.key, r.value])),
    blocked: blocked.results[0]?.n ?? 0,
    processedComments: Object.fromEntries(processed.results.map((r: any) => [r.result, r.n])),
    stripeEvents: Object.fromEntries(stripe.results.map((r: any) => [r.status, r.n])),
    recentEvents: events.results,
  });
}
