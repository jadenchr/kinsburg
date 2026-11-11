// Kinsburg city-layout engine. Plain ESM, no dependencies, runs in Node, the browser and the Worker.
// Single source of truth: imported by src/data/load.ts (browser), worker/ and scripts/. Types: city-layout.d.mts.
//
// The town lives on an infinite plane split into CHUNK x CHUNK "neighbourhoods".
// Chunks are unlocked in a fixed, seed-determined order (centre, lake, then outward by
// distance), and every chunk's content depends only on (seed, chunk coords). Plot ids are
// handed out in unlock order, and inside a chunk in move-in order (nearest the town hall
// first). So building a bigger city with the same seed only APPENDS plots: resident #k
// always lands on house plot k-1 of the fill order, whatever the final size.
//
// The only thing that changes as the city grows is the map window: it is re-centred so
// tile coordinates shift by a uniform offset (city.originX/originY = map coords of the
// town centre). Plot ids, resident -> plot links, street ids and house numbers are stable.

export const CHUNK = 20; // tile pitch between arterial roads
const P = CHUNK;
const HP = P / 2;
const S = P + 1; // local grid includes both border road lines
const MARGIN = 6; // countryside shown around the outermost ring
const SPARE = 1.45; // capacityFor(): ~31% of house plots stay empty

const C = { g: 103, r: 114, w: 119, p: 112, z: 122, f: 102, t: 116, s: 115 };
const TILE_CHARS = 'grwpzfts';

// ---------------------------------------------------------------- RNG

export function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded RNG from any list of parts, e.g. rngFrom(seed, 'chunk', 3, -1). */
export function rngFrom(...parts) {
  return mulberry32(hashString(parts.join('|')));
}

/** Cheap deterministic 0..1 hash for a tile (no RNG state). */
function hash01(seedHash, x, y, salt) {
  let h = seedHash ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- street names

const NAME_WORDS = [
  'Larkspur', 'Thistle', 'Honeycomb', 'Kiln', 'Fiddlehead', 'Bramble', 'Clover', 'Foxglove', 'Hazel',
  'Juniper', 'Lavender', 'Marigold', 'Nettle', 'Primrose', 'Rowan', 'Saffron', 'Tansy', 'Willow',
  'Yarrow', 'Aster', 'Bluebell', 'Buttercup', 'Campion', 'Daisy', 'Elder', 'Fennel', 'Gorse',
  'Heather', 'Ivy', 'Jasmine', 'Kestrel', 'Linden', 'Meadowsweet', 'Nutmeg', 'Orchard', 'Poppy',
  'Quince', 'Rosehip', 'Sorrel', 'Teasel', 'Violet', 'Wren', 'Acorn', 'Badger', 'Beacon', 'Birch',
  'Bobbin', 'Brook', 'Candle', 'Cedar', 'Chestnut', 'Cobble', 'Copper', 'Cricket', 'Dovecote', 'Elm',
  'Ember', 'Fern', 'Finch', 'Flax', 'Forge', 'Garnet', 'Glade', 'Hawthorn', 'Heron', 'Hollow',
  'Hopfield', 'Inkwell', 'Kettle', 'Lantern', 'Loom', 'Maple', 'Millrace', 'Mossy', 'Nightjar',
  'Oakapple', 'Otter', 'Owl', 'Pebble', 'Pinecone', 'Plover', 'Potter', 'Quill', 'Rook', 'Saddle',
  'Sandpiper', 'Sparrow', 'Spindle', 'Spruce', 'Starling', 'Teapot', 'Thimble', 'Thrush', 'Timber',
  'Treacle', 'Tumble', 'Weaver', 'Wicker', 'Wheelwright', 'Wildflower', 'Woodruff', 'Alder', 'Anvil',
  'Barley', 'Basket', 'Bellflower', 'Blackberry', 'Bracken', 'Burdock', 'Cherry', 'Cinder', 'Clay',
  'Cowslip', 'Damson', 'Dewdrop', 'Drystone', 'Glassblower', 'Goldfinch', 'Harvest', 'Hearth',
  'Honeysuckle', 'Lark', 'Lilac', 'Mallow', 'Marten', 'Oatfield', 'Parsley', 'Pippin', 'Quarry',
  'Reed', 'Rush', 'Sage', 'Saltmarsh', 'Shuttle', 'Snowdrop', 'Tinker', 'Thatch', 'Woolpack', 'Yew',
  'Apple', 'Bakehouse', 'Cooper', 'Dyer', 'Fletcher', 'Mason', 'Tanner', 'Chandler', 'Saltbox',
];
const SUFFIX = {
  edge: ['Street', 'Way', 'Avenue', 'Hill', 'Lane', 'Street', 'Way'],
  band: ['Lane', 'Row', 'Walk', 'Way', 'Gardens', 'Street', 'Lane'],
  cut: ['Close', 'Walk', 'Row', 'Lane', 'Close'],
  ring: ['Crescent', 'Gardens', 'Crescent'],
  spoke: ['Walk', 'Lane', 'Close', 'Row'],
};
const NAME_PREFIX = ['', 'Upper ', 'Lower ', 'Old ', 'New ', 'Little ', 'Great ', 'North ', 'South ',
  'East ', 'West ', 'Far ', 'High ', 'Middle ', 'Nether ', 'Long '];
const AVENUE_NAME = 'Kinsfolk Avenue';
const SQUARE_NAME = 'Commons Crescent';

function makeNamer(seed) {
  const used = new Set([AVENUE_NAME, SQUARE_NAME]);
  return function nameFor(id, type) {
    const rng = rngFrom(seed, 'street', id);
    const suffixes = SUFFIX[type] || SUFFIX.band;
    for (const prefix of NAME_PREFIX) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const name = prefix + NAME_WORDS[Math.floor(rng() * NAME_WORDS.length)] + ' ' + suffixes[Math.floor(rng() * suffixes.length)];
        if (!used.has(name)) { used.add(name); return name; }
      }
    }
    const name = NAME_WORDS[id % NAME_WORDS.length] + ' ' + suffixes[0] + ' ' + id;
    used.add(name);
    return name;
  };
}

