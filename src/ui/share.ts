// Share card: a 1080×1920 PNG for Instagram Stories.
// Instagram draws its own UI over roughly the top 250px and bottom 300px,
// so no key text goes there.
import type { CityData, Resident } from '../types';
import { COLORS, FONTS, alpha, mix, type SkyState } from '../theme';
import { drawHouse } from '../city/house';
import { addressOf } from './lookup';

const W = 1080;
const H = 1920;
const SAFE_BOTTOM = H - 300;

/** Small deterministic PRNG so a resident's stars are the same every time. */
function seeded(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

async function fontsReady() {
  try {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load(`120px ${FONTS.display}`, 'Kinsburg'),
      document.fonts.load(`700 96px ${FONTS.ui}`, '@abc'),
      document.fonts.load(`500 44px ${FONTS.ui}`, 'Resident'),
      document.fonts.load(`600 40px ${FONTS.ui}`, 'Find'),
    ]);
  } catch {
    // Fall back to system fonts; the card still renders.
  }
}

/** Shrink the font until the text fits `maxW`. Returns the size used. */
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, start: number, min: number, maxW: number) {
  let size = start;
  for (; size > min; size -= 4) {
    ctx.font = `${weight} ${size}px ${FONTS.ui}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  ctx.font = `${weight} ${size}px ${FONTS.ui}`;
  return size;
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

export async function renderShareCard(resident: Resident, data: CityData, sky: SkyState): Promise<Blob> {
  await fontsReady();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');

  const p = sky.palette;
  const dark = sky.ui === 'dark';
  const ink = dark ? COLORS.nightInk : COLORS.ink;
  const inkSoft = dark ? COLORS.nightInkSoft : COLORS.inkSoft;
  const paper = dark ? COLORS.nightPaper : COLORS.paper;

  // Sky
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, p.skyTop);
  g.addColorStop(0.62, p.skyBottom);
  g.addColorStop(1, mix(p.skyBottom, p.skyTop, 0.35));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Stars at night
  if (sky.darkness > 0.4) {
    const rand = seeded(resident.id);
    const count = Math.round(140 * sky.darkness);
    for (let i = 0; i < count; i++) {
      const x = rand() * W;
      const y = rand() * H * 0.62;
      const r = 1 + rand() * 2.6;
      ctx.fillStyle = alpha(COLORS.nightInk, (0.35 + rand() * 0.6) * sky.darkness * (1 - y / (H * 0.8)));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Wordmark
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  ctx.font = `120px ${FONTS.display}`;
  ctx.fillText(data.name || 'Kinsburg', W / 2, 380);

  // Grass island with the house
  const cx = W / 2;
  const cy = 880;
  const iw = 700;
  const ih = iw / 2;
  const depth = 40;

  if (sky.glow > 0.05) {
    const halo = ctx.createRadialGradient(cx, cy - 120, 20, cx, cy - 120, 520);
    halo.addColorStop(0, alpha(COLORS.glow, 0.32 * sky.glow));
    halo.addColorStop(1, alpha(COLORS.glow, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, cy - 700, W, 1100);
  }
  // soft shadow under the island
  ctx.fillStyle = alpha(p.edge, 0.22);
  ctx.beginPath();
  ctx.ellipse(cx, cy + ih / 2 + depth - 10, iw * 0.4, 34, 0, 0, Math.PI * 2);
  ctx.fill();
  // island sides
  ctx.fillStyle = p.grassShade;
  ctx.beginPath();
  ctx.moveTo(cx - iw / 2, cy);
  ctx.lineTo(cx, cy + ih / 2);
  ctx.lineTo(cx + iw / 2, cy);
  ctx.lineTo(cx + iw / 2, cy + depth);
  ctx.lineTo(cx, cy + ih / 2 + depth);
  ctx.lineTo(cx - iw / 2, cy + depth);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = alpha(p.edge, 0.25);
  ctx.beginPath();
  ctx.moveTo(cx, cy + ih / 2);
  ctx.lineTo(cx + iw / 2, cy);
  ctx.lineTo(cx + iw / 2, cy + depth);
  ctx.lineTo(cx, cy + ih / 2 + depth);
  ctx.closePath();
  ctx.fill();
  // island top
  ctx.fillStyle = p.grass;
  ctx.beginPath();
  ctx.moveTo(cx, cy - ih / 2);
  ctx.lineTo(cx + iw / 2, cy);
  ctx.lineTo(cx, cy + ih / 2);
  ctx.lineTo(cx - iw / 2, cy);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  drawHouse(ctx, cx, cy, 440, { style: resident.houseStyle, perks: resident.perks, sky });
  ctx.restore();

  // Text panel
  const panelX = 90;
  const panelY = 1150;
  const panelW = W - panelX * 2;
  const panelH = 330;
  ctx.fillStyle = alpha(paper, dark ? 0.72 : 0.8);
  roundRect(ctx, panelX, panelY, panelW, panelH, 44);
  ctx.fill();

  ctx.textAlign = 'center';
  const handle = '@' + resident.handle;
  ctx.fillStyle = ink;
  fitText(ctx, handle, 700, 96, 48, panelW - 80);
  ctx.fillText(handle, W / 2, panelY + 120);

  ctx.fillStyle = ink;
  ctx.font = `600 44px ${FONTS.ui}`;
  ctx.fillText(`Resident #${resident.number.toLocaleString()} of ${data.name || 'Kinsburg'}`, W / 2, panelY + 198);

  ctx.fillStyle = inkSoft;
  const address = addressOf(resident, data);
  const line3 = address ? `${address}` : '';
  fitText(ctx, line3, 500, 40, 28, panelW - 80);
  if (line3) ctx.fillText(line3, W / 2, panelY + 252);
  ctx.font = `500 40px ${FONTS.ui}`;
  ctx.fillText(resident.job, W / 2, panelY + (line3 ? 304 : 252));

  // Footer (ends above the bottom 300px)
  ctx.fillStyle = ink;
  ctx.font = `600 40px ${FONTS.ui}`;
  ctx.fillText('Find your home at kinsburg.com', W / 2, SAFE_BOTTOM - 62);
  ctx.font = `500 36px ${FONTS.ui}`;
  ctx.fillText('@' + (data.account || 'kinsburgtown'), W / 2, SAFE_BOTTOM - 8);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode PNG'))), 'image/png');
  });
}

/** Share via the native sheet when files are supported, otherwise download. Returns what happened. */
export async function shareOrDownload(blob: Blob, handle: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const name = `kinsburg-${handle}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'My home in Kinsburg' });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
