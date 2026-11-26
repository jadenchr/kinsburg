// The Christmas look (only while src/season.ts says it's on): snow on roofs, strings of fairy lights,
// the giant tree on the town square, and the per-frame overlays (falling snow, light twinkle,
// Santa's sleigh).
//
// Baked into the chunk cache: roof snow, bulbs (steady), the tree. Drawn every frame, as light overlays
// only: snowfall, twinkle, sleigh. Every one of those is a pure function of the frame time `t` (ms)
// the renderer hands in and of seeded hashes, never the wall clock or Math.random, so a reel frame
// is identical on every run.
import { XMAS, alpha, mix, type SkyState } from '../theme';
import { christmasOn } from '../season';
import { HH, HW, fillPoly, hash, projX, projY, sideShade, box, material, type Proj } from './iso';
import type { Model, Obj } from './model';

const TAU = Math.PI * 2;

export const xmasOn = christmasOn;

// ── sky for helpers that are not handed one (hipRoof is shared with the builds) ────────────────
let curSky: SkyState | null = null;
/** drawEntry tells us which sky the next sprite is lit with */
export function setSnowSky(sky: SkyState): void {
  curSky = sky;
}
export const snowSky = () => curSky;

// ── snow colours ────────────────────────────────────────────────────────────────────────────────
export interface SnowMat {
  top: string;
  l: string;
  r: string;
  /** ground snow */
  ground: string;
}
const snowCache = new WeakMap<SkyState, SnowMat>();
export function snowMat(sky: SkyState): SnowMat {
  let m = snowCache.get(sky);
  if (!m) {
    const pal = sky.palette;
    const sh = sideShade(sky);
    // daylight: white with a breath of the sky; night: moonlit blue-grey
    const lit = mix(mix(XMAS.snow, pal.skyBottom, 0.14), pal.skyTop, 0.5 * sky.darkness);
    const shade = mix(XMAS.snowShade, pal.skyTop, 0.5 * sky.darkness);
    m = {
      top: lit,
      l: mix(lit, shade, 0.75 * sh.l),
      r: mix(lit, shade, 0.75 * sh.r),
      ground: mix(mix(XMAS.snow, pal.skyBottom, 0.1), pal.skyTop, 0.46 * sky.darkness),
    };
    snowCache.set(sky, m);
  }
  return m;
}

type V3 = readonly [number, number, number];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A drift of snow on a roof slope: from the ridge (R0–R1) down towards the eave (E0–E1), stopping
 * `f` of the way so the roof colour still shows along the eave. A hip end is a triangle (R0 = R1).
 */
export function snowFace(ctx: CanvasRenderingContext2D, p: Proj, col: string, E0: V3, E1: V3, R0: V3, R1: V3, f = 0.78): void {
  const a = lerp3(R0, E0, f);
  const b = lerp3(R1, E1, f);
  fillPoly(ctx, p, [...R0, ...R1, ...b, ...a], col);
}

/** Snow on a flat top (u0..u1, v0..v1 at height z), a little inside the edge. */
export function snowTop(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, u0: number, u1: number, v0: number, v1: number, z: number, inset = 0.03): void {
  fillPoly(ctx, p, [u0 + inset, v0 + inset, z, u1 - inset, v0 + inset, z, u1 - inset, v1 - inset, z, u0 + inset, v1 - inset, z], snowMat(sky).top);
}

/** Snow on the hip roof drawn by hipRoof() (services.ts). */
export function snowHip(ctx: CanvasRenderingContext2D, p: Proj, E1: number, E2: number, z0: number, z1: number, r: number): void {
  const sky = curSky;
  if (!sky) return;
  const m = snowMat(sky);
  snowFace(ctx, p, m.r, [E1, E2, z0], [E1, -E2, z0], [r, 0, z1], [r, 0, z1]);
  snowFace(ctx, p, m.l, [-E1, E2, z0], [E1, E2, z0], [-r, 0, z1], [r, 0, z1]);
}

// ── fairy lights ────────────────────────────────────────────────────────────────────────────────
export interface Bulb {
  x: number;
  y: number;
  /** index into XMAS.lights */
  c: number;
  /** twinkle phase, 0..TAU */
  ph: number;
}

const SPACING = 0.085;
const SCALLOP = 0.34;
const SAG = 0.028;

