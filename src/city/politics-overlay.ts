// Politics overlay: a protest crowd with signs on the town square, the mayor's flag and gold ring,
// candidates' yard signs during an election, and a ballot-box badge over the town hall while voting.
// Drawn every frame in world space right after the sim overlay (same conventions: occlusion by
// repainting what stands in front, culling to the view, deterministic from the frame time `t`).
// All positions are computed in setModel/setPolitics, never per frame.
import { COLORS, alpha, mix, type SkyState } from '../theme';
import type { TownPolitics } from '../data/town';
import { HH, HW, clamp, groundEllipse, hash } from './iso';
import { T_PLAZA, type Model, type Obj } from './model';
import { projFor } from './objects';
import type { DrawOpts, View } from './sim-overlay';

const TAU = Math.PI * 2;
const MAX_CROWD = 40;
const MAX_FRONT = 22;

export interface PoliticsOverlay {
  setModel(m: Model | null): void;
  setPolitics(p: TownPolitics | null): void;
  draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts): void;
}

interface Person {
  /** ground point, world px */
  x: number;
  y: number;
  /** grid tile it stands on (for occlusion repaint) */
  tx: number;
  ty: number;
  phase: number;
  shirt: string;
  sign: number; // 0 "!", 1 lines, 2 cross
  paper: string;
  mega: boolean;
  /** has something tall in front of its tile, so repaint after drawing */
  covered: boolean;
}

interface YardSign {
  x: number;
  y: number;
  tx: number;
  ty: number;
  color: string;
  tilt: number;
  covered: boolean;
}

const SHIRTS = ['#c8463d', '#2f5fb8', '#4c9a5a', '#e0a526', '#7a5aa8', '#2a9d9a', '#d9792c', '#555b66'];
const PAPERS = ['#fbf6e6', '#ffe27a', '#f4f1ea', '#ff9d8a', '#bfe3f2'];
const SIGN_INK = ['#c0281f', '#22262e', '#1f4fa8'];
const SIGN_COLORS = [
  ['#d83a2e', '#ffffff'],
  ['#2f5fb8', '#ffffff'],
  ['#f0b429', '#22262e'],
];

