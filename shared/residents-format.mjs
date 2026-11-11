// Compact resident list for Kinsburg: what the Worker stores and serves, what the browser decodes.
// Plain ESM, no dependencies. Types: residents-format.d.mts.
//
// Wire format (format 1)
//   manifest  GET /api/city/manifest.json
//     { format: 1, name, account, foundedISO, seed, demo, count, rev, shardSize, packSize,
//       shards: [{ n, count, rev }] }
//   shard     GET /api/city/shard/<n>.json?v=<rev>         -> Row[]   (residents n*shardSize+1 ..)
//   pack      GET /api/city/pack/<a>-<b>.json?v=<maxRev>   -> Row[][] (shards a..b, b-a < packSize)
//   Row = [handle, number, joinedDay, jobIndex, houseStyle, perkMask]
//
// A resident's plot depends only on (seed, number), so the browser rebuilds the full CityData
// from this list with the shared layout engine (cityDataFromCompact).
import { buildCity, capacityFor, assignResidents, toCityData, hashString, mulberry32 } from './city-layout.mjs';

export const FORMAT = 1;
export const DEFAULT_SHARD_SIZE = 5000;
export const DEFAULT_PACK_SIZE = 10;

/** Mirror of JOBS in src/types.ts (same order; jobIndex points into it). */
export const JOBS = [
  'Baker', 'Barista', 'Teacher', 'Nurse', 'Florist', 'Carpenter', 'Librarian',
  'Fisher', 'Farmer', 'Painter', 'Musician', 'Mail carrier', 'Mechanic', 'Chef',
  'Gardener', 'Firefighter', 'Tailor', 'Shopkeeper', 'Beekeeper', 'Photographer',
  'Lighthouse keeper', 'Bus driver', 'Doctor', 'Coder', 'Architect', 'Potter',
];

/** Perk bit i = PERKS[i]: star 1, goldRoof 2, monument 4, street 8. */
export const PERKS = ['star', 'goldRoof', 'monument', 'street'];
export const PERK_BIT = { star: 1, goldRoof: 2, monument: 4, street: 8 };

export function perksToMask(perks) {
  let m = 0;
  for (const p of perks || []) if (PERK_BIT[p]) m |= PERK_BIT[p];
  return m;
}

export function maskToPerks(mask) {
  const out = [];
  for (let i = 0; i < PERKS.length; i++) if (mask & (1 << i)) out.push(PERKS[i]);
  return out;
}

// ---------------------------------------------------------------- handles

/** "@Some.Name " -> "some.name" (no validation). */
export function normalizeHandle(raw) {
  return String(raw ?? '').normalize('NFKC').trim().replace(/^@+/, '').trim().toLowerCase();
}

/** Instagram rules: 1-30 of [a-z0-9._], no leading/trailing ".", no "..". Expects a normalized handle. */
export function isValidHandle(h) {
  return typeof h === 'string' && /^[a-z0-9._]{1,30}$/.test(h) && !h.startsWith('.') && !h.endsWith('.') && !h.includes('..');
}

/**
 * True when a comment / DM asks to move in: "MOVE IN", "move in 🏠", "movein!", "Move-in please",
 * "𝐌𝐎𝐕𝐄 𝐈𝐍" (NFKC folds styled letters). "remove input" does not match.
 */
export function matchesMoveIn(text) {
  const t = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ');
  return /(^| )move ?in( |$)/.test(t);
}

/** Job and house style picked deterministically from the (lowercase) handle. */
export function traitsFor(handle) {
  const rng = mulberry32(hashString('kinsburg|traits|' + handle));
  const houseStyle = Math.floor(rng() * 12);
  let job;
  for (;;) {
    job = Math.floor(rng() * JOBS.length);
    const name = JOBS[job];
    if (name === 'Lighthouse keeper' && rng() > 0.1) continue; // only one lighthouse
    if (name === 'Architect' && rng() > 0.4) continue;
    break;
  }
  return { job, houseStyle };
}

