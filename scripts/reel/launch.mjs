#!/usr/bin/env node
// The three launch reels from docs/launch-content.md §3, filmed in the live city.
//
//   npm run reel:launch                       # all three, local build (sample residents)
//   npm run reel:launch -- --only A
//   npm run reel:launch -- --url https://kinsburg.com     # with the real residents
//
// How they're made (same system as From Day 30):
//   • narration in the From Day 30 voice (Kokoro "am_fenrir", scripts/reel/voice.py);
//     every glide, dissolve and caption is timed from the narration
//   • one continuous camera per scene through the city: hold → glide (cubic, or sine for calmer reels) → hold,
//     close-ups on houses; soft dissolves only where the time of day jumps
//   • one text system: 1–3 word captions synced to the voice in a fixed slot, the last word in
//     gold; a small info bar at the top; plate, comment bubble and card in one centre column
//
// Output in out/launch/: launch-A.mp4 (+ .jpg cover, .txt caption) … launch-C.mp4.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ambientArgs, parseArgs, probe, run, sleep } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = parseArgs();
const W = 1080, H = 1920, FPS = 30, XF = 0.5; // dissolve length (s)
const OUT = join(ROOT, 'out', 'launch');
const ONLY = args.only ? String(args.only).toUpperCase() : null;
const BASE = (args.url ?? process.env.KINSBURG_URL ?? '').replace(/\/+$/, '');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const KOKORO_PYTHON = process.env.KOKORO_PYTHON ?? join(ROOT, '..', 'thelastone - like', 'from-day-30', '.venv-tts', 'bin', 'python');
const log = (...a) => console.log('[launch]', ...a);

// Layout (1080×1920). Instagram covers ~220 px at the top and ~420 px at the bottom.
const L = { hudTop: 236, capTop: 330, capH: 260, colTop: 1130, cardTop: 610, cardH: 880 };
const C = { ink: '#18233a', gold: '#ffc95c', white: '#ffffff' };

