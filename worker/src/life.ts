// City life, phase 1: residents pick their job ("JOB DOCTOR", once a week) and a pet ("PET DOG").
// Free pets (dog, cat, bunny) need nothing; rare pets (fox, owl, golden) must be bought first
// (Stripe perk "pet:fox" or POST /admin/pet). Someone who isn't a resident yet moves in with it.
import {
  JOBS,
  PETS,
  RARE_PETS,
  cityDayAt,
  parseJobCommand,
  parsePetCommand,
  petBit,
  type Row,
} from '../../shared/residents-format.mjs';
import { PET_COIN_PRICE } from '../../shared/sim.mjs';
import type { Pet } from '../../src/types';
import { RESIDENT_COLS, checkHandle, eventStmt, joinMany, toRow, writeSnapshots } from './city';
import { type Env, json } from './env';
import type { IgComment } from './instagram';

/** Days between job changes (the first choice is always allowed). */
export const JOB_CHANGE_DAYS = 7;

interface Wish {
  job: number | null;
  pet: Pet | 'none' | null;
  commentIds: string[];
}

interface LifeRow {
  handle: string;
  job: number;
  job_changed_day: number | null;
  pet: number;
  pets_owned: number;
  coins: number;
}

const MAX_PARAMS = 90;
const qs = (n: number) => new Array(n).fill('?').join(',');

export async function processLifeComments(env: Env, comments: IgComment[]) {
  const db = env.DB;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const report = { jobs: [] as string[], pets: [] as string[], joined: [] as string[], tooSoon: [] as string[], locked: [] as string[] };

  const cmds = new Map<string, { c: IgComment; handle: string; job: number | null; pet: Pet | 'none' | null }>();
  for (const c of comments) {
    if (!c.id || !c.username || c.username.toLowerCase() === own) continue;
    const job = parseJobCommand(c.text);
    const pet = parsePetCommand(c.text);
    if (job === null && pet === null) continue;
    const { handle, bad } = checkHandle(c.username);
    if (!bad) cmds.set(c.id, { c, handle, job, pet });
  }
  if (!cmds.size) return report;

  // Skip comments handled by an earlier run.
  const ids = [...cmds.keys()];
  const seen = new Set<string>();
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += MAX_PARAMS) {
    const c = ids.slice(i, i + MAX_PARAMS);
    reads.push(db.prepare(`SELECT comment_id FROM life_seen WHERE comment_id IN (${qs(c.length)})`).bind(...c));
  }
  for (const r of await db.batch<{ comment_id: string }>(reads)) for (const row of r.results) seen.add(row.comment_id);
  const fresh = ids.filter((id) => !seen.has(id)).map((id) => cmds.get(id)!);
  if (!fresh.length) return report;

  // One wish per person: their latest job and latest pet in this batch (comments arrive oldest first).
  const wishes = new Map<string, Wish>();
  for (const f of fresh) {
    const w = wishes.get(f.handle) ?? { job: null, pet: null, commentIds: [] };
    if (f.job !== null) w.job = f.job;
    if (f.pet !== null) w.pet = f.pet;
    w.commentIds.push(f.c.id);
    wishes.set(f.handle, w);
  }

  const handles = [...wishes.keys()];
  const load = async () => {
    const out = new Map<string, LifeRow>();
    const rr: D1PreparedStatement[] = [];
    for (let i = 0; i < handles.length; i += MAX_PARAMS) {
      const c = handles.slice(i, i + MAX_PARAMS);
      rr.push(db.prepare(`SELECT handle, job, job_changed_day, pet, pets_owned, coins FROM residents WHERE handle IN (${qs(c.length)})`).bind(...c));
    }
    for (const r of await db.batch<LifeRow>(rr)) for (const x of r.results) out.set(x.handle, x);
    return out;
  };
  let residents = await load();

  // A JOB or PET comment from someone without a house moves them in first.
  const newcomers = handles.filter((h) => !residents.has(h));
  if (newcomers.length) {
    const joined = await joinMany(env, newcomers.map((h) => ({ raw: h, source: 'comment' as const })));
    for (const j of joined) if (j.status === 'joined') report.joined.push(j.handle);
    residents = await load();
  }

  const day = cityDayAt(env.CITY_FOUNDED_ISO);
  const stmts: D1PreparedStatement[] = [];
  const changed = new Set<string>();
  for (const f of fresh) stmts.push(db.prepare('INSERT INTO life_seen (comment_id, handle) VALUES (?1, ?2) ON CONFLICT(comment_id) DO NOTHING').bind(f.c.id, f.handle));
  for (const [handle, w] of wishes) {
    const r = residents.get(handle);
    if (!r) continue; // blocked or invalid: nothing to change
    if (w.job !== null && w.job !== r.job) {
      if (r.job_changed_day === null || day - r.job_changed_day >= JOB_CHANGE_DAYS) {
        stmts.push(db.prepare('UPDATE residents SET job = ?2, job_changed_day = ?3 WHERE handle = ?1').bind(handle, w.job, day));
        stmts.push(eventStmt(env, 'job', handle, { from: JOBS[r.job], to: JOBS[w.job] }));
        report.jobs.push(`${handle}:${JOBS[w.job]}`);
        changed.add(handle);
      } else {
        report.tooSoon.push(handle);
        stmts.push(eventStmt(env, 'job_too_soon', handle, { wanted: JOBS[w.job], nextDay: r.job_changed_day + JOB_CHANGE_DAYS }));
      }
    }
    if (w.pet !== null) {
      const idx = w.pet === 'none' ? 0 : PETS.indexOf(w.pet);
      const allowed = idx === 0 || !RARE_PETS.includes(w.pet as Pet) || (r.pets_owned & petBit(w.pet as Pet)) !== 0;
      if (!allowed && r.coins >= PET_COIN_PRICE) {
        // bought with town coins (the WHERE re-checks the balance)
        stmts.push(db.prepare('UPDATE residents SET coins = coins - ?2, pets_owned = pets_owned | ?3, pet = ?4 WHERE handle = ?1 AND coins >= ?2').bind(handle, PET_COIN_PRICE, petBit(w.pet as Pet), idx));
        stmts.push(eventStmt(env, 'pet_bought', handle, { pet: w.pet, source: 'coins', price: PET_COIN_PRICE }));
        report.pets.push(`${handle}:${w.pet}`);
        changed.add(handle);
      } else if (!allowed) {
        report.locked.push(`${handle}:${w.pet}`);
        stmts.push(eventStmt(env, 'pet_locked', handle, { pet: w.pet }));
      } else if (idx !== r.pet) {
        stmts.push(db.prepare('UPDATE residents SET pet = ?2 WHERE handle = ?1').bind(handle, idx));
        stmts.push(eventStmt(env, 'pet', handle, { pet: w.pet }));
        report.pets.push(`${handle}:${w.pet}`);
        changed.add(handle);
      }
    }
  }
  await db.batch(stmts);
  await snapshot(env, [...changed]);
  return report;
}

