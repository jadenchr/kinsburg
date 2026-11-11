// Sky-derived colour table + the batched ground pass (tiles, road paint, crops, foam,
// map-edge cliffs, far-zoom tree blobs, streetlamp light pools).
import { COLORS, ROOFS, alpha, mix, type SkyState } from '../theme';
import { HH, HW, hash, sideShade } from './iso';
import {
  TILE_TYPES, T_FARM, T_GRASS, T_PARK, T_PLAZA, T_ROAD, T_SAND, T_TREES, T_WATER, type Model,
} from './model';

export interface Look {
  sky: SkyState;
  /** tile fill colours [type * 5 + jitter level] */
  tiles: string[];
  roadLine: string;
  curb: string;
  foam: string;
  crop: string;
  paving: string;
  cliffL: string;
  cliffR: string;
  cliffWL: string;
  cliffWR: string;
  treeLit: string;
  treeShade: string;
  treeL: string;
  treeR: string;
  treeHi: string;
  trunk: string;
  flowers: string[];
  lampPost: string;
  lampHead: string;
  dirt: string;
  fence: string;
  shadow: string;
  pool: string;
  plaza: string;
}

export function makeLook(sky: SkyState): Look {
  const p = sky.palette;
  const sh = sideShade(sky);
  const plaza = mix(p.sand, p.road, 0.45);
  const base: string[] = [];
  base[T_GRASS] = p.grass;
  base[T_ROAD] = p.road;
  base[T_WATER] = p.water;
  base[T_PARK] = p.park;
  base[T_PLAZA] = plaza;
  base[T_FARM] = p.farm;
  base[T_TREES] = mix(p.grass, p.treeShade, 0.18);
  base[T_SAND] = p.sand;
  const tiles: string[] = [];
  for (let t = 0; t < TILE_TYPES; t++)
    for (let l = 0; l < 5; l++) {
      const k = l / 4;
      let c: string;
      switch (t) {
        case T_ROAD: c = mix(base[t], p.edge, 0.06 * k); break;
        case T_WATER: c = mix(base[t], p.waterShine, 0.07 * k); break;
        case T_PLAZA: c = mix(base[t], p.edge, 0.05 * k); break;
        case T_SAND: c = mix(base[t], p.grassShade, 0.1 * k); break;
        default: c = mix(base[t], p.grassShade, 0.55 * k);
      }
      tiles[t * 5 + l] = c;
    }
  const earth = mix(p.farm, p.edge, 0.5);
  const earthD = mix(earth, p.edge, 0.45);
  const wEdge = mix(p.water, p.edge, 0.3);
  const wEdgeD = mix(wEdge, p.edge, 0.4);
  return {
    sky,
    tiles,
    roadLine: mix(p.roadLine, p.road, 0.15),
    curb: mix(p.road, p.wall, 0.35),
    foam: alpha(p.waterShine, 0.75),
    crop: mix(p.farm, p.grassShade, 0.6),
    paving: mix(plaza, p.edge, 0.14),
    cliffL: mix(earth, earthD, sh.l),
    cliffR: mix(earth, earthD, sh.r),
    cliffWL: mix(wEdge, wEdgeD, sh.l),
    cliffWR: mix(wEdge, wEdgeD, sh.r),
    treeLit: p.tree,
    treeShade: p.treeShade,
    treeL: mix(p.tree, p.treeShade, sh.l),
    treeR: mix(p.tree, p.treeShade, sh.r),
    treeHi: mix(p.tree, p.grass, 0.45),
    trunk: mix(p.farm, p.edge, 0.6),
    flowers: [mix(ROOFS[2], p.wall, 0.25), mix(ROOFS[1], p.wall, 0.2), mix(p.wall, p.park, 0.1)].map((c) => mix(c, p.skyTop, 0.45 * sky.darkness)),
    lampPost: mix(p.edge, p.road, 0.3),
    lampHead: sky.glow > 0.05 ? mix(p.wall, COLORS.glow, Math.min(1, sky.glow * 1.2)) : mix(p.wall, p.roadLine, 0.4),
    dirt: mix(mix(p.farm, p.sand, 0.5), p.edge, 0.12),
    fence: mix(p.wall, p.edge, 0.3),
    shadow: alpha(p.edge, 0.2 * (1 - 0.5 * sky.darkness)),
    pool: COLORS.glow,
    plaza,
  };
}