/** Bulbs along a flat [u,v,z,…] polyline, hanging in little scallops. */
function walkString(p: Proj, path: readonly number[], seed: number, base: number, out: Bulb[]): void {
  let d = 0; // distance walked
  let next = SPACING * (0.3 + 0.5 * hash(seed, base, 1));
  let k = 0;
  for (let i = 0; i + 5 < path.length; i += 3) {
    const [u0, v0, z0, u1, v1, z1] = [path[i], path[i + 1], path[i + 2], path[i + 3], path[i + 4], path[i + 5]];
    const L = Math.hypot(u1 - u0, v1 - v0, z1 - z0);
    if (L < 1e-6) continue;
    while (next <= d + L) {
      const t = (next - d) / L;
      const u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
      const z = z0 + (z1 - z0) * t - SAG * Math.sin(Math.PI * ((next % SCALLOP) / SCALLOP));
      out.push({ x: projX(p, u, v), y: projY(p, u, v, z), c: (k + Math.floor(hash(seed, 7) * 5)) % XMAS.lights.length, ph: hash(seed, base * 64 + k, 3) * TAU });
      k++;
      next += SPACING;
    }
    d += L;
  }
}

/** Every bulb of a house's strings, in world px (also drives the twinkle overlay). */
export function lightPoints(p: Proj, paths: readonly (readonly number[])[], seed: number): Bulb[] {
  const out: Bulb[] = [];
  paths.forEach((path, i) => walkString(p, path, seed, i, out));
  return out;
}

/** Draw strings along rooflines: a thin wire with its bulbs, softly lit at night, quiet by day. */
export function drawLights(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, paths: readonly (readonly number[])[], seed: number, detail: number, k = 1): void {
  if (detail < 1) return;
  const pal = sky.palette;
  const glow = sky.glow;
  const r = (detail >= 2 ? 1.3 : 1.05) * k;
  const cores: Path2D[] = XMAS.lights.map(() => new Path2D());
  const halos: Path2D[] = XMAS.lights.map(() => new Path2D());
  ctx.save();
  ctx.lineWidth = 0.7 * k;
  ctx.strokeStyle = alpha(mix(pal.edge, '#000000', 0.2), 0.45);
  ctx.lineJoin = 'round';
  paths.forEach((path, i) => {
    const bulbs: Bulb[] = [];
    walkString(p, path, seed, i, bulbs);
    if (bulbs.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(projX(p, path[0], path[1]), projY(p, path[0], path[1], path[2]));
    for (const b of bulbs) ctx.lineTo(b.x, b.y + 0.6 * k);
    ctx.stroke();
    for (const b of bulbs) {
      cores[b.c].moveTo(b.x + r, b.y + 0.6 * k);
      cores[b.c].arc(b.x, b.y + 0.6 * k, r, 0, TAU);
      if (glow > 0.05 && detail >= 2) {
        halos[b.c].moveTo(b.x + r * 2.8, b.y + 0.6 * k);
        halos[b.c].arc(b.x, b.y + 0.6 * k, r * 2.8, 0, TAU);
      }
    }
  });
  for (let c = 0; c < XMAS.lights.length; c++) {
    const col = XMAS.lights[c];
    if (glow > 0.05 && detail >= 2) {
      ctx.fillStyle = alpha(col, 0.2 * glow);
      ctx.fill(halos[c]);
    }
    // by day a muted dot, at night the colour at full strength with a pale centre
    ctx.fillStyle = glow > 0.05 ? mix(mix(col, pal.skyTop, 0.1 * (1 - glow)), '#ffffff', 0.2 * glow) : mix(col, pal.wall, 0.35);
    ctx.fill(cores[c]);
  }
  ctx.restore();
}

// ── the giant tree ──────────────────────────────────────────────────────────────────────────────
const TREE_H = 168; // base to apex, world px
const TREE_R = 46; // radius of the lowest skirt

/** The tile the tree needs to keep clear around it (reach, world px) and how tall it stands. */
export const TREE_HEIGHT = TREE_H + 30;
export const TREE_REACH = 58;

function treeBulbs(cx: number, cy: number): Bulb[] {
  const out: Bulb[] = [];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const s = (i + 0.5) / N;
    const a = s * TAU * 9;
    if (Math.cos(a) < -0.1) continue; // round the back
    const h = 0.05 + s * 0.88;
    const rad = TREE_R * (1 - h * 0.86) + 2;
    out.push({
      x: cx + Math.sin(a) * rad * 0.94,
      y: cy - 12 - h * (TREE_H - 20) + Math.cos(a) * rad * 0.2,
      c: i % XMAS.lights.length,
      ph: hash(i, 5, 17) * TAU,
    });
  }
  return out;
}

