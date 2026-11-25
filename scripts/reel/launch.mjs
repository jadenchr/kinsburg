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
// Output in the reels library (reels/README.md): reels/<series>/<folder>/ with the video, cover, grid
// preview and caption (an existing hand-written caption is kept).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ambientArgs, loopVideo, parseArgs, probe, run, sleep } from './lib.mjs';
import { BUILD_BY_KIND } from '../../shared/builds.mjs';
import { BAR, writeMusic } from './music.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = parseArgs();
const W = 1080, H = 1920, FPS = 30, XF = 0.5; // dissolve length (s)
const OUT = join(ROOT, 'reels'); // the reels library (reels/README.md): reels/<series>/<folder>/kinsburg-<folder>.*
// where each reel goes in the library
const FOLDER = {
  A: 'launch/launch-01-yours-is-still-dark', B: 'launch/launch-02-comment-two-words', C: 'launch/launch-03-the-city-picks-your-job',
  D: 'launch/launch-04-house-number-4-is-empty', T1: 'in-this-town/in-this-town-01-rules-of-kinsburg', L1: 'live/live-01-lets-build-this-city',
  T2: 'in-this-town/in-this-town-02-six-seven', T3: 'in-this-town/in-this-town-03-the-update',
  TR: 'tour/city-tour',
  // E (daily episodes) picks its own folder: episodes/episode-NN
};
const ONLY = args.only ? String(args.only).toUpperCase() : null;
const BASE = (args.url ?? process.env.KINSBURG_URL ?? '').replace(/\/+$/, '');
// --api https://kinsburg.com: film this checkout's build (dist/) with the live city's residents, to try
// renderer changes before they're deployed
const API = String(args.api ?? '').replace(/\/+$/, '');
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
  if (API) {
    await page.route('**/api/**', async (route) => {
      const u = new URL(route.request().url());
      const res = await fetch(API + u.pathname + u.search);
      await route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }, body: Buffer.from(await res.arrayBuffer()) });
    });
  }
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
  // *word* only marks a gold caption: never let the voice read the asterisks out
  lines = lines.map((l) => ({ ...l, say: (l.say ?? l.text).replace(/\*/g, '') }));
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
/** Numbers as words for the narration: 190500 -> "a hundred and ninety thousand five hundred". */
function sayNumber(n) {
  n = Math.round(n);
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under100 = (k) => (k < 20 ? ones[k] : tens[Math.floor(k / 10)] + (k % 10 ? '-' + ones[k % 10] : ''));
  // lead: the number starts the phrase, so 100 reads "a hundred"
  const under1000 = (k, lead) => {
    const h = Math.floor(k / 100), r = k % 100;
    if (!h) return under100(r);
    const head = h === 1 ? (lead ? 'a hundred' : 'one hundred') : `${ones[h]} hundred`;
    return head + (r ? ' and ' + under100(r) : '');
  };
  if (n < 0) return 'minus ' + sayNumber(-n);
  if (n < 1000) return under1000(n, true);
  if (n < 1e6) {
    const th = Math.floor(n / 1000), r = n % 1000;
    return `${under1000(th, true)} thousand${r ? (r < 100 ? ' and ' : ' ') + under1000(r, false) : ''}`;
  }
  const m = Math.floor(n / 1e6), r = n % 1e6;
  return `${under1000(m, true)} million${r ? ' ' + sayNumber(r) : ''}`;
}
const sayMoney = (n) => `${sayNumber(n)} dollars`;
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

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
.ep-hud{position:absolute;left:60px;right:60px;top:${L.hudTop}px;display:flex;gap:16px;justify-content:center}
.ep-chip{background:rgba(11,20,48,.82);color:${C.white};border-radius:18px;padding:12px 22px;display:flex;flex-direction:column;align-items:flex-start;min-width:250px}
.ep-chip span{font-size:22px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.7}
.ep-chip b{font-size:44px;font-weight:900;font-variant-numeric:tabular-nums;color:${C.gold};line-height:1.05}
.ep-mid{position:absolute;left:60px;right:60px;top:430px;display:flex;flex-direction:column;align-items:center;gap:18px}
.ep-banner{background:#1d2a52;color:${C.white};border:6px solid ${C.white};border-radius:20px;padding:16px 44px;font-size:76px;font-weight:900;letter-spacing:.02em;text-transform:uppercase;box-shadow:0 10px 0 rgba(11,20,48,.35)}
.ep-pill{background:#d9473a;color:${C.white};border-radius:999px;padding:8px 30px;font-size:38px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;margin-top:-30px}
.ep-card{background:rgba(11,20,48,.88);color:${C.white};border-radius:26px;padding:26px 40px;min-width:640px;box-shadow:0 12px 0 rgba(11,20,48,.3)}
.ep-card h3{margin:0 0 10px;font-size:30px;letter-spacing:.08em;text-transform:uppercase;color:${C.gold};text-align:center}
.ep-row{display:flex;justify-content:space-between;gap:30px;font-size:44px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.35}
.ep-row small{font-size:30px;font-weight:700;opacity:.75;align-self:center}
.ep-row.plus b{color:#7fd38a}.ep-row.minus b{color:#ff8a7f}.ep-row.total{border-top:4px solid rgba(255,255,255,.4);margin-top:8px;padding-top:8px}.ep-row.total b{color:${C.gold};font-size:58px}
.ep-vs{display:flex;align-items:center;gap:34px;font-size:120px;font-weight:900;font-variant-numeric:tabular-nums}
.ep-vs s{opacity:.55;text-decoration-thickness:8px}.ep-vs i{font-style:normal;font-size:80px;color:${C.gold}}
.ep-vs-l{display:flex;justify-content:space-around;width:100%;font-size:26px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-top:-8px}
.ep-wall{position:absolute;left:40px;right:40px;top:340px;display:flex;flex-direction:column;gap:14px;align-items:center}
.ep-c{display:flex;align-items:center;gap:16px;background:${C.white};color:${C.ink};border-radius:20px;padding:12px 22px;width:840px;box-shadow:0 6px 0 rgba(11,20,48,.25);font-size:32px}
.ep-c i{width:52px;height:52px;border-radius:50%;background:#4f6d8f;flex:none}
.ep-c div{display:flex;flex-direction:column;flex:1;min-width:0}.ep-c div b{font-size:26px;font-weight:800;opacity:.75}
.ep-c div span{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ep-c em{font-style:normal;font-weight:900;color:#d9473a;font-size:30px;flex:none}
.ep-c.dim{opacity:.45;transform:scale(.96)}
.ep-c.win{border:6px solid ${C.gold};transform:scale(1.06);box-shadow:0 10px 0 rgba(11,20,48,.3)}
.ep-top{background:${C.gold};color:${C.ink};border-radius:14px;padding:6px 24px;font-size:40px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
.ep-tag{position:absolute;left:0;right:0;top:820px;display:flex;justify-content:center}
.ep-tag div{background:${C.white};color:${C.ink};border:5px solid ${C.ink};border-radius:16px;padding:10px 26px;font-size:46px;font-weight:900;text-transform:uppercase}
.ep-minus{position:absolute;left:0;right:0;top:700px;text-align:center;font-size:110px;font-weight:900;color:#e2574a;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 30px rgba(11,20,48,.5)}
.tr-shade{position:absolute;left:0;right:0;top:0;height:760px;background:linear-gradient(rgba(8,14,34,.62),rgba(8,14,34,.38) 55%,rgba(8,14,34,0))}
.tr-top{position:absolute;left:64px;right:64px;top:250px;text-align:center;color:${C.white};text-shadow:0 3px 0 rgba(11,20,48,.45),0 8px 28px rgba(11,20,48,.55)}
.tr-kick{font-size:27px;font-weight:800;letter-spacing:.34em;text-transform:uppercase;color:${C.gold}}
.tr-head{font-size:82px;font-weight:900;line-height:1.06;letter-spacing:-.012em;margin-top:16px;text-wrap:balance}
.tr-head b{color:${C.gold}}
.tr-sub{font-size:38px;font-weight:700;margin-top:18px;text-wrap:balance;opacity:.94}
.tr-count{position:absolute;left:0;right:0;top:1090px;display:flex;justify-content:center}
.tr-count div{background:rgba(11,20,48,.88);border:3px solid rgba(255,201,92,.5);border-radius:30px;padding:22px 70px 16px;text-align:center;color:${C.white};min-width:420px}
.tr-count span{display:block;font-size:27px;font-weight:800;letter-spacing:.22em;color:${C.gold}}
.tr-count b{display:block;font-size:156px;font-weight:900;line-height:1;font-variant-numeric:tabular-nums;margin-top:4px}
.tr-chips{position:absolute;left:30px;right:30px;top:1404px;display:flex;justify-content:center;gap:12px}
.tr-chips i{font-style:normal;background:rgba(11,20,48,.8);color:${C.white};border-radius:999px;padding:10px 22px;font-size:27px;font-weight:800;opacity:.75;white-space:nowrap}
.tr-chips i.on{background:${C.gold};color:${C.ink};opacity:1}
.tr-mid{position:absolute;left:0;right:0;top:640px;display:flex;flex-direction:column;align-items:center;gap:34px}
.tr-id{width:900px;background:linear-gradient(135deg,#1f2d57,#141d3d);border:3px solid rgba(255,201,92,.6);border-radius:34px;padding:30px 40px 26px;color:${C.white};box-shadow:0 18px 50px rgba(0,0,0,.45)}
.tr-id-top{display:flex;justify-content:space-between;font-size:24px;font-weight:800;letter-spacing:.24em;color:${C.gold}}
.tr-id-body{display:flex;gap:34px;margin-top:26px;align-items:center}
.tr-id-pic{width:190px;height:190px;border-radius:26px;background:rgba(255,201,92,.14);border:3px solid rgba(255,201,92,.45);display:flex;align-items:center;justify-content:center;font-size:110px;flex:none}
.tr-id small{display:block;font-size:22px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;opacity:.6}
.tr-id-name{font-size:64px;font-weight:900;line-height:1.05}
.tr-id-grid{display:flex;gap:34px;margin-top:16px}.tr-id-grid b{font-size:36px;font-weight:900}
.tr-id-foot{display:flex;justify-content:space-between;align-items:center;margin-top:24px}
.tr-id-badge{background:${C.gold};color:${C.ink};border-radius:999px;padding:8px 24px;font-size:26px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
.tr-id-mrz{font-family:ui-monospace,Menlo,monospace;font-size:21px;letter-spacing:.12em;opacity:.45}
.tr-prog{width:760px;text-align:center;color:${C.white};font-size:32px;font-weight:800;text-shadow:0 3px 14px rgba(11,20,48,.7)}
.tr-prog div{height:16px;border-radius:999px;background:rgba(255,255,255,.22);overflow:hidden;margin-bottom:14px}
.tr-prog i{display:block;height:100%;background:${C.gold};border-radius:999px}
.tr-prog b{color:${C.gold}}
.tr-list{width:920px;background:rgba(11,20,48,.9);border-radius:30px;padding:14px 34px;color:${C.white};box-shadow:0 14px 40px rgba(0,0,0,.4)}
.tr-row{display:flex;align-items:center;gap:22px;padding:18px 0;border-bottom:2px solid rgba(255,255,255,.1)}.tr-row:last-child{border-bottom:0}
.tr-row em{font-style:normal;font-size:54px;width:70px;text-align:center}
.tr-row div{flex:1}.tr-row div b{display:block;font-size:40px;font-weight:900}.tr-row div span{font-size:27px;font-weight:700;opacity:.7}
.tr-row u{text-decoration:none;font-size:27px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:8px 20px;background:rgba(127,211,138,.2);color:#8be39a;white-space:nowrap}
.tr-row u.gold{background:rgba(255,201,92,.18);color:${C.gold}}
.tr-btn{background:${C.gold};color:${C.ink};border-radius:999px;padding:26px 60px;font-size:46px;font-weight:900;box-shadow:0 10px 0 rgba(11,20,48,.35)}
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
async function finish(tmp, id, { shots, overlays, voice, duration, caption, coverAt, coverHtml, coverBg, xf = XF, loop = true, exactLoop = false, folder, rewriteCaption = false, music = null, musicVolume = 1 }) {
  const where = folder ?? FOLDER[id] ?? `drafts/${id}`;
  const dir = join(OUT, where);
  const name = `kinsburg-${where.split('/').pop()}`;
  mkdirSync(dir, { recursive: true });
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
    // rise: drifts up this many px a second from `from` ("-$125,000" flying off)
    const pos = o.card ? `x=(W-w)/2:y=${o.cardTop ?? L.cardTop}` : o.rise ? `x=0:y='-(t-${o.from})*${o.rise}'` : 'x=0:y=0';
    vchain.push(`[${last}][ov${k}]overlay=${pos}:enable='between(t,${o.from},${o.to})':eof_action=pass[o${k}]`);
    last = `o${k}`;
    k++;
  }
  vchain.push(`[${last}]format=yuv420p[vout]`);
  // music: a track made for this reel (scripts/reel/music.mjs, already loop-ready); otherwise the quiet ambient bed
  const bed = music ?? join(tmp, `${id}-bed.wav`);
  if (music) { /* nothing to make */ }
  else if (!loop) await run(FFMPEG, ambientArgs(duration, bed, id.charCodeAt(0)));
  else {
    // seamless loop: render the bed longer with no fades, then cross-fade its tail into its start,
    // so the last sample flows straight into the first when Instagram repeats the video
    const X = 1.6, long = join(tmp, `${id}-bed-long.wav`);
    const args = ambientArgs(duration + X, long, id.charCodeAt(0)).map((a) => (typeof a === 'string' ? a.replace(/afade=t=in:d=[\d.]+,afade=t=out:st=[\d.]+:d=[\d.]+,/, '') : a));
    await run(FFMPEG, args);
    const D = duration.toFixed(3);
    await run(FFMPEG, ['-hide_banner', '-y', '-i', long, '-filter_complex',
      `[0]atrim=0:${D},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${X}:curve=qsin[m];[0]atrim=${D}:${(duration + X).toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${X}:curve=qsin,apad=whole_dur=${D}[t];[m][t]amix=inputs=2:normalize=0[o]`,
      '-map', '[o]', '-c:a', 'pcm_s16le', bed]);
  }
  const vo = k, bd = k + 1;
  const achain = `[${vo}:a]apad,atrim=0:${duration}[vo];[${bd}:a]volume=${music ? musicVolume : 0.22}[bed];[vo][bed]amix=inputs=2:normalize=0,alimiter=limit=0.89[aout]`;
  const mp4 = join(dir, `${name}.mp4`);
  await run(FFMPEG, ['-hide_banner', '-y', ...inputs, ...ovIn, '-i', voice.wav, '-i', bed,
    '-filter_complex', vchain.join(';') + ';' + achain, '-map', '[vout]', '-map', '[aout]', '-t', duration.toFixed(3), '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4]);
  const capFile = join(dir, `${name}.txt`);
  // hand-written captions are kept; automatic ones (daily episodes) are rewritten from the day's data
  if (rewriteCaption || !existsSync(capFile)) writeFileSync(capFile, caption + '\n');
  else log(`kept the caption in ${relative(ROOT, capFile)}; check its numbers against this render. Generated caption:\n${caption}`);
  if (coverHtml) {
    // a cover with its own title (the grid shows the cover, not the first frame)
    const ov = await png(join(tmp, `${id}-cover-text.png`), coverHtml);
    const bg = coverBg ? ['-i', coverBg] : ['-ss', String(coverAt), '-i', mp4]; // a still made for the cover, or a frame of the reel
    await run(FFMPEG, ['-hide_banner', '-y', ...bg, '-i', ov, '-filter_complex', '[0:v][1:v]overlay=0:0', '-frames:v', '1', '-q:v', '2', join(dir, `${name}-cover.jpg`)]);
  } else await run(FFMPEG, ['-hide_banner', '-y', '-ss', String(coverAt), '-i', mp4, '-frames:v', '1', '-q:v', '3', join(dir, `${name}-cover.jpg`)]);
  // how the cover looks as a profile-grid tile (Instagram keeps the middle 3:4)
  await run(FFMPEG, ['-hide_banner', '-y', '-i', join(dir, `${name}-cover.jpg`), '-f', 'lavfi', '-i', 'color=c=0x2b2f36:s=386x514', '-f', 'lavfi', '-i', 'color=c=0x8a6f5a:s=386x514',
    '-filter_complex', '[0]crop=1080:1440:0:240,scale=386:514[t];[1][t][2]hstack=3', '-frames:v', '1', join(dir, `${name}-grid-preview.jpg`)]);
  // every reel loops on Instagram: the end dissolves into frame one (exact loops are built that way)
  if (loop && !exactLoop) await loopVideo(mp4, { ffmpeg: FFMPEG, ffprobe: process.env.FFPROBE ?? 'ffprobe' });
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
async function common(tmp, id, voice, right, { title = 'live city', words = 3, hud: withHud = true } = {}) {
  const overlays = [];
  if (withHud) {
    const hud = await png(join(tmp, `${id}-hud.png`), `<div class="hud"><div class="chip"><i></i>Kinsburg <span>|</span> ${esc(title)}</div><div class="chip">${esc(right)}</div></div>`);
    overlays.push({ png: hud, from: 0, to: 1e3, noFade: true });
  }
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
    xf,
    shots, overlays, voice: v, duration: D,
    caption: `In this town… 🏡 Rules of Kinsburg, part 1.\n\nEvery house here belongs to a real person on Instagram. Comment MOVE IN and the city builds yours: a street address, a job it picks for you, a resident number that's yours forever, and lights that turn on when it gets dark where you live.\n\nWant to be in the next one? Comment CAST ME.`,
    coverBg: await thumbStill(page, tmp, 'T1', { target: 'actor:jadie', zoom: 8.2, y: 0.74, rings: [JADIE], actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'wave' }, { t: 1, ...home, pose: 'wave' }] }] }),
    coverHtml: `<div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;text-align:center;color:${C.white};font-weight:900;text-transform:uppercase;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div style="font-size:136px;line-height:1">In this</div>
  <div style="font-size:250px;line-height:.9;color:${C.gold};letter-spacing:-.02em">town…</div>
  <div style="font-size:64px;line-height:1.1;margin-top:18px">rules of Kinsburg #1</div></div>`,
  });
}

// ── Live: "Let's build this city" (Jadie's voice, real neighbours as hover cards) ──
// Shows only the handles asked for by name (FEATURED); everyone else is a gold ring with no name.
const FEATURED = ['itsjadenchristy', 'metabro.pov'];
async function reelL1({ tmp, page, R }) {
  const J = R.find((r) => r.id === JADIE);
  if (!J) throw new Error('@jadiedevs is not a resident');
  const N = FEATURED.map((id) => R.find((r) => r.id === id)).filter(Boolean);
  if (N.length !== FEATURED.length) throw new Error(`not residents: ${FEATURED.filter((id) => !R.some((r) => r.id === id)).join(', ')}`);
  const n = R.length, next = n + 1;
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const say = (k) => (k < 20 ? words[k] : k < 100 ? tens[Math.floor(k / 10)] + (k % 10 ? '-' + words[k % 10] : '') : String(k));
  const first = Math.min(3, n);
  const v = await narrate(tmp, 'L1', [
    { text: `This city had ${say(first)} people.`, gap: 0.25 },
    { text: `Now it has *${n}*.`, say: `Now it has ${say(n)}.`, gap: 0.4 },
    { text: 'Meet my neighbours.', gap: 0.3 },
    { text: "And this one's mine.", gap: 0.35 },
    { text: 'But most of this island is still empty.', gap: 0.3 },
    { text: "So let's build it together.", gap: 0.3 },
    { text: 'Comment MOVE IN, and be my neighbour.', say: 'Comment, move in, and be my neighbour.', gap: 1.2 },
  ], JADIE_VOICE);
  const ls = v.lines, D = v.duration, xf = 0.35;
  // four shots: [island grows] [neighbours] [Jadie's house → island] [next plot]
  const cuts = [0, ls[2].start - 0.25, ls[3].start - 0.2, ls[5].start - 0.25, D];
  const home = { at: JADIE, dx: -36, dy: 18 }, spot = { at: 'next', dx: -36, dy: 18 };
  const mid = N[0];
  const shot = async (i, build) => {
    const d = cuts[i + 1] - cuts[i] + (i < cuts.length - 2 ? xf : 0);
    const loc = (x) => x - cuts[i];
    const talk = ls.filter((l) => l.end > cuts[i] && l.start < cuts[i + 1]).map((l) => ({ from: loc(l.start), to: loc(l.end) }));
    const s = build(d, loc);
    return { file: await film(page, tmp, `L1-${i}`, { duration: d, ease: 'sine', hours: [{ t: 0, h: 22 }], ...s, actors: (s.actors ?? []).map((a) => ({ ...a, talk })) }), at: cuts[i] };
  };
  const shots = [];
  // 1 · the island: the first three houses ringed, then a ring for every resident as the number lands
  shots.push(await shot(0, (d, loc) => {
    const grow = loc(ls[1].start) - 0.1;
    return {
      keys: [{ t: 0, target: mid.id, zoom: 1.5, y: 0.6 }, { t: d, target: mid.id, zoom: 0.9, y: 0.58 }],
      rings: R.map((r, i) => ({ id: r.id, from: i < first ? 0.15 : grow + ((i - first) / Math.max(1, n - first)) * 1.1 })),
    };
  }));
  // 2 · neighbours: hover cards over the featured homes, Jadie waving in the street
  shots.push(await shot(1, (d) => ({
    keys: [{ t: 0, target: N[0].id, zoom: 5.6, y: 0.62 }, { t: d, target: N[N.length - 1].id, zoom: 6.0, y: 0.62 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, at: N[0].id, dx: -12, dy: 34, pose: 'wave' }, { t: d, at: N[0].id, dx: -12, dy: 34, pose: 'wave' }] }],
    rings: N.map((r) => ({ id: r.id, from: 0.1 })),
    labels: N.map((r, i) => ({ id: r.id, text: `@${r.id}`, sub: `Resident #${r.number} · ${r.job}`, from: 0.2 + i * 0.35, to: d + 1 })),
  })));
  // 3 · Jadie's house and card, then a long pull out over the empty island
  shots.push(await shot(2, (d, loc) => {
    const out0 = loc(ls[4].start) - 0.2;
    return {
      keys: [{ t: 0, target: 'actor:jadie', zoom: 7.6, y: 0.62 }, { t: out0, target: 'actor:jadie', zoom: 8.0, y: 0.62 }, { t: d, target: JADIE, zoom: 0.55, y: 0.55 }],
      actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'point', face: 1 }, { t: d, ...home, pose: 'point', face: 1 }] }],
      rings: [{ id: JADIE, from: 0.1, to: out0 + 0.6 }, { id: 'next', from: out0 + 0.8 }],
      labels: [{ id: JADIE, text: `@${JADIE}`, sub: `Resident #${J.number} · ${J.job}`, from: 0.25, to: out0 + 0.4 }],
    };
  }));
  // 4 · the next plot: Jadie walks up to it, waves; sign and MOVE IN
  shots.push(await shot(3, (d) => {
    const arrive = 1.3;
    return {
      keys: [{ t: 0, target: 'actor:jadie', zoom: 6.6, y: 0.62 }, { t: arrive, target: 'actor:jadie', zoom: 7.2, y: 0.62 }, { t: d, target: 'actor:jadie', zoom: 6.4, y: 0.62 }],
      actors: [{ id: 'jadie', keys: [{ t: 0, at: 'next', dx: -110, dy: 55, pose: 'idle' }, { t: arrive, ...spot, pose: 'idle' }, { t: arrive + 0.2, ...spot, pose: 'wave' }, { t: d, ...spot, pose: 'wave' }] }],
      rings: [{ id: 'next', from: 0 }],
    };
  }));

  const right = `${n.toLocaleString('en-US')} residents`;
  const overlays = await common(tmp, 'L1', v, right, { title: 'live city', words: 1 });
  overlays.push({ png: await png(join(tmp, 'L1-title.png'), `<div class="cap" style="font-size:104px"><div>We're building <b>a city</b></div></div>`), from: 0, to: cuts[1] + 0.1, noFade: true });
  overlays.push({ png: await sign(tmp, 'L1', 'Next house', `#${next}`), from: cuts[3] + 0.9, to: ls[6].start, fade: 0.25 });
  overlays.push({ png: await bubble(tmp, 'L1', 660), from: ls[6].start, to: D, fade: 0.25 });

  await finish(tmp, 'L1', {
    xf,
    shots, overlays, voice: v, duration: D,
    caption: `This city had ${first} people. Now it has ${n}. 🏡\n\nMeet a few of the neighbours: @${N.map((r) => r.id).join(', @')} and me, @${JADIE}. Every house here is a real person on Instagram, and most of the island is still empty, so let's build it together.\n\nComment MOVE IN and house #${next} is yours. Want to be in the next video? Comment CAST ME.`,
    coverBg: await thumbStill(page, tmp, 'L1', { target: mid.id, zoom: 1.15, y: 0.72, rings: R.map((r) => r.id) }),
    coverHtml: `<div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;text-align:center;color:${C.white};font-weight:900;text-transform:uppercase;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div style="font-size:120px;line-height:1">${first} people</div>
  <div style="font-size:300px;line-height:.9;color:${C.gold};letter-spacing:-.03em">→ ${n}</div>
  <div style="font-size:84px;line-height:1.05;margin-top:14px;text-wrap:balance">let's build this city</div></div>`,
  });
}

// ── "In this town" #2: six seven (only while the city has exactly 67 residents) ──
// The "6-7" meme: Jadie says "six, seven" bouncing his palms. Built as a seamless loop: the last shot
// lands on the first frame (same camera, pose and gesture phase), the last line runs into the first
// ("…we're only" → "six, seven"), and the music bed's tail is cross-faded into its start.
async function reelT2({ tmp, page, R }) {
  const n = R.length;
  if (n !== 67 && !args.force) throw new Error(`the city has ${n} residents, not 67: this one only works at 67 (pass --force to render anyway)`);
  const J = R.find((r) => r.id === JADIE);
  if (!J) throw new Error('@jadiedevs is not a resident');
  const last = R[n - 1], next = n + 1;
  const job = last.job.toLowerCase();
  const an = /^[aeiou]/.test(job) ? 'an' : 'a';
  const v = await narrate(tmp, 'T2', [
    { text: '*6*… *7*.', say: 'Six, seven.', gap: 0.3 },
    { text: "That's how many people live in this town.", gap: 0.3 },
    { text: `Resident *#${n}*? The city made them ${an} *${job}*.`, say: `Resident number sixty-seven? The city made them ${an} ${job}.`, gap: 0.3 },
    { text: 'Every comment builds a house.', gap: 0.3 },
    { text: `House *#${next}* is still empty.`, say: 'House number sixty-eight is still empty.', gap: 0.3 },
    { text: "So comment MOVE IN, because right now, we're only…", say: "So comment, move in. Because right now, we're only", gap: 0.04 },
  ], JADIE_VOICE);
  const ls = v.lines, D = v.duration, xf = 0.3;
  const cuts = [0, ls[2].start - 0.2, ls[3].start - 0.2, ls[4].start - 0.2, ls[5].start - 0.2, D];
  const home = { at: JADIE, dx: -36, dy: 18 }, spot = { at: 'next', dx: -36, dy: 18 };
  const LOOP_CAM = { target: 'actor:jadie', zoom: 9.4, y: 0.6 }; // first frame = last frame
  const shot = async (i, build) => {
    const d = cuts[i + 1] - cuts[i] + (i < cuts.length - 2 ? xf : 0);
    const loc = (x) => x - cuts[i];
    const talk = ls.filter((l) => l.end > cuts[i] && l.start < cuts[i + 1]).map((l) => ({ from: loc(l.start), to: loc(l.end) }));
    const s = build(d, loc);
    return { file: await film(page, tmp, `T2-${i}`, { duration: d, ease: 'sine', hours: [{ t: 0, h: 22 }], ...s, actors: (s.actors ?? []).map((a) => ({ ...a, talk })) }), at: cuts[i] };
  };
  const shots = [];
  // 1 · "six, seven" in close-up, then the pull out over 67 gold markers
  shots.push(await shot(0, (d, loc) => {
    const out0 = loc(ls[0].end) + 0.15;
    return {
      keys: [{ t: 0, ...LOOP_CAM }, { t: out0, ...LOOP_CAM }, { t: Math.min(d, out0 + 2.2), target: JADIE, zoom: 0.95, y: 0.55 }, { t: d, target: JADIE, zoom: 0.92, y: 0.55 }],
      actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'sixseven' }, { t: out0, ...home, pose: 'sixseven' }, { t: out0 + 0.01, ...home, pose: 'wave' }, { t: d, ...home, pose: 'wave' }] }],
      rings: R.map((r, i) => ({ id: r.id, from: out0 + 0.3 + (i / n) * 1.6 })),
    };
  }));
  // 2 · resident #67's house (no name: they haven't commented CAST ME), Jadie pointing at it
  shots.push(await shot(1, (d) => ({
    keys: [{ t: 0, target: last.id, zoom: 6.2, y: 0.64 }, { t: d, target: last.id, zoom: 6.8, y: 0.64 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, at: last.id, dx: -40, dy: 26, pose: 'point', face: 1 }, { t: d, at: last.id, dx: -40, dy: 26, pose: 'point', face: 1 }] }],
    rings: [{ id: last.id, from: 0.1 }],
  })));
  // 3 · every comment builds a house: the newest homes light up gold one after another
  shots.push(await shot(2, (d) => ({
    keys: [{ t: 0, target: last.id, zoom: 2.6, y: 0.56 }, { t: d, target: last.id, zoom: 2.2, y: 0.56 }],
    rings: R.slice(-12).map((r, i) => ({ id: r.id, from: 0.15 + i * 0.12 })),
  })));
  // 4 · the next empty plot: Jadie walks up and points
  shots.push(await shot(3, (d) => {
    const arrive = Math.min(d - 0.4, 1.2);
    return {
      keys: [{ t: 0, target: 'actor:jadie', zoom: 7.2, y: 0.62 }, { t: arrive, target: 'actor:jadie', zoom: 7.4, y: 0.62 }, { t: d, target: 'actor:jadie', zoom: 7.7, y: 0.62 }],
      actors: [{ id: 'jadie', keys: [{ t: 0, at: 'next', dx: -96, dy: 48, pose: 'idle' }, { t: arrive, ...spot, pose: 'idle' }, { t: arrive + 0.15, ...spot, pose: 'point', face: 1 }, { t: d, ...spot, pose: 'point', face: 1 }] }],
      rings: [{ id: 'next', from: arrive - 0.35 }],
    };
  }));
  // 5 · back home: he waves, then starts "six seven" exactly as the video began (the loop point)
  shots.push(await shot(4, (d, loc) => {
    const six = Math.max(0.6, loc(ls[5].words.find((w) => /^only/i.test(w.w))?.start ?? ls[5].start + 1.5) - 0.35);
    return {
      keys: [{ t: 0, target: 'actor:jadie', zoom: 7.8, y: 0.6 }, { t: Math.max(0.5, d - 1.2), ...LOOP_CAM }, { t: d, ...LOOP_CAM }],
      // clock: -d makes the gesture's phase at the last frame equal to the first frame's
      actors: [{ id: 'jadie', clock: -d, keys: [{ t: 0, ...home, pose: 'wave' }, { t: six, ...home, pose: 'wave' }, { t: six + 0.01, ...home, pose: 'sixseven' }, { t: d, ...home, pose: 'sixseven' }] }],
    };
  }));

  const right = `${n.toLocaleString('en-US')} residents`;
  const overlays = await common(tmp, 'T2', v, right, { title: 'in this town', words: 1 });
  overlays.push({ png: await sign(tmp, 'T2', `Resident #${n}`, last.job), from: cuts[1] + 0.35, to: cuts[2], fade: 0.2 });
  overlays.push({ png: await sign(tmp, 'T2', `House #${next}`, 'Still empty'), from: cuts[3] + 1.1, to: cuts[4], fade: 0.2 });
  const because = ls[5].words.find((w) => /^because/i.test(w.w))?.start ?? ls[5].start + 1;
  overlays.push({ png: await bubble(tmp, 'T2', 660), from: ls[5].start, to: because, fade: 0.2 });

  await finish(tmp, 'T2', {
    xf, loop: true, exactLoop: true,
    shots, overlays, voice: v, duration: D,
    caption: `6… 7. That's how many people live in this town. 🏡\n\nKinsburg is a cozy isometric city where every house belongs to a real person on Instagram. Resident #${n} became ${an} ${job}. House #${next} is still empty.\n\nComment MOVE IN and it's yours. Want to be in the next one? Comment CAST ME.\n\n#kinsburg #citybuilder #isometric #cozygames #67`,
    coverBg: await thumbStill(page, tmp, 'T2', { target: 'actor:jadie', zoom: 8.2, y: 0.74, actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'sixseven' }, { t: 1, ...home, pose: 'sixseven' }] }] }),
    coverHtml: `<div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;text-align:center;color:${C.white};font-weight:900;text-transform:uppercase;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div style="font-size:112px;line-height:1">In this town</div>
  <div style="font-size:330px;line-height:.88;color:${C.gold};letter-spacing:-.03em">6 7</div>
  <div style="font-size:84px;line-height:1.05;margin-top:10px">people live here</div></div>`,
  });
}

