#!/usr/bin/env node
// Record the daily Kinsburg Reel: headless Chrome renders the city frame by frame in
// ?reel=1 mode, ffmpeg adds the title overlay + audio and encodes an Instagram-ready MP4.
//
//   node scripts/reel/record.mjs                      # local build via `vite preview`
//   node scripts/reel/record.mjs --url https://kinsburg.com
//   node scripts/reel/record.mjs --duration 8 --focus kinsburgtown --hour 18-21.6
//
// Options (all optional):
//   --url <base>          site to record (env KINSBURG_URL). Default: serve ./dist locally
//   --port 4180           port for the local `vite preview`
//   --duration 20         seconds (3 … 900)
//   --fps 30              23 … 60
//   --w 1080 --h 1920     frame size
//   --hour <h|a-b>        fixed hour (21.5) or time-lapse range (18.2-21.7). Default: golden hour → night
//   --focus a,b           residents to fly to (default: today's newest, ≤ 3)
//   --day <n>             override the city day number
//   --series lights-on    caption/title set from scripts/reel/series.mjs (env REEL_SERIES)
//   --title "…" --subtitle "…"   override the overlay text ({day} {residents} {new_today} {street})
//   --music <file>        audio track (royalty-free only!). Default: a file from scripts/reel/audio/
//                         picked by date, else a generated ambient bed
//   --no-music            always use the generated ambient bed
//   --font <ttf|otf>      overlay font file (env REEL_FONT). Default: Figtree from Google Fonts,
//                         falling back to a system sans-serif
//   --no-names            leave new residents' names out of the caption
//   --out out             output folder
//   --date YYYY-MM-DD     date used in file names (default: today, UTC)
//   --quality 0.92        JPEG quality of the captured frames (--frame-format png for lossless)
//   --crf 20 --preset medium     x264 settings
//   --ffmpeg / --ffprobe  binaries (env FFMPEG / FFPROBE). Default: from PATH
//   --chrome <path>       Chrome executable (env CHROME_PATH). Default: Playwright's channel 'chrome'
//
// Output: out/reel-YYYY-MM-DD.mp4, out/reel-YYYY-MM-DD.jpg (cover), out/caption.txt,
//         out/reel-YYYY-MM-DD.json (manifest for publish.mjs)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { parseArgs, run, sleep, probe, rgba, strHash, ambientArgs } from './lib.mjs';
import { SERIES, buildCaption } from './series.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = parseArgs();
const opt = (k, env, def) => (args[k] !== undefined && args[k] !== true ? String(args[k]) : env && process.env[env] ? process.env[env] : def);

const W = Number(opt('w', null, '1080'));
const H = Number(opt('h', null, '1920'));
const FPS = Math.max(23, Math.min(60, Number(opt('fps', null, '30'))));
const DUR = Math.max(3, Math.min(900, Number(opt('duration', 'REEL_DURATION', '20'))));
const HOUR = opt('hour', 'REEL_HOUR', '');
const FOCUS = opt('focus', null, '');
const DAY = opt('day', null, '');
const SERIES_ID = opt('series', 'REEL_SERIES', 'lights-on');
const DATE = opt('date', null, new Date().toISOString().slice(0, 10));
const OUT = resolve(ROOT, opt('out', null, 'out'));
const FFMPEG = opt('ffmpeg', 'FFMPEG', 'ffmpeg');
const FFPROBE = opt('ffprobe', 'FFPROBE', 'ffprobe');
const FONT = opt('font', 'REEL_FONT', '');
const QUALITY = Number(opt('quality', null, '0.92'));
const FRAME_FMT = opt('frame-format', null, 'jpeg') === 'png' ? 'png' : 'jpeg';
const CRF = opt('crf', null, '20');
/** Peak video bitrate. 8 Mbps keeps a 20 s reel near 20 MB (hosting limit is 25 MiB per file). */
const MAXRATE = opt('maxrate', null, '8M');
const BUFSIZE = String(parseInt(MAXRATE, 10) * 2) + 'M';
const PRESET = opt('preset', null, 'medium');
const PORT = Number(opt('port', null, '4180'));
const CHROME = opt('chrome', 'CHROME_PATH', '');
let BASE = opt('url', 'KINSBURG_URL', '');

if (!SERIES[SERIES_ID]) {
  console.error(`Unknown --series "${SERIES_ID}". Known: ${Object.keys(SERIES).join(', ')}`);
  process.exit(2);
}

