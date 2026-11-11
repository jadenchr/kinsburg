#!/usr/bin/env node
// End-to-end test of the Kinsburg Worker, fully local (no Cloudflare / Meta / Stripe accounts):
//   npm run test:worker
// 1. builds the site, seeds a local D1 with demo residents
// 2. starts a mock Instagram Graph API and `wrangler dev --test-scheduled`
// 3. checks: city API decodes into a valid city, admin join, comment poller (MOVE IN variants,
//    duplicates, pagination, bad handles), signed + badly signed Stripe events, Meta webhook signature.
import { createServer } from 'node:http';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cityDataFromCompact, decodeShards, planRequests } from '../../shared/residents-format.mjs';
import { validateCityData } from '../../shared/city-layout.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKER_PORT = 8797;
const MOCK_PORT = 8798;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const SECRETS = {
  ADMIN_TOKEN: 'test-admin',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
  IG_ACCESS_TOKEN: 'test-ig-token',
  IG_USER_ID: '17840000000000000',
  IG_APP_SECRET: 'test-app-secret',
  IG_VERIFY_TOKEN: 'test-verify',
};
const VARS = {
  IG_API_BASE: `http://127.0.0.1:${MOCK_PORT}/v27.0`,
  EDGE_CACHE: 'false',
  STRIPE_PERKS: JSON.stringify({ plink_star: 'star', plink_gold: 'goldRoof' }),
};

let failures = 0;
const ok = (cond, msg, extra) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}${extra !== undefined && !cond ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!cond) failures++;
};

// ── Mock Instagram Graph API ─────────────────────────────────────────────────
const COMMENTS = {
  m1: [
    [
      { id: 'c1', text: 'MOVE IN', username: 'new_person1' },
      { id: 'c2', text: 'move in 🏠🏠', username: 'Second.Person' },
      { id: 'c3', text: 'nice city!', username: 'lurker' },
    ],
    [
      { id: 'c4', text: 'movein!!', username: 'third_person' },
      { id: 'c5', text: 'Move   In please', username: 'bad..handle' },
    ],
  ],
  m2: [[{ id: 'c6', text: 'MOVE IN', username: 'new_person1' }]], // same person again
};
let mockHits = 0;
let published = null;
const mock = createServer((req, res) => mockHandler(req, res).catch((e) => { console.log('  mock error:', e); res.writeHead(500); res.end(); }));
async function mockHandler(req, res) {
  mockHits++;
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    for (const [k, v] of new URLSearchParams(raw)) u.searchParams.set(k, v);
  }
  const send = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (u.searchParams.get('access_token') !== SECRETS.IG_ACCESS_TOKEN && req.headers.authorization !== `Bearer ${SECRETS.IG_ACCESS_TOKEN}`) {
    return send({ error: { message: 'bad token' } }, 401);
  }
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}/media` && req.method === 'POST') {
    published = { container: Object.fromEntries(u.searchParams) };
    return send({ id: 'cont1' });
  }
  if (u.pathname === '/v27.0/cont1') return send({ status_code: 'FINISHED' });
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}/media_publish`) {
    published.creation_id = u.searchParams.get('creation_id');
    return send({ id: 'pub1' });
  }
  if (u.pathname === '/v27.0/pub1') return send({ permalink: 'https://instagram.com/reel/test' });
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}/media`) return send({ data: [{ id: 'm1' }, { id: 'm2' }] });
  const m = /^\/v27\.0\/(m\d)\/comments$/.exec(u.pathname);
  if (m && COMMENTS[m[1]]) {
    const pages = COMMENTS[m[1]];
    const i = u.searchParams.get('after') ? Number(u.searchParams.get('after')) : 0;
    const next = i + 1 < pages.length;
    return send({ data: pages[i], paging: next ? { cursors: { after: String(i + 1) }, next: 'more' } : {} });
  }
  send({ error: { message: 'not found ' + u.pathname } }, 404);
}

// ── helpers ──────────────────────────────────────────────────────────────────
const admin = (path, body) =>
  fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${SECRETS.ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function loadCity() {
  const manifest = await (await fetch(`${BASE}/api/city/manifest.json`)).json();
  const parts = [];
  for (const r of planRequests(manifest, `${BASE}/api/city`)) {
    const b = await (await fetch(r.url)).json();
    parts.push(...(r.kind === 'pack' ? b : [b]));
  }
  const data = cityDataFromCompact(manifest, decodeShards(manifest, parts));
  return { manifest, data };
}

function stripeEvent(id, session, secret = SECRETS.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify({ id, type: 'checkout.session.completed', data: { object: session } });
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(`${BASE}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' }, body: raw });
}

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for ' + url);
}