// ---------------------------------------------------------------- Kinsfolk Avenue

/** The main avenue meanders east-west through the town centre, |y| <= 5 tiles. */
function makeAvenue(seed) {
  const r = rngFrom(seed, 'avenue');
  const l1 = 56 + r() * 20, l2 = 23 + r() * 9;
  const p1 = r() * Math.PI * 2, p2 = r() * Math.PI * 2;
  const cache = new Map();
  return function aveY(x) {
    let y = cache.get(x);
    if (y === undefined) {
      y = Math.round(3.5 * Math.sin((2 * Math.PI * x) / l1 + p1) + 1.2 * Math.sin((2 * Math.PI * x) / l2 + p2));
      cache.set(x, y);
    }
    return y;
  };
}

// ---------------------------------------------------------------- chunk order

function lakeChunk(seed) {
  const d = Math.floor(rngFrom(seed, 'lake')() * 4);
  return [[1, 1], [-1, 1], [-1, -1], [1, -1]][d];
}

/** Infinite, prefix-stable unlock order: centre, lake, then by distance (seeded spiral tie-break). */
function* chunkOrder(seed) {
  const lake = lakeChunk(seed);
  yield [0, 0];
  yield lake;
  const rot = rngFrom(seed, 'spiral')() * Math.PI * 2;
  let done = 0; // index into the sorted list already yielded (excluding centre & lake)
  for (let Q = 4; ; Q *= 2) {
    const list = [];
    for (let cy = -Q; cy <= Q; cy++) for (let cx = -Q; cx <= Q; cx++) {
      const d2 = cx * cx + cy * cy;
      if (d2 === 0 || d2 > Q * Q) continue;
      if (cx === lake[0] && cy === lake[1]) continue;
      let a = Math.atan2(cy, cx) - rot;
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      list.push([d2, a, cx, cy]);
    }
    list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (; done < list.length; done++) yield [list[done][2], list[done][3]];
  }
}

// ---------------------------------------------------------------- local chunk grid

// sref values in a local grid: -1 none, 0..3 border edges (top, left, bottom, right),
// 4 = Kinsfolk Avenue, 5+k = chunk-local street k.
const E_TOP = 0, E_LEFT = 1, E_BOTTOM = 2, E_RIGHT = 3, AVE = 4;
const W_LOT = 1, W_TAKEN = 2;

function newLocal() {
  return {
    t: new Uint8Array(S * S).fill(C.g),
    sref: new Int16Array(S * S).fill(-1),
    want: new Uint8Array(S * S),
    ave: new Uint8Array(S * S),
    streets: [], // {type, axis:'x'|'y'|'seq', fixed?}
    specials: [], // {lx,ly,w,h,kind}
    landmarks: [],
  };
}
const li = (x, y) => y * S + x;

function addStreet(L, type, axis, fixed) {
  L.streets.push({ type, axis, fixed });
  return 5 + L.streets.length - 1;
}

function drawEdges(L) {
  for (let i = 0; i <= P; i++) {
    L.t[li(i, 0)] = C.r; L.sref[li(i, 0)] = E_TOP;
    L.t[li(i, P)] = C.r; L.sref[li(i, P)] = E_BOTTOM;
  }
  for (let j = 1; j < P; j++) {
    L.t[li(0, j)] = C.r; L.sref[li(0, j)] = E_LEFT;
    L.t[li(P, j)] = C.r; L.sref[li(P, j)] = E_RIGHT;
  }
}

function carveAvenue(L, x0, y0, aveY) {
  for (let lx = 1; lx < P; lx++) {
    const x = x0 + lx;
    const a = aveY(x - 1), b = aveY(x);
    for (let y = Math.min(a, b); y <= Math.max(a, b); y++) {
      const ly = y - y0;
      if (ly < 1 || ly >= P) continue;
      const k = li(lx, ly);
      L.ave[k] = 1; L.t[k] = C.r; L.sref[k] = AVE;
    }
  }
}

// Cell writers that never overwrite the avenue (except plaza, which the avenue opens into).
function wRoad(L, k, ref) { if (L.ave[k]) return; L.t[k] = C.r; L.sref[k] = ref; L.want[k] = 0; }
function wLot(L, k) { if (L.ave[k]) return; L.t[k] = C.g; L.want[k] = W_LOT; }
function wGarden(L, k, rng) { if (L.ave[k]) return; L.t[k] = rng() < 0.3 ? C.t : C.g; L.want[k] = 0; }
function wPark(L, k, rng, treeP = 0.22) { if (L.ave[k]) return; L.t[k] = rng() < treeP ? C.t : C.p; L.want[k] = 0; }
function wPlaza(L, k) { L.ave[k] = 0; L.t[k] = C.z; L.sref[k] = -1; L.want[k] = 0; }

function isRoad(L, x, y) { return x >= 0 && y >= 0 && x <= P && y <= P && L.t[li(x, y)] === C.r; }
function touchesRoad(L, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (isRoad(L, xx - 1, yy) || isRoad(L, xx + 1, yy) || isRoad(L, xx, yy - 1) || isRoad(L, xx, yy + 1)) return true;
  }
  return false;
}
function footprintIs(L, x, y, w, h, want) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (xx < 1 || yy < 1 || xx >= P || yy >= P) return false;
    const k = li(xx, yy);
    if (L.want[k] !== want || L.t[k] !== C.g) return false;
  }
  return true;
}
function take(L, x, y, w, h, kind) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) L.want[li(xx, yy)] = W_TAKEN;
  L.specials.push({ lx: x, ly: y, w, h, kind });
}

