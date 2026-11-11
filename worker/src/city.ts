// Residents + snapshots. D1 is the source of truth; `city_shards` holds pre-built compact JSON
// (Row[] per shard) so reads never touch the residents table and a join rewrites only one shard.
// CPU-light: no layout code here, only string/JSON work on at most a few shards.
import {
  PERK_BIT,
  cityDayAt,
  isValidHandle,
  normalizeHandle,
  shardOf,
  traitsFor,
  FORMAT,
  type Manifest,
  type Row,
} from '../../shared/residents-format.mjs';
import { type Env, log, packSize, shardSize } from './env';

export type JoinSource = 'comment' | 'webhook' | 'stripe' | 'admin' | 'dm';
export type JoinStatus = 'joined' | 'exists' | 'invalid' | 'abusive' | 'blocked';

export interface JoinRequest {
  raw: string;
  source: JoinSource;
  igUserId?: string;
  /** perk bitmask to start with (Stripe auto-join) */
  perks?: number;
}

export interface JoinResult {
  handle: string;
  status: JoinStatus;
  number?: number;
  row?: Row;
}

export type Perk = keyof typeof PERK_BIT;
export const isPerk = (p: unknown): p is Perk => typeof p === 'string' && Object.prototype.hasOwnProperty.call(PERK_BIT, p);

// Small built-in list; the `blocked` table covers the rest. Matched against the handle with . _ and
// digits removed. Kept short on purpose to avoid blocking innocent names (Scunthorpe problem).
const ABUSIVE = [
  'nigger', 'nigga', 'faggot', 'retard', 'rapist', 'hitler', 'kkk', 'cunt', 'whore', 'slut',
  'porn', 'fuck', 'shit', 'bitch', 'pussy', 'killyourself', 'onlyfans',
];
export function isAbusive(handle: string): boolean {
  const flat = handle.replace(/[._0-9]/g, '');
  return ABUSIVE.some((w) => flat.includes(w)) || /(^|[._])kys([._]|$)/.test(handle);
}