/** City day (Day 1 = founding day, UTC) for a timestamp. */
export function cityDayAt(foundedISO, ms = Date.now()) {
  const start = Date.parse(foundedISO + 'T00:00:00Z');
  return Math.max(1, Math.floor((ms - start) / 86_400_000) + 1);
}

// ---------------------------------------------------------------- rows

/** Resident (src/types.ts shape, plotId ignored) -> Row. */
export function encodeResident(r) {
  const job = typeof r.job === 'number' ? r.job : JOBS.indexOf(r.job);
  if (job < 0) throw new Error(`unknown job ${r.job}`);
  return [r.handle, r.number, r.joinedDay, job, r.houseStyle, typeof r.perks === 'number' ? r.perks : perksToMask(r.perks)];
}

/** Row -> Resident without plotId. */
export function decodeRow(row) {
  const [handle, number, joinedDay, job, houseStyle, mask] = row;
  return { id: String(handle).toLowerCase(), handle, number, joinedDay, job: JOBS[job] ?? JOBS[0], houseStyle, perks: maskToPerks(mask) };
}

/** Shard index for a 1-based resident number. */
export function shardOf(number, shardSize = DEFAULT_SHARD_SIZE) {
  return Math.floor((number - 1) / shardSize);
}

/** Split an ordered resident list into shard bodies (Row[] per shard). */
export function encodeShards(residents, shardSize = DEFAULT_SHARD_SIZE) {
  const shards = [];
  residents.forEach((r, i) => {
    const s = Math.floor(i / shardSize);
    (shards[s] ||= []).push(encodeResident(r));
  });
  return shards;
}

/**
 * Plan the requests for a manifest: full shards are grouped into packs aligned to packSize
 * (rarely change, cached as immutable), the last, still-filling shard is fetched alone.
 * Returns [{ url, from, to, kind: 'pack' | 'shard' }].
 */
export function planRequests(manifest, base = '/api/city') {
  const shards = manifest.shards || [];
  const size = manifest.shardSize, pack = Math.max(1, manifest.packSize || 1);
  const out = [];
  const hot = shards.length && shards[shards.length - 1].count < size ? shards.length - 1 : shards.length;
  for (let a = 0; a < hot; a += pack) {
    const b = Math.min(hot, a + pack) - 1;
    if (a === b) { out.push({ kind: 'shard', from: a, to: a, url: `${base}/shard/${a}.json?v=${shards[a].rev}` }); continue; }
    let v = 0;
    for (let i = a; i <= b; i++) v = Math.max(v, shards[i].rev);
    out.push({ kind: 'pack', from: a, to: b, url: `${base}/pack/${a}-${b}.json?v=${v}` });
  }
  if (hot < shards.length) out.push({ kind: 'shard', from: hot, to: hot, url: `${base}/shard/${hot}.json?v=${shards[hot].rev}` });
  return out;
}

/** Check a manifest + its shard bodies (in shard order) and return the ordered Resident list. */
export function decodeShards(manifest, shardBodies) {
  if (!manifest || manifest.format !== FORMAT) throw new Error('unsupported manifest format');
  const residents = [];
  shardBodies.forEach((rows, s) => {
    const meta = manifest.shards[s];
    if (!Array.isArray(rows)) throw new Error(`shard ${s} is not a list`);
    if (meta && rows.length !== meta.count) throw new Error(`shard ${s} has ${rows.length} rows, manifest says ${meta.count}`);
    for (const row of rows) {
      const r = decodeRow(row);
      if (r.number !== residents.length + 1) throw new Error(`resident ${r.handle} has number ${r.number}, expected ${residents.length + 1}`);
      residents.push(r);
    }
  });
  if (residents.length !== manifest.count) throw new Error(`got ${residents.length} residents, manifest says ${manifest.count}`);
  return residents;
}

/** Build the full CityData (src/types.ts) from a manifest + ordered residents, using the layout engine. */
export function cityDataFromCompact(manifest, residents) {
  const city = buildCity({ seed: manifest.seed, capacity: capacityFor(residents.length) });
  const placed = assignResidents(city, residents);
  return toCityData(city, placed, { name: manifest.name, account: manifest.account, foundedISO: manifest.foundedISO, demo: !!manifest.demo });
}