/** Rewrite the snapshot rows of these residents (after their job or pet changed). */
async function snapshot(env: Env, handles: string[]) {
  if (!handles.length) return;
  const rows: Row[] = [];
  for (let i = 0; i < handles.length; i += MAX_PARAMS) {
    const c = handles.slice(i, i + MAX_PARAMS);
    const q = await env.DB.prepare(`SELECT ${RESIDENT_COLS} FROM residents WHERE handle IN (${qs(c.length)})`).bind(...c).all<any>();
    for (const r of q.results) rows.push(toRow(r));
  }
  await writeSnapshots(env, rows);
}

/** Give someone a rare pet they paid for (and put it in their yard). Moves them in if needed. */
export async function grantPet(env: Env, handle: string, pet: Pet, source: string): Promise<Row | null> {
  const [j] = await joinMany(env, [{ raw: handle, source: 'stripe' }]);
  if (j.status !== 'joined' && j.status !== 'exists') return null;
  const idx = PETS.indexOf(pet);
  const row = await env.DB.prepare(`UPDATE residents SET pets_owned = pets_owned | ?2, pet = ?3 WHERE handle = ?1 RETURNING ${RESIDENT_COLS}`)
    .bind(j.handle, petBit(pet), idx).first<any>();
  if (!row) return null;
  const r = toRow(row);
  await writeSnapshots(env, [r], [eventStmt(env, 'pet_bought', j.handle, { pet, source })]);
  return r;
}

/**
 * POST /admin/pet { handle, pet, own? }  set a pet (own: true also unlocks a rare one, e.g. a manual sale)
 * POST /admin/job { handle, job }        set a job by name, ignoring the weekly limit
 */
export async function lifeAdmin(env: Env, path: string, body: any): Promise<Response | null> {
  if (path !== '/admin/pet' && path !== '/admin/job') return null;
  const { handle, bad } = checkHandle(String(body?.handle ?? ''));
  if (bad || !handle) return json({ error: `handle ${bad ?? 'required'}` }, 400);
  if (path === '/admin/pet') {
    const pet = String(body?.pet ?? '');
    const idx = (PETS as readonly string[]).indexOf(pet);
    if (idx < 0) return json({ error: `pet must be one of ${PETS.join(', ')}` }, 400);
    if (body?.own && RARE_PETS.includes(pet as Pet)) {
      const row = await grantPet(env, handle, pet as Pet, 'admin');
      return row ? json({ handle, pet, owned: true }) : json({ error: 'could not move them in' }, 400);
    }
    const row = await env.DB.prepare(`UPDATE residents SET pet = ?2 WHERE handle = ?1 RETURNING ${RESIDENT_COLS}`).bind(handle, idx).first<any>();
    if (!row) return json({ error: 'not a resident' }, 404);
    await writeSnapshots(env, [toRow(row)], [eventStmt(env, 'pet', handle, { pet, source: 'admin' })]);
    return json({ handle, pet });
  }
  const job = (JOBS as readonly string[]).indexOf(String(body?.job ?? ''));
  if (job < 0) return json({ error: `job must be one of ${JOBS.join(', ')}` }, 400);
  const row = await env.DB.prepare(`UPDATE residents SET job = ?2, job_changed_day = ?3 WHERE handle = ?1 RETURNING ${RESIDENT_COLS}`)
    .bind(handle, job, cityDayAt(env.CITY_FOUNDED_ISO)).first<any>();
  if (!row) return json({ error: 'not a resident' }, 404);
  await writeSnapshots(env, [toRow(row)], [eventStmt(env, 'job', handle, { to: JOBS[job], source: 'admin' })]);
  return json({ handle, job: JOBS[job] });
}