// ── "In this town" #3: the update (pets, jobs, RESPOND and coins, besties, secret spots) ──
// Everything shown is live: Jadie's own dog, a real resident's pet (house only, no name unless cast),
// the police and fire stations, a house with an open incident, the next empty plot.
async function reelT3({ tmp, page, R }) {
  const J = R.find((r) => r.id === JADIE);
  if (!J) throw new Error('@jadiedevs is not a resident');
  if (!J.pet) throw new Error('Jadie has no pet yet: POST /admin/pet {"handle":"jadiedevs","pet":"dog"}');
  const town = await page.evaluate(() => fetch('/api/city/town.json').then((r) => r.json()).catch(() => null));
  const call = (town?.sim?.open ?? []).find((c) => c.target && R.some((r) => r.id === c.target));
  const trouble = call?.target ?? J.id;
  const n = R.length, next = n + 1;
  const v = await narrate(tmp, 'T3', [
    { text: 'In this town, we got *pets* now.', gap: 0.3 },
    { text: 'Comment *PET* *DOG*, *PET* *CAT*, or *PET* *BUNNY*.', say: 'Comment, pet dog. Pet cat. Or pet bunny.', gap: 0.3 },
    { text: 'Hate your job? Comment *JOB*, and pick a new one.', say: 'Hate your job? Comment, job, and pick a new one.', gap: 0.3 },
    { text: 'When something goes wrong, comment *RESPOND*.', say: 'When something goes wrong, comment, respond.', gap: 0.25 },
    { text: 'Helping pays *coins*. A hundred and fifty gets you a *fox*.', gap: 0.3 },
    { text: 'Moving in? Tag your *bestie*, and they get the house next door.', gap: 0.3 },
    { text: 'Oh, and there are *six* secret spots. Good luck.', say: 'Oh, and there are six secret spots. Good luck.', gap: 1.0 },
  ], JADIE_VOICE);
  const ls = v.lines, D = v.duration, xf = 0.3;
  const cuts = [0, ls[1].start - 0.2, ls[2].start - 0.2, ls[3].start - 0.2, ls[5].start - 0.2, ls[6].start - 0.2, D];
  // the lawn by the monument: the police station now stands on the street in front of his house
  const home = { at: JADIE, dx: -36, dy: -18 }, spot = { at: 'next', dx: -36, dy: 18 };
  const wordAt = (l, re) => l.words.find((w) => re.test(w.w.replace(/\*/g, '')))?.start ?? l.start;
  const shot = async (i, build) => {
    const d = cuts[i + 1] - cuts[i] + (i < cuts.length - 2 ? xf : 0);
    const loc = (x) => x - cuts[i];
    const talk = ls.filter((l) => l.end > cuts[i] && l.start < cuts[i + 1]).map((l) => ({ from: loc(l.start), to: loc(l.end) }));
    const s = build(d, loc);
    return { file: await film(page, tmp, `T3-${i}`, { duration: d, ease: 'sine', hours: [{ t: 0, h: 22 }], ...s, actors: (s.actors ?? []).map((a) => ({ ...a, talk })) }), at: cuts[i] };
  };
  const shots = [];
  // 1 · Jadie and his new dog
  shots.push(await shot(0, (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 8.6, y: 0.6 }, { t: d, target: 'actor:jadie', zoom: 9.2, y: 0.6 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'jump', pet: 'dog' }, { t: d, ...home, pose: 'jump' }] }],
    rings: [{ id: JADIE, from: 0.2 }],
  })));
  // 2 · a real resident's pet in their yard; the sign swaps DOG → CAT → BUNNY on the words
  const l1 = ls[1], tCat = wordAt(l1, /^cat/i) - 0.25, tBun = wordAt(l1, /^bunny/i) - 0.25;
  shots.push(await shot(1, (d, loc) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 9.6, y: 0.6 }, { t: d, target: 'actor:jadie', zoom: 10.2, y: 0.6 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'point', face: -1, pet: 'dog' }, { t: loc(tCat), ...home, pose: 'point', face: -1, pet: 'cat' }, { t: loc(tBun), ...home, pose: 'point', face: -1, pet: 'bunny' }, { t: d, ...home, pose: 'point', face: -1 }] }],
  })));
  // 3 · jobs: glide from the police station to the fire station
  shots.push(await shot(2, (d) => ({
    keys: [{ t: 0, target: 'landmark:police', zoom: 4.4, y: 0.6 }, { t: d, target: 'landmark:firestation', zoom: 4.6, y: 0.6 }],
  })));
  // 4 · RESPOND: Jadie runs to a house with an open call, then jumps when the coins land
  shots.push(await shot(3, (d, loc) => {
    const arrive = Math.min(1.4, d - 1);
    const paid = loc(wordAt(ls[4], /^coins/i)), fox = loc(wordAt(ls[4], /^fox/i)) - 0.1;
    return {
      keys: [{ t: 0, target: 'actor:jadie', zoom: 6.6, y: 0.62 }, { t: arrive, target: 'actor:jadie', zoom: 7.2, y: 0.62 }, { t: d, target: 'actor:jadie', zoom: 7.6, y: 0.62 }],
      actors: [{ id: 'jadie', keys: [{ t: 0, at: trouble, dx: -110, dy: 55, pose: 'idle', pet: 'dog' }, { t: arrive, at: trouble, dx: -36, dy: 18, pose: 'idle' }, { t: paid, at: trouble, dx: -36, dy: 18, pose: 'jump' }, { t: fox, at: trouble, dx: -36, dy: 18, pose: 'jump', pet: 'fox' }, { t: d, at: trouble, dx: -36, dy: 18, pose: 'jump' }] }],
      rings: [{ id: trouble, from: 0.2 }],
    };
  }));
  // 5 · besties: the next empty plot, Jadie waves
  shots.push(await shot(4, (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 7.4, y: 0.62 }, { t: d, target: 'actor:jadie', zoom: 7.8, y: 0.62 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...spot, pose: 'wave', pet: 'dog' }, { t: d, ...spot, pose: 'wave' }] }],
    rings: [{ id: 'next', from: 0.15 }],
  })));
  // 6 · secrets: a long pull out over the whole city
  shots.push(await shot(5, (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 7.0, y: 0.62 }, { t: Math.min(d, 2.4), target: J.id, zoom: 0.85, y: 0.55 }, { t: d, target: J.id, zoom: 0.8, y: 0.55 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...spot, pose: 'look', pet: 'dog' }, { t: d, ...spot, pose: 'look' }] }],
  })));

  const right = `${n.toLocaleString('en-US')} residents`;
  const overlays = await common(tmp, 'T3', v, right, { title: 'in this town', words: 1 });
  overlays.push({ png: await png(join(tmp, 'T3-title.png'), `<div class="cap" style="font-size:108px"><div>New in <b>Kinsburg</b></div></div>`), from: 0, to: cuts[1], noFade: true });
  overlays.push({ png: await sign(tmp, 'T3', 'Comment', 'Pet dog'), from: cuts[1] + 0.2, to: tCat, fade: 0.12 });
  overlays.push({ png: await sign(tmp, 'T3', 'Comment', 'Pet cat'), from: tCat, to: tBun, fade: 0.12 });
  overlays.push({ png: await sign(tmp, 'T3', 'Comment', 'Pet bunny'), from: tBun, to: cuts[2], fade: 0.12 });
  overlays.push({ png: await sign(tmp, 'T3', 'Comment', 'Job vet'), from: wordAt(ls[2], /^job/i) - 0.1, to: cuts[3], fade: 0.15 });
  overlays.push({ png: await sign(tmp, 'T3', 'Comment', 'Respond'), from: wordAt(ls[3], /^respond/i) - 0.15, to: ls[4].start, fade: 0.15 });
  overlays.push({ png: await sign(tmp, 'T3', 'Helping pays', '+10 coins'), from: ls[4].start, to: wordAt(ls[4], /^fifty/i) - 0.3, fade: 0.15 });
  overlays.push({ png: await sign(tmp, 'T3', '150 coins =', 'Fox 🦊'), from: wordAt(ls[4], /^fifty/i) - 0.3, to: cuts[4], fade: 0.15 });
  overlays.push({ png: await sign(tmp, 'T3', 'Comment', 'Move in @bestie'), from: wordAt(ls[5], /^bestie/i) - 0.2, to: cuts[5], fade: 0.15 });
  overlays.push({ png: await sign(tmp, 'T3', 'Secret spots', '0 / 6'), from: wordAt(ls[6], /^six/i) - 0.1, to: D, fade: 0.2 });

  await finish(tmp, 'T3', {
    xf, shots, overlays, voice: v, duration: D,
    caption: `In this town… we got pets now. 🐶🐱🐰`,
    coverBg: await thumbStill(page, tmp, 'T3', { target: 'actor:jadie', zoom: 10.5, y: 0.76, actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'wave', pet: 'dog' }, { t: 1, ...home, pose: 'wave' }] }] }),
    coverHtml: `<div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;text-align:center;color:${C.white};font-weight:900;text-transform:uppercase;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div style="font-size:112px;line-height:1">In this town</div>
  <div style="font-size:250px;line-height:.9;color:${C.gold};letter-spacing:-.02em">pets!</div>
  <div style="font-size:70px;line-height:1.1;margin-top:14px;text-wrap:balance">+ jobs, coins, besties &amp; secrets</div></div>`,
  });
  return { trouble, call };
}

