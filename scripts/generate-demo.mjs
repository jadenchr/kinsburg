#!/usr/bin/env node
// Demo data for Kinsburg.
//   node scripts/generate-demo.mjs [count=1200] [seed=kinsburg]   -> writes public/residents.json
//   node scripts/generate-demo.mjs --check                         -> invariants, append-only stability, 100k timing (writes nothing)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCity, capacityFor, assignResidents, toCityData, validateCityData, asciiMap, rngFrom } from '../shared/city-layout.mjs';
import { JOBS } from '../shared/residents-format.mjs';

export { JOBS }; // single copy lives in shared/residents-format.mjs (mirror of src/types.ts)

const ADJ = ['maple', 'sunny', 'quiet', 'little', 'golden', 'misty', 'velvet', 'rusty', 'honey', 'silver', 'cosy',
  'wild', 'gentle', 'amber', 'salty', 'lucky', 'sleepy', 'brave', 'clever', 'tiny', 'mossy', 'windy', 'rosy', 'dusky',
  'frosty', 'merry', 'plucky', 'snowy', 'sandy', 'starry', 'breezy', 'cedar', 'copper', 'dapper', 'fuzzy', 'hazel',
  'jolly', 'lemon', 'minty', 'olive', 'peachy', 'quirky', 'rainy', 'sage', 'teal', 'zesty', 'autumn', 'cloudy',
  'crimson', 'dreamy', 'early', 'foggy', 'ginger', 'humble', 'indigo', 'juniper', 'kind', 'lazy', 'mellow', 'nimble',
  'oaken', 'pebbly', 'rustic', 'spruce', 'tidy', 'violet', 'willow', 'woolly', 'curious', 'wandering', 'cheery', 'soft'];
const NOUN = ['fox', 'rook', 'kettle', 'otter', 'sparrow', 'teapot', 'lantern', 'badger', 'acorn', 'meadow', 'pebble',
  'robin', 'wren', 'heron', 'fern', 'biscuit', 'muffin', 'pickle', 'button', 'compass', 'thimble', 'owl', 'hedgehog',
  'marten', 'finch', 'clover', 'bramble', 'puffin', 'walrus', 'gecko', 'koala', 'pigeon', 'squirrel', 'toad', 'turnip',
  'waffle', 'pancake', 'noodle', 'dumpling', 'cactus', 'violin', 'ukulele', 'banjo', 'kite', 'canoe', 'harbor',
  'orchard', 'cottage', 'chimney', 'teacup', 'scone', 'crumpet', 'bagel', 'pretzel', 'mango', 'plum', 'fig', 'peach',
  'cherry', 'berry', 'melon', 'basil', 'thyme', 'nutmeg', 'cinnamon', 'pepper', 'comet', 'moon', 'cloud', 'storm',
  'river', 'brook', 'pond', 'island', 'valley', 'hill', 'grove', 'field', 'harvest', 'lily', 'tulip', 'daisy', 'poppy',
  'iris', 'moss', 'birch', 'oak', 'pine', 'aspen', 'beacon', 'anchor', 'sail', 'paddle', 'mitten', 'scarf', 'quilt'];
const NAMES = ['nora', 'milo', 'ivy', 'theo', 'ada', 'finn', 'luna', 'oscar', 'maya', 'leo', 'ruby', 'felix', 'iris',
  'jonah', 'elsie', 'hugo', 'clara', 'otis', 'hazel', 'arlo', 'june', 'ezra', 'mabel', 'rafa', 'zoe', 'kai', 'priya',
  'omar', 'lena', 'sami', 'yuki', 'nina', 'tomas', 'aiko', 'ines', 'dev', 'amara', 'bea', 'cal', 'dara', 'eli', 'faye',
  'gus', 'hana', 'ivo', 'jada', 'kofi', 'lila', 'max', 'nell', 'ola', 'pia', 'quinn', 'rosa', 'sol', 'tess', 'uma',
  'vik', 'wes', 'yara', 'zev', 'anya', 'bruno', 'cleo', 'dina', 'emil', 'freya', 'gio', 'hal', 'isla', 'jun', 'kaia',
  'lars', 'mira', 'noor', 'paz', 'remy', 'sana', 'tariq', 'una', 'vera', 'wren', 'yusuf', 'zara', 'ana', 'ben', 'cora',
  'dani', 'eva', 'gabe', 'ida', 'jo', 'kit', 'liv', 'mo', 'ned', 'pip', 'rae', 'sid', 'tilly', 'vic'];