const log = (...a) => console.log('[reel]', ...a);
const cleanup = [];
async function teardown() {
  while (cleanup.length) {
    try {
      await cleanup.pop()();
    } catch {
      /* best effort */
    }
  }
}
process.on('SIGINT', () => teardown().then(() => process.exit(130)));

async function waitForHttp(url, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Serve ./dist with `vite preview` unless --url was given. */
async function ensureServer() {
  if (BASE) return BASE.replace(/\/+$/, '');
  if (!existsSync(join(ROOT, 'dist/index.html'))) {
    log('no dist/ yet, building…');
    await run(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { quiet: false });
  }
  const p = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errText = '';
  p.stderr.on('data', (d) => (errText += d));
  cleanup.push(async () => p.kill('SIGTERM'));
  const base = `http://127.0.0.1:${PORT}`;
  await waitForHttp(base + '/').catch((e) => {
    throw new Error(`${e.message}\n${errText}`);
  });
  log('serving dist at', base);
  return base;
}

/** Pick the audio: --music, else a track in scripts/reel/audio/ (rotated by date), else synth. */
async function audioFile(tmp) {
  if (args.music !== false) {
    if (typeof args.music === 'string') {
      const f = resolve(process.cwd(), args.music);
      if (!existsSync(f)) throw new Error(`--music file not found: ${f}`);
      return { file: f, kind: `track ${relative(ROOT, f)}` };
    }
    const dir = join(ROOT, 'scripts/reel/audio');
    const tracks = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(f)).sort() : [];
    if (tracks.length) {
      const f = join(dir, tracks[Math.floor(strHash(DATE) * tracks.length)]);
      return { file: f, kind: `track ${relative(ROOT, f)}` };
    }
  }
  const f = join(tmp, 'ambient.wav');
  await run(FFMPEG, ambientArgs(DUR, f, strHash(DATE)));
  return { file: f, kind: 'generated ambient bed' };
}

/** Title overlay as a transparent full-frame PNG, rendered by Chrome (no ffmpeg drawtext/freetype needed). */
async function renderOverlay(browser, title, subtitle, colors, file) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    let fontFace = '';
    let family = `'Figtree', 'Avenir Next', 'Helvetica Neue', 'Segoe UI', 'Noto Sans', 'DejaVu Sans', system-ui, sans-serif`;
    if (FONT) {
      const buf = readFileSync(resolve(process.cwd(), FONT));
      const fmt = extname(FONT).toLowerCase() === '.otf' ? 'opentype' : extname(FONT).toLowerCase() === '.woff2' ? 'woff2' : 'truetype';
      fontFace = `@font-face{font-family:'ReelFont';src:url(data:font/${fmt};base64,${buf.toString('base64')}) format('${fmt}');font-weight:100 900;}`;
      family = `'ReelFont', ${family}`;
    }
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    // Safe zone: Instagram covers ~220 px at the top and ~420 px at the bottom of a 1920 frame.
    const top = Math.round(H * (262 / 1920));
    const k = W / 1080;
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
${FONT ? '' : '<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@600;800&display=block" rel="stylesheet">'}
<style>${fontFace}
html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
.wrap{position:absolute;left:0;right:0;top:${top}px;display:flex;flex-direction:column;align-items:center;gap:${Math.round(16 * k)}px;font-family:${family}}
.t{font-weight:800;font-size:${Math.round(84 * k)}px;line-height:1.05;color:${colors.nightInk};letter-spacing:-0.01em;white-space:nowrap;
  padding:${Math.round(20 * k)}px ${Math.round(44 * k)}px ${Math.round(24 * k)}px;border-radius:${Math.round(999 * k)}px;background:${rgba(colors.nightPaper, 0.5)};
  text-shadow:0 ${Math.round(3 * k)}px ${Math.round(14 * k)}px ${rgba(colors.nightPaper, 0.6)}}
.s{font-weight:600;font-size:${Math.round(44 * k)}px;line-height:1.15;color:${colors.glow};white-space:nowrap;
  padding:${Math.round(10 * k)}px ${Math.round(30 * k)}px;border-radius:${Math.round(999 * k)}px;background:${rgba(colors.nightPaper, 0.42)};
  text-shadow:0 ${Math.round(2 * k)}px ${Math.round(10 * k)}px ${rgba(colors.nightPaper, 0.7)}}
