#!/usr/bin/env node
// Publish the daily Reel to Instagram (Content Publishing API, Instagram Login).
// SAFE BY DEFAULT: without --publish it only prints what it would do. Nothing is uploaded or posted.
//
//   node scripts/reel/publish.mjs                       # dry run for today's reel in out/
//   node scripts/reel/publish.mjs --publish             # upload to the Worker + post to Instagram
//   node scripts/reel/publish.mjs --date 2026-11-12 --publish
//   node scripts/reel/publish.mjs --video-url https://… --cover-url https://… --publish   # already hosted
//
// Env (GitHub Actions secrets/vars):
//   KINSBURG_URL     site base, e.g. https://kinsburg.com  (videos are hosted at <base>/media/<file>)
//   ADMIN_TOKEN      the Worker's admin token (for the upload)
//   IG_ACCESS_TOKEN  long-lived Instagram token for @kinsburgtown
//   IG_USER_ID       Instagram professional account id
//   IG_API_BASE      default https://graph.instagram.com/v27.0
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const opt = (k, def) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const log = (...a) => console.log('[publish]', ...a);

const PUBLISH = has('publish');
const DATE = opt('date', new Date().toISOString().slice(0, 10));
const OUT = resolve(ROOT, opt('out', 'out'));
const BASE = (opt('base', process.env.KINSBURG_URL) ?? '').replace(/\/+$/, '');
const IG_BASE = (process.env.IG_API_BASE ?? 'https://graph.instagram.com/v27.0').replace(/\/+$/, '');
const { ADMIN_TOKEN, IG_ACCESS_TOKEN, IG_USER_ID } = process.env;
const POLL_SECONDS = Number(opt('poll-seconds', '10'));
const POLL_LIMIT_SECONDS = Number(opt('timeout', '900'));

function fail(msg) {
  console.error('[publish] FAILED:', msg);
  process.exit(1);
}

// ── what to publish ──────────────────────────────────────────────────────────
const manifestPath = join(OUT, `reel-${DATE}.json`);
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const videoFile = manifest ? join(ROOT, manifest.video) : join(OUT, `reel-${DATE}.mp4`);
const coverFile = manifest ? join(ROOT, manifest.cover) : join(OUT, `reel-${DATE}.jpg`);
const caption = opt('caption', manifest?.caption ?? (existsSync(join(OUT, 'caption.txt')) ? readFileSync(join(OUT, 'caption.txt'), 'utf8').trim() : ''));
let videoUrl = opt('video-url');
let coverUrl = opt('cover-url');

if (!videoUrl && !existsSync(videoFile)) fail(`no video at ${videoFile} — run scripts/reel/record.mjs first, or pass --video-url`);
if (manifest?.probe && manifest.probe.ok === false) fail(`the recorded video failed the Instagram spec check: ${JSON.stringify(manifest.probe)}`);
if (caption.length > 2200) fail(`caption is ${caption.length} characters (Instagram max 2,200)`);
if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) fail('caption has more than 30 hashtags');

// ── helpers ──────────────────────────────────────────────────────────────────
async function upload(file) {
  const name = basename(file);
  const url = `${BASE}/admin/media/${name}`;
  const body = readFileSync(file);
  const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/octet-stream' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`upload ${name}: HTTP ${res.status} ${data.error ?? ''}`);
  // Instagram must be able to download it: check the public URL answers.
  const pub = `${BASE}/media/${name}`;
  const head = await fetch(pub, { method: 'HEAD' });
  if (!head.ok) fail(`uploaded ${name} but ${pub} answered HTTP ${head.status}`);
  log(`hosted ${name} (${(body.length / 1e6).toFixed(1)} MB) at ${pub}`);
  return pub;
}

async function ig(method, path, params = {}) {
  const url = new URL(`${IG_BASE}/${path}`);
  const init = { method };
  const all = { ...params, access_token: IG_ACCESS_TOKEN };
  if (method === 'GET') url.search = new URLSearchParams(all).toString();
  else init.body = new URLSearchParams(all);
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) fail(`${method} ${path}: HTTP ${res.status} ${data.error?.message ?? ''}`);
  return data;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// ── dry run ──────────────────────────────────────────────────────────────────
if (!PUBLISH) {
  log('DRY RUN: nothing will be uploaded or posted. Add --publish to do it for real.');
  log('video   ', videoUrl ?? `${videoFile} → PUT ${BASE || '<KINSBURG_URL>'}/admin/media/${basename(videoFile)}`);
  log('cover   ', coverUrl ?? (existsSync(coverFile) ? `${coverFile} → PUT ${BASE || '<KINSBURG_URL>'}/admin/media/${basename(coverFile)}` : '(none)'));
  log('step 1  ', `POST ${IG_BASE}/${IG_USER_ID ?? '<IG_USER_ID>'}/media  media_type=REELS share_to_feed=true video_url=… cover_url=… caption=(${caption.length} chars)`);
  log('step 2  ', `GET  ${IG_BASE}/<container>?fields=status_code  every ${POLL_SECONDS}s until FINISHED (max ${POLL_LIMIT_SECONDS}s)`);
  log('step 3  ', `POST ${IG_BASE}/${IG_USER_ID ?? '<IG_USER_ID>'}/media_publish  creation_id=<container>`);
  log('caption ↓\n' + caption);
  const missing = ['KINSBURG_URL', 'ADMIN_TOKEN', 'IG_ACCESS_TOKEN', 'IG_USER_ID'].filter((k) => (k === 'KINSBURG_URL' ? !BASE : !process.env[k]));
  if (missing.length) log('missing for a real run:', missing.join(', '));
  process.exit(0);
}

// ── real run ─────────────────────────────────────────────────────────────────
if (!IG_ACCESS_TOKEN || !IG_USER_ID) fail('IG_ACCESS_TOKEN and IG_USER_ID are required');
if (!videoUrl || (!coverUrl && existsSync(coverFile))) {
  if (!BASE || !ADMIN_TOKEN) fail('KINSBURG_URL and ADMIN_TOKEN are required to host the video (or pass --video-url)');
  videoUrl ??= await upload(videoFile);
  if (!coverUrl && existsSync(coverFile)) coverUrl = await upload(coverFile);
}

const params = { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' };
if (coverUrl) params.cover_url = coverUrl;
const { id: container } = await ig('POST', `${IG_USER_ID}/media`, params);
log('container', container, '— waiting for Instagram to process the video');

let waited = 0;
for (;;) {
  const { status_code: code, status } = await ig('GET', container, { fields: 'status_code,status' });
  if (code === 'FINISHED') break;
  if (code === 'ERROR' || code === 'EXPIRED') fail(`Instagram could not process the video: ${code} ${status ?? ''}`);
  if (waited >= POLL_LIMIT_SECONDS) fail(`still ${code} after ${waited}s`);
  await sleep(POLL_SECONDS);
  waited += POLL_SECONDS;
}

const { id: mediaId } = await ig('POST', `${IG_USER_ID}/media_publish`, { creation_id: container });
const { permalink } = await ig('GET', mediaId, { fields: 'permalink' });
log('published', mediaId, permalink ?? '');
