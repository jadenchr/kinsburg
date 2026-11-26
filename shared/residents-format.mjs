// Compact resident list for Kinsburg: what the Worker stores and serves, what the browser decodes.
// Plain ESM, no dependencies. Types: residents-format.d.mts.
//
// Wire format (format 1)
//   manifest  GET /api/city/manifest.json
//     { format: 1, name, account, foundedISO, seed, demo, count, rev, shardSize, packSize,
//       shards: [{ n, count, rev }] }
//   shard     GET /api/city/shard/<n>.json?v=<rev>         -> Row[]   (residents n*shardSize+1 ..)
//   pack      GET /api/city/pack/<a>-<b>.json?v=<maxRev>   -> Row[][] (shards a..b, b-a < packSize)
//   Row = [handle, number, joinedDay, jobIndex, houseStyle, perkMask, level?, follower?, pet?, coins?, home?, homeNo?]
//   (the optional tail is cut after its last non-zero value, so older rows stay valid)
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
  'Police officer', 'Vet', // append-only: a resident's stored job is an index into this list
];

/** Pets: index 0 = none. Free ones anyone can pick; rare ones need buying first (pets_owned bit). */
export const PETS = ['none', 'dog', 'cat', 'bunny', 'fox', 'owl', 'golden'];
export const FREE_PETS = ['dog', 'cat', 'bunny'];
export const RARE_PETS = ['fox', 'owl', 'golden'];
export const PET_NAMES = { none: 'No pet', dog: 'Dog', cat: 'Cat', bunny: 'Bunny', fox: 'Fox', owl: 'Owl', golden: 'Golden retriever' };
/** Bit for a rare pet in residents.pets_owned. */
export const petBit = (pet) => 1 << PETS.indexOf(pet);

/** Special homes: index 0 = an ordinary house. Limited editions, first come first served. */
export const HOMES = ['house', 'villa', 'skyscraper'];
export const HOME_LIMIT = { villa: 100, skyscraper: 100 };

/**
 * The special home a comment asks for, or null. Any comment mentioning a villa counts ("i need a
 * villa", "VILLA pls 🏝️"); skyscrapers by "skyscraper"/"sky scraper" anywhere, or "tower" in a
 * short comment ("TOWER!", "i want a tower") so "the lighthouse tower is cute" doesn't.
 */
export function parseHomeCommand(text) {
  const t = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  // stretched and misspelled too: "Villaaa", "vila", "mansion"; "Skycraper", "sky scrapper"
  if (/(^| )(vill*a+s?|mansions?)( |$)/.test(t)) return 'villa';
  if (/(^| )sky ?s?c?rap+e*r+s?( |$)/.test(t)) return 'skyscraper';
  if (/(^| )towers?( |$)/.test(t) && t.split(' ').length <= 6) return 'skyscraper';
  return null;
}

/** Perk bit i = PERKS[i]: star 1, goldRoof 2, monument 4, street 8. */
export const PERKS = ['star', 'goldRoof', 'monument', 'street'];
/** Comments needed for each house level (1, 2, 3). */
export const LEVEL_AT = [3, 10, 30];
export function levelFor(engagement) {
  let l = 0;
  for (const t of LEVEL_AT) if (engagement >= t) l++;
  return l;
}
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
  const base = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  // "Moveee innnn", "MOVE INNN": letters stretched for emphasis count once.
  const t = ` ${base.replace(/([a-z])\1+/g, '$1')} `;
  if (base.split(' ').length <= 4 && / movie in /.test(` ${base} `)) return true; // the common typo, in a short comment
  if (/ (don t|dont|not|never|won t|wont) /.test(t) && !/ move ?in /.test(t)) return false;
  return (
    / (move|moving|moved|movin) ?(me )?in /.test(t) || // MOVE IN, moving in, move me in, movein
    / (i |me )?(want|ned|wana|give me|get me|can i get|can i have|i d like)( a| an| my)? (house|home|plot) /.test(t) ||
    / (house|home) (please|pls|plz) /.test(t) ||
    / i want in /.test(t)
  );
}

/** "CAST ME" anywhere in a comment: permission to appear in videos (independent of MOVE IN). */
export function matchesCastMe(text) {
  const t = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ');
  return /(^| )cast ?me( |$)/.test(t);
}

// ---------------------------------------------------------------- JOB and PET commands

const fold = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
/** A command comment starts with MOVE IN, JOB, PET, ADOPT or NO PET; later words can add more commands. */
const COMMANDISH = /^(move ?in|job|pet|adopt|no pet)( |$)/;