// ---------------------------------------------------------------- neighbourhood patterns

/** Rows of lots between parallel lanes, staggered short cross-streets. T = transpose (vertical lanes). */
function patternBands(L, rng, T) {
  const at = T ? (i, j) => li(j, i) : (i, j) => li(i, j);
  const laneAxis = T ? 'y' : 'x', cutAxis = T ? 'x' : 'y';
  const bands = [];
  let j = 1;
  while (j <= P - 1) {
    const rem = P - j;
    let h;
    if (rem <= 4) h = rem;
    else {
      const opts = [2, 3, 3, 4, 2, 3];
      do { h = opts[Math.floor(rng() * opts.length)]; } while (rem - h - 1 < 2);
    }
    bands.push([j, h]);
    j += h;
    if (j <= P - 1) {
      const ref = addStreet(L, 'band', laneAxis);
      for (let i = 1; i < P; i++) wRoad(L, at(i, j), ref);
      j++;
    }
  }
  for (const [b0, h] of bands) {
    if (rng() < 0.09) { // pocket park
      for (let jj = b0; jj < b0 + h; jj++) for (let i = 1; i < P; i++) wPark(L, at(i, jj), rng, 0.3);
      continue;
    }
    const rows = h === 2 ? [1, 1] : h === 3 ? [1, 0, 1] : [1, 0, 0, 1];
    for (let r = 0; r < h; r++) for (let i = 1; i < P; i++) {
      if (rows[r]) { if (rng() < 0.04) wGarden(L, at(i, b0 + r), rng); else wLot(L, at(i, b0 + r)); }
      else wGarden(L, at(i, b0 + r), rng);
    }
    if (rng() < 0.7) {
      const c = 4 + Math.floor(rng() * (P - 8));
      const ref = addStreet(L, 'cut', cutAxis);
      for (let r = 0; r < h; r++) {
        wRoad(L, at(c, b0 + r), ref);
        if (!rows[r]) { wLot(L, at(c - 1, b0 + r)); wLot(L, at(c + 1, b0 + r)); }
      }
    }
  }
}

/** Lots around a square crescent with a green in the middle. */
function patternCrescent(L, rng) {
  const ring = addStreet(L, 'ring', 'seq');
  const a = 4, b = P - 4, mid = HP;
  for (let y = 1; y < P; y++) for (let x = 1; x < P; x++) {
    const k = li(x, y);
    const onRing = (x >= a && x <= b && (y === a || y === b)) || (y >= a && y <= b && (x === a || x === b));
    const spoke = (x === mid && (y < a || y > b)) || (y === mid && (x < a || x > b));
    if (onRing || spoke) { wRoad(L, k, ring); continue; }
    if (x > a && x < b && y > a && y < b) {
      const dIn = Math.min(x - a, y - a, b - x, b - y);
      if (dIn === 1) wLot(L, k);
      else wPark(L, k, rng, dIn === 2 ? 0.35 : 0.12);
    } else {
      const dOut = Math.min(x, y, P - x, P - y);
      if (dOut === 2) wGarden(L, k, rng); else wLot(L, k);
    }
  }
}

function addShops(L, rng, p = 0.045) {
  for (let y = 1; y < P; y++) for (let x = 1; x < P; x++) {
    if (L.want[li(x, y)] !== W_LOT) continue;
    const nearEdge = x === 1 || y === 1 || x === P - 1 || y === P - 1;
    if (!nearEdge || rng() >= p) continue;
    const horiz = y === 1 || y === P - 1;
    if (rng() < 0.5) {
      if (horiz && footprintIs(L, x, y, 2, 1, W_LOT) && touchesRoad(L, x, y, 2, 1)) { take(L, x, y, 2, 1, 'shop'); continue; }
      if (!horiz && footprintIs(L, x, y, 1, 2, W_LOT) && touchesRoad(L, x, y, 1, 2)) { take(L, x, y, 1, 2, 'shop'); continue; }
    }
    if (touchesRoad(L, x, y, 1, 1)) take(L, x, y, 1, 1, 'shop');
  }
}

function addCivic(L, rng) {
  for (let tries = 0; tries < 60; tries++) {
    const x = 1 + Math.floor(rng() * (P - 2)), y = 1 + Math.floor(rng() * (P - 2));
    if (footprintIs(L, x, y, 2, 2, W_LOT) && touchesRoad(L, x, y, 2, 2)) { take(L, x, y, 2, 2, 'civic'); return; }
  }
}

function genHood(L, rng) {
  const roll = rng();
  if (roll < 0.38) patternBands(L, rng, false);
  else if (roll < 0.76) patternBands(L, rng, true);
  else patternCrescent(L, rng);
  addShops(L, rng);
  if (rng() < 0.3) addCivic(L, rng);
}

