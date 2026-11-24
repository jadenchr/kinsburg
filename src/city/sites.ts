// Build sites and secret spots: fixed places in the city for things that are added over time.
//
// Rules (everything is derived from the CityData alone, so the browser and the reel agree):
//  • The map is a grid of 20x20-tile neighbourhoods ("chunks") that the layout engine unlocks in a
//    fixed order; every chunk's content depends only on (seed, chunk coordinates). The map window
//    is re-centred as the city grows, so sites are worked out in WORLD coordinates (map minus the
//    origin) and per chunk. A chunk's sites never change once it is unlocked; new chunks only append.
//  • Unlock order is read from the plots: plot ids are handed out chunk by chunk in unlock order.
//  • A site is a plain grass or park tile that can never be a house: no house lot (a grass tile
//    next to a road) on it or touching it, no shop, civic lot or landmark touching it, nowhere near
//    water, trees or roads that would make it look wrong. Because a house can only ever stand on a
//    grass tile with a road beside it, and every site keeps a tile of clearance from all of those,
//    a site can never collide with a house that moves in later (even in a half-filled chunk).
//  • Inside a chunk, sites come in tiers so builds are seen: the town square first, then open
//    ground with nothing in front, then the rest; within a tier parks first, 2 tiles apart.
//  • Build #k goes on site k. Secrets are chosen first and never share a tile with a site.
import { TILE, type CityData } from '../types';
import { HH, HW, hash } from './iso';
import { capacityFor } from '../../shared/city-layout.mjs';
import { RESIDENTIAL_ONLY } from '../../shared/builds.mjs';

const P = 20; // CHUNK in shared/city-layout.mjs
const HP = P / 2;
const MARGIN = 6;

export interface Spot {
  /** map tile */
  x: number;
  y: number;
  /** index of the chunk in unlock order */
  chunk: number;
  /** build sites only: 0 town square, 1 open (nothing in front), 2 partly hidden */
  tier?: number;
}

export type SecretKind = 'garden' | 'well' | 'fairy' | 'chest' | 'bench' | 'gnomes';

export interface SecretSpot extends Spot {
  /** 0-based, fixed: the order of SECRETS */
  index: number;
  kind: SecretKind;
  name: string;
}

/** The six hidden spots. Names are shown only once found. */
export const SECRETS: { kind: SecretKind; name: string }[] = [
  { kind: 'garden', name: 'Secret Garden' },
  { kind: 'well', name: 'Wishing Well' },
  { kind: 'fairy', name: 'Fairy Ring' },
  { kind: 'chest', name: 'Old Treasure Chest' },
  { kind: 'bench', name: 'Hidden Bench' },
  { kind: 'gnomes', name: 'Tiny Gnome Village' },
];

export interface Sites {
  builds: Spot[];
  secrets: SecretSpot[];
  /** chunk (unlock index) of each house plot, in move-in order */
  houseChunks: number[];
}

interface Cand {
  x: number;
  y: number;
  ch: string;
  h: number;
  water: boolean;
  trees: number;
  /** neighbours (of 8) that are houses, shops or landmarks: the more, the more cramped */
  crowd: number;
  /** houses, shops or landmarks on the tiles in front (towards the viewer) that would hide a tall sprite */
  front: number;
  /** tree tiles in front, which hide a sprite as well as a house does */
  frontTrees: number;
  /** a landmark (town hall, fountain, market…) touches this tile */
  byLandmark: boolean;
}

/** The chunk (by unlock index) a secret lives in, and what tile it needs. If that chunk isn't unlocked yet, the secret simply isn't there yet. */
const PLACE: Record<SecretKind, { chunks: number[]; ok: (c: Cand) => boolean }> = {
  garden: { chunks: [2], ok: (c) => c.ch === TILE.park || (c.ch === TILE.trees && c.trees >= 1) },
  well: { chunks: [0], ok: (c) => c.ch === TILE.grass || c.ch === TILE.park },
  fairy: { chunks: [2], ok: (c) => c.trees >= 2 && c.ch !== TILE.sand },
  chest: { chunks: [1], ok: (c) => c.ch === TILE.sand || (c.ch === TILE.grass && c.water) },
  bench: { chunks: [1], ok: (c) => c.water && c.ch !== TILE.trees },
  gnomes: { chunks: [1], ok: (c) => c.ch === TILE.trees && c.trees >= 2 },
};