const VERBS = { bakes: 'Baker', paints: 'Painter', knits: 'Tailor', sews: 'Tailor', brews: 'Barista', grows: 'Gardener',
  plants: 'Gardener', codes: 'Coder', sings: 'Musician', cooks: 'Chef', reads: 'Librarian', snaps: 'Photographer',
  fixes: 'Mechanic', fishes: 'Fisher', builds: 'Carpenter', draws: null, hikes: null, writes: null, travels: null,
  makes: null, dances: null, rides: null, sails: null, doodles: null, gardens: 'Gardener', throws: 'Potter' };
const VERB_LIST = Object.keys(VERBS);

const pick = (rng, a) => a[Math.floor(rng() * a.length)];
const num = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

function makeHandle(rng) {
  const a = pick(rng, ADJ), n = pick(rng, NOUN), nm = pick(rng, NAMES), v = pick(rng, VERB_LIST);
  let verb = null, h;
  switch (Math.floor(rng() * 14)) {
    case 0: case 1: h = `${a}.${n}`; break;
    case 2: h = `${a}_${n}${num(rng, 1, 99)}`; break;
    case 3: h = `the.${a}.${n}`; break;
    case 4: case 5: h = `${nm}_${v === 'throws' ? 'throws.pots' : v}`; verb = v; break;
    case 6: h = `${nm}.${n}`; break;
    case 7: h = `${nm}${num(rng, 2, 9999)}`; break;
    case 8: h = `${n}.and.${pick(rng, NOUN)}`; break;
    case 9: h = `${a}${n}`; break;
    case 10: h = `${nm}.${a}`; break;
    case 11: h = `${nm}_${n}_${num(rng, 1, 30)}`; break;
    case 12: h = `${nm}.${pick(rng, 'abcdefghijklmnoprstvwz'.split(''))}${rng() < 0.5 ? '' : num(rng, 1, 9)}`; break;
    default: h = `${pick(rng, ['hello', 'its', 'just', 'hey', 'little'])}.${nm}`;
  }
  return { handle: h, verb };
}

function pickJob(rng, verb) {
  if (verb && VERBS[verb] && rng() < 0.85) return VERBS[verb];
  for (;;) {
    const j = pick(rng, JOBS);
    if (j === 'Lighthouse keeper' && rng() > 0.1) continue; // only one lighthouse
    if (j === 'Architect' && rng() > 0.4) continue;
    return j;
  }
}

/** Day 1..14, front-loaded like a viral first reel (~25% on day 1). Non-decreasing in number. */
function dayFor(number, total) {
  if (number <= 1) return 1;
  const tau = 3.5, f = (number - 1) / Math.max(1, total - 1);
  const d = Math.ceil(-tau * Math.log(1 - f * (1 - Math.exp(-14 / tau))));
  return Math.min(14, Math.max(1, d));
}

/** First `count` demo residents. The sequence is prefix-stable for a seed (only joinedDay depends on count). */
export function demoResidents(count, seed = 'kinsburg') {
  const rng = rngFrom(seed, 'residents');
  const seen = new Set(['kinsburgtown']);
  const out = [{ id: 'kinsburgtown', handle: 'kinsburgtown', number: 1, joinedDay: 1, job: 'Architect', houseStyle: 0, perks: ['monument'] }];
  while (out.length < count) {
    const { handle, verb } = makeHandle(rng);
    const job = pickJob(rng, verb);
    const houseStyle = Math.floor(rng() * 12);
    const pr = rng(), pk = rng();
    if (handle.length < 3 || handle.length > 30 || !/^[a-z0-9._]+$/.test(handle) || seen.has(handle)) continue;
    seen.add(handle);
    const perks = pr < 0.03 ? [pk < 0.7 ? 'star' : pk < 0.9 ? 'goldRoof' : pk < 0.95 ? 'monument' : 'street'] : [];
    const number = out.length + 1;
    // house level from a hash of the handle (not the RNG, so the existing city doesn't reshuffle):
    // most houses are new, some have grown a floor or more from commenting
    const lh = [...handle].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 100;
    const level = lh < 62 ? 0 : lh < 86 ? 1 : lh < 96 ? 2 : 3;
    out.push({ id: handle, handle, number, joinedDay: 0, job, houseStyle, perks, ...(level ? { level } : {}) });
  }
  for (const r of out) r.joinedDay = dayFor(r.number, count);
  return out.slice(0, count);
}