// ── run ──────────────────────────────────────────────────────────────────────
const state = mkdtempSync(join(tmpdir(), 'kinsburg-e2e-'));
const devVars = join(root, '.dev.vars');
let wrangler;
try {
  console.log('building site…');
  execFileSync('npx', ['vite', 'build'], { cwd: root, stdio: 'ignore' });
  console.log('seeding local D1 (50 demo residents)…');
  execFileSync('node', ['scripts/seed-d1.mjs', 'demo', '50', '--persist-to', state], { cwd: root, stdio: 'ignore' });
  writeFileSync(devVars, Object.entries({ ...SECRETS, ...VARS }).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n');

  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--persist-to', state, '--test-scheduled'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  let wlog = '';
  wrangler.stdout.on('data', (d) => (wlog += d));
  wrangler.stderr.on('data', (d) => (wlog += d));
  wrangler.on('exit', (c) => c && console.log('wrangler exited', c, '\n' + wlog.slice(-2000)));
  await waitFor(`${BASE}/api/city/manifest.json`);

  console.log('\ncity API');
  let { manifest, data } = await loadCity();
  ok(manifest.count === 50 && data.residents.length === 50, 'manifest + shards decode to 50 residents', manifest.count);
  try { validateCityData(data); ok(true, 'decoded city passes validateCityData'); } catch (e) { ok(false, 'decoded city passes validateCityData', String(e)); }
  ok((await fetch(`${BASE}/`)).status === 200, 'static site served at /');

  console.log('\nadmin');
  ok((await admin('/admin/stats')).status === 200, 'stats with token');
  ok((await fetch(`${BASE}/admin/stats`)).status === 401, 'stats without token → 401');
  let r = await admin('/admin/join', { handle: '@Admin.Added' });
  let j = await r.json();
  ok(r.status === 200 && j.status === 'joined' && j.number === 51, 'admin join → resident #51', j);
  j = await (await admin('/admin/join', { handle: 'admin.added' })).json();
  ok(j.status === 'exists', 'second join is a no-op', j);
  ok((await admin('/admin/join', { handle: 'no spaces allowed' })).status === 400, 'invalid handle rejected');

  console.log('\ncomment poller (cron)');
  const before = mockHits;
  r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('7,22,37,52 * * * *')}`);
  ok(r.status === 200, 'scheduled handler ran');
  ok(mockHits > before, 'poller called the Instagram API', mockHits - before);
  ({ data } = await loadCity());
  const ids = new Set(data.residents.map((x) => x.id));
  for (const h of ['new_person1', 'second.person', 'third_person']) ok(ids.has(h), `joined @${h}`);
  ok(!ids.has('lurker'), 'comment without MOVE IN ignored');
  ok(!ids.has('bad..handle'), 'invalid handle not joined');
  ok(data.residents.length === 54, 'exactly 3 new residents (duplicate comment joined once)', data.residents.length);
  try { validateCityData(data); ok(true, 'city still valid after joins'); } catch (e) { ok(false, 'city still valid after joins', String(e)); }
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('7,22,37,52 * * * *')}`);
  ({ data } = await loadCity());
  ok(data.residents.length === 54, 'second poll adds nobody (comments remembered)', data.residents.length);

  console.log('\nStripe webhook');
  r = await stripeEvent('evt_1', { id: 'cs_1', payment_status: 'paid', payment_link: 'plink_gold', custom_fields: [{ key: 'instagramhandle', text: { value: '@Third_Person' } }] });
  ok(r.status === 200, 'signed event accepted', r.status);
  ({ data } = await loadCity());
  ok(data.residents.find((x) => x.id === 'third_person')?.perks.includes('goldRoof'), 'gold roof perk applied to @third_person');
  r = await stripeEvent('evt_1', { id: 'cs_1', payment_status: 'paid', payment_link: 'plink_gold', custom_fields: [{ key: 'instagramhandle', text: { value: 'third_person' } }] });
  j = await r.json();
  ok(r.status === 200 && j.duplicate, 'repeated event is idempotent', j);
  r = await stripeEvent('evt_2', { id: 'cs_2', payment_status: 'paid', payment_link: 'plink_star', custom_fields: [{ key: 'instagramhandle', text: { value: 'brand.new.buyer' } }] });
  ({ data } = await loadCity());
  const buyer = data.residents.find((x) => x.id === 'brand.new.buyer');
  ok(r.status === 200 && buyer?.perks.includes('star'), 'buyer who was not a resident is moved in with a star', buyer);
  r = await stripeEvent('evt_3', { id: 'cs_3', payment_status: 'paid', payment_link: 'plink_star', custom_fields: [{ key: 'instagramhandle', text: { value: 'x' } }] }, 'whsec_wrong');
  ok(r.status === 400, 'badly signed event rejected', r.status);
  r = await stripeEvent('evt_4', { id: 'cs_4', payment_status: 'paid', payment_link: 'plink_star' }, SECRETS.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
  ok(r.status === 400, 'stale timestamp rejected', r.status);

  console.log('\nInstagram webhook');
  r = await fetch(`${BASE}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${SECRETS.IG_VERIFY_TOKEN}&hub.challenge=12345`);
  ok(r.status === 200 && (await r.text()) === '12345', 'verify handshake echoes challenge');
  r = await fetch(`${BASE}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  ok(r.status === 403, 'wrong verify token → 403', r.status);
  const hook = JSON.stringify({ object: 'instagram', entry: [{ id: SECRETS.IG_USER_ID, time: 1, changes: [{ field: 'comments', value: { id: 'c900', text: 'MOVE IN 🏡', from: { id: '1', username: 'via_webhook' }, media: { id: 'm1' } } }] }] });
  const hsig = 'sha256=' + createHmac('sha256', SECRETS.IG_APP_SECRET).update(hook).digest('hex');
  r = await fetch(`${BASE}/webhooks/instagram`, { method: 'POST', headers: { 'x-hub-signature-256': hsig, 'content-type': 'application/json' }, body: hook });
  ok(r.status === 200, 'signed comment webhook accepted', r.status);
  ({ data } = await loadCity());
  ok(data.residents.some((x) => x.id === 'via_webhook'), 'webhook commenter moved in');
  r = await fetch(`${BASE}/webhooks/instagram`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=00', 'content-type': 'application/json' }, body: hook });
  ok(r.status === 401 || r.status === 403, 'badly signed webhook rejected', r.status);

  console.log('\nReel hosting + publishing');
  const video = Buffer.alloc(200_000, 7);
  r = await fetch(`${BASE}/admin/media/reel-2026-11-11-test.mp4`, { method: 'PUT', body: video });
  ok(r.status === 401, 'upload without admin token → 401', r.status);
  r = await fetch(`${BASE}/admin/media/reel-2026-11-11-test.mp4`, { method: 'PUT', headers: { authorization: `Bearer ${SECRETS.ADMIN_TOKEN}` }, body: video });
  ok(r.status === 200, 'admin uploads a video', r.status);
  r = await fetch(`${BASE}/media/reel-2026-11-11-test.mp4`);
  const got = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && r.headers.get('content-type') === 'video/mp4' && got.equals(video), 'video served publicly, byte-identical, as video/mp4');
  ok((await fetch(`${BASE}/media/../wrangler.jsonc`)).status === 404, 'only reel files are served from /media');
  ok((await fetch(`${BASE}/admin/media/evil.html`, { method: 'PUT', headers: { authorization: `Bearer ${SECRETS.ADMIN_TOKEN}` }, body: 'x' })).status === 400, 'non-reel file names refused');
  const pubDir = mkdtempSync(join(tmpdir(), 'kinsburg-pub-'));
  writeFileSync(join(pubDir, 'reel-2026-11-11.mp4'), video);
  writeFileSync(join(pubDir, 'reel-2026-11-11.jpg'), Buffer.alloc(5000, 1));
  writeFileSync(join(pubDir, 'caption.txt'), 'Lights on, night 1. Comment MOVE IN.');
  const pubEnv = { ...process.env, KINSBURG_URL: BASE, ADMIN_TOKEN: SECRETS.ADMIN_TOKEN, IG_ACCESS_TOKEN: SECRETS.IG_ACCESS_TOKEN, IG_USER_ID: SECRETS.IG_USER_ID, IG_API_BASE: VARS.IG_API_BASE };
  const dry = execFileSync('node', ['scripts/reel/publish.mjs', '--date', '2026-11-11', '--out', pubDir, '--poll-seconds', '1'], { cwd: root, env: pubEnv, encoding: 'utf8' });
  ok(dry.includes('DRY RUN') && published === null, 'publish without --publish posts nothing');
  try {
    // async: the mock Instagram API lives in this process and must keep answering
    await promisify(execFile)('node', ['scripts/reel/publish.mjs', '--date', '2026-11-11', '--out', pubDir, '--poll-seconds', '1', '--publish'], { cwd: root, env: pubEnv, encoding: 'utf8' });
  } catch (e) {
    console.log('  publish stderr:', String(e.stderr).trim().split('\n').slice(0, 14).join('\n'));
  }
  ok(published?.container.media_type === 'REELS' && published.container.video_url === `${BASE}/media/reel-2026-11-11.mp4` && published.container.cover_url?.endsWith('.jpg') && published.creation_id === 'cont1', 'publish uploads, creates a REELS container with hosted URLs, then publishes it', published);
  rmSync(pubDir, { recursive: true, force: true });

  const st = await (await admin('/admin/stats')).json();
  console.log(`\nfinal: ${st.residents} residents, processed comments ${JSON.stringify(st.processedComments)}, stripe ${JSON.stringify(st.stripeEvents)}`);
} catch (err) {
  failures++;
  console.error('ERROR', err);
} finally {
  wrangler?.kill('SIGINT');
  mock.close();
  rmSync(devVars, { force: true });
  rmSync(state, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