/** Words people use for each job (lowercase). Job names themselves always count. */
const JOB_ALIASES = {
  'Police officer': ['police', 'cop', 'officer', 'kpd', 'police officer', 'policeman', 'policewoman', 'sheriff'],
  Firefighter: ['firefighter', 'fireman', 'firewoman', 'fire fighter', 'kfd', 'fire'],
  Doctor: ['doctor', 'doc', 'surgeon', 'dr'],
  Nurse: ['nurse'],
  Teacher: ['teacher', 'teach', 'professor'],
  Vet: ['vet', 'veterinarian'],
  'Mail carrier': ['mail carrier', 'mailman', 'postman', 'postie', 'mail'],
  'Lighthouse keeper': ['lighthouse keeper', 'lighthouse'],
  'Bus driver': ['bus driver', 'bus'],
  Coder: ['coder', 'programmer', 'developer', 'dev', 'engineer'],
  Chef: ['chef', 'cook'],
  Musician: ['musician', 'singer', 'dj', 'rapper'],
  Photographer: ['photographer', 'photo'],
  Painter: ['painter', 'artist'],
};
const JOB_WORDS = new Map();
for (let i = 0; i < JOBS.length; i++) {
  const names = [JOBS[i].toLowerCase(), ...(JOB_ALIASES[JOBS[i]] ?? [])];
  for (const n of names) if (!JOB_WORDS.has(n)) JOB_WORDS.set(n, i);
}

/**
 * The job a comment asks for, or null. The comment must start with a command (MOVE IN, JOB, PET):
 * "JOB DOCTOR", "job: police", "MOVE IN job firefighter pet dog". "great job doctor" does not count.
 */
export function parseJobCommand(text) {
  const t = fold(text);
  if (!COMMANDISH.test(t)) return null;
  const m = /(?:^| )job (.+)$/.exec(t);
  if (!m) return null;
  const words = m[1].split(' ');
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const w = words.slice(0, n).join(' ');
    if (JOB_WORDS.has(w)) return JOB_WORDS.get(w);
  }
  const single = words[0].replace(/s$/, ''); // "doctors"
  return JOB_WORDS.has(single) ? JOB_WORDS.get(single) : null;
}

const PET_WORDS = {
  dog: 'dog', puppy: 'dog', pup: 'dog', doggo: 'dog',
  cat: 'cat', kitten: 'cat', kitty: 'cat',
  bunny: 'bunny', rabbit: 'bunny',
  fox: 'fox', owl: 'owl',
  golden: 'golden', 'golden retriever': 'golden', retriever: 'golden',
  none: 'none', no: 'none',
};

/** The pet a comment asks for ("PET DOG", "MOVE IN pet cat", "pet golden retriever"), or null. */
export function parsePetCommand(text) {
  const t = fold(text);
  if (!COMMANDISH.test(t)) return null;
  const m = /(?:^| )(?:pet|adopt) (.+)$/.exec(t) || /^(no) pet$/.exec(t);
  if (!m) return null;
  const words = m[1].split(' ');
  if (words.length >= 2 && PET_WORDS[words.slice(0, 2).join(' ')]) return PET_WORDS[words.slice(0, 2).join(' ')];
  const w = words[0].replace(/s$/, '');
  return PET_WORDS[w] ?? PET_WORDS[words[0]] ?? null;
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
  const pet = typeof r.pet === 'number' ? r.pet : Math.max(0, PETS.indexOf(r.pet ?? 'none'));
  return withTail([r.handle, r.number, r.joinedDay, job, r.houseStyle, typeof r.perks === 'number' ? r.perks : perksToMask(r.perks)], [r.level | 0, r.follower ? 1 : 0, pet, r.coins | 0, Math.max(0, HOMES.indexOf(r.home ?? 'house')), r.homeNo | 0]);
}

/** Append the optional tail [level, follower, pet, coins, home, homeNo], cut after its last non-zero value. */
export function withTail(row, tail) {
  let n = tail.length;
  while (n > 0 && !tail[n - 1]) n--;
  for (let i = 0; i < n; i++) row.push(tail[i] | 0);
  return row;
}

/** Row -> Resident without plotId. */
export function decodeRow(row) {
  const [handle, number, joinedDay, job, houseStyle, mask, level = 0, follower = 0, pet = 0, coins = 0, home = 0, homeNo = 0] = row;
  const r = { id: String(handle).toLowerCase(), handle, number, joinedDay, job: JOBS[job] ?? JOBS[0], houseStyle, perks: maskToPerks(mask), level: Math.max(0, Math.min(3, level | 0)), follower: follower === 1 };
  if (pet > 0 && pet < PETS.length) r.pet = PETS[pet];
  if (coins > 0) r.coins = coins | 0;
  if (home > 0 && home < HOMES.length) { r.home = HOMES[home]; if (homeNo > 0) r.homeNo = homeNo | 0; }
  return r;
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