export function generate(count, seed) {
  const t0 = performance.now();
  const city = buildCity({ seed, capacity: capacityFor(count) });
  const residents = assignResidents(city, demoResidents(count, seed));
  const data = toCityData(city, residents, { demo: true });
  const ms = performance.now() - t0;
  return { city, data, ms };
}

function check(seed) {
  console.log('--- append-only stability (1000 -> 1200, and 1200 -> 5000) ---');
  for (const [a, b] of [[1000, 1200], [1200, 5000]]) {
    const A = generate(a, seed).data, B = generate(b, seed).data;
    for (let i = 0; i < a; i++) {
      const ra = A.residents[i], rb = B.residents[i];
      if (ra.id !== rb.id || ra.plotId !== rb.plotId) throw new Error(`resident #${i + 1} moved: ${ra.id}@${ra.plotId} vs ${rb.id}@${rb.plotId}`);
      const pa = A.plots[ra.plotId], pb = B.plots[rb.plotId];
      const dx = pb.x - pa.x, dy = pb.y - pa.y, ox = (B.width - A.width) / 2, oy = (B.height - A.height) / 2;
      if (dx !== ox || dy !== oy || pa.streetId !== pb.streetId || pa.houseNumber !== pb.houseNumber) throw new Error(`plot ${ra.plotId} changed`);
    }
    console.log(`ok: first ${a} residents keep plot ids, addresses and positions (map offset ${(B.width - A.width) / 2}) when growing to ${b}`);
  }
  const C2 = generate(1200, seed).data;
  if (JSON.stringify(C2) !== JSON.stringify(generate(1200, seed).data)) throw new Error('not deterministic');
  console.log('ok: deterministic for same seed');
  console.log('--- 100,000 resident timing run (not saved) ---');
  const { city, data, ms } = generate(100000, seed);
  const tv = performance.now();
  const stats = validateCityData(data, { jobs: JOBS, streetOf: city.streetOf });
  const vms = performance.now() - tv;
  const size = JSON.stringify(data).length;
  console.log(`100k: build+assign ${ms.toFixed(0)} ms, validate ${vms.toFixed(0)} ms, map ${data.width}x${data.height}, ` +
    `${stats.houses} houses (${stats.sparePct.toFixed(1)}% spare), ${stats.streets} streets, JSON ${(size / 1e6).toFixed(1)} MB`);
}

// CLI only when run directly (importing demoResidents() from the D1 seed script must not write files).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const pos = args.filter((a) => !a.startsWith('--'));
  const count = Math.max(1, parseInt(pos[0] ?? '1200', 10) || 1200);
  const seed = pos[1] ?? 'kinsburg';

  if (flags.has('--check')) {
    check(seed);
  } else {
    const { city, data, ms } = generate(count, seed);
    const stats = validateCityData(data, { jobs: JOBS, streetOf: city.streetOf });
    const json = JSON.stringify(data);
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'residents.json');
    if (!flags.has('--no-write')) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, json); }
    console.log(`Kinsburg: ${count} residents, seed "${seed}", map ${data.width}x${data.height}, ${city.chunks} neighbourhoods, ` +
      `${stats.houses} houses (${stats.sparePct.toFixed(1)}% spare), ${stats.shops} shops, ${stats.civic} civic, ${stats.streets} streets, ` +
      `${(json.length / 1024).toFixed(0)} KB, ${ms.toFixed(0)} ms${flags.has('--no-write') ? '' : ' -> ' + out}`);
    if (flags.has('--ascii') || !flags.has('--quiet')) console.log(asciiMap(data, 60, 30));
  }
}