// ── Daily episodes: "Kinsburg · Episode N" (city cash, the comment wall, what got built) ──
// Made entirely from the day's summary the 12:00 UTC build run records (town.json cityCash.today):
// residents and followers yesterday -> today, the money that came in, the comment wall with real
// handles, what the city bought (flying to each real build), what's left and what's next.
const EP_START_DAY = 14; // the city day of episode 1 (then every other day: 16, 18…)
// kinds newer than this copy of shared/builds.mjs still read well
const EXTRA_KINDS = { university: { label: 'University', emoji: '🎓' } };
const kindLabel = (k) => BUILD_BY_KIND[k]?.label ?? EXTRA_KINDS[k]?.label ?? k.charAt(0).toUpperCase() + k.slice(1);
const kindEmoji = (k) => BUILD_BY_KIND[k]?.emoji ?? EXTRA_KINDS[k]?.emoji ?? '🏗️';
const aOrAn = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
async function reelE({ tmp, page, R }) {
  const town = await page.evaluate(() => fetch('/api/city/town.json').then((r) => r.json()));
  const cc = town?.cityCash, T = cc?.today;
  if (!T || !Array.isArray(T.wall)) throw new Error('no daily build run with episode data yet (it runs at 12:00 UTC)');
  // episodes alternate with the city tour: episodes on even days from EP_START_DAY, tours in between
  const off = T.day - EP_START_DAY;
  if (off % 2 && !args.force) throw new Error(`city day ${T.day} is a tour day (episodes are every other day): npm run reel:launch -- --only TR --url https://kinsburg.com`);
  const N = Math.max(1, Math.floor(off / 2) + 1), NN = String(N).padStart(2, '0');
  const first = N === 1 || !T.prev;
  const prevRes = T.prev?.residents ?? 3, nowRes = T.residents;
  const inc = T.income ?? {};
  const moveIns = inc.move_in?.n ?? 0, moveCash = inc.move_in?.amount ?? 0;
  const followCash = inc.follows?.amount ?? 0, followers = Math.round(followCash / 1500);
  const seed = inc.seed?.amount ?? 0, gift = inc.gift?.amount ?? 0, extra = inc.adjust?.amount ?? 0;
  const startCash = T.prev?.after ?? 0;
  const buys = [
    ...T.built.map((b) => ({ ...b, label: kindLabel(b.kind), emoji: kindEmoji(b.kind), target: `build:${b.id}`, home: false, city: b.by === (town.account ?? 'kinsburgtown') })),
    ...T.homes.map((h) => ({ ...h, label: h.kind === 'villa' ? 'Villa' : 'Skyscraper', emoji: h.kind === 'villa' ? '🏝️' : '🏙️', target: h.handle, home: true, by: h.handle })),
  ];
  const wait = T.waiting ? { ...T.waiting, label: T.waiting.type === 'home' ? (T.waiting.kind === 'villa' ? 'Villa' : 'Skyscraper') : kindLabel(T.waiting.kind) } : null;
  const wall = T.wall.slice(0, 6);
  const winner = buys.find((b) => !b.home && !b.city) ?? null;

  // ── narration ──
  const lines = [];
  const L = (key, text, say, gap = 0.3) => lines.push({ key, text, say, gap });
  L('title', `Kinsburg, episode ${N}.`, `Kinsburg, episode ${sayNumber(N)}.`, 0.25);
  // not "live here": the voice reads that as "live music"; "live in this city" comes out right
  if (first) L('people', `This city started with *3* people. Today, *${nowRes}* people live in this city.`, `This city started with three people. Today, ${sayNumber(nowRes)} people live in this city.`);
  else L('people', `Yesterday, *${prevRes}* people lived here. Today, *${nowRes}*.`, `Yesterday, ${sayNumber(prevRes)} people lived here. Today, ${sayNumber(nowRes)}.`);
  if (seed) L('money', `Every neighbour is worth *$1,500* to the city. That's *${usd(seed)}*.`, `Every neighbour is worth fifteen hundred dollars to the city. That's ${sayMoney(seed)}.`);
  else L('money', `New neighbours and followers brought in *${usd(T.before - startCash)}*. So we have *${usd(T.before)}*.`, `New neighbours and followers brought in ${sayMoney(T.before - startCash)}. So we have ${sayMoney(T.before)}.`);
  // only claim "a lot" when there really was a crowd of requests
  if (gift) L('gift', `Then someone gave the city *${usd(gift)}*. Anonymously.`, `Then someone gave the city ${sayMoney(gift)}. Anonymously.`, 0.35);
  if (wall.length >= 3) L('wall', 'You asked for a lot.', 'You asked for a lot.', 0.2);
  if (winner) L('winner', `The top comment? *${aOrAn(winner.label)} ${winner.label.toLowerCase()}*.`, `The top comment? ${aOrAn(winner.label)} ${winner.label.toLowerCase()}.`);
  buys.forEach((b, i) => {
    const what = `${aOrAn(b.label)} ${b.label.toLowerCase()}`;
    if (i === 0) L(`buy${i}`, `${what[0].toUpperCase() + what.slice(1)} costs *${usd(b.price)}*. Built.`, `${what} costs ${sayMoney(b.price)}. Built.`);
    else L(`buy${i}`, `And ${what}, for *${usd(b.price)}*.`, `And ${what}, for ${sayMoney(b.price)}.`);
  });
  if (!buys.length && wait) L('cant', `${aOrAn(wait.label)[0].toUpperCase() + aOrAn(wait.label).slice(1)} ${wait.label.toLowerCase()} costs *${usd(wait.price)}*. We can't afford it yet.`, `${aOrAn(wait.label)} ${wait.label.toLowerCase()} costs ${sayMoney(wait.price)}. We can't afford it yet.`);
  L('left', `That leaves *${usd(T.after)}*.`, `That leaves ${sayMoney(T.after)}.`, 0.25);
  if (wait && buys.length) L('next', `Next, we're saving up for ${aOrAn(wait.label)} *${wait.label.toLowerCase()}*.`, `Next, we're saving up for ${aOrAn(wait.label)} ${wait.label.toLowerCase()}.`);
  L('cta', 'Comment what we build next. The top comment gets built.', 'Comment what we build next. The top comment gets built.', 1.1);
  const v = await narrate(tmp, `E${NN}`, lines.map(({ text, say, gap }) => ({ text, say, gap })), JADIE_VOICE);
  const ls = v.lines, D = v.duration, xf = 0.3;
  const at = (key) => ls[lines.findIndex((l) => l.key === key)];

  // ── shots: one per beat ──
  const beats = [];
  const B = (keys, build) => { const idx = lines.findIndex((l) => keys.includes(l.key)); if (idx >= 0) beats.push({ idx, build }); };
  const byNumber = [...R].sort((a, b) => a.number - b.number);
  const newest = byNumber.slice(Math.max(1, prevRes)).slice(-40);
  const home = { at: JADIE, dx: -36, dy: -18 };
  const square = 'landmark:townhall';
  B(['title'], (d, loc) => ({
    keys: [{ t: 0, target: square, zoom: 1.0, y: 0.62 }, { t: d, target: square, zoom: 1.25, y: 0.62 }],
    rings: newest.map((r, i) => ({ id: r.id, from: loc(at('people').start) + 0.3 + (i / Math.max(1, newest.length)) * 1.4 })),
  }));
  B(['money', 'gift'], (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 8.6, y: 0.58 }, { t: d, target: 'actor:jadie', zoom: 9.0, y: 0.58 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'point', face: 1, pet: 'dog' }, { t: d, ...home, pose: 'point', face: 1 }] }],
  }));
  B(['wall', 'winner'], (d) => ({ keys: [{ t: 0, target: square, zoom: 2.0, y: 0.6 }, { t: d, target: square, zoom: 2.3, y: 0.6 }] }));
  buys.forEach((b, i) => B([`buy${i}`], (d) => ({
    keys: [{ t: 0, target: b.target, zoom: b.home ? 5.0 : 3.6, y: 0.66 }, { t: d, target: b.target, zoom: b.home ? 5.6 : 4.2, y: 0.66 }],
    rings: [{ id: b.target, from: 0.6 }],
  })));
  if (!buys.length) B(['cant'], (d) => ({ keys: [{ t: 0, target: square, zoom: 1.6, y: 0.6 }, { t: d, target: square, zoom: 1.9, y: 0.6 }] }));
  const lastTarget = buys.length ? buys[buys.length - 1].target : square;
  B(['left'], (d) => ({ keys: [{ t: 0, target: lastTarget, zoom: buys.length ? 4.2 : 1.9, y: 0.62 }, { t: Math.min(d, 2.4), target: square, zoom: 1.1, y: 0.6 }, { t: d, target: square, zoom: 1.05, y: 0.6 }] }));
  B(['cta'], (d) => ({
    keys: [{ t: 0, target: 'actor:jadie', zoom: 8.0, y: 0.58 }, { t: d, target: 'actor:jadie', zoom: 8.6, y: 0.58 }],
    actors: [{ id: 'jadie', keys: [{ t: 0, ...home, pose: 'wave', pet: 'dog' }, { t: d, ...home, pose: 'wave' }] }],
  }));
  beats.sort((a, b) => a.idx - b.idx);
  const cuts = beats.map((b, i) => (i === 0 ? 0 : ls[b.idx].start - 0.2));
  cuts.push(D);
  const shots = [];
  for (const [i, bt] of beats.entries()) {
    const from = cuts[i], to = cuts[i + 1];
    const d = to - from + (i < beats.length - 1 ? xf : 0);
    const loc = (x) => x - from;
    const talk = ls.filter((l) => l.end > from && l.start < to).map((l) => ({ from: loc(l.start), to: loc(l.end) }));
    const sc = bt.build(d, loc);
    shots.push({ file: await film(page, tmp, `E${NN}-${i}`, { duration: d, ease: 'sine', hours: [{ t: 0, h: 21 }], ...sc, actors: (sc.actors ?? []).map((a) => ({ ...a, talk })) }), at: from });
  }

  // ── overlays ──
  const overlays = await common(tmp, `E${NN}`, v, '', { words: 1, hud: false });
  const hud = async (cash, people, k) => png(join(tmp, `E${NN}-hud${k}.png`), `<div class="ep-hud"><div class="ep-chip"><span>City cash</span><b>${usd(cash)}</b></div><div class="ep-chip"><span>Residents</span><b>${people.toLocaleString('en-US')}</b></div></div>`);
  // the counters tick: yesterday's cash, then today's total, then down with each purchase
  const ticks = [{ t: 0, cash: startCash }, { t: at('money').start + 0.6, cash: T.before - gift }];
  if (gift) ticks.push({ t: at('gift').start + 1.2, cash: T.before });
  let running = T.before;
  buys.forEach((b, i) => { running -= b.price; ticks.push({ t: at(`buy${i}`).start + 1.0, cash: running }); });
  for (const [k, tk] of ticks.entries()) overlays.push({ png: await hud(tk.cash, nowRes, k), from: tk.t, to: ticks[k + 1]?.t ?? D, noFade: true });
  const mid = (html, k) => png(join(tmp, `E${NN}-mid-${k}.png`), `<div class="ep-mid">${html}</div>`);
  overlays.push({ png: await mid(`<div class="ep-banner">Kinsburg</div><div class="ep-pill">Episode ${N}</div>`, 'title'), from: 0, to: at('people').start, fade: 0.2 });
  overlays.push({ png: await mid(`<div class="ep-card"><h3>Residents</h3><div class="ep-vs"><s>${prevRes}</s><i>→</i><span>${nowRes}</span></div><div class="ep-vs-l"><span>${first ? 'Day 1' : 'Yesterday'}</span><span>Today</span></div></div>`, 'people'), from: at('people').start, to: cuts[1], fade: 0.2 });
  const rows = [];
  if (!seed) rows.push(`<div class="ep-row"><span>Yesterday</span><b>${usd(startCash)}</b></div>`);
  if (seed) rows.push(`<div class="ep-row plus"><span>Starting budget <small>${(seed / 1500).toLocaleString('en-US')} × $1,500</small></span><b>+${usd(seed)}</b></div>`);
  if (moveCash) rows.push(`<div class="ep-row plus"><span>Move-ins <small>${moveIns} × $1,500</small></span><b>+${usd(moveCash)}</b></div>`);
  if (followCash) rows.push(`<div class="ep-row plus"><span>Followers <small>${followers} × $1,500</small></span><b>+${usd(followCash)}</b></div>`);
  if (extra) rows.push(`<div class="ep-row ${extra > 0 ? 'plus' : 'minus'}"><span>Other</span><b>${extra > 0 ? '+' : ''}${usd(extra)}</b></div>`);
  if (gift) rows.push(`<div class="ep-row plus"><span>Anonymous gift 🎁</span><b>+${usd(gift)}</b></div>`);
  rows.push(`<div class="ep-row total"><span>City cash</span><b>${usd(T.before)}</b></div>`);
  const has = (key) => lines.some((l) => l.key === key);
  const afterMoney = cuts[beats.findIndex((b) => ['money', 'gift'].includes(lines[b.idx].key)) + 1];
  overlays.push({ png: await mid(`<div class="ep-card"><h3>The city's money</h3>${rows.join('')}</div>`, 'money'), from: at('money').start - 0.1, to: afterMoney - 0.15, fade: 0.2 });
  if (wall.length && (has('wall') || has('winner'))) {
    const card = (w, cls) => `<div class="ep-c ${cls}"><i></i><div><b>@${esc(w.handle)}</b><span>${kindEmoji(w.kind)} ${esc(kindLabel(w.kind))}, please!</span></div><em>♥ ${w.likes}</em></div>`;
    const isWin = (w) => winner && w.kind === winner.kind && w.handle === winner.by;
    const plain = `<div class="ep-wall">${wall.map((w) => card(w, '')).join('')}</div>`;
    const lit = `<div class="ep-wall"><div class="ep-top">Top comment</div>${wall.map((w) => card(w, isWin(w) ? 'win' : 'dim')).join('')}</div>`;
    const wEnd = winner ? at('winner').start : cuts[beats.findIndex((b) => lines[b.idx].key === 'wall') + 1];
    // "You asked for a lot" shows every card; with only a few requests the wall opens on the winner
    if (has('wall')) overlays.push({ png: await png(join(tmp, `E${NN}-wall.png`), plain), from: at('wall').start - 0.1, to: wEnd, fade: 0.2 });
    if (winner) overlays.push({ png: await png(join(tmp, `E${NN}-wall-win.png`), lit), from: has('wall') ? wEnd : wEnd - 0.1, to: at('winner').end + 0.4, fade: 0.15 });
  }
  for (const [i, b] of buys.entries()) {
    const l = at(`buy${i}`);
    overlays.push({ png: await png(join(tmp, `E${NN}-tag${i}.png`), `<div class="ep-tag"><div>${b.emoji} ${esc(b.label)}: ${usd(b.price)}</div></div>`), from: l.start + 0.1, to: l.end + 0.3, fade: 0.15 });
    overlays.push({ png: await png(join(tmp, `E${NN}-minus${i}.png`), `<div class="ep-minus">−${usd(b.price)}</div>`), from: l.start + 1.0, to: l.start + 2.2, fade: 0.25, rise: 160 });
  }
  if (!buys.length && wait) {
    overlays.push({ png: await mid(`<div class="ep-card"><h3>Saving up</h3><div class="ep-row"><span>${esc(wait.label)}</span><b>${usd(wait.price)}</b></div><div class="ep-row total"><span>We have</span><b>${usd(T.after)}</b></div></div>`, 'cant'), from: at('cant').start, to: at('left').start, fade: 0.2 });
  }
  const leftRows = [`<div class="ep-row total"><span>Left</span><b>${usd(T.after)}</b></div>`];
  if (wait) leftRows.push(`<div class="ep-row"><span>Next: ${esc(wait.label)}</span><b>${usd(wait.price)}</b></div>`);
  const leftEnd = lines.find((l) => l.key === 'next') ? at('next').end + 0.3 : at('cta').start;
  overlays.push({ png: await mid(`<div class="ep-card"><h3>After today</h3>${leftRows.join('')}</div>`, 'left'), from: at('left').start, to: leftEnd, fade: 0.2 });
  overlays.push({ png: await sign(tmp, `E${NN}`, 'Top comment', 'gets built'), from: at('cta').start + 0.1, to: D, fade: 0.2 });

  const builtText = buys.length ? buys.map((b) => `${b.emoji} ${b.label} (${usd(b.price)}${b.city ? ', the city\'s own pick' : b.by && !b.home ? `, asked by @${b.by}` : b.home ? `, for @${b.by}` : ''})`).join('\n') : `Nothing yet: we're saving up for ${aOrAn(wait?.label ?? 'thing')} ${(wait?.label ?? 'something').toLowerCase()} (${usd(wait?.price ?? 0)}).`;
  await finish(tmp, 'E', {
    xf, folder: `episodes/episode-${NN}`, rewriteCaption: true,
    shots, overlays, voice: v, duration: D,
    caption: `Kinsburg · Episode ${N} 🏗️\n\n${first ? 'Day 1 of building this city together.' : `Yesterday ${prevRes} people lived here. Today ${nowRes}.`} Every new neighbour and every new follower gives the city $1,500.${gift ? ` And today someone gave the city ${usd(gift)}, anonymously 🎁` : ''}\n\nBuilt today:\n${builtText}\n\nLeft in the bank: ${usd(T.after)}.${wait ? ` Next up: ${wait.label} (${usd(wait.price)}).` : ''}\n\nComment what we should build next. The top comment gets built. No house yet? Comment MOVE IN.\n\n#kinsburg #citybuilder #isometric #cozygames #buildingtogether`,
    coverBg: await thumbStill(page, tmp, `E${NN}`, { target: buys[0]?.target ?? square, zoom: buys.length ? 3.4 : 1.4, y: 0.72, rings: buys.map((b) => b.target) }),
    coverHtml: `<div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;color:${C.white};font-weight:900;text-transform:uppercase;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div class="ep-banner" style="font-size:92px;text-shadow:none">Kinsburg</div><div class="ep-pill" style="font-size:46px;text-shadow:none">Episode ${N}</div>
  <div style="font-size:${buys.length ? 104 : 96}px;line-height:1.02;margin-top:20px;text-wrap:balance">${buys.length ? `We built ${esc(aOrAn(buys[0].label))} <span style="color:${C.gold}">${esc(buys[0].label.toLowerCase())}</span>` : `Saving up: <span style="color:${C.gold}">${usd(T.after)}</span>`}</div></div>`,
  });
  return { episode: N, built: buys.map((b) => b.label), after: T.after };
}