/** A rectangle of tiles, optionally narrowed to a diagonal band (screen culling). */
export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dMin: number;
  dMax: number;
  sMin: number;
  sMax: number;
}

/** Visit tiles in back-to-front order. */
export function eachTile(m: Model, r: Region, fn: (x: number, y: number, i: number) => void): void {
  const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0);
  const x1 = Math.min(m.W, r.x1), y1 = Math.min(m.H, r.y1);
  const s1 = Math.min(x1 + y1 - 2, r.sMax);
  for (let s = Math.max(x0 + y0, r.sMin); s <= s1; s++) {
    // d = x - y = 2x - s
    const xa = Math.max(x0, s - (y1 - 1), Math.ceil((s + r.dMin) / 2));
    const xb = Math.min(x1 - 1, s - y0, Math.floor((s + r.dMax) / 2));
    for (let x = xa; x <= xb; x++) {
      const y = s - x;
      fn(x, y, y * m.W + x);
    }
  }
}

const CLIFF = 22;

export function drawGround(
  ctx: CanvasRenderingContext2D,
  m: Model,
  look: Look,
  r: Region,
  detail: number,
  /** device px per world px — for hairline-proof tile overlap */
  scale: number,
  clip: boolean,
): void {
  const ex = 0.7 / scale;
  const paths: (Path2D | null)[] = new Array(TILE_TYPES * 5).fill(null);
  const cliffs: Path2D[] = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  let hasCliff = false;
  const dash = new Path2D();
  const curb = new Path2D();
  const crop = new Path2D();
  const foam = new Path2D();
  const paving = new Path2D();
  const blobS = new Path2D();
  const blobL = new Path2D();
  const flowers = [new Path2D(), new Path2D(), new Path2D()];
  const { W, H, tile, jit } = m;
  const isWater = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || tile[y * W + x] === T_WATER;

  eachTile(m, r, (x, y, i) => {
    const t = tile[i];
    const k = t * 5 + jit[i];
    const p = paths[k] ?? (paths[k] = new Path2D());
    const wx = (x - y) * HW;
    const wy = (x + y) * HH;
    p.moveTo(wx, wy - ex);
    p.lineTo(wx + HW + 2 * ex, wy + HH);
    p.lineTo(wx, wy + 2 * HH + ex);
    p.lineTo(wx - HW - 2 * ex, wy + HH);
    p.closePath();

    if (x === W - 1 || y === H - 1) {
      hasCliff = true;
      const w = t === T_WATER ? 2 : 0;
      if (x === W - 1) {
        const c = cliffs[w + 1];
        c.moveTo(wx, wy + 2 * HH);
        c.lineTo(wx + HW, wy + HH);
        c.lineTo(wx + HW, wy + HH + CLIFF);
        c.lineTo(wx, wy + 2 * HH + CLIFF + ex);
        c.closePath();
      }
      if (y === H - 1) {
        const c = cliffs[w];
        c.moveTo(wx - HW, wy + HH);
        c.lineTo(wx, wy + 2 * HH);
        c.lineTo(wx, wy + 2 * HH + CLIFF + ex);
        c.lineTo(wx - HW, wy + HH + CLIFF);
        c.closePath();
      }
    }

    if (detail >= 1) {
      // point at grid offset (a, b) inside this tile
      const gx = (a: number, b: number) => wx + (a - b) * HW;
      const gy = (a: number, b: number) => wy + (a + b) * HH;
      if (t === T_ROAD) {
        const mm = m.road[i];
        const u = (mm & 3) !== 0, v = (mm & 12) !== 0;
        if (u && !v) {
          dash.moveTo(gx(0.32, 0.5), gy(0.32, 0.5));
          dash.lineTo(gx(0.68, 0.5), gy(0.68, 0.5));
        } else if (v && !u) {
          dash.moveTo(gx(0.5, 0.32), gy(0.5, 0.32));
          dash.lineTo(gx(0.5, 0.68), gy(0.5, 0.68));
        }
        if (detail >= 2) {
          const c = 0.05;
          if (!(mm & 1)) { curb.moveTo(gx(c, 0), gy(c, 0)); curb.lineTo(gx(c, 1), gy(c, 1)); }
          if (!(mm & 2)) { curb.moveTo(gx(1 - c, 0), gy(1 - c, 0)); curb.lineTo(gx(1 - c, 1), gy(1 - c, 1)); }
          if (!(mm & 4)) { curb.moveTo(gx(0, c), gy(0, c)); curb.lineTo(gx(1, c), gy(1, c)); }
          if (!(mm & 8)) { curb.moveTo(gx(0, 1 - c), gy(0, 1 - c)); curb.lineTo(gx(1, 1 - c), gy(1, 1 - c)); }
        }
      } else if (t === T_FARM) {
        const alongU = ((x >> 2) + (y >> 2)) % 2 === 0;
        for (let q = 0.2; q < 0.9; q += 0.2) {
          if (alongU) { crop.moveTo(gx(0.08, q), gy(0.08, q)); crop.lineTo(gx(0.92, q), gy(0.92, q)); }
          else { crop.moveTo(gx(q, 0.08), gy(q, 0.08)); crop.lineTo(gx(q, 0.92), gy(q, 0.92)); }
        }
      } else if (t === T_WATER) {
        const f = 0.07;
        if (!isWater(x - 1, y)) { foam.moveTo(gx(f, 0), gy(f, 0)); foam.lineTo(gx(f, 1), gy(f, 1)); }
        if (!isWater(x + 1, y)) { foam.moveTo(gx(1 - f, 0), gy(1 - f, 0)); foam.lineTo(gx(1 - f, 1), gy(1 - f, 1)); }
        if (!isWater(x, y - 1)) { foam.moveTo(gx(0, f), gy(0, f)); foam.lineTo(gx(1, f), gy(1, f)); }
        if (!isWater(x, y + 1)) { foam.moveTo(gx(0, 1 - f), gy(0, 1 - f)); foam.lineTo(gx(1, 1 - f), gy(1, 1 - f)); }
      } else if (t === T_PLAZA && detail >= 2) {
        paving.moveTo(gx(0, 0), gy(0, 0)); paving.lineTo(gx(1, 0), gy(1, 0)); paving.lineTo(gx(1, 1), gy(1, 1));
        paving.moveTo(gx(0.5, 0), gy(0.5, 0)); paving.lineTo(gx(0.5, 1), gy(0.5, 1));
        paving.moveTo(gx(0, 0.5), gy(0, 0.5)); paving.lineTo(gx(1, 0.5), gy(1, 0.5));
      } else if (t === T_PARK && detail >= 2 && m.occ[i] < 0) {
        for (let f = 0; f < 3; f++) {
          const a = 0.15 + 0.7 * hash(x, y, 30 + f), b = 0.15 + 0.7 * hash(x, y, 40 + f);
          const fp = flowers[f % 3];
          fp.moveTo(gx(a, b) + 1.6, gy(a, b));
          fp.arc(gx(a, b), gy(a, b), 1.6, 0, Math.PI * 2);
        }
      }
    } else if (t === T_TREES && m.occ[i] < 0) {
      const cx = wx, cy = wy + HH - 8;
      blobS.moveTo(cx + 22, cy);
      blobS.ellipse(cx, cy, 22, 15, 0, 0, Math.PI * 2);
      blobL.moveTo(cx + 15 - 4, cy - 4);
      blobL.ellipse(cx - 4, cy - 4, 15, 10, 0, 0, Math.PI * 2);
    }
  });

  for (let k = 0; k < paths.length; k++) {
    const p = paths[k];
    if (!p) continue;
    ctx.fillStyle = look.tiles[k];
    ctx.fill(p);
  }
  if (hasCliff) {
    const cc = [look.cliffL, look.cliffR, look.cliffWL, look.cliffWR];
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = cc[k];
      ctx.fill(cliffs[k]);
    }
  }
  if (detail >= 1) {
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = look.roadLine;
    ctx.stroke(dash);
    if (detail >= 2) {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = look.curb;
      ctx.stroke(curb);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = look.paving;
      ctx.stroke(paving);
      for (let f = 0; f < 3; f++) {
        ctx.fillStyle = look.flowers[f];
        ctx.fill(flowers[f]);
      }
    }
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = look.crop;
    ctx.stroke(crop);
    ctx.lineWidth = 2;
    ctx.strokeStyle = look.foam;
    ctx.stroke(foam);
    ctx.lineCap = 'butt';
  } else {
    ctx.fillStyle = look.treeShade;
    ctx.fill(blobS);
    ctx.fillStyle = look.treeLit;
    ctx.fill(blobL);
  }

  // streetlamp light pools (ground only — buildings are painted after)
  const glow = look.sky.glow;
  if (glow > 0.04 && m.lamps.length) {
    ctx.save();
    if (clip) {
      const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0), x1 = Math.min(W, r.x1), y1 = Math.min(H, r.y1);
      ctx.beginPath();
      ctx.moveTo((x0 - y0) * HW, (x0 + y0) * HH);
      ctx.lineTo((x1 - y0) * HW, (x1 + y0) * HH);
      ctx.lineTo((x1 - y1) * HW, (x1 + y1) * HH);
      ctx.lineTo((x0 - y1) * HW, (x0 + y1) * HH);
      ctx.closePath();
      ctx.clip();
    }
    const batch = new Path2D();
    const grow: Region = { x0: r.x0 - 1, y0: r.y0 - 1, x1: r.x1 + 1, y1: r.y1 + 1, dMin: r.dMin - 2, dMax: r.dMax + 2, sMin: r.sMin - 2, sMax: r.sMax + 2 };
    for (const ti of lampTiles(m, grow)) {
      const o = m.objs[ti];
      const gx = o.x + 0.5 + (o.lampU ?? 0) * 0.7;
      const gy = o.y + 0.5 + (o.lampV ?? 0) * 0.7;
      const cx = (gx - gy) * HW, cy = (gx + gy) * HH;
      if (detail >= 1) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, 0.5);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 46);
        g.addColorStop(0, alpha(look.pool, 0.5 * glow));
        g.addColorStop(0.55, alpha(look.pool, 0.16 * glow));
        g.addColorStop(1, alpha(look.pool, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, 46, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        batch.moveTo(cx + 30, cy);
        batch.ellipse(cx, cy, 30, 15, 0, 0, Math.PI * 2);
      }
    }
    if (detail < 1) {
      ctx.fillStyle = alpha(look.pool, 0.18 * glow);
      ctx.fill(batch);
    }
    ctx.restore();
  }
}

/** Lamp objects whose tile lies in the region. */
function lampTiles(m: Model, r: Region): number[] {
  const out: number[] = [];
  eachTile(m, r, (_x, _y, i) => {
    for (let k = m.entryStart[i]; k < m.entryStart[i + 1]; k++) {
      const o = m.objs[m.entryList[k]];
      if (o.kind === 'lamp' && o.y * m.W + o.x === i) out.push(m.entryList[k]);
    }
  });
  return out;
}