</style></head><body><div class="wrap"><div class="t" id="t">${esc(title)}</div>${subtitle ? `<div class="s" id="s">${esc(subtitle)}</div>` : ''}</div></body></html>`,
      { waitUntil: 'load', timeout: 15_000 },
    ).catch(() => log('overlay: web font did not load in time, using a system font'));
    await page.evaluate(async (maxW) => {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
      // shrink long lines until they fit inside the side margins
      for (const id of ['t', 's']) {
        const el = document.getElementById(id);
        if (!el) continue;
        let size = parseFloat(getComputedStyle(el).fontSize);
        while (el.getBoundingClientRect().width > maxW && size > 20) el.style.fontSize = `${(size *= 0.95)}px`;
      }
    }, Math.round(W * 0.88));
    const usedFont = await page.evaluate(() => {
      const fam = getComputedStyle(document.getElementById('t')).fontFamily.split(',')[0].trim();
      return [...document.fonts].some((f) => f.status === 'loaded') ? fam : 'system fallback';
    });
    await page.screenshot({ path: file, omitBackground: true, type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    return usedFont;
  } finally {
    await page.close();
  }
}

async function main() {
  const t0 = Date.now();
  mkdirSync(OUT, { recursive: true });
  const tmp = join(OUT, `.tmp-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  cleanup.push(async () => rmSync(tmp, { recursive: true, force: true }));

  const base = await ensureServer();
  const q = new URLSearchParams({ reel: '1', duration: String(DUR), fps: String(FPS), w: String(W), h: String(H) });
  if (HOUR) q.set('hour', HOUR);
  if (FOCUS) q.set('focus', FOCUS);
  if (DAY) q.set('day', DAY);
  const pageUrl = `${base}/?${q}`;

  log('launching Chrome…');
  const browser = await chromium
    .launch({
      ...(CHROME ? { executablePath: CHROME } : { channel: 'chrome' }),
      headless: true,
      args: ['--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    })
    .catch((e) => {
      throw new Error(`Could not start Chrome (${e.message.split('\n')[0]}).\nInstall Google Chrome, set CHROME_PATH, or run: npx playwright-core install chrome`);
    });
  cleanup.push(() => browser.close());

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => r.status() >= 400 && !/favicon/.test(r.url()) && pageErrors.push(`HTTP ${r.status()} ${r.url()}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && pageErrors.push(m.text()));
  log('opening', pageUrl);
  await page.goto(pageUrl, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => !!window.kinsburgReel, null, { timeout: 60_000 }).catch(() => {
    throw new Error(`Reel mode did not start on ${pageUrl}. Does the site include src/reel.ts? Page errors:\n${pageErrors.join('\n')}`);
  });
  await page.evaluate(() => window.kinsburgReel.ready);
  const { stats, colors, duration, width, height } = await page.evaluate(() => {
    const r = window.kinsburgReel;
    return { stats: r.stats, colors: r.colors, duration: r.duration, width: r.width, height: r.height };
  });
  if (width !== W || height !== H || duration !== DUR) throw new Error(`Page reports ${width}x${height} ${duration}s, expected ${W}x${H} ${DUR}s`);
  if (stats.missingFocus.length) log('focus handles not found (skipped):', stats.missingFocus.join(', '));
  log(`city day ${stats.day}: ${stats.residents} residents, ${stats.newToday} new today; camera visits: ${stats.focus.join(', ') || '(town centre)'}`);

  // ── text: overlay + caption ──
  const names = args.names === false ? [] : stats.newResidents.map((r) => r.handle);
  const cs = { day: stats.day, residents: stats.residents, newToday: stats.newToday, names, street: stats.newestStreet, city: stats.city };
  const fill = (tpl) =>
    tpl
      .replaceAll('{day}', String(cs.day))
      .replaceAll('{residents}', cs.residents.toLocaleString('en-US'))
      .replaceAll('{new_today}', cs.newToday.toLocaleString('en-US'))
      .replaceAll('{street}', cs.street ?? '');
  const series = SERIES[SERIES_ID];
  const title = typeof args.title === 'string' ? fill(args.title) : series.title(cs);
  const subtitle = typeof args.subtitle === 'string' ? fill(args.subtitle) : args.subtitle === false ? '' : series.subtitle(cs);
  const caption = buildCaption(SERIES_ID, cs);
  const overlayPng = join(tmp, 'overlay.png');
  const font = await renderOverlay(browser, title, subtitle, colors, overlayPng);
  log(`overlay "${title}" / "${subtitle}" (font: ${font})`);

  const audio = await audioFile(tmp);
  log('audio:', audio.kind);

  // ── encode: frames on stdin + overlay + audio → H.264/AAC MP4 with +faststart ──
  const mp4 = join(OUT, `reel-${DATE}.mp4`);
  const fadeOut = Math.max(0, DUR - 1.5).toFixed(3);
  const ff = spawn(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', FRAME_FMT === 'png' ? 'png' : 'mjpeg', '-i', 'pipe:0',
      '-loop', '1', '-framerate', String(FPS), '-i', overlayPng,
      ...(audio.kind.startsWith('track') ? ['-stream_loop', '-1'] : []), '-i', audio.file,
      '-filter_complex',
      [
        `[1:v]format=rgba,fade=t=in:st=0.35:d=0.7:alpha=1[ov]`,
        // JPEG frames are full-range BT.601; Instagram expects limited-range BT.709 yuv420p
        `[0:v]scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p[base]`,
        `[base][ov]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]`,
        `[2:a]atrim=0:${DUR},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=0.8,afade=t=out:st=${fadeOut}:d=1.5[a]`,
      ].join(';'),
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-r', String(FPS), '-g', String(FPS * 2), '-keyint_min', String(FPS), '-sc_threshold', '0', '-bf', '2',
      '-maxrate', MAXRATE, '-bufsize', BUFSIZE, // capped so a 20 s reel stays under the 25 MiB KV value limit
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-t', String(DUR),
      '-movflags', '+faststart', '-use_editlist', '0',
      mp4,
    ],
    { stdio: ['pipe', 'inherit', 'pipe'] },
  );
  let ffErr = '';
  ff.stderr.on('data', (d) => (ffErr += d));
  const ffDone = new Promise((res, rej) => {
    ff.on('error', rej);
    ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}\n${ffErr.slice(-3000)}`))));
  });
  cleanup.push(async () => ff.exitCode === null && ff.kill('SIGKILL'));
  let ffClosed = false;
  ff.on('close', () => (ffClosed = true));
  ff.stdin.on('error', () => {}); // surfaced through ffDone instead
  const write = async (buf) => {
    if (ffClosed) await ffDone;
    if (!ff.stdin.write(buf)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), ffDone]);
  };

  const frames = Math.round(DUR * FPS);
  const mime = FRAME_FMT === 'png' ? 'image/png' : 'image/jpeg';
  const tRender = Date.now();
  let worst = 0;
  for (let i = 0; i < frames; i++) {
    const ts = Date.now();
    const url = await page.evaluate(([t, m, qq]) => window.kinsburgReel.captureFrame(t, m, qq), [i / FPS, mime, QUALITY]);
    worst = Math.max(worst, Date.now() - ts);
    await write(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    if ((i + 1) % (FPS * 2) === 0 || i === frames - 1) {
      const per = (Date.now() - tRender) / (i + 1) / 1000;
      process.stdout.write(`[reel] frame ${i + 1}/${frames}  ${per.toFixed(3)} s/frame  (eta ${Math.round(per * (frames - i - 1))} s)\n`);
    }
  }
  ff.stdin.end();
  await ffDone;
  const renderSec = (Date.now() - tRender) / 1000;
  if (pageErrors.length) log('page reported errors:\n  ' + pageErrors.join('\n  '));

  // ── cover: the last second (town hall at night, title on) ──
  const cover = join(OUT, `reel-${DATE}.jpg`);
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, DUR - 0.75)), '-i', mp4, '-frames:v', '1', '-q:v', '2', cover]);

  writeFileSync(join(OUT, 'caption.txt'), caption + '\n');
  const info = await probe(mp4, FFPROBE).catch((e) => ({ ok: false, error: e.message }));
  const manifest = {
    date: DATE,
    series: SERIES_ID,
    video: relative(ROOT, mp4),
    cover: relative(ROOT, cover),
    caption,
    title,
    subtitle,
    stats,
    source: base,
    audio: audio.kind,
    probe: info,
    timing: { frames, renderSeconds: Math.round(renderSec * 10) / 10, secondsPerFrame: Math.round((renderSec / frames) * 1000) / 1000, worstFrameMs: worst, totalSeconds: Math.round((Date.now() - t0) / 100) / 10 },
  };
  writeFileSync(join(OUT, `reel-${DATE}.json`), JSON.stringify(manifest, null, 2) + '\n');

  log(`done in ${manifest.timing.totalSeconds} s (${manifest.timing.secondsPerFrame} s/frame, worst ${worst} ms)`);
  log('video  ', manifest.video, info.ok ? '✓ Instagram specs' : '✗ CHECK SPECS', JSON.stringify(info));
  log('cover  ', manifest.cover);
  log('caption', relative(ROOT, join(OUT, 'caption.txt')), `(${caption.length} chars)`);
  if (!info.ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('[reel] FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(teardown);