function genCentre(L, rng) {
  const ring = addStreet(L, 'ring', 'seq', SQUARE_NAME);
  const spokeN = addStreet(L, 'spoke', 'y');
  const spokeS = addStreet(L, 'spoke', 'y');
  const qx = rng() < 0.5 ? -1 : 1, qy = rng() < 0.5 ? -1 : 1; // monument park quadrant
  for (let y = 1; y < P; y++) for (let x = 1; x < P; x++) {
    const u = x - HP, v = y - HP, k = li(x, y);
    const m = Math.max(Math.abs(u), Math.abs(v));
    if (m <= 4) { wPlaza(L, k); continue; }
    if (m === 5) { wRoad(L, k, ring); continue; }
    if (u === 0) { wRoad(L, k, v < 0 ? spokeN : spokeS); continue; }
    if (Math.sign(u) === qx && Math.sign(v) === qy && Math.abs(u) >= 6 && Math.abs(v) >= 6) {
      wPark(L, k, rng, Math.abs(u) === 9 || Math.abs(v) === 9 ? 0.5 : 0);
      continue;
    }
    if (m === 6 || m === 9) wLot(L, k); else wGarden(L, k, rng);
  }
  const lm = (id, name, kind, x, y, w, h) => {
    L.landmarks.push({ id, name, kind, lx: x, ly: y, w, h });
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) L.want[li(xx, yy)] = W_TAKEN;
  };
  lm('townhall', 'Kinsburg Town Hall', 'townhall', HP - 1, HP - 4, 3, 3);
  lm('fountain', 'Wishing Fountain', 'fountain', HP, HP, 1, 1);
  lm('market', 'Kinsburg Market', 'market', HP + 2, HP + 2, 3, 2);
  // Founders Monument: 2x2 in the centre of the corner park (park tiles under it, no trees).
  const mx = HP + (qx > 0 ? 7 : -8), my = HP + (qy > 0 ? 7 : -8);
  for (let yy = my; yy < my + 2; yy++) for (let xx = mx; xx < mx + 2; xx++) { L.t[li(xx, yy)] = C.p; }
  lm('monument', 'Founders Monument', 'monument', mx, my, 2, 2);
  // School, library, clinic: 2x2 civic lots facing the square.
  const cands = [[-3, -7], [2, -7], [-3, 6], [2, 6], [-7, -3], [-7, 2], [6, -3], [6, 2]];
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  let civics = 0;
  for (const [u0, v0] of cands) {
    if (civics >= 3) break;
    const x = HP + u0, y = HP + v0;
    let ok = true;
    for (let yy = y; yy < y + 2 && ok; yy++) for (let xx = x; xx < x + 2; xx++) {
      const k = li(xx, yy);
      if (L.ave[k] || L.t[k] === C.p || L.t[k] === C.r || L.want[k] === W_TAKEN) { ok = false; break; }
    }
    if (!ok || !touchesRoad(L, x, y, 2, 2)) continue;
    for (let yy = y; yy < y + 2; yy++) for (let xx = x; xx < x + 2; xx++) { L.t[li(xx, yy)] = C.g; L.want[li(xx, yy)] = W_LOT; }
    take(L, x, y, 2, 2, 'civic');
    civics++;
  }
  // Shops around the square.
  for (let y = 1; y < P; y++) for (let x = 1; x < P; x++) {
    const u = x - HP, v = y - HP;
    if (Math.max(Math.abs(u), Math.abs(v)) !== 6 || L.want[li(x, y)] !== W_LOT || rng() >= 0.4) continue;
    const horiz = Math.abs(v) === 6;
    if (rng() < 0.5 && footprintIs(L, x, y, horiz ? 2 : 1, horiz ? 1 : 2, W_LOT) && touchesRoad(L, x, y, horiz ? 2 : 1, horiz ? 1 : 2)) take(L, x, y, horiz ? 2 : 1, horiz ? 1 : 2, 'shop');
    else if (touchesRoad(L, x, y, 1, 1)) take(L, x, y, 1, 1, 'shop');
  }
}

function genLake(L, rng, cx, cy) {
  const rx = 5.4 + rng() * 1.3, ry = 5.4 + rng() * 1.3;
  const ph = rng() * 6.28;
  const lakeAt = (x, y) => {
    const dx = (x - HP) / rx, dy = (y - HP) / ry;
    const ang = Math.atan2(dy, dx);
    return Math.sqrt(dx * dx + dy * dy) - 0.09 * Math.sin(3 * ang + ph) - 0.05 * Math.sin(5 * ang + ph * 2);
  };
  for (let y = 1; y < P; y++) for (let x = 1; x < P; x++) {
    const k = li(x, y);
    if (x === 1 || y === 1 || x === P - 1 || y === P - 1) { wLot(L, k); continue; }
    const d = lakeAt(x, y);
    if (d < 1) L.t[k] = C.w;
    else if (d < 1 + 1.25 / Math.min(rx, ry)) L.t[k] = C.s;
    else L.t[k] = rng() < 0.28 ? C.t : C.g;
  }
  // Lighthouse on the shore facing away from town.
  const away = Math.atan2(cy, cx) + (rng() - 0.5) * 0.9;
  for (let r = 3; r < HP; r += 0.5) {
    const x = Math.round(HP + Math.cos(away) * r), y = Math.round(HP + Math.sin(away) * r);
    const k = li(x, y);
    if (L.t[k] === C.w || L.t[k] === C.s) continue;
    if (L.want[k]) break;
    L.t[k] = C.g;
    L.landmarks.push({ id: 'lighthouse', name: 'Kinsmere Lighthouse', kind: 'lighthouse', lx: x, ly: y, w: 1, h: 1 });
    L.want[k] = W_TAKEN;
    break;
  }
  addShops(L, rng, 0.03);
}

/** Generate one unlocked chunk in local coordinates. Depends only on seed + chunk coords. */
function genChunk(seed, cx, cy, kind, aveY) {
  const L = newLocal();
  const rng = rngFrom(seed, 'chunk', cx, cy);
  const x0 = cx * P - HP, y0 = cy * P - HP;
  drawEdges(L);
  if (cy === 0) carveAvenue(L, x0, y0, aveY);
  if (kind === 'centre') genCentre(L, rng);
  else if (kind === 'lake') genLake(L, rng, cx, cy);
  else genHood(L, rng);
  // House lots, ordered nearest-the-town-hall first (this is the move-in order).
  const houses = [];
  for (let y = 1; y < P; y++) for (let x = 1; x < P; x++) {
    if (L.want[li(x, y)] === W_LOT && L.t[li(x, y)] === C.g && touchesRoad(L, x, y, 1, 1)) {
      const wx = x0 + x, wy = y0 + y + 3; // town hall centre is world (0,-3)
      houses.push({ lx: x, ly: y, d: wx * wx + wy * wy });
    }
  }
  houses.sort((a, b) => a.d - b.d || a.ly - b.ly || a.lx - b.lx);
  L.houses = houses;
  L.planned = L.want; // cells planned for lots: never planted with trees
  return L;
}