const MAX_PARAMS = 90; // D1 allows 100 bound parameters per statement
function chunks<T>(a: T[], n = MAX_PARAMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
const qs = (n: number) => new Array(n).fill('?').join(',');

interface ResidentRow {
  handle: string;
  number: number;
  joined_day: number;
  job: number;
  house_style: number;
  perks: number;
  level?: number;
  follower?: number;
}
export const toRow = (r: ResidentRow): Row => {
  const row: Row = [r.handle, r.number, r.joined_day, r.job, r.house_style, r.perks];
  const level = r.level ?? 0, follower = r.follower ? 1 : 0;
  if (level || follower) row.push(level); // optional tail, omitted when 0 (see shared/residents-format)
  if (follower) row.push(1);
  return row;
};
const RESIDENT_COLS = 'handle, number, joined_day, job, house_style, perks, level, follower';

const INSERT_RESIDENT = `
INSERT INTO residents (number, handle, joined_day, job, house_style, perks, source, ig_user_id)
SELECT COALESCE(l.number, 0) + 1, ?1, MAX(?2, COALESCE(l.joined_day, 1)), ?3, ?4, ?5, ?6, ?7
FROM (SELECT 1) AS one
LEFT JOIN (SELECT number, joined_day FROM residents ORDER BY number DESC LIMIT 1) AS l ON 1
WHERE NOT EXISTS (SELECT 1 FROM blocked WHERE handle = ?1)
ON CONFLICT(handle) DO NOTHING
RETURNING ${RESIDENT_COLS}`;

/** Validate a raw handle. Returns the normalized handle and a failure status, if any. */
export function checkHandle(raw: string): { handle: string; bad?: 'invalid' | 'abusive' } {
  const handle = normalizeHandle(raw);
  if (!isValidHandle(handle)) return { handle, bad: 'invalid' };
  if (isAbusive(handle)) return { handle, bad: 'abusive' };
  return { handle };
}

/**
 * Join many handles in two D1 round trips (one read batch, one transactional write batch).
 * Idempotent: existing residents are a no-op. Does NOT rewrite snapshots: pass the returned
 * rows to writeSnapshots() once per run.
 */
export async function joinMany(env: Env, reqs: JoinRequest[]): Promise<JoinResult[]> {
  const db = env.DB;
  const results: JoinResult[] = [];
  const pending = new Map<string, { req: JoinRequest; idx: number[] }>();
  for (const req of reqs) {
    const { handle, bad } = checkHandle(req.raw);
    results.push({ handle, status: bad ?? 'exists' });
    if (bad) continue;
    const p = pending.get(handle);
    if (p) p.idx.push(results.length - 1); // same handle twice in one batch: later ones are 'exists'
    else pending.set(handle, { req, idx: [results.length - 1] });
  }
  if (!pending.size) return results;

  const handles = [...pending.keys()];
  const reads: D1PreparedStatement[] = [];
  for (const c of chunks(handles)) {
    reads.push(db.prepare(`SELECT handle, number FROM residents WHERE handle IN (${qs(c.length)})`).bind(...c));
    reads.push(db.prepare(`SELECT handle FROM blocked WHERE handle IN (${qs(c.length)})`).bind(...c));
  }
  const readRes = await db.batch<{ handle: string; number?: number }>(reads);
  const existing = new Map<string, number>();
  const blocked = new Set<string>();
  readRes.forEach((r, i) => {
    for (const row of r.results) {
      if (i % 2 === 0) existing.set(row.handle, row.number!);
      else blocked.add(row.handle);
    }
  });

  const day = cityDayAt(env.CITY_FOUNDED_ISO);
  const toInsert: string[] = [];
  for (const [handle, { idx }] of pending) {
    const first = results[idx[0]];
    if (blocked.has(handle)) first.status = 'blocked';
    else if (existing.has(handle)) first.number = existing.get(handle);
    else toInsert.push(handle);
  }
  if (toInsert.length) {
    const stmts = toInsert.map((handle) => {
      const { req } = pending.get(handle)!;
      const t = traitsFor(handle);
      return db.prepare(INSERT_RESIDENT).bind(handle, day, t.job, t.houseStyle, req.perks ?? 0, req.source, req.igUserId ?? null);
    });
    const ins = await db.batch<ResidentRow>(stmts);
    ins.forEach((r, i) => {
      const handle = toInsert[i];
      const first = results[pending.get(handle)!.idx[0]];
      const row = r.results[0];
      if (row) {
        first.status = 'joined';
        first.number = row.number;
        first.row = toRow(row);
      } // else: lost a race with another invocation, or blocked meanwhile -> stays 'exists'
    });
  }
  for (const r of results) if (r.status === 'joined') log('join', { handle: r.handle, number: r.number });
  return results;
}

/** Set (or clear) a perk on an existing resident. Returns the updated row, or null if not a resident. */
export async function setPerk(env: Env, handle: string, perk: Perk, on = true): Promise<Row | null> {
  const bit = PERK_BIT[perk];
  const sql = on
    ? `UPDATE residents SET perks = perks | ?1 WHERE handle = ?2 RETURNING ${RESIDENT_COLS}`
    : `UPDATE residents SET perks = perks & ~?1 WHERE handle = ?2 RETURNING ${RESIDENT_COLS}`;
  const row = await env.DB.prepare(sql).bind(bit, handle).first<ResidentRow>();
  return row ? toRow(row) : null;
}

// ---------------------------------------------------------------- snapshots

const BUMP_REV = `UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'`;
const CUR_REV = `(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'rev')`;
const UPSERT_SHARD_IF = `
INSERT INTO city_shards (shard, rev, count, body, updated_at)
VALUES (?1, ${CUR_REV}, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
ON CONFLICT(shard) DO UPDATE SET rev = excluded.rev, count = excluded.count, body = excluded.body, updated_at = excluded.updated_at
WHERE city_shards.rev = ?4`;
const UPSERT_SHARD = `
INSERT INTO city_shards (shard, rev, count, body, updated_at)
VALUES (?1, ${CUR_REV}, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
ON CONFLICT(shard) DO UPDATE SET rev = excluded.rev, count = excluded.count, body = excluded.body, updated_at = excluded.updated_at`;

/**
 * Apply changed/new resident rows to their shards: read the affected shard bodies, patch them in
 * memory, write them back with one new city revision, all in one transactional batch (plus any
 * `extra` statements, e.g. processed-comment records). Optimistic: a shard changed by someone else
 * meanwhile, or a gap in numbers, triggers a rebuild of that shard from the residents table.
 */
export async function writeSnapshots(env: Env, rows: Row[], extra: D1PreparedStatement[] = []): Promise<{ rev: number; shards: number[] }> {
  const db = env.DB;
  const size = shardSize(env);
  const byShard = new Map<number, Row[]>();
  for (const row of rows) {
    const s = shardOf(row[1], size);
    (byShard.get(s) ?? byShard.set(s, []).get(s)!).push(row);
  }
  const ids = [...byShard.keys()];
  if (!ids.length) {
    if (extra.length) await db.batch(extra);
    return { rev: -1, shards: [] };
  }
  const cur = await db
    .prepare(`SELECT shard, rev, count, body FROM city_shards WHERE shard IN (${qs(ids.length)})`)
    .bind(...ids)
    .all<{ shard: number; rev: number; count: number; body: string }>();
  const have = new Map(cur.results.map((r) => [r.shard, r]));
  const rebuild = new Set<number>();
  const stmts: D1PreparedStatement[] = [db.prepare(BUMP_REV)];
  const written: number[] = [];
  for (const s of ids) {
    const old = have.get(s);
    let body: Row[];
    try {
      body = old ? (JSON.parse(old.body) as Row[]) : [];
    } catch {
      rebuild.add(s);
      continue;
    }
    const base = s * size;
    for (const row of byShard.get(s)!.sort((a, b) => a[1] - b[1])) {
      const i = row[1] - 1 - base;
      if (i < body.length) body[i] = row;
      else if (i === body.length) body.push(row);
      else { rebuild.add(s); break; }
    }
    if (rebuild.has(s)) continue;
    stmts.push(db.prepare(UPSERT_SHARD_IF).bind(s, body.length, JSON.stringify(body), old ? old.rev : -1));
    written.push(s);
  }
  stmts.push(...extra);
  const res = await db.batch(stmts);
  written.forEach((s, i) => { if (!res[i + 1].meta.changes) rebuild.add(s); });
  if (rebuild.size) await rebuildShards(env, [...rebuild]);
  const rev = await currentRev(env);
  return { rev, shards: ids };
}

async function currentRev(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT CAST(value AS INTEGER) AS rev FROM meta WHERE key = 'rev'`).first<{ rev: number }>();
  return r?.rev ?? 0;
}

/** Rebuild shards from the residents table (authoritative). ~shardSize rows read per shard. */
export async function rebuildShards(env: Env, ids: number[]): Promise<number[]> {
  const db = env.DB;
  const size = shardSize(env);
  if (!ids.length) return [];
  const reads = ids.map((s) =>
    db.prepare(`SELECT ${RESIDENT_COLS} FROM residents WHERE number BETWEEN ?1 AND ?2 ORDER BY number`).bind(s * size + 1, (s + 1) * size),
  );
  const res = await db.batch<ResidentRow>(reads);
  const stmts: D1PreparedStatement[] = [db.prepare(BUMP_REV)];
  const done: number[] = [];
  res.forEach((r, i) => {
    const s = ids[i];
    const rows = r.results.map(toRow);
    if (!rows.length) { stmts.push(db.prepare('DELETE FROM city_shards WHERE shard = ?1').bind(s)); return; }
    stmts.push(db.prepare(UPSERT_SHARD).bind(s, rows.length, JSON.stringify(rows)));
    done.push(s);
  });
  await db.batch(stmts);
  log('shards_rebuilt', { shards: ids });
  return done;
}

/** Resident count per the residents table vs. the snapshots; rebuild the tail if they disagree. */
export async function healSnapshots(env: Env): Promise<number[]> {
  const [mx, sh] = await env.DB.batch<{ n: number | null }>([
    env.DB.prepare('SELECT MAX(number) AS n FROM residents'),
    env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM city_shards'),
  ]);
  const total = mx.results[0]?.n ?? 0, snap = sh.results[0]?.n ?? 0;
  if (total === snap) return [];
  const size = shardSize(env);
  const from = shardOf(Math.max(1, Math.min(total, snap) + 1), size), to = shardOf(Math.max(1, total, snap), size);
  const ids: number[] = [];
  for (let s = from; s <= to; s++) ids.push(s);
  log('snapshots_heal', { total, snap, shards: ids });
  return rebuildShards(env, ids);
}

// ---------------------------------------------------------------- reads (public API)

export async function getManifest(env: Env): Promise<Manifest> {
  const [shards, meta] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT shard AS n, count, rev FROM city_shards ORDER BY shard'),
    env.DB.prepare(`SELECT key, value FROM meta WHERE key IN ('rev', 'demo')`),
  ]);
  const m = new Map(meta.results.map((r) => [r.key as string, String(r.value)]));
  const list = shards.results.map((r) => ({ n: Number(r.n), count: Number(r.count), rev: Number(r.rev) }));
  return {
    format: FORMAT,
    name: env.CITY_NAME,
    account: env.CITY_ACCOUNT,
    foundedISO: env.CITY_FOUNDED_ISO,
    seed: env.CITY_SEED,
    demo: m.get('demo') === 'true',
    count: list.reduce((a, s) => a + s.count, 0),
    rev: Number(m.get('rev') ?? 0),
    shardSize: shardSize(env),
    packSize: packSize(env),
    shards: list,
  };
}

/** Raw JSON bodies of shards from..to (inclusive), or null if any is missing. */
export async function getShardBodies(env: Env, from: number, to: number): Promise<{ bodies: string[]; rev: number } | null> {
  const r = await env.DB.prepare('SELECT shard, rev, body FROM city_shards WHERE shard BETWEEN ?1 AND ?2 ORDER BY shard')
    .bind(from, to)
    .all<{ shard: number; rev: number; body: string }>();
  if (r.results.length !== to - from + 1) return null;
  return { bodies: r.results.map((x) => x.body), rev: Math.max(...r.results.map((x) => x.rev)) };
}

/** Audit log statement (add it to a batch). */
export function eventStmt(env: Env, kind: string, handle: string | null, detail?: unknown): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO events (kind, handle, detail) VALUES (?1, ?2, ?3)').bind(
    kind,
    handle,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

/** Join one handle and publish it immediately (admin / webhook / Stripe paths). */
export async function joinOne(env: Env, req: JoinRequest): Promise<JoinResult> {
  const [r] = await joinMany(env, [req]);
  if (r.status === 'joined' && r.row) await writeSnapshots(env, [r.row], [eventStmt(env, 'join', r.handle, { source: req.source, number: r.number })]);
  else if (r.status !== 'exists') await env.DB.batch([eventStmt(env, 'join_rejected', r.handle, { source: req.source, status: r.status })]);
  return r;
}