export function createPoliticsOverlay(): PoliticsOverlay {
  let model: Model | null = null;
  let pol: TownPolitics | null = null;
  let crowd: Person[] = [];
  let crowdBig = false;
  // crowd bounds (world): centre x, top y for the badge
  let crowdX = 0, crowdTop = 0, crowdMinX = 0, crowdMaxX = 0, crowdMinY = 0, crowdMaxY = 0;
  let signs: YardSign[] = [];
  let mayorObj: Obj | null = null;
  let hallObj: Obj | null = null;

  const houseByHandle = new Map<string, Obj>();

  function houseFor(handle: string): Obj | null {
    const key = handle.toLowerCase();
    return houseByHandle.get(key) ?? null;
  }

  /** Is anything solid on a tile in front of (tx, ty) (larger x+y within 3 tiles)? */
  function covered(m: Model, tx: number, ty: number): boolean {
    for (let dy = 0; dy <= 3; dy++)
      for (let dx = 0; dx <= 3; dx++) {
        if (!dx && !dy) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= m.W || y >= m.H) continue;
        if (m.occ[y * m.W + x] >= 0) return true;
      }
    return false;
  }

  function rebuild() {
    crowd = [];
    signs = [];
    mayorObj = null;
    hallObj = null;
    const m = model;
    if (!m) return;
    if (!houseByHandle.size) {
      for (const o of m.objs) if (o.resident) {
        houseByHandle.set(o.resident.id.toLowerCase(), o);
        houseByHandle.set(o.resident.handle.toLowerCase(), o);
      }
    }
    const th = m.townhall;
    if (th) hallObj = m.objs.find((o) => o.landmark === th) ?? null;
    if (!pol) return;
    if (pol.mayor) mayorObj = houseFor(pol.mayor.handle);
    if (pol.election) {
      for (const h of pol.election.candidates) {
        const o = houseFor(h);
        if (!o) continue;
        const k = signs.length;
        // front yard: the south-east corner of the tile (toward the camera), slightly off the road
        const gx = o.x + 0.84, gy = o.y + 0.9;
        const c = SIGN_COLORS[Math.floor(hash(o.x, o.y, 61) * SIGN_COLORS.length)];
        signs.push({
          x: (gx - gy) * HW, y: (gx + gy) * HH,
          tx: o.x, ty: o.y, color: c[0] + '|' + c[1], tilt: (hash(o.x, o.y, 62) - 0.5) * 0.3,
          covered: covered(m, o.x, o.y),
        });
        void k;
      }
    }
    if (pol.protest && pol.protest.count > 0 && th) buildCrowd(m, th, pol.protest.count, pol.protest.threshold);
  }

  function buildCrowd(m: Model, th: NonNullable<Model['townhall']>, count: number, threshold: number) {
    crowdBig = count >= threshold;
    const n = Math.min(MAX_CROWD, count * 2 + (crowdBig ? 8 : 0));
    // free plaza tiles just south of the hall, nearest the hall's front first
    const bill = { x: th.x - 2, y: th.y + th.h + 4.2 };
    const cx = th.x + th.w / 2, fy = th.y + th.h;
    const tiles: { x: number; y: number; d: number }[] = [];
    for (let y = fy; y <= fy + 4; y++)
      for (let x = Math.floor(cx - 4); x <= Math.ceil(cx + 3); x++) {
        if (x < 0 || y < 0 || x >= m.W || y >= m.H) continue;
        const i = y * m.W + x;
        if (m.tile[i] !== T_PLAZA || m.occ[i] >= 0) continue;
        // keep clear of the billboard's footprint and its posts
        if (Math.abs(x + 0.5 - bill.x) < 2.6 && Math.abs(y + 0.5 - bill.y) < 2.6) continue;
        // keep a one-tile margin around buildings in front so figures don't hide behind a roofline
        tiles.push({ x, y, d: Math.hypot(x + 0.5 - cx, (y + 0.5 - (fy + 1.2)) * 1.4) });
      }
    tiles.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
    // ~4 people per tile, spread on a jittered 2x2 grid
    const spots: { gx: number; gy: number; tx: number; ty: number }[] = [];
    for (const tl of tiles) {
      for (let s = 0; s < 4; s++) {
        const u = 0.27 + (s & 1) * 0.46 + (hash(tl.x, tl.y, 70 + s) - 0.5) * 0.14;
        const w = 0.27 + (s >> 1) * 0.46 + (hash(tl.x, tl.y, 80 + s) - 0.5) * 0.14;
        spots.push({ gx: tl.x + u, gy: tl.y + w, tx: tl.x, ty: tl.y });
      }
      if (spots.length >= n * 1.4) break;
    }
    // choose n spots with the nearest tiles first; spots are already ordered by tile distance
    const pick = spots.slice(0, n);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pick.forEach((s, i) => {
      const x = (s.gx - s.gy) * HW, y = (s.gx + s.gy) * HH;
      crowd.push({
        x, y, tx: s.tx, ty: s.ty,
        phase: hash(s.tx, s.ty, 90 + i) * TAU,
        shirt: SHIRTS[Math.floor(hash(i, 3, 91) * SHIRTS.length)],
        sign: Math.floor(hash(i, 5, 92) * 3),
        paper: PAPERS[Math.floor(hash(i, 7, 93) * PAPERS.length)],
        mega: false,
        covered: covered(m, s.tx, s.ty),
      });
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    if (crowdBig && pick.length) {
      // megaphone person standing out in front of the crowd
      const s = pick[0];
      const gx = s.gx + 0.15, gy = s.gy + 1.0;
      const tx = Math.floor(gx), ty = Math.floor(gy);
      const i = ty * m.W + tx;
      if (ty < m.H && m.tile[i] === T_PLAZA && m.occ[i] < 0) {
        const x = (gx - gy) * HW, y = (gx + gy) * HH;
        crowd.push({ x, y, tx, ty, phase: 1.3, shirt: '#d83a2e', sign: 0, paper: '#fff', mega: true, covered: covered(m, tx, ty) });
        maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      }
    }
    crowd.sort((a, b) => a.y - b.y || a.x - b.x);
    crowdX = (minX + maxX) / 2;
    crowdTop = minY - 22;
    crowdMinX = minX - 14; crowdMaxX = maxX + 14; crowdMinY = minY - 40; crowdMaxY = maxY + 14;
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  function draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts) {
    if (!model || !pol) return;
    const k = clamp(1 / S, 0.7, 3.2);
    const inView = (x: number, y: number, pad: number) => x > v.minX - pad && x < v.maxX + pad && y > v.minY - pad && y < v.maxY + pad;
    const dark = sky.darkness;

    // mayor: gold ring on the ground (front arc only, so it doesn't cut across the house)
    if (mayorObj && inView((mayorObj.minX + mayorObj.maxX) / 2, (mayorObj.minY + mayorObj.maxY) / 2, 120 + mayorObj.height)) {
      drawMayorRing(ctx, mayorObj, sky, t, k);
    }

    // yard signs
    if (signs.length) {
      let repainted = 0;
      for (const s of signs) {
        if (!inView(s.x, s.y, 30)) continue;
        drawYardSign(ctx, s, sky, k);
        if (S >= 0.5 && s.covered && repainted++ < MAX_FRONT) o.front(s.tx, s.ty, s.x, s.y - 8, 12, 14);
      }
    }

    // protest crowd
    if (crowd.length && crowdMaxX > v.minX && crowdMinX < v.maxX && crowdMaxY > v.minY && crowdMinY < v.maxY - 0) {
      let repainted = 0;
      const seen = new Set<number>();
      for (const p of crowd) {
        if (!inView(p.x, p.y, 20)) continue;
        drawProtester(ctx, p, sky, t, dark);
        const key = p.ty * 4096 + p.tx;
        if (S >= 0.5 && p.covered && repainted < MAX_FRONT && !seen.has(key)) {
          seen.add(key);
          repainted++;
          o.front(p.tx, p.ty, (p.tx + 0.5 - p.ty - 0.5) * HW, (p.tx + p.ty + 1) * HH - 8, 30, 22);
        }
      }
    }

    // flag + badges on top
    if (mayorObj && inView((mayorObj.minX + mayorObj.maxX) / 2, mayorObj.minY, 80)) drawFlag(ctx, mayorObj, sky, t, k);
    if (crowd.length && inView(crowdX, crowdTop, 60 * k)) drawBadge(ctx, crowdX, crowdTop, t, k, 'protest');
    if (pol.election?.phase === 'voting' && hallObj) {
      const p = projFor(hallObj);
      const top = p.cy - hallObj.height * 0.7;
      if (inView(p.cx - 20, top, 60 * k)) drawBadge(ctx, p.cx - 20, top - 8, t, k, 'ballot');
    }
  }

  function drawMayorRing(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, t: number, k: number) {
    const p = projFor(o);
    const pulse = 0.75 + 0.25 * Math.sin(t / 700);
    ctx.save();
    ctx.beginPath();
    // lower half of the diamond-ish ground ellipse
    ctx.rect(p.cx - 60, p.cy - 1, 120, 40);
    ctx.clip();
    groundEllipse(ctx, p, 0, 0, 0, 0.66);
    ctx.fillStyle = alpha(COLORS.gold, 0.12 * pulse);
    ctx.fill();
    ctx.lineWidth = Math.max(1.4, 1.1 * k);
    ctx.strokeStyle = alpha(COLORS.gold, (0.55 + 0.25 * (1 - sky.darkness)) * pulse);
    ctx.stroke();
    ctx.restore();
  }

  function drawFlag(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, t: number, k: number) {
    const p = projFor(o);
    const sc = Math.max(1, k * 0.85);
    const bx = p.cx + 3, by = p.cy - o.height * 0.88; // on the roof
    const h = 22 * sc;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = mix('#5a4a3a', sky.palette.skyTop, 0.3 * sky.darkness);
    ctx.lineWidth = 1.5 * sc;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx, by - h);
    ctx.stroke();
    // wavy flag
    const fw = 15 * sc, fh = 10 * sc;
    const gold = mix('#e9b824', sky.palette.skyTop, 0.25 * sky.darkness);
    ctx.fillStyle = gold;
    ctx.strokeStyle = alpha('#7a5a00', 0.8);
    ctx.lineWidth = 0.8 * sc;
    ctx.beginPath();
    const steps = 6;
    const wave = (i: number, y: number) => Math.sin(t / 240 + i * 0.9 + y * 0.1) * 1.4 * sc * (i / steps);
    ctx.moveTo(bx, by - h);
    for (let i = 1; i <= steps; i++) ctx.lineTo(bx + (fw * i) / steps, by - h + wave(i, 0));
    for (let i = steps; i >= 0; i--) ctx.lineTo(bx + (fw * i) / steps, by - h + fh + wave(i, fh));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // little star on the flag
    ctx.fillStyle = '#fff6cf';
    const sx = bx + fw * 0.4, sy = by - h + fh / 2 + wave(2, 0.5 * fh);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = (i & 1 ? 0.9 : 2.2) * sc, a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#b8860b';
    ctx.beginPath();
    ctx.arc(bx, by - h, 1.5 * sc, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawYardSign(ctx: CanvasRenderingContext2D, s: YardSign, sky: SkyState, k: number) {
    const sc = Math.max(1, k * 0.75);
    const [bg, fg] = s.color.split('|');
    const dk = sky.darkness * 0.35;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = alpha(sky.palette.edge, 0.22);
    ctx.beginPath();
    ctx.ellipse(1, 0.5, 4.5 * sc, 1.6 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(s.tilt);
    // two stakes
    ctx.fillStyle = mix('#8a6a40', sky.palette.skyTop, dk);
    ctx.fillRect(-2.6 * sc, -4 * sc, 1 * sc, 4.2 * sc);
    ctx.fillRect(1.6 * sc, -4 * sc, 1 * sc, 4.2 * sc);
    // board
    const w = 11 * sc, h = 7.5 * sc;
    ctx.fillStyle = mix(bg, sky.palette.skyTop, dk);
    ctx.strokeStyle = alpha('#1b1d22', 0.65);
    ctx.lineWidth = 0.7 * sc;
    ctx.beginPath();
    ctx.rect(-w / 2, -4 * sc - h, w, h);
    ctx.fill();
    ctx.stroke();
    // "VOTE": a band of short blocks, no real text
    ctx.fillStyle = mix(fg, sky.palette.skyTop, dk);
    const cy = -4 * sc - h / 2;
    for (let i = 0; i < 4; i++) ctx.fillRect(-w / 2 + 1.4 * sc + i * 2.3 * sc, cy - 1.7 * sc, 1.5 * sc, 3.4 * sc);
    ctx.fillRect(-w / 2 + 1.2 * sc, cy + 2.3 * sc, w - 2.4 * sc, 0.7 * sc);
    ctx.restore();
  }

  function drawProtester(ctx: CanvasRenderingContext2D, p: Person, sky: SkyState, t: number, dark: number) {
    const bob = Math.abs(Math.sin(t / 300 + p.phase)) * 0.9;
    // a few signs are raised and lowered out of phase
    const raise = p.mega ? 0 : Math.max(0, Math.sin(t / 650 + p.phase * 2.3) - 0.35) * 4.5;
    const x = p.x, y = p.y - bob * 0.6;
    const pal = sky.palette;
    ctx.fillStyle = alpha(pal.edge, 0.22);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 2.7, 1.2, 0, 0, TAU);
    ctx.fill();
    const body = mix(p.shirt, pal.skyTop, 0.4 * dark);
    // sign on a stick (behind the head)
    const armUp = 3 + raise;
    const stickTop = y - 13 - raise;
    if (p.mega) {
      drawMegaphone(ctx, x, y, bob, body, dark, pal.skyTop, t);
    } else {
      ctx.strokeStyle = mix('#7a5a38', pal.skyTop, 0.4 * dark);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x + 2, y - 3 - bob * 0.3);
      ctx.lineTo(x + 2, stickTop - 4);
      ctx.stroke();
      const sw = 8, sh = 6;
      const sx = x - 2, sy = stickTop - 4 - sh + 1;
      ctx.fillStyle = mix(p.paper, pal.skyTop, 0.45 * dark);
      ctx.strokeStyle = alpha('#22262e', 0.7);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = mix(SIGN_INK[p.sign], pal.skyTop, 0.3 * dark);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 0.9;
      ctx.lineCap = 'round';
      if (p.sign === 0) {
        ctx.beginPath();
        ctx.moveTo(sx + sw / 2, sy + 1);
        ctx.lineTo(sx + sw / 2, sy + sh - 2.3);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx + sw / 2, sy + sh - 1.1, 0.6, 0, TAU);
        ctx.fill();
      } else if (p.sign === 1) {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          ctx.moveTo(sx + 1.4, sy + 1.4 + i * 1.5);
          ctx.lineTo(sx + sw - 1.4 - (i === 2 ? 2 : 0), sy + 1.4 + i * 1.5);
        }
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(sx + 2, sy + 1.3);
        ctx.lineTo(sx + sw - 2, sy + sh - 1.3);
        ctx.moveTo(sx + sw - 2, sy + 1.3);
        ctx.lineTo(sx + 2, sy + sh - 1.3);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    // body + head (like the commuters)
    ctx.fillStyle = body;
    ctx.fillRect(x - 1.5, y - 6 - bob, 3, 5.2);
    // arm holding the stick
    ctx.fillRect(x + 1, y - 5.6 - bob - (p.mega ? 0 : raise * 0.25), 1.6, 1.3);
    ctx.fillStyle = mix('#e6c3a0', pal.skyTop, 0.4 * dark);
    ctx.beginPath();
    ctx.arc(x, y - 7.7 - bob, 1.7, 0, TAU);
    ctx.fill();
    void armUp;
  }

  function drawMegaphone(ctx: CanvasRenderingContext2D, x: number, y: number, bob: number, body: string, dark: number, sky: string, t: number) {
    const hy = y - 7.7 - bob;
    ctx.save();
    ctx.fillStyle = mix('#e9e9e4', sky, 0.4 * dark);
    ctx.strokeStyle = alpha('#22262e', 0.7);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x + 1.5, hy + 1.6);
    ctx.lineTo(x + 7, hy - 1.8);
    ctx.lineTo(x + 7, hy + 4.6);
    ctx.lineTo(x + 1.5, hy + 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = body;
    // sound arcs
    ctx.strokeStyle = alpha('#d83a2e', 0.5 + 0.4 * Math.sin(t / 220));
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(x + 7.4, hy + 1.4, 2.6, -0.9, 0.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 7.4, hy + 1.4, 4.6, -0.8, 0.8);
    ctx.stroke();
    ctx.restore();
  }

  function drawBadge(ctx: CanvasRenderingContext2D, x: number, topY: number, t: number, k: number, kind: 'protest' | 'ballot') {
    const r = 11 * k;
    const bob = Math.sin(t / 520 + (kind === 'ballot' ? 2 : 0)) * 1.6 * k;
    const bx = x, by = topY - r - 6 * k + bob;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(bx, by + r + 3 * k, r * 0.7, r * 0.22, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = kind === 'protest' ? '#d9382c' : '#2f5fb8';
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1.7 * k;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(bx - 3 * k, by + r - 0.5 * k);
    ctx.lineTo(bx, by + r + 4.5 * k);
    ctx.lineTo(bx + 3 * k, by + r - 0.5 * k);
    ctx.fill();
    ctx.translate(bx, by);
    ctx.scale(r, r);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    if (kind === 'protest') {
      // megaphone: cone + handle + sound arcs
      ctx.beginPath();
      ctx.moveTo(-0.58, -0.18);
      ctx.lineTo(-0.1, -0.18);
      ctx.lineTo(0.4, -0.52);
      ctx.lineTo(0.4, 0.52);
      ctx.lineTo(-0.1, 0.18);
      ctx.lineTo(-0.58, 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-0.4, 0.14, 0.2, 0.42);
      ctx.lineWidth = 0.1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0.42, 0, 0.3, -0.9, 0.9);
      ctx.stroke();
    } else {
      // ballot box with a slot and a paper going in
      ctx.beginPath();
      ctx.rect(-0.52, -0.02, 1.04, 0.6);
      ctx.fill();
      ctx.fillStyle = '#2f5fb8';
      ctx.fillRect(-0.3, 0.1, 0.6, 0.1);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.rect(-0.26, -0.58 + 0.08 * Math.sin(t / 380), 0.52, 0.42);
      ctx.fill();
      ctx.fillStyle = '#2f5fb8';
      ctx.fillRect(-0.15, -0.46 + 0.08 * Math.sin(t / 380), 0.3, 0.07);
      ctx.fillRect(-0.15, -0.32 + 0.08 * Math.sin(t / 380), 0.2, 0.07);
    }
    ctx.restore();
  }

  return {
    setModel(m) {
      model = m;
      houseByHandle.clear();
      rebuild();
    },
    setPolitics(p) {
      pol = p;
      rebuild();
    },
    draw,
  };
}