// ---------------------------------------------------------------- countryside

function genCountry(seed, cx, cy, type) {
  const t = new Uint8Array(S * S).fill(C.g);
  const rng = rngFrom(seed, 'country', cx, cy);
  if (!type) { const r = rng(); type = r < 0.45 ? 'farm' : r < 0.7 ? 'forest' : 'meadow'; }
  if (type === 'farm' || type === 'windmill') {
    const T = rng() < 0.5;
    const at = T ? (i, j) => li(j, i) : (i, j) => li(i, j);
    let j = 0;
    while (j <= P) {
      const hgt = 3 + Math.floor(rng() * 4);
      for (let i = 0; i <= P; i++) t[at(i, j)] = rng() < 0.55 ? C.t : C.g; // hedgerow
      let i = 1;
      while (i <= P) {
        const wdt = 4 + Math.floor(rng() * 6);
        const fallow = rng() < 0.15;
        for (let jj = j + 1; jj <= Math.min(P, j + hgt); jj++) for (let ii = i; ii < Math.min(P + 1, i + wdt); ii++) t[at(ii, jj)] = fallow ? C.g : C.f;
        i += wdt;
        if (i <= P) { for (let jj = j + 1; jj <= Math.min(P, j + hgt); jj++) t[at(i, jj)] = rng() < 0.4 ? C.t : C.g; i++; }
      }
      j += hgt + 1;
    }
    if (type === 'windmill') for (let y = HP - 3; y <= HP + 2; y++) for (let x = HP - 3; x <= HP + 2; x++) t[li(x, y)] = C.g;
  } else if (type === 'forest') {
    const sh = hashString(seed + 'forest' + cx + ',' + cy);
    for (let y = 0; y <= P; y++) for (let x = 0; x <= P; x++) {
      const coarse = hash01(sh, x >> 2, y >> 2, 1), fine = hash01(sh, x, y, 2);
      t[li(x, y)] = coarse * 0.6 + fine * 0.4 > 0.38 ? C.t : C.g;
    }
  } else {
    for (let i = 0; i < t.length; i++) if (rng() < 0.07) t[i] = C.t;
    if (rng() < 0.4) {
      const px = 6 + rng() * 8, py = 6 + rng() * 8, r = 2.2 + rng() * 1.8;
      for (let y = 1; y < P; y++) for (let x = 1; x < P; x++) {
        const d = Math.hypot(x - px, (y - py) * 1.15);
        if (d < r) t[li(x, y)] = C.w; else if (d < r + 1) t[li(x, y)] = C.s;
      }
    }
  }
  return t;
}

// ---------------------------------------------------------------- public API

/** House plots to build for n residents (~31% of them spare, min 8). */
export function capacityFor(n) {
  return Math.max(8, Math.ceil(n * SPARE));
}

/**
 * Build the city map for `capacity` house plots.
 * Returns { width, height, tiles, streets, plots, landmarks, fillOrder, originX, originY, ... }.
 * plots carry no residents yet; use assignResidents().
 */
