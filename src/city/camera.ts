// Camera (world point at the viewport centre + zoom) and pointer / wheel / pinch input.
import { clamp } from './iso';

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2.5;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Flight {
  wx: number;
  wy: number;
  sx0: number;
  sy0: number;
  sx1: number;
  sy1: number;
  z0: number;
  z1: number;
  t0: number;
  dur: number;
}

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  /** viewport size in CSS px */
  vw = 1;
  vh = 1;
  /** set by the view: keeps the camera over the map */
  limit: (c: Camera) => void = () => {};
  private flight: Flight | null = null;
  private vx = 0;
  private vy = 0;
  private lastStep = 0;
  /** bumps whenever the view changes */
  rev = 0;

  toWorldX(sx: number) { return (sx - this.vw / 2) / this.zoom + this.x; }
  toWorldY(sy: number) { return (sy - this.vh / 2) / this.zoom + this.y; }
  toScreenX(wx: number) { return (wx - this.x) * this.zoom + this.vw / 2; }
  toScreenY(wy: number) { return (wy - this.y) * this.zoom + this.vh / 2; }

  set(x: number, y: number, zoom: number) {
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.x = x;
    this.y = y;
    this.limit(this);
    this.rev++;
  }

  panBy(dsx: number, dsy: number) {
    this.set(this.x - dsx / this.zoom, this.y - dsy / this.zoom, this.zoom);
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const wx = this.toWorldX(sx);
    const wy = this.toWorldY(sy);
    const z = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.set(wx - (sx - this.vw / 2) / z, wy - (sy - this.vh / 2) / z, z);
  }

  /** Move so world point (wx, wy) ends at screen (sx, sy) with zoom z. dur 0 jumps. */
  flyTo(wx: number, wy: number, sx: number, sy: number, z: number, dur: number, now: number) {
    this.stop();
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (dur <= 0) {
      this.set(wx - (sx - this.vw / 2) / z, wy - (sy - this.vh / 2) / z, z);
      return;
    }
    this.flight = { wx, wy, sx0: this.toScreenX(wx), sy0: this.toScreenY(wy), sx1: sx, sy1: sy, z0: this.zoom, z1: z, t0: now, dur };
  }

  fling(vx: number, vy: number) {
    this.vx = vx;
    this.vy = vy;
    this.lastStep = 0;
  }

  stop() {
    this.flight = null;
    this.vx = this.vy = 0;
  }

  get moving() {
    return this.flight !== null || this.vx !== 0 || this.vy !== 0;
  }

  /** Advance animations; returns true while something moved. */
  step(now: number): boolean {
    const f = this.flight;
    if (f) {
      const t = Math.min(1, (now - f.t0) / f.dur);
      const e = easeInOut(t);
      const z = Math.exp(Math.log(f.z0) + (Math.log(f.z1) - Math.log(f.z0)) * e);
      const sx = f.sx0 + (f.sx1 - f.sx0) * e;
      const sy = f.sy0 + (f.sy1 - f.sy0) * e;
      this.set(f.wx - (sx - this.vw / 2) / z, f.wy - (sy - this.vh / 2) / z, z);
      if (t >= 1) this.flight = null;
      return true;
    }
    if (this.vx || this.vy) {
      const dt = this.lastStep ? Math.min(50, now - this.lastStep) : 16;
      this.lastStep = now;
      this.panBy(this.vx * dt, this.vy * dt);
      const k = Math.exp(-dt / 260);
      this.vx *= k;
      this.vy *= k;
      if (Math.hypot(this.vx, this.vy) < 0.01) this.vx = this.vy = 0;
      return true;
    }
    return false;
  }
}

export interface InputHandlers {
  tap(sx: number, sy: number): void;
  /** double click / double tap */
  zoomIn(sx: number, sy: number): void;
  reducedMotion(): boolean;
}

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
  type: string;
}

