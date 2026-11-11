// Kinsburg city renderer: isometric Canvas 2D map that follows the time of day.
//
// Performance model
// • Static ground + buildings are painted into offscreen chunk canvases, one grid per
//   level of detail (LOD = device px per world px, a power of two from 1/8 to 8). Chunk
//   side in tiles shrinks as LOD grows (64 → 2 tiles), so every chunk canvas is ~1000 px
//   wide and close-up views only allocate pixels for the few tiles actually on screen.
// • Chunks are built lazily as they come into view, within a per-frame time budget, and
//   marked stale (rebuilt progressively, still shown meanwhile) when the sky changes.
// • A frame is: sky gradient + one drawImage per visible chunk + animated overlays.
// • Animated bits (water shimmer, windmill, lighthouse beam, fountain, stars, highlight)
//   are drawn on top each frame. The loop pauses while the tab is hidden.
// • Reel mode (enterReel, used only behind ?reel=1) turns the loop off and renders
//   complete frames on demand: no time budget, every visible chunk built, all motion
//   driven by the reel's own clock.
import type { CreateCityView, ReelControl, ReelFrame, ReelTarget } from './api';
import type { Resident } from '../types';
import { COLORS, alpha, type SkyState } from '../theme';
import { Camera, attachInput } from './camera';
import { drawGround, eachTile, makeLook, type Look, type Region } from './ground';
import { HH, HW, hash } from './iso';
import { buildModel, type Model, type Obj } from './model';
import { drawAnimated, drawEntry, projFor } from './objects';
import { drawRing } from './house';

interface Chunk {
  lod: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  canvas: HTMLCanvasElement | null;
  ver: number;
  used: number;
}

const MAX_CHUNK_PX = 40e6;
const FRAME_BUDGET_MS = 7;
const HIT_MASS: Record<string, number> = { townhall: 48, fountain: 18, market: 34, monument: 16, lighthouse: 24, windmill: 64 };

const tilesPer = (lod: number) => Math.max(2, Math.min(64, Math.round(16 / lod)));
const detailFor = (scale: number) => (scale >= 0.9 ? 2 : scale >= 0.4 ? 1 : 0);
const lodFor = (need: number) => Math.min(8, Math.max(0.125, Math.pow(2, Math.round(Math.log2(need)))));
/** reel frames are stills people pause on: never upscale a chunk, always paint at ≥ the needed resolution */
const lodForSharp = (need: number) => Math.min(8, Math.max(0.125, Math.pow(2, Math.ceil(Math.log2(need) - 0.05))));

