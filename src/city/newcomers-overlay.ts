// Newcomers overlay: a floating "@handle" name tag above the house of every resident who moved in
// today or yesterday (city days, UTC, Day 1 = founding day), newest 40 at most. In the demo city the
// days are fixed, so the 12 newest residents count as new. Drawn every frame in world space after the
// politics overlay; the list is built in setModel, never per frame.
//
// Tags keep a constant screen size (scale 1/S between limits, like the incident badges), hide when
// zoomed far out (except the 3 newest), and a greedy pass in screen space drops the older tag when two
// would overlap. Bob and the page-load pop-in are deterministic from the frame time `t`.
import { FONTS, alpha, type SkyState } from '../theme';
import { clamp, hash } from './iso';
import type { Model } from './model';
import { projFor } from './objects';
import type { DrawOpts, View } from './sim-overlay';

const MAX_TAGS = 40;
const DEMO_NEW = 12;
const ALWAYS_SHOW = 3;
const MIN_ZOOM = 0.35;
const DAY_MS = 86_400_000;

const GOLD = '#e0a526';
const GOLD_DARK = '#b9830f';
const PILL_H = 20;
const PAD = 8;
const DOT = 13;

export interface NewcomersOverlay {
  setModel(m: Model | null): void;
  draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts): void;
}

interface Tag {
  text: string;
  /** anchor above the roof, world px */
  cx: number;
  cy: number;
  /** 0 = newest */
  rank: number;
  seed: number;
  /** pill width at k = 1, measured lazily */
  w: number;
}

export function createNewcomersOverlay(): NewcomersOverlay {
  let tags: Tag[] = [];
  let t0 = -1;

  function setModel(m: Model | null) {
    tags = [];
    t0 = -1;
    if (!m) return;
    const d = m.data;
    const list: Tag[] = [];
    const picked = [...m.residents.values()].sort((a, b) => b.number - a.number);
    let chosen = picked;
    if (d.demo) chosen = picked.slice(0, DEMO_NEW);
    else {
      const start = Date.parse(d.foundedISO + 'T00:00:00Z');
      const today = Math.max(1, Math.floor((Date.now() - start) / DAY_MS) + 1);
      chosen = picked.filter((r) => r.joinedDay >= today - 1);
    }
    for (const r of chosen.slice(0, MAX_TAGS)) {
      const oi = m.byResident.get(r.id);
      if (oi === undefined) continue;
      const o = m.objs[oi];
      const p = projFor(o);
      list.push({ text: '@' + r.handle, cx: p.cx, cy: p.cy - o.height, rank: list.length, seed: hash(r.number, 7, 3) * 6.28, w: 0 });
    }
    tags = list;
  }

  function draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts) {
    if (!tags.length) return;
    if (t0 < 0) t0 = t;
    const k = clamp(1 / S, 0.7, 3.2);
    const far = S < MIN_ZOOM;
    const night = sky.darkness > 0.5;
    const dk = clamp(sky.darkness * 1.4 - 0.2, 0, 1);
    const placed: number[] = [];
    const m = 40 * k + 80;
    ctx.save();
    ctx.font = `800 13px ${FONTS.ui}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const g of tags) {
      if (far && g.rank >= ALWAYS_SHOW) break; // tags are sorted newest first
      if (g.cx < v.minX - m || g.cx > v.maxX + m || g.cy < v.minY - m - 60 * k || g.cy > v.maxY + m + 60 * k) continue;
      if (!g.w) g.w = Math.ceil(ctx.measureText(g.text).width) + PAD * 2 + DOT;
      // pop-in on page load (staggered), none in a reel so every frame is complete
      const pop = o.reel ? 1 : clamp((t - t0 - g.rank * 70) / 520, 0, 1);
      if (pop <= 0) continue;
      const sc = pop < 1 ? 1 + 2.2 * Math.pow(pop - 1, 3) + 1.2 * Math.pow(pop - 1, 2) : 1;
      const bob = Math.sin(t / 640 + g.seed) * 2 * k;
      const x = g.cx;
      const y = g.cy - 14 * k - PILL_H * k - bob; // pill centre
      // greedy overlap check in screen px
      const hw = (g.w * k * S) / 2 + 3, hh = (PILL_H * k * S) / 2 + 5;
      const sx = x * S, sy = (y - 3 * k) * S;
      let hit = false;
      for (let i = 0; i < placed.length; i += 4)
        if (Math.abs(sx - placed[i]) < hw + placed[i + 2] && Math.abs(sy - placed[i + 1]) < hh + placed[i + 3]) { hit = true; break; }
      if (hit) continue;
      placed.push(sx, sy, hw, hh);

      ctx.save();
      ctx.translate(x, y + (PILL_H * k) / 2);
      ctx.scale(k * sc, k * sc);
      const w = g.w, h = PILL_H;
      // soft glow at night
      if (night || dk > 0) {
        ctx.shadowColor = alpha(GOLD, 0.35 + 0.45 * dk);
        ctx.shadowBlur = 10 * dk * S * k * sc;
      }
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h, w, h, h / 2);
      ctx.moveTo(-4, 0);
      ctx.lineTo(0, 5);
      ctx.lineTo(4, 0);
      // Two fixed styles, never a blend: fading both the pill and the text toward each other left
      // them the same grey at dusk. Light pill + dark text by day, navy pill + cream text from dusk.
      const dark = dk >= 0.5;
      ctx.fillStyle = dark ? '#14213f' : '#fffaf0';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = dark ? '#f3c648' : GOLD_DARK;
      ctx.stroke();
      // sparkle
      const sp = 0.75 + 0.25 * Math.sin(t / 380 + g.seed * 2);
      const sx0 = -w / 2 + PAD + 3, sy0 = -h / 2;
      ctx.fillStyle = dark ? '#ffd966' : GOLD;
      ctx.beginPath();
      const r1 = 4.6 * sp, r2 = 1.4 * sp;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2, r = i % 2 ? r2 : r1;
        const px = sx0 + Math.cos(a) * r, py = sy0 + Math.sin(a) * r;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      // a thin edge in the pill colour keeps the letters crisp over snow, lights and halos
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = dark ? '#14213f' : '#fffaf0';
      ctx.strokeText(g.text, -w / 2 + PAD + DOT - 2, -h / 2 + 0.5);
      ctx.fillStyle = dark ? '#fff4d6' : '#2a1d05';
      ctx.fillText(g.text, -w / 2 + PAD + DOT - 2, -h / 2 + 0.5);
      ctx.restore();
    }
    ctx.restore();
  }

  return { setModel, draw };
}
