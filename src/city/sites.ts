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
//  • Inside a chunk, sites are picked greedily in a seeded order (parks first), 3 tiles apart.
//  • Build #k goes on site k. Secrets are chosen first and never share a tile with a site.
import { TILE, type CityData } from '../types';
import { hash } from './iso';

const P = 20; // CHUNK in shared/city-layout.mjs
const HP = P / 2;
const MARGIN = 6;

export interface Spot {
  /** map tile */
  x: number;
  y: number;
  /** index of the chunk in unlock order */
  chunk: number;
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
  const empty: Sites = { builds: [], secrets: [] };
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
      if (at(x - 1, y) === TILE.road || at(x + 1, y) === TILE.road || at(x, y - 1) === TILE.road || at(x, y + 1) === TILE.road) lotish[y * W + x] = 1;
    }
  // Neighbour checks never look into the next chunk (it may not be unlocked yet, and what it
  // becomes would then change this chunk's sites): outside this chunk's interior counts as nothing.
  const near = (x: number, y: number, r: number, f: (xx: number, yy: number) => boolean) => {
    const c0 = chunkOf(x, y);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const lx = c0.lx + dx, ly = c0.ly + dy;
        if (lx < 0 || ly < 0 || lx > P || ly > P) continue;
        if (f(x + dx, y + dy)) return true;
      }
    return false;
  };

  const perChunk: Cand[][] = chunks.map(() => []);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ch = at(x, y);
      if (ch !== TILE.grass && ch !== TILE.park && ch !== TILE.trees && ch !== TILE.sand) continue;
      const c = chunkOf(x, y);
      if (c.lx < 1 || c.lx >= P || c.ly < 1 || c.ly >= P) continue; // roads run along the border
      const ci = chunkIndex.get(c.cx + ',' + c.cy);
      if (ci === undefined) continue; // countryside: not part of the town yet
      const i = y * W + x;
      if (stand[i] || lotish[i]) continue;
      let crowd = 0;
      near(x, y, 1, (xx, yy) => ((xx !== x || yy !== y) && xx >= 0 && yy >= 0 && xx < W && yy < H && (lotish[yy * W + xx] === 1 || stand[yy * W + xx] === 1) ? (crowd++, false) : false));
      const c0 = c;
      let front = 0;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2], [2, 0], [0, 2], [2, 2]] as const) {
        const xx = x + dx, yy = y + dy;
        const c1 = chunkOf(xx, yy);
        if (c1.lx < 1 || c1.ly < 1 || c1.lx >= P || c1.ly >= P || c1.cx !== c0.cx || c1.cy !== c0.cy) continue;
        if (xx < W && yy < H && (lotish[yy * W + xx] === 1 || stand[yy * W + xx] === 1)) front++;
      }
      let trees = 0;
      near(x, y, 1, (xx, yy) => ((xx !== x || yy !== y) && at(xx, yy) === TILE.trees ? (trees++, false) : false));
      perChunk[ci].push({
        x, y, ch, trees, crowd, front,
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

  // parks first, then open grass, then clearings among the trees
  const rank = (c: Cand) => (c.ch === TILE.park ? 0 : c.ch === TILE.grass ? 1 : 1.6) + c.h * 0.9 + c.crowd * 0.3 + c.front * 0.8;
  const builds: Spot[] = [];
  perChunk.forEach((list, ci) => {
    const pick: Cand[] = [];
    const ordered = list
      .filter((c) => c.ch !== TILE.sand)
      .filter((c) => !near(c.x, c.y, 1, (xx, yy) => at(xx, yy) === TILE.water))
      .sort((a, b) => rank(a) - rank(b));
    for (const c of ordered) {
      if (taken[ci].some((t) => cheb(t, c) < 2)) continue;
      if (pick.some((t) => cheb(t, c) < 2)) continue;
      pick.push(c);
    }
    // spread out: each next site is the one farthest from those already used, so early builds
    // don't crowd each other (ties and the first pick follow the seeded rank)
    const left = [...pick];
    const used: Cand[] = [];
    while (left.length) {
      let best = 0, bestD = -1;
      left.forEach((c, k) => {
        const d = used.length ? Math.min(...used.map((u) => (u.x - c.x) ** 2 + (u.y - c.y) ** 2)) : 1e9 - k;
        if (d > bestD) { bestD = d; best = k; }
      });
      const [c] = left.splice(best, 1);
      used.push(c);
      builds.push({ x: c.x, y: c.y, chunk: ci });
    }
  });
  return { builds, secrets };
}
