// Jadie, the jadiedevs lead, redrawn in Kinsburg's flat isometric style for the "In this town" reels.
// Red beanie, brown fringe, classic yellow face and smile, blue pizza sweater, dark jeans, orange
// sneakers. Drawn in screen space at world scale (so the camera zoom sizes him like the houses),
// flat colours with one darker side, a neutral ground shadow, no outlines or glow.

export type JadiePose = 'idle' | 'walk' | 'wave' | 'jump' | 'point' | 'look' | 'sixseven';

const C = {
  beanie: '#d9473a', beanieBand: '#b5382d', beanieShade: '#bf3c31',
  hair: '#5b3a23', hairShade: '#472c19',
  skin: '#f4cf3d', skinShade: '#ddb72e',
  sweater: '#3f6d9e', sweaterShade: '#33597f', sweaterCuff: '#365f8a',
  pizza: '#f2c14e', crust: '#c9843c', pepperoni: '#d6453a',
  jeans: '#2f3440', jeansShade: '#252a34',
  shoe: '#d9822b', sole: '#f3eee4',
  ink: '#1d1b1a',
};

/** Drawing scale: the design is 28 units tall; 0.8 makes him ~22, a bit shorter than a house wall. */
const SCALE = 0.8;
/** Height of Jadie in world units (a house is about 64 wide). */
export const JADIE_HEIGHT = 28 * SCALE;

/**
 * Draw Jadie with his feet at (sx, sy) on screen. `k` is pixels per world unit (the camera zoom),
 * `face` 1 looks right, -1 left. `talk` opens and closes the mouth while his line plays.
 */