const cache = new WeakMap<CityData, Sites>();

export function computeSites(data: CityData): Sites {
  const hit = cache.get(data);
  if (hit) return hit;
  const out = compute(data);
  cache.set(data, out);
  return out;
}

function compute(data: CityData): Sites {
  const empty: Sites = { builds: [], secrets: [], houseChunks: [] };
  const W = data.width, H = data.height;
  // width = (2R + 1) * CHUNK + 1 + 2 * MARGIN
  const R = ((W - 1 - 2 * MARGIN) / P - 1) / 2;
  if (!Number.isInteger(R) || R < 0 || W !== H || data.tiles.length !== W * H) return empty;
  const origin = R * P + HP + MARGIN; // map = world + origin
  const chunkOf = (mx: number, my: number) => {
    const ax = mx - origin + HP, ay = my - origin + HP;
    const cx = Math.floor(ax / P), cy = Math.floor(ay / P);
    return { cx, cy, lx: ax - cx * P, ly: ay - cy * P };
  };
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? '' : data.tiles[y * W + x]);

  // what stands on each tile: 1 = shop / civic lot / landmark, 2 = house plot
  const stand = new Uint8Array(W * H);
  const firstId = new Map<string, number>();
  const mark = (x: number, y: number, w: number, h: number, v: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) stand[yy * W + xx] = Math.max(stand[yy * W + xx], v);
  };
  for (const p of data.plots) {
    mark(p.x, p.y, p.w, p.h, p.kind === 'house' ? 2 : 1);
    const c = chunkOf(p.x, p.y);
    const key = c.cx + ',' + c.cy;
    const prev = firstId.get(key);
    if (prev === undefined || p.id < prev) firstId.set(key, p.id);
  }
  for (const l of data.landmarks) mark(l.x, l.y, l.w, l.h, 1);

  // chunks in unlock order
  const chunks = [...firstId.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const chunkIndex = new Map(chunks.map((k, i) => [k, i]));

  // a tile where a house could stand (now or later): bare grass with a road beside it
  const lotish = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (at(x, y) !== TILE.grass || stand[y * W + x] === 1) continue;
      // the border roads of a chunk may only appear once the chunk next to it is built, so a tile
      // beside the border counts as a possible house lot from the start (keeps sites stable)
      const c = chunkOf(x, y);
      const byBorder = c.lx === 1 || c.ly === 1 || c.lx === P - 1 || c.ly === P - 1;
      if (byBorder || at(x - 1, y) === TILE.road || at(x + 1, y) === TILE.road || at(x, y - 1) === TILE.road || at(x, y + 1) === TILE.road) lotish[y * W + x] = 1;
    }
  // Neighbour checks never look into the next chunk (it may not be unlocked yet, and what it
  // becomes would then change this chunk's sites): outside this chunk's interior counts as nothing.
  const near = (x: number, y: number, r: number, f: (xx: number, yy: number) => boolean) => {
    const c0 = chunkOf(x, y);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const lx = c0.lx + dx, ly = c0.ly + dy;
        if (lx < 1 || ly < 1 || lx >= P || ly >= P) continue; // the border lines change when the next chunk is built
        if (f(x + dx, y + dy)) return true;
      }
    return false;
  };

  const perChunk: Cand[][] = chunks.map(() => []);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ch = at(x, y);
      if (ch !== TILE.grass && ch !== TILE.park && ch !== TILE.trees && ch !== TILE.sand && ch !== TILE.plaza) continue;
      const c = chunkOf(x, y);
      if (c.lx < 1 || c.lx >= P || c.ly < 1 || c.ly >= P) continue; // roads run along the border
      const ci = chunkIndex.get(c.cx + ',' + c.cy);
      if (ci === undefined) continue; // countryside: not part of the town yet
      // the newest chunk is still filling in (its parks, trees and lots appear as people move in),
      // so nothing is placed there until the next chunk opens; the centre chunk is always complete
      if (ci === chunks.length - 1 && ci !== 0) continue;
      const i = y * W + x;
      if (stand[i] || lotish[i]) continue;
      let crowd = 0;
      near(x, y, 1, (xx, yy) => ((xx !== x || yy !== y) && xx >= 0 && yy >= 0 && xx < W && yy < H && (lotish[yy * W + xx] === 1 || stand[yy * W + xx] === 1) ? (crowd++, false) : false));
      const c0 = c;
      let front = 0, frontTrees = 0;
      // the tiles drawn in front of this one, up to 3 steps (tall houses and the monument reach that far)
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2], [2, 0], [0, 2], [2, 2], [3, 1], [1, 3], [3, 2], [2, 3], [3, 3]] as const) {
        const xx = x + dx, yy = y + dy;
        const c1 = chunkOf(xx, yy);
        // past this chunk's edge we can't know what will stand there (the next chunk may not exist
        // yet), so count it as blocked: only sites whose whole view lies inside the chunk are "open"
        if (c1.lx < 1 || c1.ly < 1 || c1.lx >= P || c1.ly >= P || c1.cx !== c0.cx || c1.cy !== c0.cy) { front++; continue; }
        if (xx < W && yy < H && (lotish[yy * W + xx] === 1 || stand[yy * W + xx] >= 1)) front++; // any house tile, not just its road side
        else if (at(xx, yy) === TILE.trees) frontTrees++;
      }
      const byLandmark = near(x, y, 1, (xx, yy) => xx >= 0 && yy >= 0 && xx < W && yy < H && stand[yy * W + xx] === 1);
      let trees = 0;
      near(x, y, 1, (xx, yy) => ((xx !== x || yy !== y) && at(xx, yy) === TILE.trees ? (trees++, false) : false));
      perChunk[ci].push({
        x, y, ch, trees, crowd, front, frontTrees, byLandmark,
        h: hash(x - origin, y - origin, 4242),
        water: near(x, y, 2, (xx, yy) => at(xx, yy) === TILE.water),
      });
    }

  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const secrets: SecretSpot[] = [];
  const taken: { x: number; y: number }[][] = chunks.map(() => []);
  SECRETS.forEach((def, index) => {
    const rule = PLACE[def.kind];
    // one fixed home chunk per secret (no fallbacks to other chunks: that would move it later)
    for (const ci of rule.chunks.slice(0, 1)) {
      if (ci >= chunks.length) continue;
      const pool = perChunk[ci]
        .filter((c) => rule.ok(c) && !taken[ci].some((t) => cheb(t, c) < 4))
        .sort((a, b) => hash(a.x - origin, a.y - origin, 100 + index) - hash(b.x - origin, b.y - origin, 100 + index));
      if (!pool.length) continue;
      const c = pool[0];
      taken[ci].push(c);
      secrets.push({ x: c.x, y: c.y, chunk: ci, index, kind: def.kind, name: def.name });
      return;
    }
  });

  // Builds should be seen, so inside each chunk sites come in three tiers:
  //   0  the town square (paved, open, in every Reel), clear of its landmarks
  //   1  open ground with nothing in front (no house, shop or tree on the tiles towards the viewer)
  //   2  everything else that is safe, used only once a chunk's better sites are taken
  // Tiers are per chunk, so the order stays prefix-stable as the city grows.
  // The sponsor billboard stands in the south-west of the town square (drawBillboard in index.ts:
  // anchored 2 tiles left of and 4.2 below the town hall, a 124 x 86 px panel). Keep square sites
  // out of its way so it never hides a build (a sprite is up to 114 px tall and a tile wide).
  const th = data.landmarks.find((l) => l.kind === 'townhall');
  const underBillboard = (c: Cand) => {
    if (!th) return false;
    const gx = th.x - 2, gy = th.y + th.h + 4.2;
    const bx = (gx - gy) * HW, by = (gx + gy) * HH + HH;
    const sx = (c.x - c.y) * HW, sy = (c.x + c.y + 1) * HH;
    const pad = 10;
    return sx + HW > bx - 62 - pad && sx - HW < bx + 62 + pad && sy + HH > by - 86 - pad && sy - 114 < by + pad;
  };
  const tier = (c: Cand) => (c.ch === TILE.plaza ? 0 : c.front === 0 && c.frontTrees === 0 && c.crowd <= 1 ? 1 : 2);
  // within a tier: parks, then open grass, then clearings among the trees
  const rank = (c: Cand) => (c.ch === TILE.park || c.ch === TILE.plaza ? 0 : c.ch === TILE.grass ? 1 : 1.6) + c.h * 0.9 + c.crowd * 0.3 + c.front * 0.8;
  const builds: Spot[] = [];
  perChunk.forEach((list, ci) => {
    const pick: Cand[] = [];
    const ordered = list
      .filter((c) => c.ch !== TILE.sand)
      .filter((c) => !(c.ch === TILE.plaza && (c.byLandmark || underBillboard(c)))) // keep the town hall, fountain, market and billboard readable
      .filter((c) => !near(c.x, c.y, 1, (xx, yy) => at(xx, yy) === TILE.water))
      .sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b));
    for (const c of ordered) {
      if (taken[ci].some((t) => cheb(t, c) < 2)) continue;
      if (pick.some((t) => cheb(t, c) < 2)) continue;
      pick.push(c);
    }
    // spread out within each tier: each next site is the one farthest from those already used,
    // so early builds don't crowd each other (ties and the first pick follow the seeded rank)
    const used: Cand[] = [];
    for (const t of [0, 1, 2]) {
      const left = pick.filter((c) => tier(c) === t);
      while (left.length) {
        let best = 0, bestD = -1;
        left.forEach((c, k) => {
          const d = used.length ? Math.min(...used.map((u) => (u.x - c.x) ** 2 + (u.y - c.y) ** 2)) : 1e9 - k;
          if (d > bestD) { bestD = d; best = k; }
        });
        const [c] = left.splice(best, 1);
        used.push(c);
        builds.push({ x: c.x, y: c.y, chunk: ci, tier: t });
      }
    }
  });
  const houseChunks = data.plots
    .filter((p) => p.kind === 'house')
    .sort((a, b) => a.id - b.id)
    .map((p) => { const c = chunkOf(p.x, p.y); return chunkIndex.get(c.cx + ',' + c.cy) ?? 0; });
  return { builds, secrets, houseChunks };
}

