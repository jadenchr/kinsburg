// "Build what you ask" and bestie neighbours. Comment rules live in shared/builds.mjs.
//
// Build requests: each comment check records comments asking for something buildable, with their
// Instagram like counts. Once a day (after BUILD_HOUR_UTC) the most-liked kinds are built; the
// browser places build #id on build site #id, so nothing ever moves.
//
// Besties: "MOVE IN @friend" holds the next house plot for @friend for BESTIE_HOLD_DAYS. The held
// plot is a 'vacant.lot.<n>' resident row; when the friend comments MOVE IN, joinMany renames the
// row to them (claimHolds), so they live next door. The friend is never added without asking.
import { BESTIE_HOLD_DAYS, BUILDS_PER_DAY, BUILD_BY_KIND, REQUEST_DAYS, parseBuildRequest } from '../../shared/builds.mjs';
import { cityDayAt, traitsFor, type Row } from '../../shared/residents-format.mjs';
import { RESIDENT_COLS, eventStmt, toRow } from './city';
import { type Env, intVar, log } from './env';
import type { IgComment } from './instagram';

const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const qs = (n: number) => new Array(n).fill('?').join(',');

// ---------------------------------------------------------------- build requests

/** Record new build requests and refresh the like counts of open ones. */
export async function processBuildComments(env: Env, comments: IgComment[]) {
  const own = env.CITY_ACCOUNT.toLowerCase();
  const stmts: D1PreparedStatement[] = [];
  let found = 0;
  for (const c of comments) {
    if (!c.id || !c.username || c.username.toLowerCase() === own) continue;
    const kind = parseBuildRequest(c.text);
    if (!kind) continue;
    found++;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO build_requests (comment_id, media_id, handle, kind, likes) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(comment_id) DO UPDATE SET likes = excluded.likes WHERE build_requests.status = 'open'`,
      ).bind(c.id, c.mediaId, c.username.toLowerCase(), kind, Math.max(0, c.likes ?? 0)),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { requests: found };
}

/**
 * Once a city day, after BUILD_HOUR_UTC: build the most-liked requested kinds (ranked by the total
 * likes of their open requests, then by how many asked, then who asked first). Requests older than
 * REQUEST_DAYS drop out. Safe to call on every cron tick.
 */
export async function runDailyBuilds(env: Env, now = Date.now(), force = false) {
  const db = env.DB;
  const day = cityDayAt(env.CITY_FOUNDED_ISO, now);
  const done = await db.prepare(`SELECT value FROM meta WHERE key = 'builds_day'`).first<{ value: string }>();
  if (!force && (Number(done?.value) === day || new Date(now).getUTCHours() < intVar(env.BUILD_HOUR_UTC, 12))) return { built: [] as string[], skipped: true };

  await db.prepare(`UPDATE build_requests SET status = 'expired' WHERE status = 'open' AND created_at < ?1`).bind(iso(now - REQUEST_DAYS * 86400_000)).run();
  const top = (await db.prepare(
    `SELECT kind, SUM(likes) AS likes, COUNT(*) AS n, MIN(created_at) AS first FROM build_requests
     WHERE status = 'open' GROUP BY kind ORDER BY likes DESC, n DESC, first ASC LIMIT ?1`,
  ).bind(intVar(env.BUILDS_PER_DAY, BUILDS_PER_DAY)).all<{ kind: string; likes: number; n: number }>()).results;

  const built: string[] = [];
  for (const t of top) {
    if (!BUILD_BY_KIND[t.kind]) continue;
    const by = await db.prepare(
      `SELECT handle FROM build_requests WHERE status = 'open' AND kind = ?1 ORDER BY likes DESC, created_at ASC LIMIT 1`,
    ).bind(t.kind).first<{ handle: string }>();
    const row = await db.prepare(
      `INSERT INTO builds (kind, by_handle, day, likes, requests) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
    ).bind(t.kind, by?.handle ?? 'kinsburgtown', day, t.likes ?? 0, t.n).first<{ id: number }>();
    await db.batch([
      db.prepare(`UPDATE build_requests SET status = 'built', build_id = ?1 WHERE status = 'open' AND kind = ?2`).bind(row!.id, t.kind),
      eventStmt(env, 'build', by?.handle ?? null, { id: row!.id, kind: t.kind, likes: t.likes, requests: t.n }),
    ]);
    built.push(t.kind);
  }
  await db.prepare(`INSERT INTO meta (key, value) VALUES ('builds_day', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(day)).run();
  if (built.length) log('builds_done', { day, built });
  return { built, skipped: false };
}

/** What town.json shows: every build, open requests per kind, holds and besties. */
export async function getBuildsPublic(env: Env, now = Date.now()) {
  const db = env.DB;
  const [builds, requests, holds, besties] = await db.batch([
    db.prepare(`SELECT id, kind, by_handle AS by, day, likes FROM builds WHERE removed = 0 ORDER BY id LIMIT 2000`),
    db.prepare(
      `SELECT kind, SUM(likes) AS likes, COUNT(*) AS count FROM build_requests WHERE status = 'open' AND created_at >= ?1
       GROUP BY kind ORDER BY likes DESC, count DESC LIMIT 10`,
    ).bind(iso(now - REQUEST_DAYS * 86400_000)),
    db.prepare(`SELECT number, expires_at FROM bestie_holds WHERE status = 'held' AND expires_at > ?1 ORDER BY number`).bind(iso(now)),
    db.prepare(`SELECT a, b FROM besties ORDER BY created_at LIMIT 5000`),
  ]);
  return {
    builds: builds.results as Array<{ id: number; kind: string; by: string; day: number; likes: number }>,
    requests: requests.results as Array<{ kind: string; likes: number; count: number }>,
    holds: (holds.results as Array<{ number: number; expires_at: string }>).map((h) => ({
      number: h.number,
      days: Math.max(1, Math.ceil((Date.parse(h.expires_at) - now) / 86400_000)),
    })),
    besties: (besties.results as Array<{ a: string; b: string }>).map((p) => [p.a, p.b] as [string, string]),
  };
}

// ---------------------------------------------------------------- besties

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
export const bestiePairStmt = (env: Env, x: string, y: string) =>
  env.DB.prepare('INSERT OR IGNORE INTO besties (a, b) VALUES (?1, ?2)').bind(...pair(x, y));

// Built on demand: city.ts imports this module, so RESIDENT_COLS isn't ready at load time.
const insertHold = () => `
INSERT INTO residents (number, handle, joined_day, job, house_style, perks, source)
SELECT COALESCE(l.number, 0) + 1, 'vacant.lot.' || (COALESCE(l.number, 0) + 1), MAX(?1, COALESCE(l.joined_day, 1)), 0, 0, 0, 'hold'
FROM (SELECT 1) AS one
LEFT JOIN (SELECT number, joined_day FROM residents ORDER BY number DESC LIMIT 1) AS l ON 1
RETURNING ${RESIDENT_COLS}`;

export type BestieOutcome = 'held' | 'paired' | 'already-held' | 'blocked' | 'self' | 'not-new';

/**
 * After `by` moved in with "MOVE IN @friend": pair them if the friend already lives here,
 * otherwise hold the next plot for the friend. Call right after by's own join, before anyone
 * else joins, so the held plot is the one after theirs. Returns the hold's row to snapshot.
 */
export async function bestieAfterJoin(env: Env, by: string, friend: string, now = Date.now(), allowHold = true): Promise<{ outcome: BestieOutcome; row?: Row }> {
  const db = env.DB;
  if (friend === by) return { outcome: 'self' };
  const [resident, blocked, hold] = await db.batch([
    db.prepare('SELECT number FROM residents WHERE handle = ?1').bind(friend),
    db.prepare('SELECT 1 AS x FROM blocked WHERE handle = ?1').bind(friend),
    db.prepare(`SELECT number FROM bestie_holds WHERE for_handle = ?1 AND status = 'held' AND expires_at > ?2`).bind(friend, iso(now)),
  ]);
  if (blocked.results.length) return { outcome: 'blocked' };
  if (resident.results.length) {
    await db.batch([bestiePairStmt(env, by, friend), eventStmt(env, 'besties', by, { friend })]);
    return { outcome: 'paired' };
  }
  if (hold.results.length) return { outcome: 'already-held' }; // someone else is already saving them a spot
  if (!allowHold) return { outcome: 'not-new' };
  const day = cityDayAt(env.CITY_FOUNDED_ISO, now);
  const [ins] = await db.batch([
    db.prepare(insertHold()).bind(day),
    db.prepare(
      `INSERT INTO bestie_holds (number, for_handle, by_handle, expires_at)
       SELECT number, ?1, ?2, ?3 FROM residents ORDER BY number DESC LIMIT 1`,
    ).bind(friend, by, iso(now + BESTIE_HOLD_DAYS * 86400_000)),
    eventStmt(env, 'bestie_hold', by, { friend }),
  ]);
  const row = (ins.results[0] as any) ? toRow(ins.results[0] as any) : undefined;
  return { outcome: 'held', row };
}

/**
 * For joinMany: move handles that have a plot held for them onto it. Returns the handles claimed
 * (with their new rows); the rest join normally.
 */
export async function claimHolds(env: Env, handles: string[], source: string, now = Date.now()) {
  const db = env.DB;
  const claimed = new Map<string, Row>();
  if (!handles.length) return claimed;
  const holds = (await db.prepare(
    `SELECT number, for_handle, by_handle FROM bestie_holds WHERE status = 'held' AND expires_at > ?1 AND for_handle IN (${qs(handles.length)})`,
  ).bind(iso(now), ...handles.slice(0, 90)).all<{ number: number; for_handle: string; by_handle: string }>()).results;
  for (const h of holds) {
    const t = traitsFor(h.for_handle);
    // The lot name is built here: D1 binds JS numbers as REAL, so SQL 'vacant.lot.' || ?n would read "64.0".
    const upd = await db.prepare(
      `UPDATE residents SET handle = ?1, job = ?2, house_style = ?3, source = ?4, joined_day = MAX(joined_day, ?5)
       WHERE number = ?6 AND handle = ?7 RETURNING ${RESIDENT_COLS}`,
    ).bind(h.for_handle, t.job, t.houseStyle, source, cityDayAt(env.CITY_FOUNDED_ISO, now), h.number, `vacant.lot.${h.number}`).first<any>();
    if (!upd) {
      log('bestie_claim_missed', { number: h.number, handle: h.for_handle }); // lot no longer vacant: join normally
      continue;
    }
    await db.batch([
      db.prepare(`UPDATE bestie_holds SET status = 'claimed' WHERE number = ?1`).bind(h.number),
      bestiePairStmt(env, h.by_handle, h.for_handle),
      eventStmt(env, 'bestie_claimed', h.for_handle, { number: h.number, by: h.by_handle }),
    ]);
    claimed.set(h.for_handle, toRow(upd));
  }
  return claimed;
}

/** Holds past their date lapse; the lot stays vacant (addresses never move). */
export async function lapseHolds(env: Env, now = Date.now()) {
  const r = await env.DB.prepare(`UPDATE bestie_holds SET status = 'lapsed' WHERE status = 'held' AND expires_at <= ?1`).bind(iso(now)).run();
  return r.meta?.changes ?? 0;
}

// ---------------------------------------------------------------- admin

/** POST /admin/builds { run?: true, remove?: id } */
export async function buildsAdmin(env: Env, body: any) {
  if (body?.remove) {
    await env.DB.prepare('UPDATE builds SET removed = 1 WHERE id = ?1').bind(Number(body.remove)).run();
    return { removed: Number(body.remove) };
  }
  const run = body?.run ? await runDailyBuilds(env, Date.now(), true) : null;
  return { run, ...(await getBuildsPublic(env)) };
}