export function buildCity({ seed = 'kinsburg', capacity = 100 } = {}) {
  seed = String(seed);
  const seedHash = hashString(seed);
  const aveY = makeAvenue(seed);
  const lake = lakeChunk(seed);

  // 1. Unlock chunks in order until there are enough house lots.
  const unlocked = [];
  let houses = 0;
  for (const [cx, cy] of chunkOrder(seed)) {
    const kind = cx === 0 && cy === 0 ? 'centre' : cx === lake[0] && cy === lake[1] ? 'lake' : 'hood';
    const L = genChunk(seed, cx, cy, kind, aveY);
    L.cx = cx; L.cy = cy; L.kind = kind;
    const take = Math.min(L.houses.length, capacity - houses);
    L.houses = L.houses.slice(0, Math.max(0, take));
    houses += L.houses.length;
    unlocked.push(L);
    if (houses >= capacity && unlocked.length >= 2) break;
  }
  let R = 1;
  for (const L of unlocked) R = Math.max(R, Math.abs(L.cx), Math.abs(L.cy));
  const xmin = -(R * P + HP) - MARGIN, ymin = xmin;
  const width = (2 * R + 1) * P + 1 + 2 * MARGIN, height = width;
  const tiles = new Uint8Array(width * height).fill(C.g);
  const streetOf = new Int32Array(width * height).fill(-1);
  const occ = new Uint8Array(width * height);
  const planned = new Uint8Array(width * height);
  const inMap = (x, y) => x >= xmin && y >= ymin && x < xmin + width && y < ymin + height;
  const mi = (x, y) => (y - ymin) * width + (x - xmin);
  const isUnlocked = new Set(unlocked.map((L) => L.cx + ',' + L.cy));

  // 2. Windmill farm: a countryside chunk next to town, roughly opposite the lake.
  const wantAng = Math.atan2(-lake[1], -lake[0]);
  let windmill = null, best = Infinity;
  for (let cy = -R; cy <= R; cy++) for (let cx = -R; cx <= R; cx++) {
    if (isUnlocked.has(cx + ',' + cy) || cy === 0) continue;
    let near = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (isUnlocked.has(cx + dx + ',' + (cy + dy))) near = true;
    if (!near) continue;
    let da = Math.abs(Math.atan2(cy, cx) - wantAng);
    if (da > Math.PI) da = 2 * Math.PI - da;
    const score = da * 10 + Math.hypot(cx, cy);
    if (score < best) { best = score; windmill = [cx, cy]; }
  }

  // 3. Countryside around and between neighbourhoods.
  for (let cy = -R - 1; cy <= R + 1; cy++) for (let cx = -R - 1; cx <= R + 1; cx++) {
    if (isUnlocked.has(cx + ',' + cy)) continue;
    const isWm = windmill && windmill[0] === cx && windmill[1] === cy;
    const t = genCountry(seed, cx, cy, isWm ? 'windmill' : null);
    const x0 = cx * P - HP, y0 = cy * P - HP;
    for (let ly = 0; ly <= P; ly++) for (let lx = 0; lx <= P; lx++) {
      const x = x0 + lx, y = y0 + ly;
      if (inMap(x, y)) tiles[mi(x, y)] = t[li(lx, ly)];
    }
  }

  // 4. Streets. id 0 is always Kinsfolk Avenue.
  const nameFor = makeNamer(seed);
  const streets = [{ id: 0, name: AVENUE_NAME }];
  const smeta = [{ axis: 'seq', ox: 0, oy: 0, seq: [1, 2] }];
  const newStreet = (type, axis, ox, oy, fixed) => {
    const id = streets.length;
    streets.push({ id, name: fixed || nameFor(id, type) });
    smeta.push({ axis, ox, oy, seq: [1, 2] });
    return id;
  };
  // Avenue across the whole map (country road outside town).
  for (let x = xmin; x < xmin + width; x++) {
    const a = aveY(x - 1), b = aveY(x);
    for (let y = Math.min(a, b); y <= Math.max(a, b); y++) {
      const k = mi(x, y);
      tiles[k] = C.r; streetOf[k] = 0;
    }
  }

  // 5. Paste neighbourhoods in unlock order; plots get ids in move-in order.
  const edgeIds = new Map();
  const plots = [], landmarks = [], fillOrder = [];
  const usedNumbers = new Set();
  const houseNumber = (sid, roadX, roadY, lotX, lotY) => {
    const m = smeta[sid];
    const odd = lotY < roadY || lotX < roadX;
    let n;
    if (m.axis === 'seq') { n = m.seq[odd ? 0 : 1]; }
    else {
      const along = m.axis === 'x' ? roadX - m.ox : roadY - m.oy;
      n = along * 2 + (odd ? 1 : 2);
    }
    while (usedNumbers.has(sid * 1e6 + n)) n += 2;
    usedNumbers.add(sid * 1e6 + n);
    if (m.axis === 'seq') m.seq[odd ? 0 : 1] = n + 2;
    return n;
  };
  const pickStreet = (x, y, w, h) => {
    let found = null;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const rx = xx + dx, ry = yy + dy;
        if (rx >= x && rx < x + w && ry >= y && ry < y + h) continue;
        const k = mi(rx, ry);
        if (tiles[k] !== C.r) continue;
        if (streetOf[k] === 0) return { sid: 0, rx, ry, lx: xx, ly: yy };
        if (!found) found = { sid: streetOf[k], rx, ry, lx: xx, ly: yy };
      }
    }
    return found;
  };

  for (const L of unlocked) {
    const x0 = L.cx * P - HP, y0 = L.cy * P - HP;
    const edgeKeys = [
      ['h', L.cx, L.cy, 'x', x0, y0], ['v', L.cx, L.cy, 'y', x0, y0],
      ['h', L.cx, L.cy + 1, 'x', x0, y0 + P], ['v', L.cx + 1, L.cy, 'y', x0 + P, y0],
    ];
    const eid = edgeKeys.map(([o, a, b, axis, ox, oy]) => {
      const key = o + a + ',' + b;
      if (!edgeIds.has(key)) edgeIds.set(key, newStreet('edge', axis, ox, oy));
      return edgeIds.get(key);
    });
    const lid = L.streets.map((s) => newStreet(s.type, s.axis, x0, y0, s.fixed));
    for (let ly = 0; ly <= P; ly++) for (let lx = 0; lx <= P; lx++) {
      const x = x0 + lx, y = y0 + ly, k = mi(x, y), lk = li(lx, ly);
      const border = lx === 0 || ly === 0 || lx === P || ly === P;
      if (border) {
        if (tiles[k] === C.r && streetOf[k] >= 0) continue;
        tiles[k] = C.r; streetOf[k] = eid[L.sref[lk]];
        continue;
      }
      tiles[k] = L.t[lk];
      const s = L.sref[lk];
      streetOf[k] = s < 0 ? -1 : s < 4 ? eid[s] : s === AVE ? 0 : lid[s - 5];
      if (L.planned[lk] === W_LOT) planned[k] = 1;
    }
    const addPlot = (lx, ly, w, h, kind) => {
      const x = x0 + lx, y = y0 + ly;
      const st = pickStreet(x, y, w, h);
      const id = plots.length;
      plots.push({ id, x, y, w, h, kind, streetId: st.sid, houseNumber: houseNumber(st.sid, st.rx, st.ry, st.lx, st.ly) });
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) occ[mi(xx, yy)] = 1;
      return id;
    };
    for (const sp of L.specials) addPlot(sp.lx, sp.ly, sp.w, sp.h, sp.kind);
    for (const hs of L.houses) fillOrder.push(addPlot(hs.lx, hs.ly, 1, 1, 'house'));
    for (const lm of L.landmarks) {
      landmarks.push({ id: lm.id, name: lm.name, kind: lm.kind, x: x0 + lm.lx, y: y0 + lm.ly, w: lm.w, h: lm.h });
      for (let yy = 0; yy < lm.h; yy++) for (let xx = 0; xx < lm.w; xx++) occ[mi(x0 + lm.lx + xx, y0 + lm.ly + yy)] = 1;
    }
  }

  // 6. Windmill among the fields (or in the margin if the map has no countryside chunk).
  {
    let placed = false;
    const tryAt = (x, y) => {
      for (let yy = y; yy < y + 2; yy++) for (let xx = x; xx < x + 2; xx++) {
        if (!inMap(xx, yy) || tiles[mi(xx, yy)] === C.r || occ[mi(xx, yy)] || tiles[mi(xx, yy)] === C.w) return false;
      }
      for (let yy = y; yy < y + 2; yy++) for (let xx = x; xx < x + 2; xx++) { tiles[mi(xx, yy)] = C.g; occ[mi(xx, yy)] = 1; }
      landmarks.push({ id: 'windmill', name: 'Old Mill', kind: 'windmill', x, y, w: 2, h: 2 });
      return true;
    };
    if (windmill) {
      const bx = windmill[0] * P - 1, by = windmill[1] * P - 1;
      for (let r = 0; r < 6 && !placed; r++) for (let dy = -r; dy <= r && !placed; dy++) for (let dx = -r; dx <= r && !placed; dx++) placed = tryAt(bx + dx, by + dy);
    }
    if (!placed) {
      const ang = wantAng, rr = R * P + HP + MARGIN / 2;
      placed = tryAt(Math.round(Math.cos(ang) * rr) - 1, Math.round(Math.sin(ang) * rr) - 1) || tryAt(xmin + 2, ymin + 2);
    }
  }

  // 7. Scatter trees on leftover grass inside town (never on planned lots).
  for (const L of unlocked) {
    const x0 = L.cx * P - HP, y0 = L.cy * P - HP;
    for (let ly = 1; ly < P; ly++) for (let lx = 1; lx < P; lx++) {
      const x = x0 + lx, y = y0 + ly, k = mi(x, y);
      if (tiles[k] === C.g && !occ[k] && !planned[k] && hash01(seedHash, x, y, 7) < 0.05) tiles[k] = C.t;
    }
  }

  // Map coordinates.
  for (const p of plots) { p.x -= xmin; p.y -= ymin; }
  for (const l of landmarks) { l.x -= xmin; l.y -= ymin; }

  let str = '';
  for (let i = 0; i < tiles.length; i += 8192) str += String.fromCharCode.apply(null, tiles.subarray(i, i + 8192));

  return {
    seed, width, height, tiles: str, streets, plots, landmarks, fillOrder,
    originX: -xmin, originY: -ymin, rings: R, chunks: unlocked.length, houseCapacity: fillOrder.length,
    streetOf, // Int32Array per tile, street id of each road tile (-1 elsewhere); not serialised
  };
}