// ── City tour: "Every follower who comments MOVE IN gets a house in this city" ──
// Made like Keystone City's tour (own.ur.property): Jadie says the hook, then music and big text tour
// the live city: the resident counter, three streets with every resident's name tag (the newest with
// its open lots), the free villas and skyscrapers left, the resident card that's coming, what comments
// built, a thank-you over every home, and an end card. Every cut lands on a bar of the music.
//   npm run reel:launch -- --only TR --url https://kinsburg.com        (add --stills for a quick look)
async function reelTour({ tmp, page, R }) {
  const town = await page.evaluate(() => fetch('/api/city/town.json').then((r) => r.json()));
  const n = R.length, next = n + 1;
  const homes = town?.homes ?? { villa: { limit: 100, taken: 0 }, skyscraper: { limit: 100, taken: 0 } };
  const left = { villa: homes.villa.limit - homes.villa.taken, skyscraper: homes.skyscraper.limit - homes.skyscraper.taken };
  const FOUNDING = 1000;
  const byNum = [...R].sort((a, b) => a.number - b.number);

  // streets in move-in order: the founders' street opens the reel, then two more, ending on the newest
  const streetOf = (r) => (r.address ?? '').replace(/^\d+\s+/, '');
  const groups = new Map();
  for (const r of byNum) if (streetOf(r)) (groups.get(streetOf(r)) ?? groups.set(streetOf(r), []).get(streetOf(r))).push(r);
  const streets = [...groups].map(([name, rs]) => ({ name, rs, lo: rs[0].number, hi: rs.at(-1).number })).sort((a, b) => a.lo - b.lo);
  const founders = streets[0];
  const newest = streets.find((s) => s.rs.some((r) => r.number === byNum.at(-1).number));
  const middle = [...streets.filter((s) => s !== founders && s !== newest)].sort((a, b) => b.rs.length - a.rs.length);
  const tourStreets = [middle.find((s) => s.lo < (newest?.lo ?? Infinity) / 2) ?? middle[0], middle.find((s) => s.lo > (newest?.lo ?? 0) / 2) ?? middle[1], newest].filter(Boolean);
  const villas = byNum.filter((r) => r.home === 'villa'), skys = byNum.filter((r) => r.home === 'skyscraper');
  const builds = (town?.builds ?? []).map((b) => ({ ...b, id: `build:${b.id}`, label: kindLabel(b.kind), emoji: kindEmoji(b.kind), city: b.by === (town.account ?? 'kinsburgtown') }));
  const OPEN = [0, 1, 2, 3, 4, 5].map((k) => `open:${k}`);

  // where everything is, and cameras that frame a group of it
  const pos = Object.fromEntries(await page.evaluate((ids) => ids.map((id) => [id, window.kinsburgReel.where(id)]), [...R.map((r) => r.id), ...builds.map((b) => b.id), ...OPEN]));
  const frame = (ids, { frac = 0.82, min = 0.5, max = 3, y = 0.62 } = {}) => {
    const ps = ids.map((id) => pos[id]).filter(Boolean);
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const zoom = Math.max(min, Math.min(max, (W * frac) / Math.max(160, x1 - x0), (H * 0.36) / Math.max(120, y1 - y0)));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return { target: `xy:${cx.toFixed(1)},${cy.toFixed(1)}`, zoom, y, cx, cy };
  };
  // is this home inside the frame (below the headline, above Instagram's caption), at zoom × k
  const screen = (id, f, k = 1) => { const p = pos[id], z = f.zoom * k; return p ? { x: W / 2 + (p.x - f.cx) * z, y: f.y * H + (p.y - f.cy) * z } : null; };
  const onScreen = (id, f, k = 1, top = 760) => {
    const q = screen(id, f, k);
    return !!q && q.x > 50 && q.x < W - 50 && q.y > top && q.y < 1560;
  };
  // the biggest bunch of homes within `r` world px of each other (villas and skyscrapers are spread out)
  const cluster = (list, r = 420) => list.map((a) => list.filter((b) => Math.hypot(pos[a.id].x - pos[b.id].x, pos[a.id].y - pos[b.id].y) < r)).sort((a, b) => b.length - a.length)[0] ?? list;
  const drift = (f, d, k = 1.08) => [{ t: 0, target: f.target, zoom: f.zoom, y: f.y }, { t: d, target: f.target, zoom: f.zoom * k, y: f.y }];
  const tag = (r, from, to) => ({ id: r.id, num: `#${r.number}`, text: `@${r.handle}`, from, to });
  const all0 = frame(R.map((r) => r.id), { frac: 1.0, min: 0.3, y: 0.55 });
  const all = { ...all0, zoom: all0.zoom * 1.2 }; // a little closer than the whole city, so it fills the frame

  // ── timeline in bars of the music ──
  const sections = [];
  // each section: its shortest length in bars, the shot, the on-screen text, and what Jadie says over it
  const S = (key, bars, build, text, line) => sections.push({ key, bars, build, text, line });
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const hookF = frame(founders.rs.map((r) => r.id), { frac: 0.95, min: 1.6, max: 2.8, y: 0.7 });
  // homes in the first frame wear their name tags from frame one (it's also where the loop lands); the
  // ones nearest the middle, so the stacked tags stay under the headline
  const hookTags = R.filter((r) => onScreen(r.id, hookF, 1.1, 900)).sort((a, b) => Math.abs(screen(a.id, hookF).x - W / 2) - Math.abs(screen(b.id, hookF).x - W / 2)).slice(0, 16);
  S('hook', 2, (d) => ({ keys: drift(hookF, d, 1.1), labels: hookTags.map((r) => tag(r, -1, d + 1)) }),
    { kick: 'Kinsburg · city tour', head: 'Every follower gets a <b>house</b> in this city.', sub: 'Follow + comment MOVE IN' },
    { text: 'Every follower who comments MOVE IN gets a house in this city.', say: 'Every follower who comments, move in, gets a house in this city.' });
  S('count', 2, (d) => ({
    keys: [{ t: 0, target: hookF.target, zoom: hookF.zoom * 1.1, y: hookF.y }, { t: d * 0.7, target: all.target, zoom: all.zoom, y: all.y }, { t: d, target: all.target, zoom: all.zoom * 1.03, y: all.y }],
    rings: byNum.map((r, i) => ({ id: r.id, from: 0.35 + (i / n) * (d * 0.75) })),
  }), { head: `It started with 3 people.<br>Now <b>${n}</b> live here.`, sub: 'and it’s growing every day' },
    { text: `It started with 3 people. Now ${n} people live in this city.`, say: `It started with three people. Now, ${sayNumber(n)} people live in this city.` });
  for (const [i, st] of tourStreets.entries()) {
    const isNew = st === newest;
    const f = frame([...st.rs.map((r) => r.id), ...(isNew ? OPEN.slice(0, 3) : [])], { frac: 0.86, min: 1.0, max: 2.6 });
    S(`street${i}`, 2, (d) => ({
      keys: drift(f, d),
      labels: [...st.rs.filter((r) => onScreen(r.id, f, 1.08)).map((r) => tag(r, 0.15, d + 1)),
        ...(isNew ? OPEN.filter((id) => onScreen(id, f, 1.08)).map((id, k) => ({ id, num: `#${next + Number(id.slice(5))}`, text: 'OPEN', from: 0.6 + k * 0.15, to: d + 1 })) : [])],
      rings: isNew ? OPEN.filter((id) => onScreen(id, f, 1.08)).map((id, k) => ({ id, from: 0.6 + k * 0.15 })) : [],
    }), {
      head: `<b>${esc(st.name)}</b>`,
      sub: isNew ? `The newest street · house #${next} is open` : `${st.rs.length} residents, from #${st.lo} to #${st.hi} · all moved in`,
      chips: tourStreets.map((s) => s.name), on: i,
    }, isNew
      ? { text: `And ${st.name}, our newest street. House #${next} is still open.`, say: `And ${st.name}, our newest street. House number ${sayNumber(next)} is still open.` }
      : i === 0 ? { text: `This is ${st.name}. ${st.rs.length} neighbours, every house taken.`, say: `This is ${st.name}. ${cap(sayNumber(st.rs.length))} neighbours, every house taken.` }
      : { text: `${st.name}. ${st.rs.length} more.`, say: `${st.name}. ${cap(sayNumber(st.rs.length))} more.` });
  }
  const homeShot = (list, kind) => {
    const f = frame(cluster(list).map((r) => r.id), { frac: 0.7, min: 1.2, max: 2.8 });
    return (d) => ({ keys: drift(f, d), labels: list.filter((r) => onScreen(r.id, f, 1.08)).map((r) => ({ id: r.id, num: kind, text: `@${r.handle}`, from: 0.15, to: d + 1 })), rings: list.map((r) => ({ id: r.id, from: 0.1 })) });
  };
  if (villas.length) S('villa', 1.5, homeShot(villas, 'Villa'), { head: `The first 100 villas are <b>free</b>`, sub: `${left.villa} left · comment VILLA` },
    { text: `The first 100 villas are free. ${left.villa} left. Comment VILLA.`, say: `The first hundred villas are free. ${cap(sayNumber(left.villa))} left. Comment, villa.` });
  if (skys.length) S('sky', 1.5, homeShot(skys, 'Skyscraper'), { head: `And 100 free <b>skyscrapers</b>`, sub: `${left.skyscraper} left · comment SKYSCRAPER` },
    { text: `Skyscrapers too. ${left.skyscraper} left. Comment SKYSCRAPER.`, say: `Skyscrapers too. ${cap(sayNumber(left.skyscraper))} left. Comment, skyscraper.` });
  const squareF = frame(founders.rs.map((r) => r.id), { frac: 1.3, min: 0.9, max: 1.4 });
  S('card', 1.5, (d) => ({ keys: drift(squareF, d, 1.06) }),
    { head: 'Coming soon: your <b>resident card</b>', sub: `The first ${FOUNDING.toLocaleString('en-US')} residents become Founding Residents`, card: true },
    { text: `Soon, every resident gets a resident card. The first ${FOUNDING.toLocaleString('en-US')} become founding residents.`, say: `Soon, every resident gets a resident card. The first ${sayNumber(FOUNDING)} become founding residents.` });
  if (builds.length) {
    // builds stand all over the city: one shot per bunch of them (at most two), under one headline
    const rest = [...builds], bunches = [];
    while (rest.length && bunches.length < 2) {
      const b = cluster(rest, 520);
      bunches.push(b);
      for (const x of b) rest.splice(rest.indexOf(x), 1);
    }
    const text = { head: 'You asked. <b>We built it.</b>', sub: 'The top comment gets built' };
    // "You asked for a stadium, a shop and a tower. So we built them."
    const asked = builds.filter((b) => !b.city).slice(0, 3).map((b) => `${aOrAn(b.label)} ${b.label.toLowerCase()}`);
    const list = asked.length > 1 ? `${asked.slice(0, -1).join(', ')} and ${asked.at(-1)}` : asked[0];
    const line = asked.length ? { text: `You asked for ${list}. So we built ${asked.length > 1 ? 'them' : 'it'}.` } : { text: 'You asked. We built it.' };
    for (const [k, bunch] of bunches.entries()) {
      const f = frame(bunch.map((b) => b.id), { frac: 0.62, min: 1.2, max: 2.4, y: 0.66 });
      S(`builds${k}`, bunches.length > 1 ? 1 : 2, (d) => ({
        keys: drift(f, d),
        labels: builds.filter((b) => onScreen(b.id, f, 1.08)).map((b, j) => ({ id: b.id, text: `${b.emoji} ${b.label}`, sub: b.city ? 'the city’s own pick' : `asked by @${b.by}`, from: 0.15 + j * 0.2, to: d + 1 })),
        rings: bunch.map((b, j) => ({ id: b.id, from: 0.15 + j * 0.2 })),
      }), text, k === 0 ? line : null);
    }
  }
  // thank you: a slow pan along the whole city, every home ringed
  const panZ = all0.zoom * 2.0, span = (Math.max(...R.map((r) => pos[r.id]?.x ?? 0)) - Math.min(...R.map((r) => pos[r.id]?.x ?? 0))) / 2 - W / (2 * panZ);
  S('thanks', 1.5, (d) => ({
    keys: [{ t: 0, target: `xy:${(all.cx - Math.max(0, span)).toFixed(1)},${all.cy.toFixed(1)}`, zoom: panZ, y: 0.55 }, { t: d, target: `xy:${(all.cx + Math.max(0, span)).toFixed(1)},${all.cy.toFixed(1)}`, zoom: panZ, y: 0.55 }],
    rings: byNum.map((r) => ({ id: r.id, from: -1 })),
  }), { head: 'Thank you, <b>residents</b>', sub: 'Every name on its own home. We keep building.' },
    { text: 'To every resident: thank you. We keep building.' });
  S('end', 2, (d) => ({ keys: drift(all, d, 1.06), rings: [{ id: 'open:0', from: 0.3 }] }),
    { head: 'Follow + comment <b>MOVE IN</b>', sub: 'Comment what we should build next', list: true },
    { text: 'Follow, and comment MOVE IN. Then tell us what to build next.', say: 'Follow, and comment, move in. Then tell us what to build next.' });

  // ── Jadie narrates every section; each line starts on its section's first bar ──
  const spoken = sections.filter((sc) => sc.line);
  const raw = await narrate(tmp, 'TR', spoken.map((sc) => ({ ...sc.line, gap: 0.35 })), JADIE_VOICE);
  const LEAD = 0.12, TAIL = 0.55; // a beat after the cut before he speaks; room after his last word
  spoken.forEach((sc, k) => (sc.said = raw.lines[k]));
  // This tour is voice only (no music), so each shot lasts about as long as Jadie's line: a short beat
  // after it, and never less than the time it takes to read the screen. With MUSIC on, the shots are
  // stretched to whole bars of the music instead.
  const MUSIC = false;
  const MIN_SEC = { hook: 3.2, count: 3.6, villa: 3.0, sky: 3.0, card: 3.4, thanks: 2.6, end: 3.6 };
  const minSec = (sc) => MIN_SEC[sc.key] ?? (sc.key.startsWith('street') ? 2.8 : sc.key.startsWith('builds') ? 1.8 : 2.6);
  if (!MUSIC) {
    for (const sc of sections) sc.bars = minSec(sc) / BAR;
    for (const [k, sc] of spoken.entries()) {
      const i = sections.indexOf(sc), j = k + 1 < spoken.length ? sections.indexOf(spoken[k + 1]) : sections.length;
      const need = LEAD + (sc.said.end - sc.said.start) + 0.45;
      const have = sections.slice(i, j).reduce((a, x) => a + x.bars, 0) * BAR;
      if (have < need) sections[j - 1].bars += (need - have) / BAR;
    }
  }
  // stretch sections (in half bars) until each line fits before the next one starts
  if (MUSIC) for (const [k, sc] of spoken.entries()) {
    const i = sections.indexOf(sc), j = k + 1 < spoken.length ? sections.indexOf(spoken[k + 1]) : sections.length;
    const need = LEAD + (sc.said.end - sc.said.start) + TAIL;
    const have = sections.slice(i, j).reduce((a, x) => a + x.bars, 0) * BAR;
    if (have < need) sections[j - 1].bars += Math.ceil((need - have) / (BAR / 2)) / 2;
  }
  // whole 4-bar phrases, so the music loops cleanly: the spare half bars go to the sections from the
  // end backwards, a little each, so no one shot drags
  const used = sections.reduce((a, x) => a + x.bars, 0);
  const total = MUSIC ? Math.ceil(used / 4) * 4 : used;
  if (MUSIC) for (let spare = total - used, i = sections.length - 1; spare > 0; i = i > 1 ? i - 1 : sections.length - 1) { sections[i].bars += 0.5; spare -= 0.5; }
  const D = total * BAR, xf = 0.2;
  let t = 0;
  for (const sc of sections) { sc.from = t; t += sc.bars * BAR; sc.to = t; }
  const hookBars = sections[0].bars;
  log(`tour: ${sections.map((sc) => `${sc.key} ${(sc.bars * BAR).toFixed(1)} s${sc.said ? ` (says ${(sc.said.end - sc.said.start).toFixed(1)} s)` : ''}`).join(', ')} = ${D.toFixed(1)} s`);

  // lay each spoken line at its section's start (cut from the one narration, so the voice stays even)
  const voWav = join(tmp, 'TR-vo-placed.wav');
  const parts = spoken.map((sc, k) => {
    const at = sc.from + (sc.key === 'hook' ? 0.05 : LEAD), a = Math.max(0, sc.said.start - 0.03), b = sc.said.end + 0.12;
    return { k, at, a, b, shift: at - sc.said.start };
  });
  await run(FFMPEG, ['-hide_banner', '-y', '-i', raw.wav, '-filter_complex',
    parts.map((x) => `[0]atrim=${x.a.toFixed(3)}:${x.b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=${(x.b - x.a - 0.06).toFixed(3)}:d=0.06,adelay=delays=${Math.round(x.at * 1000)}:all=1[p${x.k}]`).join(';')
      + `;${parts.map((x) => `[p${x.k}]`).join('')}amix=inputs=${parts.length}:normalize=0,apad,atrim=0:${D.toFixed(3)}[o]`,
    '-map', '[o]', '-ar', '48000', '-ac', '1', voWav]);
  const v = { wav: voWav, duration: D, lines: parts.map((x) => ({ ...raw.lines[x.k], start: raw.lines[x.k].start + x.shift, end: raw.lines[x.k].end + x.shift })) };

  const shots = [];
  for (const [i, sc] of sections.entries()) {
    const d = sc.to - sc.from + (i < sections.length - 1 ? xf : 0);
    const spec = { duration: d, ease: 'sine', hours: [{ t: 0, h: args.hour ? Number(args.hour) : 20.6 }], ...sc.build(d) };
    if (args.stills) {
      for (const f of [0.05, 0.5, 0.95]) {
        const missing = await page.evaluate((s) => window.kinsburgReel.setScript(s), spec);
        if (missing.length) throw new Error(`${sc.key}: not found: ${missing.join(', ')}`);
        const url = await page.evaluate((tt) => window.kinsburgReel.captureFrame(tt, 'image/jpeg', 0.9), d * f);
        writeFileSync(join(args.stills === true ? tmp : String(args.stills), `TR-${String(i).padStart(2, '0')}-${sc.key}-${Math.round(f * 100)}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
      }
      continue;
    }
    shots.push({ file: await film(page, tmp, `TR-${i}`, spec), at: sc.from });
  }

  // ── overlays: the shade, then each section's text ──
  const overlays = [{ png: await png(join(tmp, 'TR-shade.png'), '<div class="tr-shade"></div>'), from: 0, to: D, noFade: true }];
  for (const [i, sc] of sections.entries()) {
    const x = sc.text;
    if (i > 0 && sections[i - 1].text === x) { overlays.at(-1).to = sc.to + (i < sections.length - 1 ? 0.05 : 0); continue; }
    let html = `<div class="tr-top">${x.kick ? `<div class="tr-kick">${esc(x.kick)}</div>` : '<div class="tr-kick">Kinsburg</div>'}<div class="tr-head">${x.head}</div>${x.sub ? `<div class="tr-sub">${esc(x.sub)}</div>` : ''}</div>`;
    if (x.chips) html += `<div class="tr-chips">${x.chips.map((c, k) => `<i class="${k === x.on ? 'on' : ''}">${esc(c)}</i>`).join('')}</div>`;
    if (x.card) {
      const pct = Math.min(100, (n / FOUNDING) * 100).toFixed(1);
      html += `<div class="tr-mid"><div class="tr-id"><div class="tr-id-top"><span>Kinsburg</span><span>Resident card</span></div>
        <div class="tr-id-body"><div class="tr-id-pic">🏡</div><div><small>Resident</small><div class="tr-id-name">@your_name</div>
        <div class="tr-id-grid"><div><small>House</small><b>#${next}</b></div><div><small>Since</small><b>${new Date().getUTCFullYear()}</b></div><div><small>Street</small><b>${esc(newest.name)}</b></div></div></div></div>
        <div class="tr-id-foot"><span class="tr-id-mrz">KB&lt;&lt;YOUR&lt;NAME&lt;&lt;${String(next).padStart(4, '0')}&lt;&lt;</span><span class="tr-id-badge">Founding resident</span></div></div>
        <div class="tr-prog"><div><i style="width:${pct}%"></i></div><span><b>${n.toLocaleString('en-US')}</b> / ${FOUNDING.toLocaleString('en-US')} founding residents</span></div></div>`;
    }
    if (x.list) {
      html += `<div class="tr-mid" style="top:700px"><div class="tr-list">
        <div class="tr-row"><em>🏠</em><div><b>House</b><span>Free · comment MOVE IN</span></div><u>#${next} open</u></div>
        <div class="tr-row"><em>🏝️</em><div><b>Villa</b><span>Free for the first 100 · comment VILLA</span></div><u class="gold">${left.villa} left</u></div>
        <div class="tr-row"><em>🏙️</em><div><b>Skyscraper</b><span>Free for the first 100 · comment SKYSCRAPER</span></div><u class="gold">${left.skyscraper} left</u></div>
        <div class="tr-row"><em>💬</em><div><b>Your idea</b><span>The top comment gets built</span></div><u class="gold">Comment</u></div>
        </div><div class="tr-btn">Follow + comment MOVE IN</div></div>`;
    }
    const card = x.card || x.list;
    overlays.push({ png: await png(join(tmp, `TR-text-${i}.png`), html), from: i === 0 ? 0 : sc.from + 0.05, to: sc.to + (i < sections.length - 1 ? 0.05 : 0), fade: i === 0 ? 0.01 : 0.18, ...(card ? { dim: true } : {}) });
    if (sc.key === 'count') {
      // the counter ticks from 3 to today's number while the rings light up
      const steps = 34, dur = (sc.to - sc.from) * 0.75, seq = [];
      for (let k = 0; k <= steps; k++) {
        const u = k / steps, val = Math.round(3 + (n - 3) * (1 - (1 - u) ** 2));
        seq.push({ file: await png(join(tmp, `TR-count-${k}.png`), `<div class="tr-count"><div><span>Residents so far</span><b>${val}</b></div></div>`), d: k === steps ? sc.to - sc.from - dur : dur / steps });
      }
      overlays.push({ seq, from: sc.from + 0.35, to: sc.to - 0.05, fade: 0.15 });
    }
  }
  if (args.stills) {
    // a quick look: each section's text over its three stills
    const dir = args.stills === true ? tmp : String(args.stills);
    for (const [i, sc] of sections.entries()) {
      let j = i;
      while (j > 0 && !overlays.some((o) => o.png?.endsWith(`TR-text-${j}.png`))) j--;
      const text = overlays.find((o) => o.png?.endsWith(`TR-text-${j}.png`)).png;
      for (const f of [5, 50, 95]) {
        const still = join(dir, `TR-${String(i).padStart(2, '0')}-${sc.key}-${f}.jpg`);
        await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', still, '-i', overlays[0].png, '-i', text, '-filter_complex', '[0][1]overlay[a];[a][2]overlay', '-q:v', '3', still.replace('.jpg', '-text.jpg')]);
      }
    }
    log(`stills in ${dir}`);
    return;
  }

  const music = MUSIC ? writeMusic(join(tmp, 'TR-music.wav'), { bars: total, dropBar: Math.round(hookBars) }) : { file: join(tmp, 'TR-silence.wav') };
  if (!MUSIC) await run(FFMPEG, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', D.toFixed(3), music.file]);
  const streetList = tourStreets.map((s) => s.name).join(', ');
  await finish(tmp, 'TR', {
    xf, shots, overlays, voice: v, duration: D, music: music.file, musicVolume: 1, rewriteCaption: true,
    caption: `Every follower who comments MOVE IN gets a house in this city. 🏡\n\nKinsburg started with 3 people. Now ${n} live here, every one of them a real person on Instagram with their name on their own home. Today's tour: ${streetList}.\n\n🏠 Houses: free, house #${next} is open\n🏝️ Villas: free for the first 100, ${left.villa} left (comment VILLA)\n🏙️ Skyscrapers: free for the first 100, ${left.skyscraper} left (comment SKYSCRAPER)\n${builds.length ? `🏗️ Built because you asked: ${builds.filter((b) => !b.city).map((b) => `${b.emoji} ${b.label} (@${b.by})`).join(', ')}\n` : ''}\nComing soon: your own Kinsburg resident card. The first ${FOUNDING.toLocaleString('en-US')} residents become Founding Residents.\n\n👉 Follow and comment MOVE IN to get your house.\n💬 Comment what we should build next. The top comment gets built.\n\nKinsburg is a community city project. Houses are virtual and free.\n\n#kinsburg #citybuilder #virtualcity #isometric #cozygames #buildwithme`,
    coverBg: await thumbStill(page, tmp, 'TR', { target: hookF.target, zoom: hookF.zoom, y: 0.74, hour: 20.6, labels: R.filter((r) => onScreen(r.id, { ...hookF, y: 0.74 }, 1, 1180)).slice(0, 12).map((r) => tag(r, -1, 2)) }),
    coverHtml: `<div class="tr-shade" style="height:1100px"></div><div style="position:absolute;left:60px;right:60px;top:${THUMB.top}px;text-align:center;color:${C.white};font-weight:900;text-shadow:0 4px 0 rgba(11,20,48,.55),0 10px 34px rgba(11,20,48,.6)">
  <div style="font-size:108px;line-height:1">Every follower</div>
  <div style="font-size:150px;line-height:1;color:${C.gold};letter-spacing:-.025em;margin:14px 0 18px;white-space:nowrap">gets a house</div>
  <div style="display:inline-block;background:${C.gold};color:${C.ink};border-radius:999px;padding:14px 40px;font-size:60px;text-shadow:none">comment MOVE IN</div></div>`,
  });
  return { streets: tourStreets.map((s) => s.name), villasLeft: left.villa, skysLeft: left.skyscraper };
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
  for (const [id, make] of [['A', reelA], ['B', reelB], ['C', reelC], ['D', reelD], ['T1', reelT1], ['L1', reelL1], ['T2', reelT2], ['T3', reelT3], ['E', reelE], ['TR', reelTour]]) {
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