/**
 * Where each build stands. Builds are placed in id order; each takes the best free site (town
 * square, then open ground, then the rest; earlier chunks first within a tier) among the chunks
 * that existed when it was built (its `pop`, the highest resident number then). That depends only
 * on numbers stored with the builds, so a build never moves when the city grows. A build without
 * a pop (demo data) uses today's city. RESIDENTIAL_ONLY kinds (universities) skip the centre chunk
 * and the town square and go to the best spot in a neighbourhood.
 */
export function assignBuildSites(sites: Sites, builds: { id: number; pop?: number | null; kind?: string }[]): Map<number, Spot> {
  const out = new Map<number, Spot>();
  const chunkCount = sites.houseChunks.length ? sites.houseChunks[sites.houseChunks.length - 1] + 1 : 0;
  // the city builds chunks until it has capacityFor(n) house plots, so the last one needed is that plot's chunk
  const chunksAt = (pop: number) => {
    const need = Math.min(sites.houseChunks.length, capacityFor(Math.max(1, pop)));
    return need ? sites.houseChunks[need - 1] + 1 : chunkCount;
  };
  const used = new Uint8Array(sites.builds.length);
  for (const b of [...builds].sort((x, y) => x.id - y.id)) {
    if (out.has(b.id)) continue;
    // only chunks that were complete then: the newest one was still filling in (see computeSites)
    const limit = Math.max(1, (b.pop ? chunksAt(b.pop) : chunkCount) - 1);
    // universities and the like belong in the neighbourhoods: never the centre chunk or the square
    const residential = !!b.kind && RESIDENTIAL_ONLY.includes(b.kind);
    let best = -1;
    for (let i = 0; i < sites.builds.length; i++) {
      const s = sites.builds[i];
      if (used[i] || s.chunk >= limit) continue;
      if (residential && (s.chunk === 0 || s.tier === 0)) continue;
      if (best < 0 || (s.tier ?? 2) < (sites.builds[best].tier ?? 2)) best = i;
      if ((s.tier ?? 2) === 0) break; // nothing beats the town square
    }
    if (best < 0) continue;
    used[best] = 1;
    out.set(b.id, sites.builds[best]);
  }
  return out;
}