/**
 * Move residents in, in order. residents[i] gets house plot fillOrder[i].
 * Mutates city.plots (residentId) and returns residents with plotId set.
 * Append-only: calling again with more residents (same order) keeps earlier homes.
 */
export function assignResidents(city, residents) {
  if (residents.length > city.fillOrder.length) {
    throw new Error(`city has ${city.fillOrder.length} house plots but ${residents.length} residents; build with capacityFor(n)`);
  }
  for (const p of city.plots) delete p.residentId;
  return residents.map((r, i) => {
    const plotId = city.fillOrder[i];
    city.plots[plotId].residentId = r.id;
    return { ...r, plotId };
  });
}

/** Plot id the next resident (0-based index `count`) will move into, or -1 if full. */
export function nextFreePlot(city, count) {
  return count < city.fillOrder.length ? city.fillOrder[count] : -1;
}

/** Assemble a CityData object (see src/types.ts). Field order matches the type. */
export function toCityData(city, residents, { name = 'Kinsburg', account = 'kinsburgtown', foundedISO = '2026-11-11', demo = true } = {}) {
  return {
    name, account, foundedISO,
    width: city.width, height: city.height, tiles: city.tiles,
    streets: city.streets,
    plots: city.plots.map((p) => {
      const o = { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, kind: p.kind, streetId: p.streetId, houseNumber: p.houseNumber };
      if (p.residentId) o.residentId = p.residentId;
      return o;
    }),
    landmarks: city.landmarks,
    residents: residents.map((r) => ({
      id: r.id, handle: r.handle, number: r.number, joinedDay: r.joinedDay, job: r.job,
      plotId: r.plotId, houseStyle: r.houseStyle, perks: r.perks,
      ...(r.level ? { level: r.level } : {}),
      ...(r.follower ? { follower: true } : {}),
    })),
    demo,
  };
}

// ---------------------------------------------------------------- validation & preview

const LANDMARK_KINDS = ['townhall', 'fountain', 'monument', 'lighthouse', 'windmill', 'market'];
const PERKS = ['star', 'goldRoof', 'monument', 'street'];
const HANDLE_RE = /^[a-z0-9._]{1,30}$/; // Instagram: 1-30 chars

