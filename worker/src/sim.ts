// City simulation (phase 2). Runs every 15 minutes after the comment poller:
//   1. incidents past their deadline fail (a failed fire leaves storm-style damage to repair),
//   2. city stats drift toward what the staffing supports (see statTargets in shared/sim.mjs),
//   3. maybe a new incident starts somewhere in town.
// Residents answer by commenting RESPOND (or "on my way", "on duty"…). With no call for their
// job, RESPOND clocks them in for a paid shift instead (once a day). Rules live in shared/sim.mjs.
import { JOBS, cityDayAt, type Row } from '../../shared/residents-format.mjs';
import {
  COINS,
  INCIDENTS,
  INCIDENT_KINDS,
  OUTCOME,
  STATS,
  clampStat,
  matchesRespond,
  neededFor,
  statTargets,
  type IncidentKind,
  type Stat,
} from '../../shared/sim.mjs';
import { RESIDENT_COLS, checkHandle, eventStmt, toRow, writeSnapshots } from './city';
import { type Env, json, log } from './env';
import { announceStmt } from './politics';
import type { IgComment } from './instagram';

export interface SimState {
  health: number;
  safety: number;
  education: number;
  happiness: number;
  /** city treasury in town coins (grows with the town; phase 3 lets the mayor spend it) */
  treasury: number;
  lastTick: string | null;
}

const START: SimState = { health: 60, safety: 60, education: 60, happiness: 60, treasury: 0, lastTick: null };
const TICKS_PER_DAY = 96;
const DRIFT = 0.08; // share of the gap to the target closed each tick
const MAX_PARAMS = 90;
const qs = (n: number) => new Array(n).fill('?').join(',');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

interface IncidentRow {
  id: number;
  kind: IncidentKind;
  target: string | null;
  needed: number;
  status: 'open' | 'resolved' | 'failed';
  created_at: string;
  deadline: string;
  closed_at: string | null;
  cause: number | null;
}

export async function getState(env: Env): Promise<SimState> {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'sim'`).first<{ value: string }>();
  if (!r) return { ...START };
  try { return { ...START, ...JSON.parse(r.value) }; } catch { return { ...START }; }
}
export const putState = (env: Env, s: SimState) =>
  env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('sim', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(s));

function applyOutcome(s: SimState, kind: IncidentKind, won: boolean) {
  const o = OUTCOME[kind];
  s[o.stat] = clampStat(s[o.stat] + (won ? o.win : o.lose));
}

/** Rewrite snapshot rows for these residents (their coins changed). */
async function snapshot(env: Env, handles: string[], extra: D1PreparedStatement[] = []) {
  if (!handles.length) {
    if (extra.length) await env.DB.batch(extra);
    return;
  }
  const rows: Row[] = [];
  for (let i = 0; i < handles.length; i += MAX_PARAMS) {
    const c = handles.slice(i, i + MAX_PARAMS);
    const q = await env.DB.prepare(`SELECT ${RESIDENT_COLS} FROM residents WHERE handle IN (${qs(c.length)})`).bind(...c).all<any>();
    for (const r of q.results) rows.push(toRow(r));
  }
  await writeSnapshots(env, rows, extra);
}

// ---------------------------------------------------------------- tick

const EMOJI: Record<IncidentKind, string> = { fire: '🔥', burglary: '🚨', crash: '🚗', flu: '🤧', lostpet: '🐾', exam: '📚', repair: '🔨' };
const plural = (job: string, n: number) => (n === 1 ? job.toLowerCase() : job === 'Police officer' ? 'police officers' : job.toLowerCase() + 's');

/** "🔥 Kitchen fire at @sam's house! Firefighters: comment RESPOND (2 needed)." */
export function callText(kind: IncidentKind, target: string | null, needed: number) {
  const d = INCIDENTS[kind];
  const where = target ? ` at @${target}'s house` : kind === 'flu' ? ' at Kinsburg General' : kind === 'exam' ? ' at Kinsburg Elementary' : '';
  const jobs = d.jobs.map((j) => plural(j, 2));
  const who = jobs.length > 1 ? `${jobs.slice(0, -1).join(', ')} or ${jobs[jobs.length - 1]}` : jobs[0];
  return `${EMOJI[kind]} ${d.label}${where}! ${who[0].toUpperCase() + who.slice(1)}: comment RESPOND (${needed} needed).`;
}

