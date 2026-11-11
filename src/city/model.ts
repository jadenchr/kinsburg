// Pre-processes CityData into flat arrays the renderer can walk quickly:
// tile codes, colour jitter, road neighbours, lamps, and depth-ordered draw entries.
import { TILE, type CityData, type Landmark, type Plot, type Resident } from '../types';
import { houseTop } from './house';
import { HW, HH, hash } from './iso';

export const T_GRASS = 0;
export const T_ROAD = 1;
export const T_WATER = 2;
export const T_PARK = 3;
export const T_PLAZA = 4;
export const T_FARM = 5;
export const T_TREES = 6;
export const T_SAND = 7;
export const TILE_TYPES = 8;

const CODE: Record<string, number> = {
  [TILE.grass]: T_GRASS,
  [TILE.road]: T_ROAD,
  [TILE.water]: T_WATER,
  [TILE.park]: T_PARK,
  [TILE.plaza]: T_PLAZA,
  [TILE.farm]: T_FARM,
  [TILE.trees]: T_TREES,
  [TILE.sand]: T_SAND,
};

export type ObjKind = 'house' | 'lot' | 'shop' | 'civic' | 'landmark' | 'trees' | 'bush' | 'lamp';

export interface Obj {
  kind: ObjKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** depth = x + y of the front-most footprint tile */
  depth: number;
  seed: number;
  /** height above ground, world px (for bounds and hit tests) */
  height: number;
  /** extra horizontal reach beyond the footprint, world px */
  reach: number;
  plot?: Plot;
  resident?: Resident;
  landmark?: Landmark;
  /** lamp: which side of the road the post stands on */
  lampU?: number;
  lampV?: number;
  /** world-space bounds */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const LANDMARK_HEIGHT: Record<Landmark['kind'], number> = {
  townhall: 140,
  fountain: 40,
  monument: 120,
  lighthouse: 165,
  windmill: 150,
  market: 44,
};

export interface Model {
  data: CityData;
  W: number;
  H: number;
  tile: Uint8Array;
  jit: Uint8Array;
  /** road neighbour bits: 1 x-1, 2 x+1, 4 y-1, 8 y+1 */
  road: Uint8Array;
  /** index into objs of the building covering each tile, -1 none */
  occ: Int32Array;
  objs: Obj[];
  /** CSR: entries anchored at tile i are entryList[entryStart[i] .. entryStart[i+1]) */
  entryStart: Int32Array;
  entryList: Int32Array;
  lamps: Int32Array;
  shimmer: Int32Array;
  animated: number[];
  byResident: Map<string, number>;
  residents: Map<string, Resident>;
  townhall: Landmark | undefined;
  /** tallest thing, world px — how far below the screen we must look for content */
  maxHeight: number;
}

export function buildModel(data: CityData): Model {
  const W = data.width;
  const H = data.height;
  const N = W * H;
  const tile = new Uint8Array(N);
  const jit = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    tile[i] = CODE[data.tiles[i]] ?? T_GRASS;
    const x = i % W;
    const y = (i / W) | 0;
    // low-frequency + per-tile noise so the grass reads as patches, not static
    const n = 0.55 * hash(x, y, 7) + 0.45 * hash(x >> 2, y >> 2, 11);
    jit[i] = Math.min(4, Math.floor(n * 5));
  }
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tile[y * W + x]);

  const road = new Uint8Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (tile[i] !== T_ROAD) continue;
      let m = 0;
      if (at(x - 1, y) === T_ROAD) m |= 1;
      if (at(x + 1, y) === T_ROAD) m |= 2;
      if (at(x, y - 1) === T_ROAD) m |= 4;
      if (at(x, y + 1) === T_ROAD) m |= 8;
      road[i] = m;
    }

  const residents = new Map<string, Resident>(data.residents.map((r) => [r.id, r]));
  const objs: Obj[] = [];
  const occ = new Int32Array(N).fill(-1);

  const add = (o: Omit<Obj, 'minX' | 'maxX' | 'minY' | 'maxY' | 'depth'>, solid: boolean): number => {
    const obj = o as Obj;
    obj.depth = o.x + o.w - 1 + o.y + o.h - 1;
    obj.minX = (o.x - o.y - o.h) * HW - o.reach;
    obj.maxX = (o.x + o.w - o.y) * HW + o.reach;
    obj.minY = (o.x + o.y) * HH - o.height - 4;
    obj.maxY = (o.x + o.w + o.y + o.h) * HH + 4;
    const idx = objs.push(obj) - 1;
    if (solid)
      for (let yy = o.y; yy < o.y + o.h; yy++)
        for (let xx = o.x; xx < o.x + o.w; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) occ[yy * W + xx] = idx;
    return idx;
  };

  for (const lm of data.landmarks) {
    add({ kind: 'landmark', x: lm.x, y: lm.y, w: lm.w, h: lm.h, seed: hash(lm.x, lm.y, 3) * 1e6, height: LANDMARK_HEIGHT[lm.kind], reach: lm.kind === 'windmill' ? 60 : 8, landmark: lm }, true);
  }
  for (const pl of data.plots) {
    const res = pl.residentId ? residents.get(pl.residentId) : undefined;
    const seed = (pl.id * 2654435761) >>> 0;
    if (pl.kind === 'house') {
      if (res) add({ kind: 'house', x: pl.x, y: pl.y, w: 1, h: 1, seed, height: houseTop(res.houseStyle, res.perks) * 64 + 6, reach: 0, plot: pl, resident: res }, true);
      else add({ kind: 'lot', x: pl.x, y: pl.y, w: 1, h: 1, seed, height: 10, reach: 0, plot: pl }, true);
    } else {
      add({ kind: pl.kind, x: pl.x, y: pl.y, w: pl.w, h: pl.h, seed, height: pl.kind === 'civic' ? 72 : 46, reach: 4, plot: pl, resident: res }, true);
    }
  }

  // trees, bushes and lamps on free tiles
  const lampList: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (occ[i] >= 0) continue;
      const t = tile[i];
      if (t === T_TREES) add({ kind: 'trees', x, y, w: 1, h: 1, seed: hash(x, y, 21) * 1e6, height: 52, reach: 6 }, false);
      else if (t === T_PARK && hash(x, y, 5) < 0.22) add({ kind: 'bush', x, y, w: 1, h: 1, seed: hash(x, y, 23) * 1e6, height: 26, reach: 4 }, false);
      else if (t === T_ROAD) {
        const m = road[i];
        const straightU = (m & 3) !== 0 && (m & 12) === 0;
        const straightV = (m & 12) !== 0 && (m & 3) === 0;
        if ((straightU || straightV) && hash(x, y, 9) < 0.26) {
          const side = hash(x, y, 10) < 0.5 ? -0.44 : 0.44;
          lampList.push(i);
          add({ kind: 'lamp', x, y, w: 1, h: 1, seed: 0, height: 44, reach: 4, lampU: straightU ? 0 : side, lampV: straightU ? side : 0 }, false);
        }
      }
    }

  // depth-ordered entries per anchor tile; multi-tile objects first on their diagonal
  const order = objs.map((_, i) => i);
  order.sort((a, b) => {
    const A = objs[a];
    const B = objs[b];
    if (A.depth !== B.depth) return A.depth - B.depth;
    const ma = A.w * A.h > 1 ? 0 : 1;
    const mb = B.w * B.h > 1 ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return A.x - B.x;
  });
  const anchored: number[][] = [];
  const anchorOf = (o: Obj) => Math.min(H - 1, o.y + o.h - 1) * W + Math.min(W - 1, o.x + o.w - 1);
  for (const i of order) {
    const a = anchorOf(objs[i]);
    (anchored[a] ??= []).push(i);
  }
  // Multi-tile objects can be overlapped by smaller things just in front of them that
  // sort earlier; redraw those right after the big object.
  for (let i = 0; i < objs.length; i++) {
    const A = objs[i];
    if (A.w * A.h <= 1) continue;
    const extra: number[] = [];
    for (let yy = A.y; yy < A.y + A.h + 3 && yy < H; yy++)
      for (let xx = A.x; xx < A.x + A.w + 3 && xx < W; xx++) {
        if (xx < A.x + A.w && yy < A.y + A.h) continue;
        for (const j of anchored[yy * W + xx] ?? []) {
          if (j !== i && objs[j].depth < A.depth) extra.push(j);
        }
      }
    if (!extra.length) continue;
    extra.sort((a, b) => objs[a].depth - objs[b].depth || objs[a].x - objs[b].x);
    const list = anchored[anchorOf(A)];
    const pos = list.indexOf(i);
    list.splice(pos + 1, 0, ...extra);
  }

  const entryStart = new Int32Array(N + 1);
  let total = 0;
  for (let i = 0; i < N; i++) {
    entryStart[i] = total;
    total += anchored[i]?.length ?? 0;
  }
  entryStart[N] = total;
  const entryList = new Int32Array(total);
  for (let i = 0, k = 0; i < N; i++) for (const j of anchored[i] ?? []) entryList[k++] = j;

  // water tiles safe to shimmer on top of (nothing tall right in front of them)
  const shimmer: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (tile[i] !== T_WATER) continue;
      let blocked = false;
      for (let dy = 0; dy <= 2 && !blocked; dy++)
        for (let dx = 0; dx <= 2 && !blocked; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < W && yy < H && occ[yy * W + xx] >= 0) blocked = true;
        }
      if (!blocked) shimmer.push(i);
    }

  const byResident = new Map<string, number>();
  const animated: number[] = [];
  let maxHeight = 0;
  objs.forEach((o, i) => {
    if (o.resident) byResident.set(o.resident.id, i);
    if (o.landmark && (o.landmark.kind === 'windmill' || o.landmark.kind === 'lighthouse' || o.landmark.kind === 'fountain')) animated.push(i);
    maxHeight = Math.max(maxHeight, o.height);
  });

  return {
    data, W, H, tile, jit, road, occ, objs, entryStart, entryList,
    lamps: Int32Array.from(lampList),
    shimmer: Int32Array.from(shimmer),
    animated, byResident, residents,
    townhall: data.landmarks.find((l) => l.kind === 'townhall'),
    maxHeight,
  };
}