function star5(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? R : r;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

export function drawTree(ctx: CanvasRenderingContext2D, _o: Obj, sky: SkyState, detail: number, p: Proj): void {
  const pal = sky.palette;
  const sh = sideShade(sky);
  const snow = snowMat(sky);
  const glow = sky.glow;
  const night = sky.darkness;
  const cx = p.cx, cy = p.cy;
  const pineL = mix(mix(XMAS.pine, pal.skyTop, 0.45 * night), mix(XMAS.pineDeep, pal.skyTop, 0.45 * night), sh.l);
  const pineR = mix(mix(XMAS.pine, pal.skyTop, 0.45 * night), mix(XMAS.pineDeep, pal.skyTop, 0.45 * night), sh.r);

  // snow drift + warm pool of light under the tree
  ctx.beginPath();
  ctx.ellipse(cx, cy + 4, TREE_R * 1.12, TREE_R * 0.52, 0, 0, TAU);
  ctx.fillStyle = alpha(snow.ground, 0.92);
  ctx.fill();
  if (glow > 0.04 && detail >= 1) {
    ctx.save();
    ctx.translate(cx, cy + 4);
    ctx.scale(1, 0.5);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, TREE_R * 1.9);
    g.addColorStop(0, alpha(XMAS.garland, 0.5 * glow));
    g.addColorStop(0.6, alpha(XMAS.garland, 0.14 * glow));
    g.addColorStop(1, alpha(XMAS.garland, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, TREE_R * 1.9, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  // trunk
  ctx.fillStyle = mix(pal.farm, pal.edge, 0.65);
  ctx.fillRect(cx - 5, cy - 16, 10, 18);

  // six skirts, bottom first
  const tiers = 6;
  for (let i = 0; i < tiers; i++) {
    const r = TREE_R * (1 - i * 0.14);
    const yb = cy - 12 - i * 24;
    const apex = yb - (50 - i * 4);
    // left half lit by the side the sun is on, right half the other
    ctx.beginPath();
    ctx.moveTo(cx, apex);
    ctx.lineTo(cx - r, yb);
    ctx.ellipse(cx, yb, r, r * 0.42, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fillStyle = pineL;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, apex);
    ctx.lineTo(cx + r, yb);
    ctx.ellipse(cx, yb, r, r * 0.42, 0, 0, Math.PI / 2, false);
    ctx.lineTo(cx, apex);
    ctx.closePath();
    ctx.fillStyle = pineR;
    ctx.fill();
    // frost along the lower edge of the skirt
    if (detail >= 1) {
      ctx.beginPath();
      ctx.ellipse(cx, yb, r - 1, r * 0.42 - 0.5, 0, 0.12, Math.PI - 0.12, false);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = alpha(snow.top, 0.75);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  const topY = cy - 12 - (tiers - 1) * 24 - (50 - (tiers - 1) * 4);

  if (detail >= 1) {
    // golden garland spiralling down the front
    ctx.beginPath();
    let pen = false;
    const G = 90;
    for (let i = 0; i <= G; i++) {
      const s = i / G;
      const a = s * TAU * 4.5 + 0.6;
      const front = Math.cos(a);
      const h = 0.07 + s * 0.8;
      const rad = TREE_R * (1 - h * 0.86) + 1;
      const x = cx + Math.sin(a) * rad;
      const y = cy - 12 - h * (TREE_H - 20) + front * rad * 0.2;
      if (front < 0) {
        pen = false;
        continue;
      }
      if (!pen) {
        ctx.moveTo(x, y);
        pen = true;
      } else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 1.9;
    ctx.strokeStyle = mix(XMAS.garland, pal.skyTop, 0.35 * night);
    ctx.stroke();

    // baubles
    const N = 34;
    for (let i = 0; i < N; i++) {
      const h = 0.1 + hash(i, 1, 41) * 0.72;
      const a = (hash(i, 2, 41) - 0.5) * 2.5;
      const rad = TREE_R * (1 - h * 0.86) - 3;
      const x = cx + Math.sin(a) * rad;
      const y = cy - 12 - h * (TREE_H - 20) + Math.cos(a) * rad * 0.2 - 2;
      const col = XMAS.baubles[i % XMAS.baubles.length];
      ctx.beginPath();
      ctx.arc(x, y, 3.3, 0, TAU);
      ctx.fillStyle = mix(col, pal.skyTop, 0.38 * night);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x - 1, y - 1, 0.95, 0, TAU);
      ctx.fillStyle = alpha('#ffffff', 0.7 - 0.3 * night);
      ctx.fill();
    }
  }

  // the string of lights (steady here; the overlay adds the twinkle)
  if (detail >= 1) {
    const bulbs = treeBulbs(cx, cy);
    const cores: Path2D[] = XMAS.lights.map(() => new Path2D());
    const halos: Path2D[] = XMAS.lights.map(() => new Path2D());
    for (const b of bulbs) {
      cores[b.c].moveTo(b.x + 1.9, b.y);
      cores[b.c].arc(b.x, b.y, 1.9, 0, TAU);
      if (glow > 0.05) {
        halos[b.c].moveTo(b.x + 6, b.y);
        halos[b.c].arc(b.x, b.y, 6, 0, TAU);
      }
    }
    for (let c = 0; c < XMAS.lights.length; c++) {
      const col = XMAS.lights[c];
      if (glow > 0.05) {
        ctx.fillStyle = alpha(col, 0.22 * glow);
        ctx.fill(halos[c]);
      }
      ctx.fillStyle = glow > 0.05 ? mix(col, '#ffffff', 0.25 * glow) : mix(col, pal.wall, 0.3);
      ctx.fill(cores[c]);
    }
  }

  // star
  const sy = topY - 7;
  if (glow > 0.04) {
    const g = ctx.createRadialGradient(cx, sy, 0, cx, sy, 34);
    g.addColorStop(0, alpha(XMAS.star, 0.65 * glow));
    g.addColorStop(1, alpha(XMAS.star, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, sy, 34, 0, TAU);
    ctx.fill();
  }
  star5(ctx, cx, sy, 13, 5.6);
  ctx.fillStyle = mix(XMAS.star, '#ffffff', 0.25 * glow);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = alpha('#9a6b00', 0.55);
  ctx.stroke();

  // presents round the foot of the tree, in front of it
  const gifts: [number, number, number, number, string, string][] = [
    [0.12, 0.44, 0.13, 0.12, '#d6453d', '#f7d56a'],
    [-0.2, 0.46, 0.11, 0.1, '#3f7de0', '#f4f6fb'],
    [0.38, 0.28, 0.1, 0.1, '#4aa86a', '#f7d56a'],
    [-0.42, 0.26, 0.1, 0.13, '#c94fb0', '#f4f6fb'],
  ];
  for (const [u, v, w, h, c, rib] of gifts) {
    const m = material(sky, c);
    box(ctx, p, u - w / 2, u + w / 2, v - w / 2, v + w / 2, 0, h, m.top, m.l, m.r);
    if (detail >= 1) {
      const rm = material(sky, rib);
      fillPoly(ctx, p, [u - 0.012, v - w / 2, h + 0.001, u + 0.012, v - w / 2, h + 0.001, u + 0.012, v + w / 2, h + 0.001, u - 0.012, v + w / 2, h + 0.001], rm.top);
      fillPoly(ctx, p, [u - w / 2, v - 0.012, h + 0.001, u + w / 2, v - 0.012, h + 0.001, u + w / 2, v + 0.012, h + 0.001, u - w / 2, v + 0.012, h + 0.001], rm.top);
    }
  }
}

// ── tree placement ──────────────────────────────────────────────────────────────────────────────
/**
 * The tile for the giant tree: a free plaza tile close to the town hall that is clear of every
 * build site, every landmark (and, strictly, their 8 neighbours) and the sponsor billboard. It only
 * reads the layout (tiles, landmarks) and the fixed build-site list, which do not change as
 * builds are added, so the tree never moves or collides.
 */
export function pickTreeTile(
  m: { W: number; H: number; tile: Uint8Array; occ: Int32Array; townhall?: { x: number; y: number; w: number; h: number } },
  plazaCode: number,
  sites: readonly { x: number; y: number }[],
  landmarks: readonly { x: number; y: number; w: number; h: number }[],
): { x: number; y: number } | null {
  const th = m.townhall;
  if (!th) return null;
  const { W, H } = m;
  const near = (x: number, y: number, list: readonly { x: number; y: number }[]) => list.some((s) => Math.abs(s.x - x) <= 1 && Math.abs(s.y - y) <= 1);
  // the tree's silhouette as three bands (half-width by height above/below its base point, world px)
  const bands: [number, number, number][] = [[-TREE_HEIGHT, -112, 26], [-112, -52, 42], [-52, 30, 56]];
  const hits = (cx: number, cy: number, r: { x0: number; x1: number; y0: number; y1: number }) =>
    bands.some(([a, b, hw]) => cx + hw > r.x0 && cx - hw < r.x1 && cy + b > r.y0 && cy + a < r.y1);
  const base = (x: number, y: number) => ({ cx: (x - y) * HW, cy: (x + y) * HH + HH });
  // sponsor billboard: anchored 2 left of and 4.2 below the town hall, a 124 x 86 px panel (see drawBillboard)
  const bgx = th.x - 2, bgy = th.y + th.h + 4.2;
  const bx = (bgx - bgy) * HW, by = (bgx + bgy) * HH + HH;
  const board = { x0: bx - 62 - 6, x1: bx + 62 + 6, y0: by - 86 - 6, y1: by + 6 };
  // the town hall's sprite: don't stand in front of it
  const hall = { x0: (th.x - th.y - th.h) * HW - 8, x1: (th.x + th.w - th.y) * HW + 8, y0: (th.x + th.y) * HH - 144, y1: (th.x + th.w + th.y + th.h) * HH + 4 };
  const hallDepth = th.x + th.w - 1 + th.y + th.h - 1;
  const lmNear = (x: number, y: number, k: number) => landmarks.some((l) => x >= l.x - k && x < l.x + l.w + k && y >= l.y - k && y < l.y + l.h + k);
  const cands: { x: number; y: number; score: number }[] = [];
  const cxT = th.x + th.w / 2, cyT = th.y + th.h / 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (m.tile[y * W + x] !== plazaCode || m.occ[y * W + x] >= 0) continue;
      if (near(x, y, sites)) continue;
      cands.push({ x, y, score: Math.hypot(x + 0.5 - cxT, y + 0.5 - cyT) });
    }
  // Strictest first: off the 8 neighbours of every landmark, not in front of the town hall, clear of the
  // billboard panel on screen; relax those (billboard first: it is drawn over the tree anyway) only if
  // the square has no such tile. Build sites and their neighbours are never relaxed.
  const covers = (c: { x: number; y: number }) => c.x + c.y > hallDepth && hits(base(c.x, c.y).cx, base(c.x, c.y).cy, hall);
  const onBoard = (c: { x: number; y: number }) => hits(base(c.x, c.y).cx, base(c.x, c.y).cy, board);
  const levels: ((c: { x: number; y: number }) => boolean)[] = [
    (c) => !lmNear(c.x, c.y, 1) && !covers(c) && !onBoard(c),
    (c) => !lmNear(c.x, c.y, 1) && !covers(c),
    (c) => !lmNear(c.x, c.y, 1),
    (c) => !lmNear(c.x, c.y, 0),
  ];
  for (const ok of levels) {
    const list = cands.filter(ok);
    if (!list.length) continue;
    list.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);
    return { x: list[0].x, y: list[0].y };
  }
  return null;
}

// ── twinkle overlay ─────────────────────────────────────────────────────────────────────────────
const houseIdx = new WeakMap<Model, number[]>();
let pathsFor: ((style: number, level: number) => number[][]) | null = null;
/** house.ts registers how a house's strings run (avoids an import cycle) */
export function registerHousePaths(fn: (style: number, level: number) => number[][]): void {
  pathsFor = fn;
}

export function drawTwinkle(
  ctx: CanvasRenderingContext2D, m: Model, sky: SkyState, t: number, S: number,
  v: { minX: number; maxX: number; minY: number; maxY: number },
): void {
  if (sky.glow < 0.1 || S < 1.1 || !pathsFor) return;
  let list = houseIdx.get(m);
  if (!list) {
    list = [];
    m.objs.forEach((o, i) => {
      if (o.kind === 'house' && o.resident && !o.resident.home) list!.push(i);
      if (o.kind === 'xmastree') list!.push(i);
    });
    houseIdx.set(m, list);
  }
  const bright: Path2D[] = XMAS.lights.map(() => new Path2D());
  const halo: Path2D[] = XMAS.lights.map(() => new Path2D());
  let any = false;
  const flick = (b: Bulb, i: number) => {
    const a = Math.sin(t * (0.0016 + 0.0012 * hash(i, b.c, 5)) + b.ph);
    return a;
  };
  for (const i of list) {
    const o = m.objs[i];
    if (o.maxX < v.minX - 40 || o.minX > v.maxX + 40 || o.maxY < v.minY - 20 || o.minY > v.maxY + 20) continue;
    const gx = o.x + o.w / 2, gy = o.y + o.h / 2;
    const p: Proj = { cx: (gx - gy) * HW, cy: (gx + gy) * HH, s: 64 };
    const bulbs = o.kind === 'xmastree' ? treeBulbs(p.cx, p.cy) : lightPoints(p, pathsFor(o.resident!.houseStyle, o.resident!.level ?? 0), o.seed);
    const big = o.kind === 'xmastree' ? 1.25 : 1;
    bulbs.forEach((b, k) => {
      const a = flick(b, k);
      if (a < 0.5) return;
      const r = (1.0 + (a - 0.5) * 1.1) * big;
      bright[b.c].moveTo(b.x + r, b.y + 0.6);
      bright[b.c].arc(b.x, b.y + 0.6, r, 0, TAU);
      halo[b.c].moveTo(b.x + r * 2.4, b.y + 0.6);
      halo[b.c].arc(b.x, b.y + 0.6, r * 2.4, 0, TAU);
      any = true;
    });
  }
  if (!any) return;
  for (let c = 0; c < XMAS.lights.length; c++) {
    ctx.fillStyle = alpha(XMAS.lights[c], 0.2 * sky.glow);
    ctx.fill(halo[c]);
    ctx.fillStyle = mix(XMAS.lights[c], '#ffffff', 0.45);
    ctx.globalAlpha = Math.min(1, sky.glow * 1.1);
    ctx.fill(bright[c]);
    ctx.globalAlpha = 1;
  }
}

// ── snowfall (screen space) ─────────────────────────────────────────────────────────────────────
const LAYERS = [
  { size: 1.0, speed: 26, sway: 5, par: 0.03, a: 0.55 },
  { size: 1.7, speed: 46, sway: 9, par: 0.07, a: 0.75 },
  { size: 2.6, speed: 78, sway: 14, par: 0.13, a: 0.92 },
];

/** Gentle snowfall. `t` ms; W/H device px. At most 220 flakes whatever the screen. */
export function drawSnowfall(
  ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number, t: number, camX: number, camY: number, S: number, sky: SkyState,
): void {
  const n = Math.min(220, Math.max(40, Math.floor((W * H) / (dpr * dpr) / 5000)));
  const ts = t / 1000;
  const flake = mix(mix('#ffffff', sky.palette.skyBottom, 0.1), sky.palette.skyTop, 0.2 * sky.darkness);
  const paths = LAYERS.map(() => new Path2D());
  const shade = LAYERS.map(() => new Path2D());
  for (let i = 0; i < n; i++) {
    const ly = i % 3;
    const L = LAYERS[ly];
    const r = L.size * dpr * (0.8 + 0.4 * hash(i, 3, 9));
    const sp = L.speed * dpr * (0.85 + 0.3 * hash(i, 4, 9));
    let x = hash(i, 1, 9) * W + Math.sin(ts * (0.5 + hash(i, 5, 9) * 0.6) + hash(i, 6, 9) * TAU) * L.sway * dpr + ts * 7 * dpr * (ly + 1) * 0.5 - camX * S * L.par;
    let y = hash(i, 2, 9) * H + sp * ts - camY * S * L.par;
    x = ((x % W) + W) % W;
    y = ((y % H) + H) % H;
    paths[ly].moveTo(x + r, y);
    paths[ly].arc(x, y, r, 0, TAU);
    shade[ly].moveTo(x + r + dpr * 0.7, y + dpr * 0.7);
    shade[ly].arc(x + dpr * 0.7, y + dpr * 0.7, r, 0, TAU);
  }
  ctx.save();
  for (let ly = 0; ly < 3; ly++) {
    if (sky.darkness < 0.5) {
      // against pale snow a flake needs a hint of shadow to be seen
      ctx.fillStyle = alpha(XMAS.snowShade, 0.5 * (1 - sky.darkness));
      ctx.fill(shade[ly]);
    }
    ctx.fillStyle = alpha(flake, LAYERS[ly].a);
    ctx.fill(paths[ly]);
  }
  ctx.restore();
}

// ── Santa's sleigh (screen space) ───────────────────────────────────────────────────────────────
interface Flight {
  s: number;
  dir: 1 | -1;
  yFrac: number;
}

/** Where the sleigh is at frame time `t` (ms), or null. Live: now and then; reel: a flight every 40 s. */
function flightAt(t: number, reel: boolean): Flight | null {
  const period = reel ? 40000 : 100000;
  const dur = reel ? 12000 : 18000;
  const k = Math.floor(t / period);
  const start = k * period + (k === 0 ? (reel ? 1500 : 6000) : (reel ? 3000 + hash(k, 1, 31) * 14000 : 12000 + hash(k, 1, 31) * 50000));
  const s = (t - start) / dur;
  if (s < 0 || s > 1) return null;
  return { s, dir: k === 0 || hash(k, 2, 31) < 0.5 ? 1 : -1, yFrac: 0.1 + 0.11 * hash(k, 3, 31) };
}

function deer(ctx: CanvasRenderingContext2D, x: number, y: number, ph: number, fill: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.4;
  // legs, mid-gallop
  const sw = Math.sin(ph) * 5;
  const sw2 = Math.sin(ph + 2.2) * 5;
  ctx.beginPath();
  ctx.moveTo(4, 2); ctx.lineTo(7 + sw, 9 - Math.abs(sw) * 0.3);
  ctx.moveTo(3, 2); ctx.lineTo(3 - sw2 * 0.4, 9);
  ctx.moveTo(-4, 2); ctx.lineTo(-7 - sw, 9 - Math.abs(sw) * 0.3);
  ctx.moveTo(-3, 2); ctx.lineTo(-2 + sw2 * 0.4, 9);
  ctx.stroke();
  // body, neck, head
  ctx.beginPath();
  ctx.ellipse(0, 0, 6.8, 3.2, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(3.5, -1.5); ctx.lineTo(9, -8); ctx.lineTo(11, -6); ctx.lineTo(6.5, 1);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(11, -8, 3.4, 1.9, 0.5, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-6, -1); ctx.lineTo(-9, -3);
  ctx.stroke();
  // antlers
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(10, -10); ctx.lineTo(8, -16); ctx.lineTo(5.5, -15);
  ctx.moveTo(8, -16); ctx.lineTo(9, -19);
  ctx.moveTo(11, -10); ctx.lineTo(12.5, -16); ctx.lineTo(15, -15);
  ctx.moveTo(12.5, -16); ctx.lineTo(12, -19);
  ctx.stroke();
  ctx.restore();
}

/**
 * Santa, four reindeer and a sparkle trail, crossing the night sky now and then. Screen space, a pure
 * function of `t` (ms). `reel` makes the flights come sooner so a short clip can catch one.
 */
export function drawSleigh(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number, t: number, sky: SkyState, reel: boolean): void {
  const dark = Math.max(0, Math.min(1, (sky.darkness - 0.55) / 0.25));
  if (dark <= 0) return;
  const f = flightAt(t, reel);
  if (!f) return;
  const pal = sky.palette;
  const cssW = W / dpr;
  const k = (Math.max(90, Math.min(220, cssW * 0.22)) * dpr) / 110; // px per sleigh unit (the whole team is ~110 units)
  const margin = 70 * k;
  const span = W + 2 * margin;
  const xAt = (s: number) => (f.dir > 0 ? -margin + s * span : W + margin - s * span);
  const yAt = (s: number) => H * f.yFrac + H * 0.07 * (1 - Math.sin(Math.PI * Math.max(0, Math.min(1, s)))) - Math.sin(s * 9) * 0.004 * H;
  const x = xAt(f.s), y = yAt(f.s);
  const ds = 0.002;
  const tilt = Math.atan2(yAt(f.s + ds) - yAt(f.s), Math.abs(xAt(f.s + ds) - xAt(f.s)));
  const ts = t / 1000;
  const fade = Math.min(1, f.s / 0.05, (1 - f.s) / 0.05) * dark;

  ctx.save();
  ctx.globalAlpha = fade;

  // sparkle trail
  const N = 30;
  for (let j = 0; j < N; j++) {
    const back = (34 * k + j * 6.2 * k) / span;
    const sj = f.s - back;
    const fr = 1 - j / N;
    const px = xAt(sj) + Math.sin(j * 1.9 + ts * 7) * 3 * k * (1 - fr * 0.5);
    const py = yAt(sj) + 4 * k + Math.cos(j * 2.3 + ts * 6) * 3.2 * k + j * 0.25 * k;
    const tw = 0.5 + 0.5 * Math.sin(ts * 9 + j * 1.3);
    const a = Math.pow(fr, 1.5) * (0.5 + 0.5 * tw);
    const r = (0.6 + fr * 1.9) * k;
    ctx.fillStyle = alpha(j % 3 === 0 ? '#ffffff' : XMAS.sparkle, 0.9 * a);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
    if (j % 4 === 1 && a > 0.25) {
      ctx.strokeStyle = alpha('#ffffff', 0.8 * a);
      ctx.lineWidth = Math.max(0.6, 0.5 * k);
      ctx.beginPath();
      ctx.moveTo(px - r * 2.6, py); ctx.lineTo(px + r * 2.6, py);
      ctx.moveTo(px, py - r * 2.6); ctx.lineTo(px, py + r * 2.6);
      ctx.stroke();
    }
  }

  ctx.translate(x, y);
  ctx.scale(f.dir, 1);
  ctx.rotate(tilt);
  ctx.scale(k, k);
  const sil = mix('#04060f', pal.skyTop, 0.3);
  const rim = alpha(mix('#dfe8ff', pal.skyBottom, 0.3), 0.5);
  ctx.lineJoin = 'round';

  // reins and reindeer (the lead one has the red nose)
  ctx.strokeStyle = sil;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(8, -2);
  const deerX = [30, 50, 70, 90];
  deerX.forEach((dx, i) => ctx.lineTo(dx - 4, -3 - i * 2.2));
  ctx.stroke();
  deerX.forEach((dx, i) => deer(ctx, dx, -2 - i * 2.2 + Math.sin(ts * 8 + i * 1.1) * 1.1, ts * 9 + i * 0.9, sil));
  // lead reindeer nose: a red glow
  const nx = 90 + 14.2, ny = -2 - 3 * 2.2 - 6.4 + Math.sin(ts * 8 + 3.3) * 1.1;
  const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, 14);
  ng.addColorStop(0, alpha(XMAS.nose, 0.85));
  ng.addColorStop(0.35, alpha(XMAS.nose, 0.3));
  ng.addColorStop(1, alpha(XMAS.nose, 0));
  ctx.fillStyle = ng;
  ctx.beginPath();
  ctx.arc(nx, ny, 14, 0, TAU);
  ctx.fill();
  ctx.fillStyle = mix(XMAS.nose, '#ffffff', 0.25);
  ctx.beginPath();
  ctx.arc(nx, ny, 1.9, 0, TAU);
  ctx.fill();

  // sleigh
  ctx.fillStyle = sil;
  ctx.strokeStyle = rim;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(-27, -12);
  ctx.lineTo(-27, 2);
  ctx.quadraticCurveTo(-26, 7, -19, 7);
  ctx.lineTo(5, 7);
  ctx.quadraticCurveTo(12, 7, 13, -3);
  ctx.quadraticCurveTo(13.5, -7, 10, -7.5);
  ctx.quadraticCurveTo(11, -3, 6, -3);
  ctx.lineTo(-18, -3);
  ctx.lineTo(-21, -12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = sil;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-24, 11); ctx.lineTo(8, 11); ctx.quadraticCurveTo(16, 11, 16, 3);
  ctx.moveTo(-14, 7); ctx.lineTo(-14, 11);
  ctx.moveTo(0, 7); ctx.lineTo(0, 11);
  ctx.stroke();
  // sack of presents
  ctx.fillStyle = sil;
  ctx.beginPath();
  ctx.ellipse(-22, -8, 5.5, 6.5, 0.2, 0, TAU);
  ctx.fill();
  // Santa: coat, head, hat with a pompom, arm on the reins
  ctx.fillStyle = mix(XMAS.sleigh, '#000000', 0.45);
  ctx.beginPath();
  ctx.ellipse(-10, -8, 5.2, 6, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = sil;
  ctx.beginPath();
  ctx.arc(-9, -16, 2.8, 0, TAU);
  ctx.fill();
  ctx.fillStyle = mix(XMAS.sleigh, '#ff2a2a', 0.35);
  ctx.beginPath();
  ctx.moveTo(-12.4, -17.4); ctx.lineTo(-5.8, -17.4); ctx.lineTo(-13.5, -25.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e9edf5';
  ctx.beginPath();
  ctx.arc(-13.8, -25.4, 1.5, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = mix(XMAS.sleigh, '#000000', 0.45);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-6, -10); ctx.lineTo(4, -5);
  ctx.stroke();
  // a lantern at the front of the sleigh
  const lg = ctx.createRadialGradient(10, -9, 0, 10, -9, 9);
  lg.addColorStop(0, alpha(XMAS.sparkle, 0.9));
  lg.addColorStop(1, alpha(XMAS.sparkle, 0));
  ctx.fillStyle = lg;
  ctx.beginPath();
  ctx.arc(10, -9, 9, 0, TAU);
  ctx.fill();
  ctx.restore();
}