/** Start an incident (also used by the admin endpoint). Picks a target house when needed. */
export async function startIncident(env: Env, kind: IncidentKind, opts: { target?: string | null; hours?: number; now?: number; cause?: number; residents?: number; quiet?: boolean } = {}) {
  const db = env.DB;
  const now = opts.now ?? Date.now();
  const def = INCIDENTS[kind];
  let target = opts.target ?? null;
  if (target === null && kind !== 'flu' && kind !== 'exam') {
    const sql = kind === 'lostpet'
      ? `SELECT handle FROM residents WHERE pet > 0 AND handle NOT LIKE 'vacant.lot.%' ORDER BY RANDOM() LIMIT 1`
      : `SELECT handle FROM residents WHERE handle NOT LIKE 'vacant.lot.%' AND handle <> ?1 AND handle NOT IN (SELECT target FROM incidents WHERE status = 'open' AND target IS NOT NULL) ORDER BY RANDOM() LIMIT 1`;
    const row = await (kind === 'lostpet' ? db.prepare(sql) : db.prepare(sql).bind(env.CITY_ACCOUNT.toLowerCase())).first<{ handle: string }>();
    if (!row) return null;
    target = row.handle;
  }
  const residents = opts.residents ?? (await db.prepare('SELECT COUNT(*) AS n FROM residents').first<{ n: number }>())?.n ?? 0;
  const needed = neededFor(kind, residents);
  const deadline = iso(now + (opts.hours ?? def.hours) * 3_600_000);
  const row = await db
    .prepare('INSERT INTO incidents (kind, target, needed, created_at, deadline, cause) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id')
    .bind(kind, target, needed, iso(now), deadline, opts.cause ?? null)
    .first<{ id: number }>();
  const stmts = [eventStmt(env, 'incident', target, { id: row?.id, kind, needed })];
  if (!opts.quiet) stmts.push(announceStmt(env, callText(kind, target, needed), deadline));
  await db.batch(stmts);
  return { id: row!.id, kind, target, needed, deadline };
}

/**
 * One simulation step. `rng` is injectable for tests; `force` starts an incident regardless of
 * chance. Cheap: a handful of small queries.
 */