// ── serving + browser ────────────────────────────────────────────────────────
let server, browser;
async function site() {
  if (BASE) return BASE;
  if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('no dist/ — run `npx vite build` first, or pass --url');
  server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', '4182', '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch('http://127.0.0.1:4182/')).ok) return 'http://127.0.0.1:4182'; } catch {}
    await sleep(250);
  }
  throw new Error('vite preview did not start');
}
async function cityPage(base) {
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 1 });
  const q = new URLSearchParams({ reel: '1', w: String(W), h: String(H), fps: String(FPS), duration: '60' });
  await page.goto(`${base}/?${q}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => !!window.kinsburgReel, null, { timeout: 60_000 });
  await page.evaluate(() => window.kinsburgReel.ready);
  return page;
}

// ── narration ────────────────────────────────────────────────────────────────
async function narrate(tmp, id, lines, character) {
  if (!existsSync(KOKORO_PYTHON)) throw new Error(`Kokoro not found at ${KOKORO_PYTHON} (set KOKORO_PYTHON)`);
  const src = join(tmp, `${id}-lines.json`), wav = join(tmp, `${id}-vo.wav`), tj = join(tmp, `${id}-vo.json`);
  writeFileSync(src, JSON.stringify(lines));
  if (!character) {
    await run(KOKORO_PYTHON, ['-I', join(ROOT, 'scripts/reel/voice.py'), src, wav, tj]);
    return { wav, ...JSON.parse(readFileSync(tj, 'utf8')) };
  }
  // a character voice, made like jadiedevs' pipeline/make_voice.py: Kokoro at normal speed, then the
  // pitch raised by `semitones` and the whole thing played at `speed`; every timing scales with it
  const raw = join(tmp, `${id}-vo-raw.wav`);
  process.env.KOKORO_VOICE = character.voice; process.env.KOKORO_SPEED = '1.0';
  try { await run(KOKORO_PYTHON, ['-I', join(ROOT, 'scripts/reel/voice.py'), src, raw, tj]); }
  finally { delete process.env.KOKORO_VOICE; delete process.env.KOKORO_SPEED; }
  const ratio = 2 ** (character.semitones / 12), tempo = character.speed / ratio;
  await run(FFMPEG, ['-hide_banner', '-y', '-i', raw, '-af', `asetrate=${(48000 * ratio).toFixed(3)},aresample=48000,atempo=${tempo.toFixed(5)}`, wav]);
  const t = JSON.parse(readFileSync(tj, 'utf8'));
  const k = 1 / character.speed, sc = (x) => Math.round(x * k * 1000) / 1000;
  return { wav, duration: sc(t.duration), lines: t.lines.map((l) => ({ ...l, start: sc(l.start), end: sc(l.end), words: l.words.map((w) => ({ ...w, start: sc(w.start), end: sc(w.end) })) })) };
}
/** Jadie (jadiedevs): Kokoro am_fenrir, +5 semitones, 1.22× (pipeline/cast.json, "Voice B"). */
const JADIE_VOICE = { voice: 'am_fenrir', semitones: 5, speed: 1.22 };

// ── overlays: transparent 1080×1920 PNGs, all from one stylesheet ────────────
const CSS = `
*{margin:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;background:transparent;font-family:'Figtree',system-ui,sans-serif}
.cap{position:absolute;left:72px;right:72px;top:${L.capTop}px;height:${L.capH}px;display:flex;align-items:center;justify-content:center;text-align:center;
  font-weight:900;font-size:96px;line-height:1.02;letter-spacing:-.01em;text-transform:uppercase;color:${C.white};text-wrap:balance;
  text-shadow:0 3px 0 rgba(11,20,48,.55),0 8px 28px rgba(11,20,48,.5)}
.cap b{color:${C.gold};font-weight:900}
.hud{position:absolute;left:72px;right:72px;top:${L.hudTop}px;display:flex;justify-content:space-between}
.chip{background:rgba(11,20,48,.74);color:${C.white};border-radius:14px;padding:12px 20px;font-weight:800;font-size:28px;letter-spacing:.04em;text-transform:uppercase;display:flex;gap:14px;align-items:center}
.chip i{width:14px;height:14px;border-radius:50%;background:${C.gold};display:block}
.chip span{opacity:.55}
.col{position:absolute;left:72px;right:72px;top:${L.colTop}px;display:flex;justify-content:center}
.bubble{display:inline-flex;align-items:center;gap:22px;background:${C.white};border-radius:46px;padding:22px 42px 22px 24px;box-shadow:0 12px 32px rgba(11,20,48,.35);font-size:48px;font-weight:800;color:${C.ink}}
.bubble i{width:66px;height:66px;border-radius:50%;background:#4f6d8f;display:block}
.plate{background:rgba(21,29,59,.9);color:${C.white};border-radius:26px;padding:26px 40px;text-align:center;font-weight:800;font-size:46px;line-height:1.25}
.plate small{display:block;color:${C.gold};font-size:34px;font-weight:700;margin-top:6px}
.word{position:absolute;left:60px;right:60px;top:1290px;height:140px;display:flex;align-items:center;justify-content:center;text-align:center;
  font-weight:900;font-size:84px;line-height:1;text-transform:lowercase;color:${C.white};
  text-shadow:0 0 2px #0b1430,0 3px 0 rgba(11,20,48,.7),0 8px 26px rgba(11,20,48,.55);-webkit-text-stroke:2px rgba(11,20,48,.6)}
.word b{color:${C.gold};text-transform:uppercase}
.signwrap{position:absolute;left:60px;right:60px;top:${L.capTop + 40}px;display:flex;justify-content:center}
.sign{background:#f6d468;border:10px solid #2b2118;border-radius:18px;padding:26px 52px 30px;text-align:center;transform:rotate(-2deg);box-shadow:0 14px 0 rgba(11,20,48,.35)}
.sign small{display:block;color:#c8352b;font-size:56px;font-weight:900;letter-spacing:.02em;text-transform:uppercase;line-height:1.05}
.sign b{display:block;color:#1d1b1a;font-size:104px;font-weight:900;line-height:1;text-transform:uppercase;margin-top:6px}
`;
let ovPage;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function png(file, html) {
  ovPage ??= await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ovPage.setContent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Figtree:wght@700;800;900&display=block" rel="stylesheet"><style>${CSS}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
  await Promise.race([ovPage.evaluate(() => document.fonts.ready), sleep(4000)]);
  await ovPage.screenshot({ path: file, omitBackground: true });
  return file;
}

/** Split the narration into 1–3 word captions; the last word of each line is gold (MOVE IN always). */
function captionChunks(timing, maxWords = 3) {
  const out = [];
  for (const line of timing.lines) {
    const ws = line.words;
    let i = 0;
    while (i < ws.length) {
      const take = [];
      while (i < ws.length && take.length < maxWords) {
        take.push(ws[i]);
        i++;
        if (/[.,!?;:]$/.test(take.at(-1).w)) break;
        if (take.map((x) => x.w).join(' ').length >= 13) break;
      }
      if (take.at(-1).w.toUpperCase() === 'MOVE' && ws[i] && /^IN\b/i.test(ws[i].w)) { take.push(ws[i]); i++; }
      out.push({ words: take, start: take[0].start, lastOfLine: i >= ws.length, lineEnd: line.end, marked: ws.some((x) => x.w.includes('*')) });
    }
  }
  // each caption stays up until the next one starts (or a beat after its line ends)
  out.forEach((c, k) => (c.end = k + 1 < out.length && out[k + 1].start - c.lineEnd < 0.05 ? out[k + 1].start : c.lineEnd + 0.2));
  if (out.length) out.at(-1).end = timing.duration; // the last words stay up through the end hold
  if (out.length && out[0].start < 0.5) out[0].start = 0; // the hook is on screen from the very first frame
  return out;
}
function captionHtml(chunk, cls = 'cap') {
  // gold: MOVE IN always; a word marked *like this* in the script; otherwise the last word of the line
  const raw = chunk.words.map((x) => x.w);
  const words = raw.map((w) => w.replace(/\*/g, ''));
  const moveIn = words.findIndex((w, i) => w.toUpperCase() === 'MOVE' && /^IN/i.test(words[i + 1] ?? ''));
  const gold = (i) => moveIn >= 0 ? i === moveIn || i === moveIn + 1 : chunk.marked ? raw[i].includes('*') : chunk.lastOfLine && i === words.length - 1;
  const body = words.map((w, i) => (gold(i) ? `<b>${esc(w)}</b>` : esc(w))).join(' ');
  return `<div class="${cls}"><div>${body}</div></div>`;
}

// ── filming one continuous shot ──────────────────────────────────────────────
async function film(page, tmp, name, shot) {
  const missing = await page.evaluate((s) => window.kinsburgReel.setScript(s), shot);
  if (missing.length) throw new Error(`${name}: not found in the city: ${missing.join(', ')}`);
  const out = join(tmp, `${name}.mp4`);
  const n = Math.round(shot.duration * FPS);
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p', '-color_range', 'tv', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'ignore', 'inherit'] });
  for (let i = 0; i < n; i++) {
    const url = await page.evaluate((t) => window.kinsburgReel.captureFrame(t, 'image/jpeg', 0.93), i / FPS);
    if (!ff.stdin.write(Buffer.from(url.split(',')[1], 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c} filming ${name}`)))));
  return out;
}

