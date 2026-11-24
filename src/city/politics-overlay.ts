// Politics overlay: the mayor's flag and gold ring,
// candidates' yard signs during an election, and a ballot-box badge over the town hall while voting.
// Drawn every frame in world space right after the sim overlay (same conventions: occlusion by
// repainting what stands in front, culling to the view, deterministic from the frame time `t`).
// All positions are computed in setModel/setPolitics, never per frame.
import { COLORS, alpha, mix, type SkyState } from '../theme';
import type { TownPolitics } from '../data/town';
import { HH, HW, clamp, groundEllipse, hash } from './iso';
import type { Model, Obj } from './model';
import { projFor } from './objects';
import type { DrawOpts, View } from './sim-overlay';

const TAU = Math.PI * 2;
const MAX_FRONT = 22;

export interface PoliticsOverlay {
  setModel(m: Model | null): void;
  setPolitics(p: TownPolitics | null): void;
  draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts): void;
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

const SIGN_COLORS = [
  ['#d83a2e', '#ffffff'],
  ['#2f5fb8', '#ffffff'],
  ['#f0b429', '#22262e'],
];

export function createPoliticsOverlay(): PoliticsOverlay {
  let model: Model | null = null;
  let pol: TownPolitics | null = null;
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
  }


  function draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts) {
    if (!model || !pol) return;
    const k = clamp(1 / S, 0.7, 3.2);
    const inView = (x: number, y: number, pad: number) => x > v.minX - pad && x < v.maxX + pad && y > v.minY - pad && y < v.maxY + pad;

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

    // flag + badges on top
    if (mayorObj && inView((mayorObj.minX + mayorObj.maxX) / 2, mayorObj.minY, 80)) drawFlag(ctx, mayorObj, sky, t, k);
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



  function drawBadge(ctx: CanvasRenderingContext2D, x: number, topY: number, t: number, k: number, _kind: 'ballot') {
    const r = 11 * k;
    const bob = Math.sin(t / 520 + 2) * 1.6 * k;
    const bx = x, by = topY - r - 6 * k + bob;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(bx, by + r + 3 * k, r * 0.7, r * 0.22, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#2f5fb8';
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
    {
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