export function drawJadie(ctx: CanvasRenderingContext2D, sx: number, sy: number, k: number, pose: JadiePose, t: number, face: 1 | -1 = 1, talk = false) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(k * face * SCALE, k * SCALE);

  const walking = pose === 'walk';
  const ph = t * 9.5; // stride phase
  const swing = walking ? Math.sin(ph) : 0;
  let lift = 0;
  if (walking) lift = -Math.abs(Math.sin(ph)) * 0.7;
  else if (pose === 'jump') lift = -7 * Math.abs(Math.sin((t * Math.PI) / 0.62));
  else lift = -0.35 * Math.sin(t * 2.6); // breathing

  // ground shadow (shrinks while airborne)
  const air = Math.min(1, -lift / 7);
  ctx.fillStyle = `rgba(10,16,32,${0.3 - 0.14 * air})`;
  ctx.beginPath();
  ctx.ellipse(0, 0.2, 7.2 * (1 - 0.3 * air), 2.6 * (1 - 0.3 * air), 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(0, lift);

  // legs + shoes (back leg first)
  const leg = (x: number, s: number, shade: boolean) => {
    const dx = s * 1.6, up = Math.max(0, s) * 1.2;
    ctx.fillStyle = shade ? C.jeansShade : C.jeans;
    ctx.fillRect(x + dx, -8.4 - up * 0.2, 4.4, 8.2 - up);
    ctx.fillStyle = C.shoe;
    ctx.fillRect(x + dx - 0.3, -2.4 - up, 5.2, 2.2);
    ctx.fillStyle = C.sole;
    ctx.fillRect(x + dx - 0.3, -0.5 - up, 5.2, 0.7);
  };
  leg(0.2, -swing, true);
  leg(-4.6, swing, false);

  // arms behind/in front of the body
  const arm = (side: -1 | 1, front: boolean) => {
    let ang = (walking ? side * swing * 0.55 : 0);
    if (side === 1 && pose === 'wave') ang = -2.5 + Math.sin(t * 10) * 0.35;
    if (side === 1 && pose === 'point') ang = -1.45;
    if (pose === 'jump') ang = side * -0.5 - 0.3;
    // "six seven": both forearms out, palms up, bouncing up and down in turn (about 2.2 bounces/s)
    if (pose === 'sixseven') ang = -1.25 + side * 0.42 * Math.sin(t * 2 * Math.PI * 2.2);
    ctx.save();
    ctx.translate(side * 6.9, -16.4);
    ctx.rotate(ang * side);
    ctx.fillStyle = front ? C.sweater : C.sweaterShade;
    ctx.fillRect(-1.45, 0, 2.9, 7.2);
    ctx.fillStyle = C.sweaterCuff;
    ctx.fillRect(-1.45, 6.2, 2.9, 1.2);
    ctx.fillStyle = front ? C.skin : C.skinShade;
    ctx.fillRect(-1.3, 7.4, 2.6, 2.4);
    ctx.restore();
  };
  arm(-1, false);

  // torso: blue sweater, darker right side, pizza on the chest
  ctx.fillStyle = C.sweater;
  roundRect(ctx, -6, -17.4, 12, 9.6, 1.2);
  ctx.fill();
  ctx.fillStyle = C.sweaterShade;
  ctx.fillRect(3.4, -17, 2.6, 9.0);
  ctx.fillStyle = C.sweaterCuff;
  ctx.fillRect(-6, -8.6, 12, 1.0);
  ctx.fillStyle = C.crust;
  ctx.beginPath(); ctx.moveTo(-2.1, -14.9); ctx.lineTo(2.1, -14.9); ctx.lineTo(0, -10.7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.pizza;
  ctx.beginPath(); ctx.moveTo(-1.7, -14.3); ctx.lineTo(1.7, -14.3); ctx.lineTo(0, -11.2); ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.pepperoni;
  ctx.beginPath(); ctx.arc(-0.55, -13.5, 0.45, 0, Math.PI * 2); ctx.arc(0.55, -12.7, 0.45, 0, Math.PI * 2); ctx.fill();

  arm(1, true);

  // head
  const look = pose === 'look' ? Math.sin(t * 2.2) * 0.9 : pose === 'sixseven' ? Math.sin(t * 2 * Math.PI * 2.2) * 0.45 : 0;
  ctx.save();
  ctx.translate(look, 0);
  ctx.fillStyle = C.skin;
  roundRect(ctx, -5, -27.2, 10, 9.6, 2.2);
  ctx.fill();
  ctx.fillStyle = C.skinShade;
  ctx.fillRect(3.2, -26.2, 1.8, 7.6);

  // face: eyes and the classic smile (or a talking mouth)
  ctx.fillStyle = C.ink;
  ctx.beginPath(); ctx.arc(-1.75, -22.9, 0.62, 0, Math.PI * 2); ctx.arc(1.75, -22.9, 0.62, 0, Math.PI * 2); ctx.fill();
  const open = talk ? (Math.sin(t * 52) > 0 ? 1 : 0.35) : 0;
  if (open > 0) {
    ctx.beginPath();
    ctx.ellipse(0, -20.5, 1.5, 0.55 + 0.75 * open, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 0.55;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, -21.6, 2.15, 0.18 * Math.PI, 0.82 * Math.PI);
    ctx.stroke();
  }

  // hair: side locks and a fringe swept across the forehead
  ctx.fillStyle = C.hair;
  ctx.beginPath();
  ctx.moveTo(-5.4, -25.4); ctx.lineTo(-5.6, -19.2); ctx.lineTo(-4.2, -20.4); ctx.lineTo(-3.6, -24.6);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-5.4, -25.6); ctx.lineTo(4.8, -25.8); ctx.lineTo(3.4, -24.1); ctx.lineTo(0.6, -24.4);
  ctx.lineTo(-1.6, -23.4); ctx.lineTo(-3.8, -24.2);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.hairShade;
  ctx.beginPath();
  ctx.moveTo(5.2, -25.6); ctx.lineTo(5.3, -21.4); ctx.lineTo(4.2, -22.6); ctx.lineTo(4.2, -25.0);
  ctx.closePath(); ctx.fill();

  // red beanie: dome and folded band
  ctx.fillStyle = C.beanie;
  ctx.beginPath();
  ctx.ellipse(0, -26.1, 5.7, 4.4, 0, Math.PI, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = C.beanieShade;
  ctx.beginPath();
  ctx.ellipse(0, -26.1, 5.7, 4.4, 0, 1.62 * Math.PI, 2 * Math.PI);
  ctx.lineTo(0, -26.1);
  ctx.fill();
  ctx.fillStyle = C.beanieBand;
  roundRect(ctx, -5.9, -26.6, 11.8, 1.9, 0.8);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── Jadie's pet (a companion that trots beside him in reels) ────────────────────
export type CompanionPet = 'dog' | 'cat' | 'bunny' | 'fox';

const P = {
  dog: { body: '#a8713f', shade: '#8c5c31', dark: '#6b4423' },
  cat: { body: '#8d929c', shade: '#747985', dark: '#5d616b' },
  bunny: { body: '#f2ede3', shade: '#ddd6c8', dark: '#e9a5a5' },
  fox: { body: '#e07a2f', shade: '#c4651f', dark: '#3a2a20' },
};

/**
 * Draw a small pet with its feet at (sx, sy), facing `face`, in the same flat style and scale as Jadie
 * (about 9 units long). `moving` makes it trot; at rest it breathes and wags.
 */
export function drawCompanion(ctx: CanvasRenderingContext2D, sx: number, sy: number, k: number, kind: CompanionPet, t: number, face: 1 | -1 = 1, moving = false) {
  const c = P[kind];
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(k * face * SCALE * 1.3, k * SCALE * 1.3); // a bit larger than life so it reads on a phone
  const hop = kind === 'bunny' ? -Math.abs(Math.sin(t * (moving ? 9 : 2.4))) * (moving ? 3 : 0.6) : moving ? -Math.abs(Math.sin(t * 11)) * 0.8 : 0;
  // shadow
  ctx.fillStyle = 'rgba(10,16,32,0.28)';
  ctx.beginPath(); ctx.ellipse(0, 0.2, 5.2, 1.7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(0, hop);
  const step = moving ? Math.sin(t * 22) * 0.9 : 0;
  // legs (not for the bunny, whose body sits on its feet)
  if (kind !== 'bunny') {
    ctx.fillStyle = c.shade;
    for (const [x, s] of [[-3.4, step], [-1.6, -step], [2.0, -step], [3.6, step]] as const) ctx.fillRect(x + s * 0.4, -3.2, 1.2, 3.2);
  }
  // tail
  ctx.strokeStyle = kind === 'fox' ? c.body : c.shade;
  ctx.lineCap = 'round';
  if (kind === 'dog') {
    const wag = Math.sin(t * 16) * 0.8;
    ctx.lineWidth = 1.1; ctx.beginPath(); ctx.moveTo(-4.4, -5.4); ctx.quadraticCurveTo(-6.2, -7.2 + wag, -6.0, -8.6 + wag); ctx.stroke();
  } else if (kind === 'cat') {
    ctx.lineWidth = 1.0; ctx.beginPath(); ctx.moveTo(-4.4, -5.0); ctx.quadraticCurveTo(-7.2, -6.0, -6.4, -10.2 + Math.sin(t * 3) * 0.5); ctx.stroke();
  } else if (kind === 'fox') {
    ctx.fillStyle = c.body; ctx.beginPath(); ctx.ellipse(-6.0, -5.2, 3.0, 1.6, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f7efe2'; ctx.beginPath(); ctx.ellipse(-8.2, -6.4, 1.2, 0.9, -0.5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(-4.2, -4.4, 1.3, 0, Math.PI * 2); ctx.fill();
  }
  // body
  ctx.fillStyle = c.body;
  ctx.beginPath();
  if (kind === 'bunny') ctx.ellipse(0, -3.4, 3.8, 3.2, 0, 0, Math.PI * 2);
  else ctx.ellipse(0, -5.0, 4.8, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.shade;
  ctx.beginPath();
  if (kind === 'bunny') ctx.ellipse(0.6, -2.4, 3.0, 1.6, 0, 0, Math.PI * 2);
  else ctx.ellipse(0.4, -4.0, 4.0, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // head
  const hx = kind === 'bunny' ? 3.2 : 4.4, hy = kind === 'bunny' ? -6.6 : -7.4;
  ctx.fillStyle = c.body;
  ctx.beginPath(); ctx.arc(hx, hy, kind === 'bunny' ? 2.3 : 2.5, 0, Math.PI * 2); ctx.fill();
  // ears
  if (kind === 'dog') {
    ctx.fillStyle = c.dark; ctx.beginPath(); ctx.ellipse(hx - 1.4, hy - 0.2, 0.9, 1.9, 0.3, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'bunny') {
    for (const dx of [-0.9, 0.7]) {
      ctx.fillStyle = c.body; ctx.beginPath(); ctx.ellipse(hx + dx, hy - 3.6, 0.85, 2.6, 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.dark; ctx.beginPath(); ctx.ellipse(hx + dx, hy - 3.4, 0.38, 1.8, 0.12, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    ctx.fillStyle = c.body;
    for (const dx of [-1.5, 1.1]) { ctx.beginPath(); ctx.moveTo(hx + dx - 1.0, hy - 1.4); ctx.lineTo(hx + dx + 0.2, hy - 4.2); ctx.lineTo(hx + dx + 1.0, hy - 1.2); ctx.closePath(); ctx.fill(); }
  }
  // snout, nose, eye
  if (kind === 'dog' || kind === 'fox') {
    ctx.fillStyle = kind === 'fox' ? '#f7efe2' : c.shade;
    ctx.beginPath(); ctx.ellipse(hx + 2.4, hy + 0.6, 1.6, 1.0, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#1d1b1a';
  ctx.beginPath(); ctx.arc(hx + (kind === 'bunny' ? 2.1 : 3.6), hy + (kind === 'bunny' ? 0.2 : 0.4), 0.45, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(hx + 0.9, hy - 0.5, 0.42, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