export const createCityView: CreateCityView = (canvas) => {
  const ctx = canvas.getContext('2d')!;
  const cam = new Camera();
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reelMode = false;
  const reduced = () => !reelMode && motionQuery.matches;
  motionQuery.addEventListener?.('change', onMotion);

  let model: Model | null = null;
  let sky: SkyState | null = null;
  let look: Look | null = null;
  let skyKey = '';
  let skyVer = 0;
  let dpr = 1;
  let selectCb: (r: Resident | null) => void = () => {};
  let highlight = -1;
  let highlightT0 = 0;
  let pendingFocus: string | null = null;

  let grids = new Map<number, Chunk[]>();
  let gridCols = new Map<number, number>();
  let chunkPx = 0;
  let mode = -1; // LOD currently shown, -1 none yet
  let frameNo = 0;
  let raf = 0;
  let dirty = true;
  let lastRev = -1;
  let lastDraw = 0;
  let pendingWork = false;
  let everDrawn = false;

  // ── camera limits: keep the viewport centre over the map diamond ──
  cam.limit = (c) => {
    if (!model) return;
    let gx = (c.x / HW + c.y / HH) / 2;
    let gy = (c.y / HH - c.x / HW) / 2;
    gx = Math.max(0, Math.min(model.W, gx));
    gy = Math.max(0, Math.min(model.H, gy));
    c.x = (gx - gy) * HW;
    c.y = (gx + gy) * HH;
  };

  // ── sizing ──
  const resize = () => {
    if (reelMode) return; // reel mode owns the canvas size
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const firstSize = cam.vw <= 1;
    cam.vw = w;
    cam.vh = h;
    if (firstSize && model) resetView();
    cam.rev++;
    dirty = true;
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  window.addEventListener('resize', resize);
  resize();

  // ── chunks ──
  function gridFor(lod: number): Chunk[] {
    let g = grids.get(lod);
    if (g || !model) return g ?? [];
    const m = model;
    const n = tilesPer(lod);
    const cols = Math.ceil(m.W / n);
    const rows = Math.ceil(m.H / n);
    g = [];
    for (let cy = 0; cy < rows; cy++)
      for (let cx = 0; cx < cols; cx++) {
        const x0 = cx * n, y0 = cy * n;
        const x1 = Math.min(m.W, x0 + n), y1 = Math.min(m.H, y0 + n);
        const c: Chunk = {
          lod, x0, y0, x1, y1,
          minX: (x0 - y1) * HW - 2, maxX: (x1 - y0) * HW + 2,
          minY: (x0 + y0) * HH - 2, maxY: (x1 + y1) * HH + 26,
          canvas: null, ver: -1, used: 0,
        };
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const i = y * m.W + x;
            for (let k = m.entryStart[i]; k < m.entryStart[i + 1]; k++) {
              const o = m.objs[m.entryList[k]];
              if (o.minX < c.minX) c.minX = o.minX;
              if (o.maxX > c.maxX) c.maxX = o.maxX;
              if (o.minY < c.minY) c.minY = o.minY;
              if (o.maxY > c.maxY) c.maxY = o.maxY;
            }
          }
        g.push(c);
      }
    grids.set(lod, g);
    gridCols.set(lod, cols);
    return g;
  }

  function freeChunk(c: Chunk) {
    if (!c.canvas) return;
    chunkPx -= c.canvas.width * c.canvas.height;
    c.canvas.width = c.canvas.height = 0;
    c.canvas = null;
    c.ver = -1;
  }

  function dropAllChunks() {
    for (const g of grids.values()) for (const c of g) freeChunk(c);
    grids = new Map();
    gridCols = new Map();
    chunkPx = 0;
  }

  function buildChunk(c: Chunk) {
    if (!model || !look) return;
    const lod = c.lod;
    const w = Math.ceil((c.maxX - c.minX) * lod) + 2;
    const h = Math.ceil((c.maxY - c.minY) * lod) + 2;
    let cv = c.canvas;
    if (!cv || cv.width !== w || cv.height !== h) {
      if (cv) chunkPx -= cv.width * cv.height;
      cv = cv ?? document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      chunkPx += w * h;
      c.canvas = cv;
    }
    const g = cv.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.setTransform(lod, 0, 0, lod, (-c.minX) * lod + 1, (-c.minY) * lod + 1);
    const r: Region = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, dMin: -1e9, dMax: 1e9, sMin: -1e9, sMax: 1e9 };
    const detail = detailFor(lod);
    drawGround(g, model, look, r, detail, lod, true);
    drawObjects(g, r, detail);
    c.ver = skyVer;
    dirty = true;
  }

  function evict() {
    if (chunkPx <= MAX_CHUNK_PX) return;
    const all: Chunk[] = [];
    for (const g of grids.values()) for (const c of g) if (c.canvas && c.used < frameNo) all.push(c);
    all.sort((a, b) => a.used - b.used);
    for (const c of all) {
      if (chunkPx <= MAX_CHUNK_PX * 0.8) break;
      freeChunk(c);
    }
  }

  /** world-space rect that is on screen */
  function viewRect() {
    const hw = cam.vw / 2 / cam.zoom, hh = cam.vh / 2 / cam.zoom;
    return { minX: cam.x - hw, maxX: cam.x + hw, minY: cam.y - hh, maxY: cam.y + hh };
  }

  function visibleChunks(lod: number): Chunk[] {
    if (!model) return [];
    const g = gridFor(lod);
    const cols = gridCols.get(lod)!;
    const n = tilesPer(lod);
    const v = viewRect();
    const pad = model.maxHeight + 80;
    // grid-space bbox of the view (plus room for tall things below the screen)
    const corners = [[v.minX - 96, v.minY], [v.maxX + 96, v.minY], [v.minX - 96, v.maxY + pad], [v.maxX + 96, v.maxY + pad]];
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
    for (const [x, y] of corners) {
      const gx = (x / HW + y / HH) / 2, gy = (y / HH - x / HW) / 2;
      gx0 = Math.min(gx0, gx); gx1 = Math.max(gx1, gx);
      gy0 = Math.min(gy0, gy); gy1 = Math.max(gy1, gy);
    }
    const rows = g.length / cols;
    const cx0 = Math.max(0, Math.floor(gx0 / n)), cx1 = Math.min(cols - 1, Math.floor(gx1 / n));
    const cy0 = Math.max(0, Math.floor(gy0 / n)), cy1 = Math.min(rows - 1, Math.floor(gy1 / n));
    const out: Chunk[] = [];
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = g[cy * cols + cx];
        if (c.maxX < v.minX || c.minX > v.maxX || c.maxY < v.minY || c.minY > v.maxY) continue;
        out.push(c);
      }
    // back to front
    out.sort((a, b) => a.x0 + a.y0 - (b.x0 + b.y0) || a.x0 - b.x0);
    return out;
  }

  function drawObjects(g: CanvasRenderingContext2D, r: Region, detail: number) {
    const m = model!;
    const lk = look!;
    eachTile(m, r, (_x, _y, i) => {
      for (let k = m.entryStart[i]; k < m.entryStart[i + 1]; k++) drawEntry(g, m.objs[m.entryList[k]], lk, detail);
    });
  }

  // ── stars ──
  const stars = Array.from({ length: 110 }, (_, i) => ({
    x: hash(i, 1, 99),
    y: Math.pow(hash(i, 2, 99), 1.4) * 0.75,
    r: 0.5 + hash(i, 3, 99) * 1.1,
    ph: hash(i, 4, 99) * Math.PI * 2,
    sp: 0.0008 + hash(i, 5, 99) * 0.0018,
  }));

  // ── per-frame ──
  /**
   * Paint one frame. `full` (reel mode) builds every chunk the frame needs before drawing,
   * at a never-upscaled LOD, instead of spreading the work over frames.
   */
  function render(now: number, full = false, rings: number[] = highlight >= 0 ? [highlight] : [], ringMs = now - highlightT0) {
    frameNo++;
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!sky) {
      ctx.clearRect(0, 0, W, H);
      return;
    }
    const pal = sky.palette;
    const t = reduced() ? 0 : now;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, pal.skyTop);
    g.addColorStop(1, pal.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (sky.darkness > 0.5) {
      const a = Math.min(1, (sky.darkness - 0.5) * 2);
      for (const s of stars) {
        const tw = reduced() ? 0.8 : 0.55 + 0.45 * Math.sin(t * s.sp + s.ph);
        ctx.fillStyle = alpha(COLORS.nightInk, 0.75 * a * tw);
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (!model || !look) return;
    const m = model;

    const S = cam.zoom * dpr;
    const ox = W / 2 - cam.x * S, oy = H / 2 - cam.y * S;
    const desired = full ? lodForSharp(S) : lodFor(S);
    const deadline = full ? Infinity : performance.now() + (everDrawn ? FRAME_BUDGET_MS : 120);
    pendingWork = false;

    // Keep showing the previous LOD (scaled) until the new one is complete on screen.
    const want = visibleChunks(desired);
    if (full || mode === -1 || want.every((c) => c.canvas) || !visibleChunks(mode).every((c) => c.canvas)) mode = desired;
    const shown = mode === desired ? want : visibleChunks(mode);
    // build: missing chunks of the shown LOD first, then the wanted LOD, then stale ones
    const queue = [
      ...shown.filter((c) => !c.canvas),
      ...want.filter((c) => !c.canvas && !shown.includes(c)),
      ...shown.filter((c) => c.canvas && c.ver !== skyVer),
    ];
    let built = 0;
    for (const c of queue) {
      if (built > 0 && performance.now() > deadline) {
        pendingWork = true;
        break;
      }
      buildChunk(c);
      built++;
    }
    for (const c of want) c.used = frameNo;
    for (const c of shown) c.used = frameNo;
    if (built) evict();

    ctx.setTransform(S, 0, 0, S, ox, oy);
    ctx.imageSmoothingEnabled = true;
    for (const c of shown) {
      if (!c.canvas) continue;
      const k = 1 / c.lod;
      ctx.drawImage(c.canvas, c.minX - k, c.minY - k, c.canvas.width * k, c.canvas.height * k);
    }
    everDrawn = true;

    // ── animated overlays (world space) ──
    const v = viewRect();
    if (S >= 0.3) {
      const paths = [new Path2D(), new Path2D(), new Path2D()];
      const time = t * 0.001;
      for (let k = 0; k < m.shimmer.length; k++) {
        const i = m.shimmer[k];
        const x = i % m.W, y = (i / m.W) | 0;
        const wx = (x - y) * HW, wy = (x + y) * HH + HH;
        if (wx < v.minX - HW || wx > v.maxX + HW || wy < v.minY - HH || wy > v.maxY + HH) continue;
        const ph = hash(x, y, 77) * 6.283;
        const a = Math.sin(time * (0.7 + hash(x, y, 78) * 0.6) + ph);
        if (a < 0.35) continue;
        const b = Math.min(2, Math.floor(((a - 0.35) / 0.65) * 3));
        const u = (hash(x, y, 79) - 0.5) * 0.5, vv = (hash(x, y, 80) - 0.5) * 0.5;
        const cx = wx + (u - vv) * HW, cy = wy + (u + vv) * HH;
        paths[b].moveTo(cx - 7, cy - 3.5);
        paths[b].lineTo(cx + 7, cy + 3.5);
      }
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.6, 1 / S);
      for (let b = 0; b < 3; b++) {
        ctx.strokeStyle = alpha(pal.waterShine, 0.3 + 0.25 * b);
        ctx.stroke(paths[b]);
      }
      ctx.lineCap = 'butt';
    }
    for (const i of m.animated) {
      const o = m.objs[i];
      if (o.maxX + 300 < v.minX || o.minX - 300 > v.maxX || o.maxY + 300 < v.minY || o.minY - 300 > v.maxY) continue;
      drawAnimated(ctx, o, sky, t, S);
    }
    for (const i of rings) drawHighlight(m.objs[i], ringMs, S);
  }

  /** `ms`: time since the highlight started (drives the pulse). */
  function drawHighlight(o: Obj, ms: number, S: number) {
    const lk = look!;
    const p = projFor(o);
    const size = Math.max(o.w, o.h);
    if (!reduced()) {
      const ph = (((ms % 1600) + 1600) % 1600) / 1600;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(p.cx, p.cy, (0.62 + ph * 0.55) * size * 64 * 0.7071, (0.62 + ph * 0.55) * size * 64 * 0.3536, 0, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, 2.5 / S);
      ctx.strokeStyle = alpha(COLORS.gold, 0.8 * (1 - ph));
      ctx.stroke();
      ctx.restore();
    }
    const detail = Math.max(1, detailFor(S));
    if (o.kind === 'house') drawEntry(ctx, o, lk, detail, true);
    else {
      drawRing(ctx, { ...p, s: 64 * size }, 0.62);
      drawEntry(ctx, o, lk, detail);
    }
    // repaint what stands in front of it so the ring/house doesn't cover it
    const r: Region = { x0: o.x, y0: o.y, x1: o.x + o.w + 4, y1: o.y + o.h + 4, dMin: -1e9, dMax: 1e9, sMin: o.depth + 1, sMax: 1e9 };
    drawObjects(ctx, r, detail);
  }

  function needsFrame(now: number): boolean {
    const moving = cam.step(now);
    if (moving || cam.rev !== lastRev || dirty || pendingWork) return true;
    if (reduced()) return false;
    // ambient animation: 30 fps is plenty when nothing is moving
    return now - lastDraw > 32;
  }

  function loop(now: number) {
    raf = requestAnimationFrame(loop);
    if (!needsFrame(now)) return;
    lastRev = cam.rev;
    dirty = false;
    lastDraw = now;
    render(now);
  }
  const start = () => {
    if (!raf && !document.hidden && !reelMode) raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVis = () => (document.hidden ? stop() : (dirty = true, start()));
  document.addEventListener('visibilitychange', onVis);
  start();

  // ── picking ──
  function pick(sx: number, sy: number): Obj | null {
    if (!model) return null;
    const m = model;
    const wx = cam.toWorldX(sx), wy = cam.toWorldY(sy);
    const tx = Math.floor((wx / HW + wy / HH) / 2);
    const ty = Math.floor((wy / HH - wx / HW) / 2);
    const seen = new Set<number>();
    let best: Obj | null = null;
    const reach = Math.ceil(m.maxHeight / (2 * HH)) + 1;
    for (let k = -1; k <= reach; k++)
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]] as const) {
        const x = tx + k + dx, y = ty + k + dy;
        if (x < 0 || y < 0 || x >= m.W || y >= m.H) continue;
        const oi = m.occ[y * m.W + x];
        if (oi < 0 || seen.has(oi)) continue;
        seen.add(oi);
        const o = m.objs[oi];
        if (hitObj(o, wx, wy) && (!best || o.depth > best.depth)) best = o;
      }
    return best;
  }

  function hitObj(o: Obj, wx: number, wy: number): boolean {
    // Hit the main mass only: spires, flags and blades shouldn't steal taps from the homes behind.
    const h = o.kind === 'lot' ? 4 : o.kind === 'landmark' ? Math.min(o.height, HIT_MASS[o.landmark!.kind]) : o.kind === 'civic' ? 44 : o.height - 6;
    const L = [(o.x - o.y - o.h) * HW, (o.x + o.y + o.h) * HH];
    const T = [(o.x - o.y) * HW, (o.x + o.y) * HH];
    const R = [(o.x + o.w - o.y) * HW, (o.x + o.w + o.y) * HH];
    const B = [(o.x + o.w - o.y - o.h) * HW, (o.x + o.w + o.y + o.h) * HH];
    const poly = [L, [L[0], L[1] - h], [T[0], T[1] - h], [R[0], R[1] - h], R, B];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > wy !== yj > wy && wx < ((xj - xi) * (wy - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  let detachInput = attachInput(canvas, cam, {
    tap(sx, sy) {
      const o = pick(sx, sy);
      selectCb(o?.resident ?? null);
    },
    zoomIn(sx, sy) {
      const wx = cam.toWorldX(sx), wy = cam.toWorldY(sy);
      cam.flyTo(wx, wy, sx, sy, cam.zoom * 2, reduced() ? 0 : 320, performance.now());
    },
    reducedMotion: reduced,
  });

  function resetView() {
    if (!model) return;
    const m = model;
    const th = m.townhall;
    const gx = th ? th.x + th.w / 2 : m.W / 2;
    const gy = th ? th.y + th.h / 2 : m.H / 2;
    // ~15 homes on a phone-sized screen
    let homes = 0, tiles = 0;
    for (let y = Math.max(0, Math.floor(gy) - 12); y < Math.min(m.H, gy + 12); y++)
      for (let x = Math.max(0, Math.floor(gx) - 12); x < Math.min(m.W, gx + 12); x++) {
        tiles++;
        const oi = m.occ[y * m.W + x];
        if (oi >= 0 && m.objs[oi].kind === 'house') homes++;
      }
    const density = Math.max(0.05, homes / Math.max(1, tiles));
    const z = Math.sqrt((390 * 844 * density) / (15 * HW * HH * 2));
    cam.set((gx - gy) * HW, (gx + gy) * HH - 20, Math.max(0.7, Math.min(1.5, z)));
  }

  function focus(id: string) {
    if (!model) {
      pendingFocus = id;
      return;
    }
    const oi = model.byResident.get(id);
    if (oi === undefined) return;
    const o = model.objs[oi];
    const p = projFor(o);
    const z = cam.zoom < 1.4 ? 1.4 : cam.zoom;
    cam.flyTo(p.cx, p.cy - o.height * 0.35, cam.vw / 2, cam.vh * 0.4, z, reduced() ? 0 : 700, performance.now());
    highlight = oi;
    highlightT0 = performance.now();
    dirty = true;
  }

  const api: ReturnType<CreateCityView> = {
    setData(data) {
      dropAllChunks();
      model = buildModel(data);
      highlight = -1;
      mode = -1;
      everDrawn = false;
      resetView();
      dirty = true;
      if (pendingFocus) {
        const id = pendingFocus;
        pendingFocus = null;
        focus(id);
      }
    },
    setSky(s) {
      const key = [
        ...Object.values(s.palette),
        Math.round(s.glow * 20),
        Math.round(s.darkness * 20),
        Math.round(s.sunX * 10),
      ].join();
      sky = s;
      look = makeLook(s);
      if (key !== skyKey) {
        skyKey = key;
        skyVer++;
      }
      dirty = true;
    },
    focusResident: focus,
    clearHighlight() {
      highlight = -1;
      dirty = true;
    },
    onSelect(cb) {
      selectCb = cb;
    },
    enterReel(width, height) {
      reelMode = true;
      stop();
      detachInput();
      detachInput = () => {};
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      dpr = 1;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.style.inset = 'auto';
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.width = w;
      canvas.height = h;
      cam.stop();
      cam.vw = w;
      cam.vh = h;
      return reelControl();
    },
    destroy() {
      stop();
      detachInput();
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      motionQuery.removeEventListener?.('change', onMotion);
      dropAllChunks();
      model = null;
    },
  };
  return api;

  function onMotion() {
    dirty = true;
  }

  function targetOf(o: Obj): ReelTarget {
    const p = projFor(o);
    return { x: p.cx, y: p.cy, height: o.height, size: Math.max(o.w, o.h) };
  }

  function reelControl(): ReelControl {
    return {
      resident(id) {
        const oi = model?.byResident.get(id);
        return oi === undefined ? null : targetOf(model!.objs[oi]);
      },
      landmark(kind) {
        const o = model?.objs.find((x) => x.landmark?.kind === kind);
        return o ? targetOf(o) : null;
      },
      homesBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const o of model?.objs ?? []) {
          if (o.kind !== 'house') continue;
          minX = Math.min(minX, o.minX); maxX = Math.max(maxX, o.maxX);
          minY = Math.min(minY, o.minY); maxY = Math.max(maxY, o.maxY);
        }
        if (!(minX < maxX) && model) {
          minX = -model.H * HW; maxX = model.W * HW; minY = 0; maxY = (model.W + model.H) * HH;
        }
        return { minX, minY, maxX, maxY };
      },
      render(f: ReelFrame) {
        if (!model) return;
        // the reel drives the sky; setSky() only re-keys the chunk cache when colours change
        api.setSky(f.sky);
        cam.x = f.camera.x;
        cam.y = f.camera.y;
        cam.zoom = f.camera.zoom;
        cam.rev++;
        const rings: number[] = [];
        for (const id of f.highlights) {
          const oi = model.byResident.get(id);
          if (oi !== undefined) rings.push(oi);
        }
        render(f.t * 1000, true, rings, f.t * 1000);
      },
    };
  }
};