/** Wire pointer, wheel and gesture input on the canvas to the camera. Returns a detach fn. */
export function attachInput(canvas: HTMLCanvasElement, cam: Camera, h: InputHandlers): () => void {
  const ptrs = new Map<number, Ptr>();
  let dragging = false;
  let multi = false;
  let pinchDist = 0;
  let pinchX = 0;
  let pinchY = 0;
  let lastTap = { t: 0, x: 0, y: 0 };
  let vel = { x: 0, y: 0, t: 0 };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const pinchState = () => {
    const [a, b] = [...ptrs.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = local(e);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    ptrs.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), type: e.pointerType });
    cam.stop();
    vel = { x: 0, y: 0, t: performance.now() };
    if (ptrs.size === 1) {
      dragging = false;
      multi = false;
    } else if (ptrs.size === 2) {
      multi = true;
      const s = pinchState();
      pinchDist = s.d;
      pinchX = s.x;
      pinchY = s.y;
    }
  };

  const move = (e: PointerEvent) => {
    const ptr = ptrs.get(e.pointerId);
    if (!ptr) return;
    const p = local(e);
    if (ptrs.size >= 2) {
      ptr.x = p.x;
      ptr.y = p.y;
      const s = pinchState();
      if (pinchDist > 0 && s.d > 0) cam.zoomAt(s.x, s.y, s.d / pinchDist);
      cam.panBy(s.x - pinchX, s.y - pinchY);
      pinchDist = s.d;
      pinchX = s.x;
      pinchY = s.y;
      return;
    }
    const dx = p.x - ptr.x;
    const dy = p.y - ptr.y;
    const thresh = ptr.type === 'mouse' ? 4 : 9;
    if (!dragging && Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > thresh) dragging = true;
    ptr.x = p.x;
    ptr.y = p.y;
    if (dragging) {
      cam.panBy(dx, dy);
      const now = performance.now();
      const dt = Math.max(1, now - vel.t);
      const k = Math.min(1, dt / 60);
      vel = { x: vel.x * (1 - k) + (dx / dt) * k, y: vel.y * (1 - k) + (dy / dt) * k, t: now };
    }
  };

  const up = (e: PointerEvent) => {
    const ptr = ptrs.get(e.pointerId);
    if (!ptr) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size === 1) {
      // continue as a one-finger drag from where the remaining finger is
      const [rest] = [...ptrs.values()];
      rest.sx = rest.x;
      rest.sy = rest.y;
      dragging = true;
      return;
    }
    if (ptrs.size > 0) return;
    const now = performance.now();
    if (e.type === 'pointercancel') return;
    if (!dragging && !multi) {
      if (ptr.type !== 'mouse' && now - lastTap.t < 320 && Math.hypot(ptr.x - lastTap.x, ptr.y - lastTap.y) < 30) {
        lastTap = { t: 0, x: 0, y: 0 };
        h.zoomIn(ptr.x, ptr.y);
      } else {
        lastTap = { t: now, x: ptr.x, y: ptr.y };
        h.tap(ptr.x, ptr.y);
      }
    } else if (dragging && !multi && !h.reducedMotion() && now - vel.t < 80) {
      const sp = Math.hypot(vel.x, vel.y);
      if (sp > 0.25) cam.fling(Math.min(sp, 3) * (vel.x / sp), Math.min(sp, 3) * (vel.y / sp));
    }
    dragging = false;
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    cam.stop();
    const p = local(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    const k = e.ctrlKey ? 0.01 : 0.0018;
    cam.zoomAt(p.x, p.y, clamp(Math.exp(-dy * k), 0.5, 2));
  };

  const dbl = (e: MouseEvent) => {
    e.preventDefault();
    const p = local(e);
    h.zoomIn(p.x, p.y);
  };

  // Safari trackpad pinch
  let gScale = 1;
  const gStart = (e: Event) => {
    e.preventDefault();
    gScale = 1;
  };
  const gChange = (e: Event) => {
    e.preventDefault();
    const ge = e as Event & { scale: number; clientX: number; clientY: number };
    const p = local(ge);
    cam.zoomAt(p.x, p.y, ge.scale / gScale);
    gScale = ge.scale;
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('dblclick', dbl);
  canvas.addEventListener('gesturestart', gStart);
  canvas.addEventListener('gesturechange', gChange);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('dblclick', dbl);
    canvas.removeEventListener('gesturestart', gStart);
    canvas.removeEventListener('gesturechange', gChange);
  };
}