/** Shots joined by dissolves (each shot starts at `at`), every overlay on the global timeline, narration over a quiet bed. */
async function finish(tmp, id, { shots, overlays, voice, duration, caption, coverAt, coverHtml, coverBg, xf = XF, name = `launch-${id}` }) {
  const inputs = shots.flatMap((s) => ['-i', s.file]);
  const vchain = [];
  let last = '0:v';
  shots.slice(1).forEach((s, i) => {
    vchain.push(`[${last}][${i + 1}:v]xfade=transition=fade:duration=${xf}:offset=${s.at.toFixed(3)}[x${i}]`);
    last = `x${i}`;
  });
  let k = shots.length;
  const ovIn = [];
  // cards (and the dim behind them) go under the text layers: info bar, captions, plates
  const ordered = [...overlays.filter((o) => o.card), ...overlays.filter((o) => !o.card)];
  for (const o of ordered) {
    if (o.seq) {
      const list = join(tmp, `${id}-seq-${k}.txt`);
      writeFileSync(list, o.seq.map((f) => `file '${f.file}'\nduration ${f.d}`).join('\n') + `\nfile '${o.seq.at(-1).file}'\n`);
      ovIn.push('-f', 'concat', '-safe', '0', '-i', list);
    } else ovIn.push('-loop', '1', '-t', String(duration), '-i', o.png);
    const fd = o.fade ?? 0.2;
    const fade = o.noFade ? '' : `,fade=t=in:st=${o.from}:d=${fd}:alpha=1,fade=t=out:st=${Math.max(o.from, o.to - fd)}:d=${fd}:alpha=1`;
    const scale = o.card ? `scale=-2:${o.cardH ?? L.cardH},` : '';
    const shift = o.seq ? `setpts=PTS-STARTPTS+${o.from}/TB,` : '';
    vchain.push(`[${k}:v]${shift}${scale}format=rgba${fade}[ov${k}]`);
    if (o.dim) {
      // the tint behind a card fades with it instead of switching on
      vchain.push(`color=c=0x0b1430:s=${W}x${H}:r=${FPS}:d=${duration.toFixed(3)},format=rgba,colorchannelmixer=aa=0.45,fade=t=in:st=${o.from}:d=${fd}:alpha=1,fade=t=out:st=${Math.max(o.from, o.to - fd)}:d=${fd}:alpha=1[dm${k}]`);
      vchain.push(`[${last}][dm${k}]overlay=0:0:enable='between(t,${o.from},${o.to})'[d${k}]`);
      last = `d${k}`;
    }
    const pos = o.card ? `x=(W-w)/2:y=${o.cardTop ?? L.cardTop}` : 'x=0:y=0';
    vchain.push(`[${last}][ov${k}]overlay=${pos}:enable='between(t,${o.from},${o.to})':eof_action=pass[o${k}]`);
    last = `o${k}`;
    k++;
  }
  vchain.push(`[${last}]format=yuv420p[vout]`);
  const bed = join(tmp, `${id}-bed.wav`);
  await run(FFMPEG, ambientArgs(duration, bed, id.charCodeAt(0)));
  const vo = k, bd = k + 1;
  const achain = `[${vo}:a]apad,atrim=0:${duration}[vo];[${bd}:a]volume=0.22[bed];[vo][bed]amix=inputs=2:normalize=0,alimiter=limit=0.89[aout]`;
  const mp4 = join(OUT, `${name}.mp4`);
  await run(FFMPEG, ['-hide_banner', '-y', ...inputs, ...ovIn, '-i', voice.wav, '-i', bed,
    '-filter_complex', vchain.join(';') + ';' + achain, '-map', '[vout]', '-map', '[aout]', '-t', duration.toFixed(3), '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4]);
  writeFileSync(join(OUT, `${name}.txt`), caption + '\n');
  if (coverHtml) {
    // a cover with its own title (the grid shows the cover, not the first frame)
    const ov = await png(join(tmp, `${id}-cover-text.png`), coverHtml);
    const bg = coverBg ? ['-i', coverBg] : ['-ss', String(coverAt), '-i', mp4]; // a still made for the cover, or a frame of the reel
    await run(FFMPEG, ['-hide_banner', '-y', ...bg, '-i', ov, '-filter_complex', '[0:v][1:v]overlay=0:0', '-frames:v', '1', '-q:v', '2', join(OUT, `${name}.jpg`)]);
  } else await run(FFMPEG, ['-hide_banner', '-y', '-ss', String(coverAt), '-i', mp4, '-frames:v', '1', '-q:v', '3', join(OUT, `${name}.jpg`)]);
  const info = await probe(mp4, process.env.FFPROBE ?? 'ffprobe').catch((e) => ({ ok: false, error: e.message }));
  log(`${relative(ROOT, mp4)}  ${info.ok ? '✓ Instagram specs' : '✗ check specs ' + JSON.stringify(info)}  ${duration.toFixed(1)} s`);
}

// ── thumbnails ───────────────────────────────────────────────────────────────
// Instagram shows the cover full-size (9:16) in the Reels tab, but the profile grid shows only a 3:4
// crop from the middle (1080×1440, y 240–1680), about 130 pt wide on a phone. So everything that
// matters sits in y 380–1540, and the hook is a giant number that still reads at tile size.
const THUMB = { top: 380, bottom: 1540 };
async function thumbStill(page, tmp, id, { target, zoom, y, rings = [], hour = 22, actors = [], labels = [] }) {
  const missing = await page.evaluate((s) => window.kinsburgReel.setScript(s), {
    duration: 1, keys: [{ t: 0, target, zoom, y }, { t: 1, target, zoom, y }], hours: [{ t: 0, h: hour }], rings: rings.map((r) => ({ id: r, from: 0 })), actors, labels,
  });
  if (missing.length) throw new Error(`thumbnail: not found: ${missing.join(', ')}`);
  const url = await page.evaluate(() => window.kinsburgReel.captureFrame(0.5, 'image/jpeg', 0.95));
  const file = join(tmp, `${id}-thumb-bg.jpg`);
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}
const thumbHtml = (above, big, below) => `<div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;text-align:center;color:${C.white};font-weight:900;text-transform:uppercase;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div style="font-size:128px;line-height:1;letter-spacing:-.01em">${esc(above)}</div>
  <div style="font-size:400px;line-height:.86;color:${C.gold};letter-spacing:-.04em;margin:6px 0 10px">${esc(big)}</div>
  <div style="font-size:104px;line-height:1.02;letter-spacing:-.01em;text-wrap:balance">${esc(below)}</div>
</div>`;

// ── shared pieces ────────────────────────────────────────────────────────────
async function common(tmp, id, voice, right, { title = 'live city', words = 3 } = {}) {
  const overlays = [];
  const hud = await png(join(tmp, `${id}-hud.png`), `<div class="hud"><div class="chip"><i></i>Kinsburg <span>|</span> ${esc(title)}</div><div class="chip">${esc(right)}</div></div>`);
  overlays.push({ png: hud, from: 0, to: 1e3, noFade: true });
  const cls = words === 1 ? 'word' : 'cap';
  for (const [i, c] of captionChunks(voice, words).entries()) overlays.push({ png: await png(join(tmp, `${id}-cap${i}.png`), captionHtml(c, cls)), from: c.start, to: c.end, noFade: true });
  return overlays;
}
const sign = (tmp, id, small, big) => png(join(tmp, `${id}-sign-${big.replace(/\W+/g, '')}.png`), `<div class="signwrap"><div class="sign"><small>${esc(small)}</small><b>${esc(big)}</b></div></div>`);
const bubble = (tmp, id, top = L.colTop) => png(join(tmp, `${id}-bubble-${top}.png`), `<div class="col" style="top:${top}px"><div class="bubble"><i></i>MOVE IN</div></div>`);
const plate = (tmp, id, title, sub) => png(join(tmp, `${id}-plate.png`), `<div class="col"><div class="plate">${esc(title)}<small>${esc(sub)}</small></div></div>`);
const at = (line, w) => line.words.find((x) => x.w.toLowerCase().startsWith(w.toLowerCase()))?.start ?? line.start;

function pickHomes(R) {
  const plain = R.filter((r) => !r.perks.length && r.level === 0 && r.address && r.id !== 'kinsburgtown').sort((a, b) => a.number - b.number);
  return { X: plain[8] ?? plain[0], Y: plain[30] ?? plain[1] };
}

// ── Reel A: "Yours is still dark" ────────────────────────────────────────────
async function reelA({ tmp, page, R, right }) {
  const { X, Y } = pickHomes(R);
  const v = await narrate(tmp, 'A', [
    { text: 'Every light in this city is someone who moved in.' },
    { text: 'This one is still empty.', gap: 0.6 },
    { text: "Comment MOVE IN, and it's yours.", say: "Comment, move in, and it's yours." },
    { text: 'An address. A job. A number.', gap: 0.5 },
    { text: 'And it gets dark here, when it gets dark where you are.' },
    { text: "We'll leave the light on.", gap: 1.3 },
  ]);
  const [l0, l1, l2, , l4, l5] = v.lines;
  const lightT = at(l2, "it's");
  const s2 = l4.start - 0.35; // dissolve into the time-lapse
  const shot1 = await film(page, tmp, 'A1', {
    duration: s2 + XF,
    keys: [
      { t: 0, target: X.id, zoom: 1.0 },
      { t: l0.end - 0.1, target: X.id, zoom: 1.7 },
      { t: l1.start + 1.0, target: X.id, zoom: 4.4 },
      { t: lightT + 0.6, target: X.id, zoom: 4.6 },
      { t: s2 + XF, target: X.id, zoom: 2.6 },
    ],
    hours: [{ t: 0, h: 22 }],
    dark: [{ id: X.id, until: lightT }],
    rings: [{ id: X.id, from: lightT }],
  });
  const shot2 = await film(page, tmp, 'A2', {
    duration: v.duration - s2,
    keys: [
      { t: 0, target: 'wide' },
      { t: l4.end - s2, target: 'wide' },
      { t: l5.start - s2 + 0.9, target: Y.id, zoom: 4.4 },
      { t: v.duration - s2, target: Y.id, zoom: 4.6 },
    ],
    hours: [{ t: 0, h: 16.8 }, { t: l4.end - s2, h: 22 }],
    dark: [{ id: Y.id, until: 1e9 }],
  });
  const overlays = await common(tmp, 'A', v, right);
  overlays.push({ png: await bubble(tmp, 'A'), from: l2.start, to: lightT + 0.2 });
  overlays.push({ png: await plate(tmp, 'A', X.address, `${X.job} | Resident #${X.number.toLocaleString('en-US')}`), from: lightT + 0.25, to: s2 });
  await finish(tmp, 'A', {
    shots: [{ file: shot1, at: 0 }, { file: shot2, at: s2 }],
    overlays, voice: v, duration: v.duration,
    caption: 'Every lit window in Kinsburg is a real person. Comment MOVE IN and one of them is you: you get a house, a street address, a job and a resident card to post. The city follows your clock, so come back tonight and see your window on. Link in bio.',
    coverAt: l1.start + 1.2,
  });
}

// ── Reel B: "Comment two words" ──────────────────────────────────────────────
async function reelB({ tmp, page, R, right, cardOf }) {
  const { X } = pickHomes(R);
  const v = await narrate(tmp, 'B', [
    { text: 'Comment two words, get a house.' },
    { text: 'The city builds it for you.' },
    { text: 'You get a real address, and a job.' },
    { text: 'And a card you can put on your story.', gap: 0.5 },
    { text: "At night, your window lights up with everyone else's.", gap: 0.5 },
    { text: 'The two words are MOVE IN.', say: 'The two words are, move in.', gap: 1.3 },
  ]);
  const [, l1, l2, l3, l4, l5] = v.lines;
  const s2 = l1.start - 0.15, s3 = l5.start - 0.3;
  const lot = await film(page, tmp, 'B1', {
    duration: s2 + XF,
    keys: [{ t: 0, target: `lot:${X.id}`, zoom: 3.6 }, { t: s2 + XF, target: `lot:${X.id}`, zoom: 4.2 }],
    hours: [{ t: 0, h: 18.7 }],
  });
  const house = await film(page, tmp, 'B2', {
    duration: s3 - s2 + XF,
    keys: [
      { t: 0, target: X.id, zoom: 4.2 },
      { t: l2.end - s2, target: X.id, zoom: 3.4 },
      { t: l3.end - s2, target: X.id, zoom: 3.0 },
      { t: l4.end - s2, target: X.id, zoom: 1.5, y: 0.6 },
      { t: s3 - s2 + XF, target: X.id, zoom: 1.4, y: 0.6 },
    ],
    hours: [{ t: 0, h: 18.7 }, { t: l3.end - s2, h: 19.2 }, { t: l4.end - s2, h: 22 }],
    rings: [{ id: X.id, from: 0.35, to: l3.end - s2 }],
  });
  const lot2 = await film(page, tmp, 'B3', {
    duration: v.duration - s3,
    keys: [{ t: 0, target: `lot:${X.id}`, zoom: 4.0 }, { t: v.duration - s3, target: `lot:${X.id}`, zoom: 4.3 }],
    hours: [{ t: 0, h: 18.7 }],
  });
  const overlays = await common(tmp, 'B', v, right);
  const b = await bubble(tmp, 'B');
  overlays.push({ png: b, from: 0.3, to: s2 + 0.3 });
  overlays.push({ png: await plate(tmp, 'B', X.address, X.job), from: at(l2, 'real'), to: l2.end + 0.2 });
  overlays.push({ png: await cardOf(X.id, {}, join(tmp, 'B-card.png')), from: l3.start, to: l3.end + 0.35, card: true, dim: true });
  overlays.push({ png: b, from: s3 + XF, to: v.duration });
  await finish(tmp, 'B', {
    shots: [{ file: lot, at: 0 }, { file: house, at: s2 }, { file: lot2, at: s3 }],
    overlays, voice: v, duration: v.duration,
    caption: 'How moving in to Kinsburg works: 1) comment MOVE IN, 2) the city builds your house and gives you an address and a job, 3) you get a resident card for your Story. Your house grows the longer you stay. Free, and it stays free.',
    coverAt: 0.8,
  });
}

// ── Reel C: "The city picks your job" ────────────────────────────────────────
async function reelC({ tmp, page, R, right, cardOf }) {
  const { X } = pickHomes(R);
  // four neighbours of X with different jobs, visited left to right so the camera glides along
  const pos = await page.evaluate((ids) => ids.map((id) => window.kinsburgReel.where(id)), R.map((r) => r.id));
  const home = pos[R.indexOf(X)];
  const near = R.map((r, i) => ({ ...r, p: pos[i] }))
    .filter((r) => r.p && r.address && !r.perks.length && r.id !== X.id)
    .map((r) => ({ ...r, d: Math.hypot(r.p.x - home.x, r.p.y - home.y) }))
    .sort((a, b) => a.d - b.d);
  const want = ['Baker', 'Beekeeper', 'Florist', 'Musician', 'Potter', 'Gardener', 'Chef', 'Librarian', 'Painter', 'Fisher'];
  const tour = [];
  for (const r of near) if (want.includes(r.job) && !tour.some((t) => t.job === r.job)) tour.push(r);
  const four = tour.slice(0, 4).sort((a, b) => a.p.x - b.p.x);
  const keepers = R.filter((r) => r.job === 'Lighthouse keeper').length;
  const v = await narrate(tmp, 'C', [
    { text: 'The city picks your job.', gap: 0.45 },
    ...four.map((r) => ({ text: `${r.job}.`, gap: 0.3 })),
    { text: keepers === 1 ? 'And just one lighthouse keeper.' : `And only ${keepers} lighthouse keepers.`, gap: 0.4 },
    { text: 'Comment MOVE IN, and tell me what you got.', say: 'Comment, move in, and tell me what you got.', gap: 1.4 },
  ]);
  const lines = v.lines;
  const lKeep = lines[1 + four.length], lEnd = lines[2 + four.length];
  const keys = [{ t: 0, target: X.id, zoom: 1.5 }, { t: lines[0].end, target: X.id, zoom: 1.7 }];
  four.forEach((r, i) => {
    const li = lines[1 + i];
    keys.push({ t: li.start + 0.05, target: r.id, zoom: 3.9 }, { t: li.end + 0.12, target: r.id, zoom: 4.05 });
  });
  keys.push({ t: lKeep.start + 1.4, target: 'landmark:lighthouse', zoom: 1.7 }, { t: v.duration, target: 'landmark:lighthouse', zoom: 1.85 });
  const shot = await film(page, tmp, 'C1', {
    duration: v.duration,
    keys,
    hours: [{ t: 0, h: 15 }, { t: lKeep.start, h: 15.5 }, { t: lKeep.start + 1.6, h: 22.2 }],
    rings: four.map((r, i) => ({ id: r.id, from: lines[1 + i].start, to: lines[1 + i].end + 0.25 })),
  });
  const overlays = await common(tmp, 'C', v, right);
  const spinJobs = ['Baker', 'Beekeeper', 'Florist', 'Musician', 'Lighthouse keeper', 'Chef', 'Potter', 'Librarian', 'Fisher', 'Painter', 'Tailor', 'Gardener', 'Coder', 'Teacher'];
  const next = R.length + 1;
  const seq = [];
  for (const [i, job] of spinJobs.entries()) seq.push({ file: await cardOf(X.id, { job, handle: 'you', number: next }, join(tmp, `C-spin${i}.png`)), d: 0.09 + i * 0.012 });
  const mystery = await cardOf(X.id, { job: '???', handle: 'you', number: next }, join(tmp, 'C-mystery.png'));
  overlays.push({ seq, from: 0.15, to: lines[0].end + 0.2, card: true, dim: true });
  overlays.push({ png: mystery, from: lEnd.start, to: v.duration, card: true, dim: true });
  await finish(tmp, 'C', {
    shots: [{ file: shot, at: 0 }],
    overlays, voice: v, duration: v.duration,
    caption: `Every resident gets a job when they move in. Bakers, beekeepers, florists, and ${keepers === 1 ? 'one lighthouse keeper' : 'a few lighthouse keepers'}. Comment MOVE IN, then reply with what the city gave you.`,
    coverAt: 0.6,
  });
}

// ── Reel D: "Only 3 people live here" (first post; needs the live city: --url) ─
async function reelD({ tmp, page, R, right, cardOf }) {
  const homes = R.filter((r) => r.id !== 'kinsburgtown');
  const X = homes[Math.floor((homes.length - 1) / 2)] ?? R[0]; // middle of the street
  const newest = R.at(-1);
  const n = R.length, next = R.length + 1;
  const word = (k) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][k] ?? String(k);
  process.env.VOICE_LEAD = '0.12'; // the hook starts on the first frame
  const v = await narrate(tmp, 'D', [
    { text: `Only *${n}* ${n === 1 ? 'person lives' : 'people live'} in this city.`, say: `Only ${word(n)} ${n === 1 ? 'person lives' : 'people live'} in this city.`, gap: 0.55 },
    { text: 'Every house is a real person, from Instagram.', gap: 0.35 },
    { text: `House number *${next}* is still empty.`, say: `House number ${word(next)} is still empty.`, gap: 0.35 },
    { text: "Comment MOVE IN, and it's yours.", say: "Comment, move in, and it's yours.", gap: 0.35 },
    { text: 'Low numbers never come back.', gap: 0.5 },
    { text: "We'll leave the light on.", gap: 1.3 },
  ]);
  delete process.env.VOICE_LEAD;
  const [l1, l2, l3, l4, l5, l6] = v.lines;
  const lot = `lot:${newest.id}`;
  // long, calm moves (sine ease, ~2 s each) that start a beat before the words they illustrate
  const atClose = l2.start + 2.1;                     // arrived back on the street
  const leave = l3.start + 0.5;                       // set off for the empty plot
  const atLot = leave + 2.0;
  const endPull = Math.min(l6.start + 0.2, v.duration - 2.6);
  const shot = await film(page, tmp, 'D1', {
    duration: v.duration,
    ease: 'sine',
    keys: [
      { t: 0, target: X.id, zoom: 3.0 },
      { t: 0.4, target: X.id, zoom: 3.05 },
      { t: l1.end + 0.35, target: X.id, zoom: 0.78 },   // pull out while it's said: the whole empty island
      { t: l2.start + 0.1, target: X.id, zoom: 0.8 },
      { t: atClose, target: X.id, zoom: 3.3, y: 0.62 }, // back down to the street, room above for the name tags
      { t: leave, target: X.id, zoom: 3.4, y: 0.62 },
      { t: atLot, target: lot, zoom: 4.2 },             // the empty plot
      { t: endPull, target: lot, zoom: 4.4 },
      { t: endPull + 2.2, target: X.id, zoom: 1.15 },   // settle on the town at night
      { t: v.duration, target: X.id, zoom: 1.2 },
    ],
    hours: [{ t: 0, h: 22 }],
    rings: [...R.map((r) => ({ id: r.id, from: atClose - 0.5, to: leave + 0.3 })), { id: lot, from: atLot - 0.6, to: l5.end + 0.3 }],
    // the first residents, by name: a tag on each house while the camera is on the street
    labels: R.map((r, i) => ({ id: r.id, text: `@${r.id}`, sub: `Resident #${r.number}`, from: atClose - 0.7 + i * 0.25, to: leave + 0.55 })),
  });
  const overlays = await common(tmp, 'D', v, right);
  overlays.push({ png: await bubble(tmp, 'D'), from: l4.start, to: l4.end + 0.3, fade: 0.3 });
  const card = await cardOf(newest.id, { handle: 'you', number: next, job: '???', plotId: '' }, join(tmp, 'D-card.png'));
  overlays.push({ png: card, from: l5.start - 0.25, to: l5.end + 0.55, card: true, dim: true, fade: 0.4 });
  await finish(tmp, 'D', {
    shots: [{ file: shot, at: 0 }],
    overlays, voice: v, duration: v.duration,
    caption: `Kinsburg is a city where every house belongs to a real person on Instagram. Right now ${n} ${n === 1 ? 'person lives' : 'people live'} here.\n\nComment MOVE IN and house #${next} is yours: a street address, a job, and a window that lights up when it gets dark where you are. Resident numbers are forever, so low numbers never come back.\n\nFind your house at the link in bio.`,
    coverAt: l1.end + 0.2,
    coverBg: await thumbStill(page, tmp, 'D', { target: X.id, zoom: 1.45, y: 0.7, rings: R.map((r) => r.id) }),
    coverHtml: thumbHtml('Only', n, n === 1 ? 'person lives here' : 'people live here'),
  });
}

// ── "In this town" series (Jadie, @jadiedevs) ────────────────────────────────
// Quick town rules in Jadie's voice: one word on screen at a time, signs in the world, a quick cut
// per rule, ends on MOVE IN. Jadie is drawn in the map (src/reel-jadie.ts) and lives at his own
// house as @jadiedevs. Real residents only appear by name if they commented CAST ME (cast list).
const JADIE = 'jadiedevs';
async function reelT1({ tmp, page, R, cardOf }) {
  const J = R.find((r) => r.id === JADIE);
  if (!J) throw new Error('@jadiedevs is not a resident yet: add him first (see docs/in-this-town.md)');
  const next = R.length + 1;
  const word = (k) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][k] ?? String(k);
  const v = await narrate(tmp, 'T1', [
    { text: 'In this town, you move in by commenting two words.', gap: 0.3 },
    { text: 'Your lights turn on when it gets dark, where you live.', gap: 0.3 },
    { text: `The city picks your job. I got *${J.job.toLowerCase()}*.`, say: `The city picks your job. I got ${J.job.toLowerCase()}.`, gap: 0.3 },
    { text: 'Your number is yours, forever.', gap: 0.3 },
    { text: `House number *${next}* is still empty.`, say: `House number ${word(next)} is still empty.`, gap: 0.3 },
    { text: 'Comment MOVE IN.', say: 'Comment, move in.', gap: 1.1 },
  ], JADIE_VOICE);
  const ls = v.lines, D = v.duration, xf = 0.12;
  const cut = [0, ...ls.slice(1).map((l) => l.start - 0.08), D];
  const home = { at: JADIE, dx: -36, dy: 18 }, spot = { at: 'next', dx: -36, dy: 18 };
  const shot = async (i, build) => {
    const d = cut[i + 1] - cut[i] + (i < ls.length - 1 ? xf : 0);
    const l = ls[i];
    const talk = [{ from: l.start - cut[i], to: l.end - cut[i] }];
    const s = build(d, (x) => x - cut[i]);
    return { file: await film(page, tmp, `T1-${i}`, { duration: d, ease: 'sine', hours: [{ t: 0, h: 22 }], ...s, actors: (s.actors ?? []).map((a) => ({ ...a, talk })) }), at: cut[i] };
  };
  const shots = [];
  // 0 · hook: Jadie waves outside his house; his tag and ring
  shots.push(await shot(0, (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 9.0, y: 0.6 }, { t: d, target: 'actor:jadie', zoom: 9.8, y: 0.6 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'wave' }, { t: d, ...home, pose: 'wave' }] }],
    rings: [{ id: JADIE, from: 0 }],
    labels: [{ id: JADIE, text: `@${JADIE}`, sub: `Resident #${J.number}`, from: 0.3, to: d + 1 }],
  })));
  // 1 · dusk to night along the street, Jadie looking around
  shots.push(await shot(1, (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 3.6, y: 0.6 }, { t: d, target: 'actor:jadie', zoom: 4.4, y: 0.6 }],
    hours: [{ t: 0, h: 17.3 }, { t: d, h: 22.4 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'look' }, { t: d, ...home, pose: 'look' }] }],
  })));
  // 2 · job: card spins above Jadie, lands on his real job; he jumps
  const tGot = ls[2].words.find((w) => /^got/i.test(w.w))?.start ?? ls[2].start + 1;
  shots.push(await shot(2, (d, loc) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 8.4, y: 0.64 }, { t: d, target: 'actor:jadie', zoom: 8.8, y: 0.64 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'idle' }, { t: loc(tGot), ...home, pose: 'jump' }, { t: d, ...home, pose: 'jump' }] }],
  })));
  // 3 · number forever: sign, Jadie points at it
  shots.push(await shot(3, (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 8.6, y: 0.64 }, { t: d, target: 'actor:jadie', zoom: 9.2, y: 0.64 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'point' }, { t: d, ...home, pose: 'point' }] }],
    rings: [{ id: JADIE, from: 0 }],
  })));
  // 4 · cut to the next empty plot (across the plaza): Jadie walks the last few steps in, points; ring
  shots.push(await shot(4, (d) => {
    const arrive = Math.min(d - 0.4, 1.25);
    const from = { at: 'next', dx: -96, dy: 48 };
    return {
      keys: [{ t: 0, target: 'actor:jadie', zoom: 7.6, y: 0.62 }, { t: arrive, target: 'actor:jadie', zoom: 7.6, y: 0.62 }, { t: d, target: 'actor:jadie', zoom: 7.9, y: 0.62 }],
      actors: [{ id: 'jadie', keys: [{ t: 0, ...from, pose: 'idle' }, { t: arrive, ...spot, pose: 'idle' }, { t: arrive + 0.15, ...spot, pose: 'point', face: 1 }, { t: d, ...spot, pose: 'point', face: 1 }] }],
      rings: [{ id: 'next', from: arrive - 0.35 }],
    };
  }));
  // 5 · MOVE IN: Jadie waves from the empty plot
  shots.push(await shot(5, (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 7.9, y: 0.62 }, { t: d, target: 'actor:jadie', zoom: 6.8, y: 0.62 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...spot, pose: 'wave' }, { t: d, ...spot, pose: 'wave' }] }],
    rings: [{ id: 'next', from: 0 }],
  })));

  const right = `${R.length.toLocaleString('en-US')} residents`;
  const overlays = await common(tmp, 'T1', v, right, { title: 'in this town', words: 1 });
  const b = await bubble(tmp, 'T1', 660); // above Jadie, who stands mid-frame
  // the hook: a big title over the first line
  overlays.push({ png: await png(join(tmp, 'T1-title.png'), `<div class="cap" style="font-size:112px"><div>In this <b>town…</b></div></div>`), from: 0, to: cut[1], noFade: true });
  const tTwo = ls[0].words.find((w) => /^two/i.test(w.w))?.start ?? ls[0].start;
  overlays.push({ png: b, from: tTwo, to: cut[1], fade: 0.2 });
  // the job card: a quick spin through jobs, landing on his real one
  const spinJobs = ['Baker', 'Florist', 'Lighthouse keeper', 'Musician', 'Beekeeper', 'Chef', 'Potter', 'Librarian'].filter((j) => j !== J.job);
  const seq = [];
  for (const [i, job] of spinJobs.entries()) seq.push({ file: await cardOf(JADIE, { job }, join(tmp, `T1-spin${i}.png`)), d: 0.07 + i * 0.012 });
  // stretch the spin (it slows down) so it runs right up to "I got…"
  const spinFor = tGot - (cut[2] + 0.05), spinSum = seq.reduce((a, f) => a + f.d, 0);
  for (const f of seq) f.d *= spinFor / spinSum;
  overlays.push({ seq, from: cut[2] + 0.05, to: tGot, card: true, dim: true, fade: 0.15, cardTop: 330, cardH: 660 });
  overlays.push({ png: await cardOf(JADIE, {}, join(tmp, 'T1-card.png')), from: tGot, to: cut[3], card: true, dim: true, fade: 0.15, cardTop: 330, cardH: 660 });
  overlays.push({ png: await sign(tmp, 'T1', `Resident #${J.number}`, 'Forever.'), from: cut[3] + 0.1, to: cut[4], fade: 0.15 });
  overlays.push({ png: await sign(tmp, 'T1', `House #${next}`, 'Still empty'), from: cut[4] + 1.4, to: cut[5], fade: 0.15 });
  overlays.push({ png: b, from: ls[5].start, to: D, fade: 0.2 });

  await finish(tmp, 'T1', {
    name: 'town-facts-01', xf,
    shots, overlays, voice: v, duration: D,
    caption: `In this town… 🏡 Rules of Kinsburg, part 1.\n\nEvery house here belongs to a real person on Instagram. Comment MOVE IN and the city builds yours: a street address, a job it picks for you, a resident number that's yours forever, and lights that turn on when it gets dark where you live.\n\nWant to be in the next one? Comment CAST ME.`,
    coverBg: await thumbStill(page, tmp, 'T1', { target: 'actor:jadie', zoom: 8.2, y: 0.74, rings: [JADIE], actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'wave' }, { t: 1, ...home, pose: 'wave' }] }] }),
    coverHtml: `<div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;text-align:center;color:${C.white};font-weight:900;text-transform:uppercase;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div style="font-size:136px;line-height:1">In this</div>
  <div style="font-size:250px;line-height:.9;color:${C.gold};letter-spacing:-.02em">town…</div>
  <div style="font-size:64px;line-height:1.1;margin-top:18px">rules of Kinsburg #1</div></div>`,
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'kinsburg-launch-'));
try {
  mkdirSync(OUT, { recursive: true });
  const base = await site();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-color-profile=srgb', '--disable-background-timer-throttling'] });
  const page = await cityPage(base);
  const R = await page.evaluate(() => window.kinsburgReel.residents);
  const demo = await page.evaluate(() => window.kinsburgReel.stats.demo);
  const cardOf = async (id, overrides, file) => {
    const url = await page.evaluate(([i, ov]) => window.kinsburgReel.card(i, ov), [id, overrides]);
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    return file;
  };
  const right = `${R.length.toLocaleString('en-US')} residents`;
  log(`${R.length} residents${demo ? ' (sample residents: re-run with --url after launch)' : ''}`);
  for (const [id, make] of [['A', reelA], ['B', reelB], ['C', reelC], ['D', reelD], ['T1', reelT1]]) {
    if (ONLY ? ONLY !== id : !['A', 'B', 'C'].includes(id)) continue; // D and the series only on request
    const t0 = Date.now();
    await make({ tmp, page, R, right, cardOf });
    log(`reel ${id} done in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
} catch (err) {
  console.error('[launch] FAILED:', err.stack ?? err.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
  rmSync(tmp, { recursive: true, force: true });
}