/** Throws on the first broken invariant; returns a stats object otherwise. */
export function validateCityData(d, { jobs, streetOf } = {}) {
  const fail = (msg) => { throw new Error('city invalid: ' + msg); };
  const { width: W, height: H, tiles } = d;
  if (!d.name || !d.account || !/^\d{4}-\d{2}-\d{2}$/.test(d.foundedISO)) fail('header');
  if (typeof d.demo !== 'boolean') fail('demo flag');
  if (tiles.length !== W * H) fail(`tiles length ${tiles.length} != ${W}*${H}`);
  for (let i = 0; i < tiles.length; i++) if (!TILE_CHARS.includes(tiles[i])) fail(`bad tile '${tiles[i]}' at ${i}`);
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? '' : tiles[y * W + x]);
  d.streets.forEach((s, i) => { if (s.id !== i || !s.name) fail(`street ${i}`); });
  if (new Set(d.streets.map((s) => s.name)).size !== d.streets.length) fail('duplicate street names');
  if (streetOf) {
    for (let i = 0; i < tiles.length; i++) if (tiles[i] === 'r' && !(streetOf[i] >= 0 && streetOf[i] < d.streets.length)) fail(`road tile ${i % W},${(i / W) | 0} has no street`);
  }
  const occ = new Int32Array(W * H).fill(-1);
  const claim = (x, y, w, h, who, allowed) => {
    if (!(Number.isInteger(x) && Number.isInteger(y) && w >= 1 && h >= 1)) fail(`${who} coords`);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const t = at(xx, yy);
      if (!t) fail(`${who} out of bounds`);
      if (!allowed.includes(t)) fail(`${who} on tile '${t}' at ${xx},${yy}`);
      if (occ[yy * W + xx] >= 0) fail(`${who} overlaps at ${xx},${yy}`);
      occ[yy * W + xx] = 1;
    }
  };
  const touches = (x, y, w, h) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (at(xx - 1, yy) === 'r' || at(xx + 1, yy) === 'r' || at(xx, yy - 1) === 'r' || at(xx, yy + 1) === 'r') return true;
    }
    return false;
  };
  const addr = new Set();
  let houses = 0, occupied = 0, shops = 0, civic = 0;
  d.plots.forEach((p, i) => {
    if (p.id !== i) fail(`plot id ${p.id} at index ${i}`);
    if (!['house', 'shop', 'civic'].includes(p.kind)) fail(`plot ${i} kind`);
    if (p.kind === 'house' && (p.w !== 1 || p.h !== 1)) fail(`house ${i} size`);
    claim(p.x, p.y, p.w, p.h, `plot ${i}`, 'g');
    if (!touches(p.x, p.y, p.w, p.h)) fail(`plot ${i} does not touch a road`);
    if (!d.streets[p.streetId]) fail(`plot ${i} street`);
    if (!(p.houseNumber >= 1)) fail(`plot ${i} house number`);
    const a = p.streetId + ':' + p.houseNumber;
    if (addr.has(a)) fail(`duplicate address ${d.streets[p.streetId].name} ${p.houseNumber}`);
    addr.add(a);
    if (p.kind === 'house') { houses++; if (p.residentId) occupied++; }
    else if (p.residentId) fail(`non-house plot ${i} has a resident`);
    if (p.kind === 'shop') shops++;
    if (p.kind === 'civic') civic++;
  });
  const kinds = new Set();
  d.landmarks.forEach((l) => {
    if (!LANDMARK_KINDS.includes(l.kind)) fail(`landmark kind ${l.kind}`);
    kinds.add(l.kind);
    claim(l.x, l.y, l.w, l.h, `landmark ${l.id}`, l.kind === 'monument' ? 'gp' : 'gz');
  });
  for (const k of LANDMARK_KINDS) if (!kinds.has(k)) fail(`missing landmark ${k}`);
  const ids = new Set();
  let lastDay = 0;
  d.residents.forEach((r, i) => {
    if (r.number !== i + 1) fail(`resident ${i} number ${r.number}`);
    if (!HANDLE_RE.test(r.handle) || r.id !== r.handle.toLowerCase()) fail(`resident handle ${r.handle}`);
    if (ids.has(r.id)) fail(`duplicate resident ${r.id}`);
    ids.add(r.id);
    if (!(Number.isInteger(r.joinedDay) && r.joinedDay >= 1 && r.joinedDay >= lastDay)) fail(`joinedDay ${r.joinedDay} at #${r.number}`);
    lastDay = r.joinedDay;
    if (jobs && !jobs.includes(r.job)) fail(`job ${r.job}`);
    if (!(Number.isInteger(r.houseStyle) && r.houseStyle >= 0 && r.houseStyle <= 11)) fail(`houseStyle ${r.houseStyle}`);
    if (!Array.isArray(r.perks) || r.perks.some((p) => !PERKS.includes(p))) fail(`perks of ${r.id}`);
    const p = d.plots[r.plotId];
    if (!p || p.kind !== 'house' || p.residentId !== r.id) fail(`resident ${r.id} plot link`);
  });
  if (occupied !== d.residents.length) fail(`occupied plots ${occupied} != residents ${d.residents.length}`);
  return { houses, occupied, spare: houses - occupied, sparePct: houses ? (100 * (houses - occupied)) / houses : 0, shops, civic, streets: d.streets.length, landmarks: d.landmarks.length };
}

/** Downsampled ASCII overview (each char = a block of tiles). */
export function asciiMap(d, cols = 60, rows = 30) {
  const { width: W, height: H, tiles } = d;
  const sx = Math.max(1, Math.ceil(W / cols)), sy = Math.max(1, Math.ceil(H / rows));
  const kindAt = new Map();
  for (const p of d.plots) for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) kindAt.set(y * W + x, p.kind === 'house' ? (p.residentId ? '#' : 'o') : p.kind === 'shop' ? '$' : 'C');
  const lmChar = { townhall: 'H', fountain: 'F', monument: 'M', lighthouse: 'L', windmill: 'W', market: 'K' };
  const tileChar = { g: '.', r: '+', w: '~', p: '"', z: '=', f: ',', t: '^', s: ':' };
  const weight = { '#': 1.6, o: 1.2, $: 3, C: 3, '+': 1, '~': 1.2, '"': 1.3, '=': 2, ',': 1, '^': 0.9, ':': 1.1, '.': 0.6 };
  const out = [];
  for (let by = 0; by < H; by += sy) {
    let line = '';
    for (let bx = 0; bx < W; bx += sx) {
      let lm = '';
      for (const l of d.landmarks) if (l.x < bx + sx && l.x + l.w > bx && l.y < by + sy && l.y + l.h > by) lm = lmChar[l.kind];
      if (lm) { line += lm; continue; }
      const cnt = {};
      for (let y = by; y < Math.min(H, by + sy); y++) for (let x = bx; x < Math.min(W, bx + sx); x++) {
        const c = kindAt.get(y * W + x) || tileChar[tiles[y * W + x]];
        cnt[c] = (cnt[c] || 0) + weight[c];
      }
      let bestC = '.', bestV = -1;
      for (const c in cnt) if (cnt[c] > bestV) { bestV = cnt[c]; bestC = c; }
      line += bestC;
    }
    out.push(line);
  }
  return out.join('\n');
}
