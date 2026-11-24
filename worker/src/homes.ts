// Limited-edition homes: the first 100 people who comment "villa" get a villa, the first 100 who
// comment "skyscraper" (or "tower") get a skyscraper. It replaces the ordinary house on their own
// lot (addresses never change). One special home per person; someone new moves in straight into it.
import { HOMES, HOME_LIMIT, parseHomeCommand, type Row } from '../../shared/residents-format.mjs';
import type { HomeKind } from '../../src/types';
import { RESIDENT_COLS, checkHandle, eventStmt, joinMany, toRow, writeSnapshots } from './city';
import { type Env, json } from './env';
import type { IgComment } from './instagram';
import { announceStmt } from './politics';

const MAX_PARAMS = 90;
const qs = (n: number) => new Array(n).fill('?').join(',');

/**
 * Give `handle` the next numbered home of `kind`, if any are left and they don't have one yet.
 * One statement, so two claims can't take the same number (the unique index backs it up).
 */
const CLAIM = `
UPDATE residents SET home = ?2, home_no = (SELECT COALESCE(MAX(home_no), 0) + 1 FROM residents WHERE home = ?2)
WHERE handle = ?1 AND home = 0 AND (SELECT COUNT(*) FROM residents WHERE home = ?2) < ?3
RETURNING ${RESIDENT_COLS}`;

/** How many of each home exist (HOME_LIMIT; HOMES_LIMIT overrides it in tests). */
const limitOf = (env: Env, kind: HomeKind) => (Number(env.HOMES_LIMIT) > 0 ? Number(env.HOMES_LIMIT) : HOME_LIMIT[kind]);

export async function homeCounts(env: Env) {
  const r = await env.DB.prepare('SELECT home, COUNT(*) AS n FROM residents WHERE home > 0 GROUP BY home').all<{ home: number; n: number }>();
  const taken = Object.fromEntries(r.results.map((x) => [HOMES[x.home], x.n]));
  return {
    villa: { limit: limitOf(env, 'villa'), taken: taken.villa ?? 0 },
    skyscraper: { limit: limitOf(env, 'skyscraper'), taken: taken.skyscraper ?? 0 },
  };
}

export async function processHomeComments(env: Env, comments: IgComment[]) {
  const db = env.DB;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const report = { claimed: [] as string[], joined: [] as string[], soldOut: [] as string[], already: 0 };
  const cmds = new Map<string, { id: string; handle: string; kind: HomeKind }>();
  for (const c of comments) {
    if (!c.id || !c.username || c.username.toLowerCase() === own) continue;
    const kind = parseHomeCommand(c.text);
    if (!kind) continue;
    const { handle, bad } = checkHandle(c.username);
    if (!bad) cmds.set(c.id, { id: c.id, handle, kind });
  }
  if (!cmds.size) return report;
  const ids = [...cmds.keys()];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += MAX_PARAMS) {
    const c = ids.slice(i, i + MAX_PARAMS);
    const r = await db.prepare(`SELECT comment_id FROM homes_seen WHERE comment_id IN (${qs(c.length)})`).bind(...c).all<{ comment_id: string }>();
    for (const x of r.results) seen.add(x.comment_id);
  }
  // comments arrive oldest first: that's the queue order for the limited homes
  const fresh = ids.filter((id) => !seen.has(id)).map((id) => cmds.get(id)!);
  if (!fresh.length) return report;
  await db.batch(fresh.map((f) => db.prepare('INSERT INTO homes_seen (comment_id, handle) VALUES (?1, ?2) ON CONFLICT DO NOTHING').bind(f.id, f.handle)));

  // Someone who isn't a resident yet moves in first.
  const handles = [...new Set(fresh.map((f) => f.handle))];
  const known = new Set<string>();
  for (let i = 0; i < handles.length; i += MAX_PARAMS) {
    const c = handles.slice(i, i + MAX_PARAMS);
    const r = await db.prepare(`SELECT handle FROM residents WHERE handle IN (${qs(c.length)})`).bind(...c).all<{ handle: string }>();
    for (const x of r.results) known.add(x.handle);
  }
  const newcomers = handles.filter((h) => !known.has(h));
  if (newcomers.length) {
    const joined = await joinMany(env, newcomers.map((h) => ({ raw: h, source: 'comment' as const })));
    const rows: Row[] = [];
    for (const j of joined) if (j.status === 'joined') { report.joined.push(j.handle); if (j.row) rows.push(j.row); }
    if (rows.length) await writeSnapshots(env, rows);
  }

  const before = await homeCounts(env);
  const rows: Row[] = [];
  const extra: D1PreparedStatement[] = [];
  const done = new Set<string>();
  for (const f of fresh) {
    if (done.has(f.handle)) continue; // one special home per person, first comment wins
    done.add(f.handle);
    const idx = HOMES.indexOf(f.kind);
    const row = await db.prepare(CLAIM).bind(f.handle, idx, limitOf(env, f.kind)).first<any>();
    if (row) {
      rows.push(toRow(row));
      report.claimed.push(`${f.handle}:${f.kind}#${row.home_no}`);
      extra.push(eventStmt(env, 'home', f.handle, { kind: f.kind, no: row.home_no }));
    } else {
      const has = await db.prepare('SELECT home FROM residents WHERE handle = ?1').bind(f.handle).first<{ home: number }>();
      if (has && has.home > 0) report.already++;
      else report.soldOut.push(`${f.handle}:${f.kind}`);
    }
  }
  // Announce the moment an edition sells out.
  const after = await homeCounts(env);
  for (const kind of ['villa', 'skyscraper'] as const) {
    if (before[kind].taken < after[kind].limit && after[kind].taken >= after[kind].limit) {
      extra.push(announceStmt(env, kind === 'villa' ? `🏝️ All ${after[kind].limit} villas in Kinsburg are taken! Thank you, neighbours 💛` : `🏙️ All ${after[kind].limit} skyscrapers in Kinsburg are taken! What a skyline 💛`));
    }
  }
  if (rows.length) await writeSnapshots(env, rows, extra);
  else if (extra.length) await db.batch(extra);
  return report;
}

/** POST /admin/home { handle, home: 'villa' | 'skyscraper' | 'house' }: give one (within the limit) or take it back. */
export async function homesAdmin(env: Env, path: string, body: any): Promise<Response | null> {
  if (path !== '/admin/home') return null;
  const { handle, bad } = checkHandle(String(body?.handle ?? ''));
  if (bad || !handle) return json({ error: `handle ${bad ?? 'required'}` }, 400);
  const kind = String(body?.home ?? '');
  if (kind === 'house') {
    const row = await env.DB.prepare(`UPDATE residents SET home = 0, home_no = NULL WHERE handle = ?1 RETURNING ${RESIDENT_COLS}`).bind(handle).first<any>();
    if (!row) return json({ error: 'not a resident' }, 404);
    await writeSnapshots(env, [toRow(row)], [eventStmt(env, 'home_removed', handle, { source: 'admin' })]);
    return json({ handle, home: 'house' });
  }
  if (kind !== 'villa' && kind !== 'skyscraper') return json({ error: 'home must be villa, skyscraper or house' }, 400);
  const row = await env.DB.prepare(CLAIM).bind(handle, HOMES.indexOf(kind), limitOf(env, kind)).first<any>();
  if (!row) return json({ error: 'not a resident, already has a special home, or none left' }, 409);
  await writeSnapshots(env, [toRow(row)], [eventStmt(env, 'home', handle, { kind, no: row.home_no, source: 'admin' })]);
  return json({ handle, home: kind, no: row.home_no });
}