export async function simTick(env: Env, { now = Date.now(), rng = Math.random, force = false }: { now?: number; rng?: () => number; force?: boolean } = {}) {
  const db = env.DB;
  const s = await getState(env);
  const nowIso = iso(now);
  const report = { failed: [] as string[], started: null as null | { id: number; kind: string; target: string | null }, stats: {} as Record<Stat, number> };

  // 1. deadlines (storm damage never fails: it waits for a carpenter)
  const due = (await db.prepare(`SELECT * FROM incidents WHERE status = 'open' AND kind <> 'repair' AND deadline <= ?1`).bind(nowIso).all<IncidentRow>()).results;
  const fail: D1PreparedStatement[] = [];
  for (const inc of due) {
    fail.push(db.prepare(`UPDATE incidents SET status = 'failed', closed_at = ?2 WHERE id = ?1 AND status = 'open'`).bind(inc.id, nowIso));
    fail.push(eventStmt(env, 'incident_failed', inc.target, { id: inc.id, kind: inc.kind }));
    applyOutcome(s, inc.kind, false);
    report.failed.push(`${inc.kind}#${inc.id}`);
  }
  if (fail.length) await db.batch(fail);
  for (const inc of due) if (inc.kind === 'fire' && inc.target) await startIncident(env, 'repair', { target: inc.target, now, cause: inc.id });

  // 2. stats drift toward what the town's staffing supports
  const weekAgo = iso(now - 7 * 86_400_000);
  const day = cityDayAt(env.CITY_FOUNDED_ISO, now);
  const [count, jobs, active, open] = await db.batch<any>([
    db.prepare(`SELECT COUNT(*) AS n, SUM(pet > 0) AS pets FROM residents WHERE handle NOT LIKE 'vacant.lot.%'`),
    db.prepare(`SELECT job, COUNT(*) AS n FROM residents WHERE handle NOT LIKE 'vacant.lot.%' GROUP BY job`),
    db.prepare(`SELECT res.job AS job, COUNT(DISTINCT res.handle) AS n FROM residents res
                WHERE res.handle IN (SELECT handle FROM responses WHERE at > ?1) OR res.handle IN (SELECT handle FROM shifts WHERE day > ?2)
                GROUP BY res.job`).bind(weekAgo, day - 7),
    db.prepare(`SELECT kind, COUNT(*) AS n FROM incidents WHERE status = 'open' GROUP BY kind`),
  ]);
  const residents = count.results[0]?.n ?? 0;
  const byJob = (rows: { job: number; n: number }[]) => Object.fromEntries(rows.map((r) => [JOBS[r.job], r.n]));
  const openBy = Object.fromEntries((open.results as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  const targets = statTargets({ residents, workers: byJob(jobs.results), active: byJob(active.results), pets: count.results[0]?.pets ?? 0, damaged: openBy.repair ?? 0 });
  for (const k of STATS) s[k] = Math.round((s[k] + (targets[k] - s[k]) * DRIFT) * 10) / 10;
  s.treasury = Math.round((s.treasury + residents * (2 / TICKS_PER_DAY)) * 100) / 100;

  // 3. maybe start something (more often in bigger towns, more of what the stats invite)
  const openTotal = Object.values(openBy).reduce((a: number, b) => a + (b as number), 0);
  const maxOpen = Math.min(6, 2 + Math.floor(residents / 150));
  const perDay = Math.min(8, 1.5 + residents / 60);
  const randomOn = env.SIM_RANDOM_INCIDENTS !== 'false';
  if (residents >= 3 && openTotal < maxOpen && (force || (randomOn && rng() < perDay / TICKS_PER_DAY))) {
    const staffed = new Set(Object.keys(byJob(jobs.results)));
    const weights = INCIDENT_KINDS.filter((k) => k !== 'repair').map((k) => {
      const d = INCIDENTS[k];
      let w = d.weight;
      const low = (stat: number) => (stat < 60 ? 1 + (60 - stat) / 30 : 1);
      if (k === 'burglary') w *= low(s.safety);
      if (k === 'flu' || k === 'crash') w *= low(s.health);
      if (k === 'exam') w *= low(s.education);
      if (!d.jobs.some((j) => staffed.has(j))) w *= 0.3; // mostly things someone can answer
      if (openBy[k]) w *= 0.3; // variety
      return [k, w] as const;
    });
    let roll = rng() * weights.reduce((a, [, w]) => a + w, 0);
    let kind: IncidentKind = weights[0][0];
    for (const [k, w] of weights) if ((roll -= w) <= 0) { kind = k; break; }
    const started = await startIncident(env, kind, { now, residents });
    if (started) report.started = { id: started.id, kind, target: started.target };
  }

  s.lastTick = nowIso;
  await db.batch([putState(env, s)]);
  report.stats = { health: s.health, safety: s.safety, education: s.education, happiness: s.happiness };
  log('sim_tick', report);
  return report;
}

// ---------------------------------------------------------------- RESPOND comments

export async function processSimComments(env: Env, comments: IgComment[], now = Date.now()) {
  const db = env.DB;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const report = { responded: [] as string[], resolved: [] as string[], shifts: [] as string[] };
  const byId = new Map<string, { id: string; handle: string }>();
  for (const c of comments) {
    if (!c.id || !c.username || c.username.toLowerCase() === own || !matchesRespond(c.text)) continue;
    const { handle, bad } = checkHandle(c.username);
    if (!bad) byId.set(c.id, { id: c.id, handle });
  }
  if (!byId.size) return report;
  const ids = [...byId.keys()];
  const seen = new Set<string>();
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += MAX_PARAMS) {
    const c = ids.slice(i, i + MAX_PARAMS);
    reads.push(db.prepare(`SELECT comment_id FROM sim_seen WHERE comment_id IN (${qs(c.length)})`).bind(...c));
  }
  for (const r of await db.batch<{ comment_id: string }>(reads)) for (const row of r.results) seen.add(row.comment_id);
  const fresh = ids.filter((id) => !seen.has(id)).map((id) => byId.get(id)!);
  if (!fresh.length) return report;

  const handles = [...new Set(fresh.map((f) => f.handle))];
  const jobOf = new Map<string, number>();
  for (let i = 0; i < handles.length; i += MAX_PARAMS) {
    const c = handles.slice(i, i + MAX_PARAMS);
    const q = await db.prepare(`SELECT handle, job FROM residents WHERE handle IN (${qs(c.length)})`).bind(...c).all<{ handle: string; job: number }>();
    for (const r of q.results) jobOf.set(r.handle, r.job);
  }
  const open = (await db.prepare(`SELECT * FROM incidents WHERE status = 'open' ORDER BY created_at, id`).all<IncidentRow>()).results;
  const count = new Map<number, Set<string>>();
  if (open.length) {
    const r = await db.prepare(`SELECT incident_id, handle FROM responses WHERE incident_id IN (${qs(open.length)})`).bind(...open.map((o) => o.id)).all<{ incident_id: number; handle: string }>();
    for (const o of open) count.set(o.id, new Set());
    for (const x of r.results) count.get(x.incident_id)?.add(x.handle);
  }

  const s = await getState(env);
  const day = cityDayAt(env.CITY_FOUNDED_ISO, now);
  const nowIso = iso(now);
  const stmts: D1PreparedStatement[] = fresh.map((f) => db.prepare('INSERT INTO sim_seen (comment_id, handle) VALUES (?1, ?2) ON CONFLICT(comment_id) DO NOTHING').bind(f.id, f.handle));
  const coins = new Map<string, number>();
  const shiftAsk: string[] = [];
  let stateChanged = false;
  for (const f of fresh) {
    const job = jobOf.get(f.handle);
    if (job === undefined) continue; // not a resident
    const jobName = JOBS[job];
    const inc = open.find((o) => (INCIDENTS[o.kind].jobs as readonly string[]).includes(jobName) && !count.get(o.id)!.has(f.handle) && count.get(o.id)!.size < o.needed);
    if (!inc) {
      shiftAsk.push(f.handle);
      continue;
    }
    const who = count.get(inc.id)!;
    who.add(f.handle);
    stmts.push(db.prepare('INSERT INTO responses (incident_id, handle, comment_id, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING').bind(inc.id, f.handle, f.id, nowIso));
    report.responded.push(`${f.handle}>${inc.kind}#${inc.id}`);
    if (who.size >= inc.needed) {
      inc.status = 'resolved';
      stmts.push(db.prepare(`UPDATE incidents SET status = 'resolved', closed_at = ?2 WHERE id = ?1 AND status = 'open'`).bind(inc.id, nowIso));
      stmts.push(eventStmt(env, 'incident_resolved', inc.target, { id: inc.id, kind: inc.kind, heroes: [...who] }));
      applyOutcome(s, inc.kind, true);
      stateChanged = true;
      const reward = inc.kind === 'repair' ? COINS.repair : COINS.respond;
      for (const h of who) coins.set(h, (coins.get(h) ?? 0) + reward);
      report.resolved.push(`${inc.kind}#${inc.id}`);
      open.splice(open.indexOf(inc), 1);
    }
  }
  // Shifts: one paid shift per person per city day. RETURNING tells us which rows are new.
  const shiftHandles = [...new Set(shiftAsk)];
  const base = stmts.length;
  for (const h of shiftHandles) stmts.push(db.prepare('INSERT INTO shifts (handle, day) VALUES (?1, ?2) ON CONFLICT DO NOTHING RETURNING handle').bind(h, day));
  const res = await db.batch<{ handle: string }>(stmts);
  for (let i = 0; i < shiftHandles.length; i++) {
    if (!res[base + i]?.results.length) continue; // already worked a shift today
    coins.set(shiftHandles[i], (coins.get(shiftHandles[i]) ?? 0) + COINS.duty);
    report.shifts.push(shiftHandles[i]);
  }
  const pay: D1PreparedStatement[] = [...coins].map(([h, c]) => db.prepare('UPDATE residents SET coins = coins + ?2 WHERE handle = ?1').bind(h, c));
  if (stateChanged) pay.push(putState(env, s));
  if (pay.length) await db.batch(pay);
  await snapshot(env, [...coins.keys()]);
  return report;
}

// ---------------------------------------------------------------- public view

const GROUPS: { key: string; title: string; jobs: string[] }[] = [
  { key: 'police', title: 'KPD officer of the week', jobs: ['Police officer'] },
  { key: 'fire', title: 'KFD firefighter of the week', jobs: ['Firefighter'] },
  { key: 'health', title: 'Medic of the week', jobs: ['Doctor', 'Nurse'] },
  { key: 'school', title: 'Teacher of the week', jobs: ['Teacher'] },
  { key: 'vet', title: 'Vet of the week', jobs: ['Vet'] },
  { key: 'build', title: 'Builder of the week', jobs: ['Carpenter'] },
];

/** The sim part of town.json: stats, what's happening now, the last few outcomes, the week's heroes. */
export async function getSim(env: Env, now = Date.now()) {
  const db = env.DB;
  const s = await getState(env);
  const [open, recent, week] = await db.batch<any>([
    db.prepare(`SELECT * FROM incidents WHERE status = 'open' ORDER BY created_at, id LIMIT 12`),
    db.prepare(`SELECT * FROM incidents WHERE status <> 'open' AND closed_at > ?1 ORDER BY closed_at DESC LIMIT 8`).bind(iso(now - 2 * 86_400_000)),
    db.prepare(`SELECT r.handle AS handle, res.job AS job, COUNT(*) AS n FROM responses r
                JOIN incidents i ON i.id = r.incident_id JOIN residents res ON res.handle = r.handle
                WHERE r.at > ?1 AND i.status = 'resolved' GROUP BY r.handle ORDER BY n DESC, MIN(r.at) LIMIT 60`).bind(iso(now - 7 * 86_400_000)),
  ]);
  const all = [...(open.results as IncidentRow[]), ...(recent.results as IncidentRow[])];
  const resp = new Map<number, string[]>();
  if (all.length) {
    const r = await db.prepare(`SELECT incident_id, handle FROM responses WHERE incident_id IN (${qs(all.length)}) ORDER BY at`).bind(...all.map((i) => i.id)).all<{ incident_id: number; handle: string }>();
    for (const x of r.results) (resp.get(x.incident_id) ?? resp.set(x.incident_id, []).get(x.incident_id)!).push(x.handle);
  }
  const pub = (i: IncidentRow) => ({
    id: i.id, kind: i.kind, label: INCIDENTS[i.kind]?.label ?? i.kind, target: i.target, needed: i.needed,
    status: i.status, createdAt: i.created_at, deadline: i.deadline, closedAt: i.closed_at, responders: resp.get(i.id) ?? [],
  });
  const ofTheWeek: { title: string; handle: string; count: number }[] = [];
  for (const g of GROUPS) {
    const top = (week.results as { handle: string; job: number; n: number }[]).find((r) => g.jobs.includes(JOBS[r.job]));
    if (top) ofTheWeek.push({ title: g.title, handle: top.handle, count: top.n });
  }
  return {
    stats: { health: Math.round(s.health), safety: Math.round(s.safety), education: Math.round(s.education), happiness: Math.round(s.happiness) },
    treasury: Math.floor(s.treasury),
    open: (open.results as IncidentRow[]).map(pub),
    recent: (recent.results as IncidentRow[]).map(pub),
    ofTheWeek,
  };
}

// ---------------------------------------------------------------- admin

/**
 * POST /admin/sim/tick  { force? }                  run one step now (force: start an incident)
 * POST /admin/sim/start { kind, target?, hours? }   start a specific incident
 * POST /admin/coins     { handle, add }             give (or with a negative number, take) town coins
 * GET  /admin/sim                                   same as the public view
 */
export async function simAdmin(env: Env, req: Request, path: string, body: any): Promise<Response | null> {
  if (path === '/admin/sim' && req.method === 'GET') return json(await getSim(env));
  if (req.method !== 'POST') return null;
  if (path === '/admin/sim/tick') return json(await simTick(env, { force: !!body?.force }));
  if (path === '/admin/coins') {
    const { handle, bad } = checkHandle(String(body?.handle ?? ''));
    const add = Math.trunc(Number(body?.add));
    if (bad || !handle || !Number.isFinite(add) || add === 0) return json({ error: 'need handle and a non-zero add' }, 400);
    const row = await env.DB.prepare(`UPDATE residents SET coins = MAX(0, coins + ?2) WHERE handle = ?1 RETURNING ${RESIDENT_COLS}`).bind(handle, add).first<any>();
    if (!row) return json({ error: 'not a resident' }, 404);
    await writeSnapshots(env, [toRow(row)], [eventStmt(env, 'coins', handle, { add, source: 'admin' })]);
    return json({ handle, coins: row.coins });
  }
  if (path === '/admin/sim/start') {
    const kind = String(body?.kind ?? '') as IncidentKind;
    if (!INCIDENT_KINDS.includes(kind)) return json({ error: `kind must be one of ${INCIDENT_KINDS.join(', ')}` }, 400);
    let target: string | null | undefined = undefined;
    if (body?.target) {
      const { handle, bad } = checkHandle(String(body.target));
      if (bad) return json({ error: `target ${bad}` }, 400);
      target = handle;
    }
    const hours = Number.isFinite(body?.hours) ? Number(body.hours) : undefined;
    const r = await startIncident(env, kind, { target, hours });
    return r ? json(r) : json({ error: 'no suitable house for that incident' }, 409);
  }
  return null;
}
