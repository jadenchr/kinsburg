#!/usr/bin/env node
// Print file for the "City poster" perk: the whole of Kinsburg on one sheet with the buyer's
// house circled and named. 3600×4800 px = 12×16 in at 300 dpi (most print-on-demand services).
//
//   node scripts/poster.mjs --handle bea_makes
//   node scripts/poster.mjs --handle bea_makes --hour 21.5 --url https://kinsburg.com
//   node scripts/poster.mjs --handle a,b --w 4800 --h 6000      # 16×20 in
//
// Output: out/poster-<handle>.png. Upload it to your print service, then mark the order done:
//   curl -X POST https://kinsburg.com/admin/order/done -H "Authorization: Bearer …" -d '{"id":1}'
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { parseArgs, sleep } from './reel/lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();
const HANDLE = String(args.handle ?? '').replace(/^@+/, '').toLowerCase();
if (!HANDLE) {
  console.error('usage: node scripts/poster.mjs --handle <instagram handle> [--hour 20.5] [--url https://kinsburg.com] [--w 3600 --h 4800]');
  process.exit(2);
}
const W = Number(args.w ?? 3600), H = Number(args.h ?? 4800);
const HOUR = String(args.hour ?? '20.6'); // golden hour turning to night: lit windows, warm sky
const BASE = (args.url ?? process.env.KINSBURG_URL ?? '').replace(/\/+$/, '');
const PORT = Number(args.port ?? 4181);
const log = (...a) => console.log('[poster]', ...a);

let server;
async function base() {
  if (BASE) return BASE;
  if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('no dist/ — run `npx vite build` first, or pass --url');
  server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const url = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return url; } catch {}
    await sleep(250);
  }
  throw new Error('vite preview did not start');
}

let browser;
try {
  const site = await base();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-color-profile=srgb'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
  const q = new URLSearchParams({ reel: '1', poster: '1', w: String(W), h: String(H), hour: HOUR, focus: HANDLE, duration: '3' });
  log('rendering', `${W}×${H}`, 'for', '@' + HANDLE);
  await page.goto(`${site}/?${q}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => !!window.kinsburgReel, null, { timeout: 60_000 });
  await page.evaluate(() => window.kinsburgReel.ready);
  const stats = await page.evaluate(() => window.kinsburgReel.stats);
  if (stats.missingFocus.length) throw new Error(`@${HANDLE} doesn't live in Kinsburg`);
  await page.evaluate(() => document.fonts.ready);
  const dataUrl = await page.evaluate(() => window.kinsburgReel.captureFrame(0, 'image/png'));
  mkdirSync(join(ROOT, 'out'), { recursive: true });
  const file = join(ROOT, 'out', `poster-${HANDLE}.png`);
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  log('saved', relative(ROOT, file));
} catch (err) {
  console.error('[poster] FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
