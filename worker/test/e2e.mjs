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
import { cityDataFromCompact, decodeShards, matchesMoveIn, planRequests } from '../../shared/residents-format.mjs';
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
  STRIPE_PERKS: JSON.stringify({ plink_star: 'star', plink_gold: 'goldRoof', plink_poster: 'poster', plink_owl: 'pet:owl' }),
  IG_DM_ENABLED: 'true',
  SIM_RANDOM_INCIDENTS: 'false',
  IG_REPLY_ENABLED: 'true', // production keeps routine replies off; the tests still exercise the pacing and pause
  IG_REPLY_MAX_PER_RUN: '4', // one queued reply + a welcome + two refused welcomes (= an account block) fit in one poll
  IG_REPLY_WINDOW_SECONDS: '1', // production paces replies per 10-minute window; the tests poll faster
  BUILD_HOUR_UTC: '24', // never build on the cron during tests: /admin/builds { run } builds on demand
  IG_CALLS_ENABLED: 'false',
  HOMES_LIMIT: '3',
  FOLLOWERS_CHECK_MINUTES: '0', // read the follower count on every poll in tests
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
  m2: [
    [
      { id: 'c6', text: 'MOVE IN', username: 'new_person1' }, // same person again
      // the vote post: residents vote by letter / candidate; third_person also gets chatty
      { id: 'v1', text: 'vote A', username: 'second.person' },
      { id: 'v2', text: 'B!', username: 'third_person' },
      { id: 'v3', text: 'A', username: 'third_person' }, // second vote: ignored
      { id: 'v4', text: 'A', username: 'lurker' }, // not a resident: ignored
      { id: 'v5', text: 'love this town', username: 'third_person' },
      { id: 'v6', text: 'so cozy', username: 'third_person' },
    ],
  ],
};
let mockHits = 0;
let FOLLOWERS = 40; // the city account's follower count, as the mock Instagram reports it
let published = null;
const replyHits = [];
const queuedSent = [];
const refusedOne = [];
const dmReplies = [];
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
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}` && req.method === 'GET' && u.searchParams.get('fields') === 'followers_count') return send({ followers_count: FOLLOWERS });
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}/media` && req.method === 'POST') {
    published = { container: Object.fromEntries(u.searchParams) };
    return send({ id: 'cont1' });
  }
  if (u.pathname === '/v27.0/cont1') return send({ status_code: 'FINISHED' });
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}/media_publish`) {
    published.creation_id = u.searchParams.get('creation_id');
    return send({ id: 'pub1' });
  }
  if (u.pathname === '/v27.0/me') return send({ user_id: SECRETS.IG_USER_ID, username: 'kinsburgtown' });
  if (u.pathname === '/v27.0/pub1') return send({ permalink: 'https://instagram.com/reel/test' });
  // DMs: profile lookup and replies
  const PROFILES = { '555': { username: 'dm_person', is_user_follow_business: true }, '556': { username: 'via_webhook', is_user_follow_business: false } };
  const prof = /^\/v27\.0\/(55\d)$/.exec(u.pathname);
  if (prof && PROFILES[prof[1]]) return send(PROFILES[prof[1]]);
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}/messages`) {
    dmReplies.push({ recipient: JSON.parse(u.searchParams.get('recipient')), text: JSON.parse(u.searchParams.get('message')).text });
    return send({ message_id: 'mid' });
  }
  if (u.pathname === `/v27.0/${SECRETS.IG_USER_ID}/media`) return send({ data: [{ id: 'm1' }, { id: 'm2' }] });
  const m = /^\/v27\.0\/(m\d)\/comments$/.exec(u.pathname);
  if (m && COMMENTS[m[1]]) {
    const pages = COMMENTS[m[1]];
    const i = u.searchParams.get('after') ? Number(u.searchParams.get('after')) : 0;
    const next = i + 1 < pages.length;
    return send({ data: pages[i], paging: next ? { cursors: { after: String(i + 1) }, next: 'more' } : {} });
  }
  // Comment replies: the first goes through, then Instagram blocks the account (anti-spam).
  const rep = /^\/v27\.0\/([^/]+)\/replies$/.exec(u.pathname);
  // queued hand-picked replies in the tests use comment ids starting 999: always accepted
  if (rep && req.method === 'POST' && rep[1] === '9990000') {
    refusedOne.push(rep[1]); // this commenter won't take replies; everyone else is fine
    return send({ error: { message: 'This API call does not support the requested response format', type: 'OAuthException', code: 20, error_subcode: 1772107, error_user_title: 'Instagram Comment Not Added' } }, 400);
  }
  if (rep && req.method === 'POST' && rep[1].startsWith('999')) {
    queuedSent.push({ comment: rep[1], message: u.searchParams.get('message') });
    return send({ id: 'qr' + queuedSent.length });
  }
  if (rep && req.method === 'POST') {
    replyHits.push({ comment: rep[1], message: u.searchParams.get('message') });
    if (replyHits.length === 1) return send({ id: 'reply1' });
    return send({ error: { message: 'This API call does not support the requested response format', type: 'OAuthException', code: 20, error_subcode: 1772107, error_user_title: 'Instagram Comment Not Added' } }, 400);
  }
  send({ error: { message: 'not found ' + u.pathname } }, 404);
}

// ── helpers ──────────────────────────────────────────────────────────────────
/** One round of the live schedules, in order: the 10-minute comment scan, then the 15-minute city step. */
const runSchedules = async () => {
  const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/10 * * * *')}`);
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('7,22,37,52 * * * *')}`);
  return r;
};
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
let wlog = '';
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
  wrangler.stdout.on('data', (d) => (wlog += d));
  wrangler.stderr.on('data', (d) => (wlog += d));
  wrangler.on('exit', (c) => c && console.log('wrangler exited', c, '\n' + wlog.slice(-2000)));
  await waitFor(`${BASE}/api/city/manifest.json`);

  console.log('\nMOVE IN phrases');
  const joinYes = ['MOVE IN', 'move in please!', 'Moving in 🙌', 'movein', 'Move me in', 'I want house', 'i want a house', 'give me a home', 'house pls', 'I want in', 'can i get a house?',
    'move inn', 'move innn', 'Moving innn', 'Moveee Innnn', 'Movie in', 'Movee me innn right now 😍😍', 'MOVE INNN 🤩', 'i neeed a house', 'i wanna home'];
  const joinNo = ['love this town', 'so cozy', 'vote A', 'I dont want a house', 'not moving in lol', 'nice houses', 'my house is ugly', 'home sweet home', 'CAST ME',
    'Please me', 'Can I be the mayor', 'the movie in theaters tonight was great', 'I dont need a house'];
  ok(joinYes.every(matchesMoveIn), 'every way of asking for a house joins', joinYes.filter((t) => !matchesMoveIn(t)));
  ok(!joinNo.some(matchesMoveIn), 'ordinary comments and refusals do not join', joinNo.filter(matchesMoveIn));

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

  console.log('\ntown: poll setup');
  r = await admin('/admin/poll', { id: 'first-mayor', kind: 'election', question: 'Who should be mayor?', mediaId: 'm2', closesISO: new Date(Date.now() + 86400000).toISOString(),
    options: [{ key: 'A', label: '@new_person1', handle: 'new_person1' }, { key: 'B', label: '@third_person', handle: 'third_person' }] });
  ok(r.status === 200, 'election created', await r.clone().json());

  console.log('\nreply queue');
  r = await admin('/admin/reply', { commentId: 'abc', message: 'hi', queue: true });
  ok(!!(await r.json()).error, 'a queued reply needs a real comment id');
  for (const [id, msg] of [['9990000', 'This commenter refuses replies'], ['9990001', 'Your villa is built 🏝️'], ['9990002', 'Your skyscraper is up 🏙️'], ['9990003', 'Third in line'], ['9990004', 'Fourth in line']]) {
    j = await (await admin('/admin/reply', { commentId: id, message: msg, handle: 'someone', queue: true })).json();
  }
  ok(j.queued === true && j.waiting === 5, 'replies wait in the queue', j);
  j = await (await admin('/admin/reply-queue/flush', {})).json();
  ok(j.sent === 3 && j.refused === 1 && queuedSent.map((x) => x.comment).join() === '9990001,9990002,9990003' && queuedSent[0].message === 'Your villa is built 🏝️', 'a flush tries the oldest, up to the pace (4 per window in tests; the refused one counts)', { j, queuedSent });
  let qs0 = await (await admin('/admin/reply-queue')).json();
  ok(refusedOne.length === 1 && qs0.replies.find((x) => x.comment_id === '9990000')?.status === 'failed' && !qs0.pace.pausedUntil, 'one comment that refuses replies is skipped (no pause, nothing held up)', { refusedOne, pace: qs0.pace });
  let qs = await (await admin('/admin/reply-queue')).json();
  await admin('/admin/reply', { commentId: '9990005', message: 'Fifth in line', queue: true });
  qs = await (await admin('/admin/reply-queue')).json();
  ok(qs.replies.filter((x) => x.status === 'queued').length === 2 && qs.replies.filter((x) => x.status === 'sent').length === 3, 'sent ones are marked; the rest keep waiting', qs.replies.map((x) => x.status));
  r = await admin('/admin/reply', { commentId: '9990009', message: 'Right now please' });
  ok(/queue/.test((await r.json()).error ?? ''), 'an immediate reply waits its turn once the window is used up (it says to queue it)');
  await new Promise((res) => setTimeout(res, 1100)); // next pacing window (1 s in tests, 10 min live)

  console.log('\ncomment poller (cron)');
  const before = mockHits;
  r = await runSchedules();
  ok(r.status === 200, 'scheduled handler ran');
  ok(mockHits > before, 'poller called the Instagram API', mockHits - before);
  ({ data } = await loadCity());
  const ids = new Set(data.residents.map((x) => x.id));
  for (const h of ['new_person1', 'second.person', 'third_person']) ok(ids.has(h), `joined @${h}`);
  ok(!ids.has('lurker'), 'comment without MOVE IN ignored');
  ok(!ids.has('bad..handle'), 'invalid handle not joined');
  ok(data.residents.length === 54, 'exactly 3 new residents (duplicate comment joined once)', data.residents.length);
  try { validateCityData(data); ok(true, 'city still valid after joins'); } catch (e) { ok(false, 'city still valid after joins', String(e)); }
  await runSchedules();
  ({ data } = await loadCity());
  ok(data.residents.length === 54, 'second poll adds nobody (comments remembered)', data.residents.length);
  ok(replyHits.length === 2 && replyHits[0].message.includes('\n') && /Follow/.test(replyHits[0].message) && /@(new_person1|second\.person|third_person)\b/.test(replyHits[0].message), 'one welcome reply greeting them by @username, then Instagram blocks the second', replyHits);
  let pace = (await (await admin('/admin/replies', { dryRun: true })).json()).pace;
  ok(!!pace?.pausedUntil && pace.lastPauseHours === 6, 'a comment block pauses replies for 6 hours', pace);
  ok(replyHits.length === 2, 'no reply attempts while paused (the second poll stayed quiet)', replyHits.length);
  r = await admin('/admin/replies', { max: 5 });
  ok(replyHits.length === 2 && (await r.json()).missed.replied === 0, 'the admin catch-up also respects the pause', replyHits.length);
  r = await admin('/admin/reply', { commentId: '1234567', message: 'Welcome!' });
  ok(/paused/.test((await r.json()).error ?? '') && replyHits.length === 2, 'a hand-picked reply also waits out the pause');
  ok(queuedSent.length === 5 && queuedSent[4].comment === '9990005', 'the check sends queued replies first, before welcomes', queuedSent.map((x) => x.comment));
  await admin('/admin/reply', { commentId: '9990007', message: 'During the block', queue: true });
  await new Promise((res) => setTimeout(res, 1100));
  j = await (await admin('/admin/reply-queue/flush', {})).json();
  qs = await (await admin('/admin/reply-queue')).json();
  ok(j.sent === 0 && qs.replies.find((x) => x.comment_id === '9990007')?.status === 'queued' && queuedSent.length === 5, 'during a comment block queued replies wait (nothing is lost)', { j, queuedSent: queuedSent.length });


  console.log('\ntown: votes, mayor, growing houses');
  let town = await (await fetch(`${BASE}/api/city/town.json`)).json();
  let poll = town.polls.find((p) => p.id === 'first-mayor');
  ok(poll && poll.total === 2 && poll.options.find((o) => o.key === 'A').votes === 1 && poll.options.find((o) => o.key === 'B').votes === 1, 'one vote per resident, non-residents and second votes ignored', poll);
  const tp = data.residents.find((x) => x.id === 'third_person');
  ok(tp?.level === 1, 'third_person grew a storey after 4 comments', tp);
  ok(!data.residents.find((x) => x.id === 'second.person')?.level, 'two comments are not enough for a storey yet');
  r = await admin('/admin/poll/close', { id: 'first-mayor' });
  j = await r.json();
  ok(j.winner === 'A', 'tie goes to the option listed first', j);
  town = await (await fetch(`${BASE}/api/city/town.json`)).json();
  ok(town.mayor?.handle === 'new_person1', 'election winner becomes mayor', town.mayor);
  ok((await admin('/admin/sponsor', { name: 'Bean There', message: 'Fresh coffee on Kinsfolk Avenue', url: 'https://example.com', days: 7 })).status === 200, 'sponsor added');
  ok((await admin('/admin/town', { perkLinks: { star: { url: 'https://buy.stripe.com/test_star', price: '$5' }, goldRoof: { url: 'http://evil.example', price: '$1' } } })).status === 200, 'perk links saved');
  town = await (await fetch(`${BASE}/api/city/town.json`)).json();
  ok(town.sponsors.some((x) => x.name === 'Bean There'), 'sponsor listed in town.json');
  ok(town.perkLinks.star?.price === '$5' && !town.perkLinks.goldRoof, 'only real Stripe links are accepted', town.perkLinks);

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
  r = await stripeEvent('evt_5', { id: 'cs_5', payment_status: 'paid', payment_link: 'plink_star', client_reference_id: 'dotted-buyer' });
  ({ data } = await loadCity());
  ok(r.status === 200 && data.residents.find((x) => x.id === 'dotted.buyer')?.perks.includes('star'), 'handle sent as client_reference_id (dots as dashes) gets the perk');
  r = await stripeEvent('evt_6', { id: 'cs_6', payment_status: 'paid', payment_link: 'plink_poster', custom_fields: [{ key: 'instagramhandle', text: { value: 'third_person' } }] });
  const st6 = await (await admin('/admin/stats')).json();
  ok(r.status === 200 && st6.ordersToFulfil?.some((o) => o.item === 'poster' && o.handle === 'third_person'), 'poster purchase becomes an order to fulfil', st6.ordersToFulfil);
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

  console.log('\nCAST ME (permission to appear in videos)');
  const castHook = (changes) => {
    const b = JSON.stringify({ object: 'instagram', entry: [{ id: SECRETS.IG_USER_ID, time: 2, changes: changes.map(([id, text, username]) => ({ field: 'comments', value: { id, text, from: { id: '9', username }, media: { id: 'm1' } } })) }] });
    return fetch(`${BASE}/webhooks/instagram`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRETS.IG_APP_SECRET).update(b).digest('hex'), 'content-type': 'application/json' }, body: b });
  };
  const castList = async () => (await (await admin('/admin/cast')).json()).cast.map((x) => x.handle);
  r = await castHook([['c901', 'CAST ME 🎬', 'new_person1'], ['c902', 'move in cast me pls', 'cast_newbie'], ['c903', 'great podcast meeting', 'lurker']]);
  ok(r.status === 200, 'cast comments accepted', r.status);
  let cast = await castList();
  ok(cast.includes('new_person1') && cast.includes('cast_newbie') && !cast.includes('lurker'), 'CAST ME grants the commenter; look-alike words do not', cast);
  ({ data } = await loadCity());
  ok(data.residents.some((x) => x.id === 'cast_newbie'), 'MOVE IN + CAST ME in one comment does both');
  r = await admin('/admin/cast', { handle: 'new_person1', remove: true });
  ok(r.status === 200 && !(await castList()).includes('new_person1'), 'admin removes permission (after a DM)');
  await castHook([['c901', 'CAST ME 🎬', 'new_person1']]);
  ok(!(await castList()).includes('new_person1'), 'an old CAST ME comment never re-grants after removal');
  r = await fetch(`${BASE}/admin/cast`);
  ok(r.status === 401, 'cast list needs the admin token', r.status);

  console.log('\nJobs and pets');
  const resident = async (h) => (await loadCity()).data.residents.find((x) => x.id === h);
  r = await castHook([
    ['c950', 'JOB POLICE 🚓', 'third_person'],
    ['c951', 'pet dog', 'third_person'],
    ['c952', 'MOVE IN JOB DOCTOR PET CAT', 'combo.person'],
    ['c953', 'job vet', 'vet.newcomer'],
    ['c954', 'PET FOX', 'second.person'],
    ['c955', 'great job doctor', 'lurker'],
  ]);
  ok(r.status === 200, 'job and pet comments accepted', r.status);
  let tp2 = await resident('third_person');
  ok(tp2?.job === 'Police officer' && tp2?.pet === 'dog', 'JOB POLICE and PET DOG set job and pet', tp2);
  const combo = await resident('combo.person');
  ok(combo?.job === 'Doctor' && combo?.pet === 'cat', 'MOVE IN JOB DOCTOR PET CAT does all three in one comment', combo);
  ok((await resident('vet.newcomer'))?.job === 'Vet', 'a JOB comment from someone new moves them in with that job');
  ok(!(await resident('second.person'))?.pet, 'a rare pet (fox) needs buying first');
  ok(!(await resident('lurker')), '"great job doctor" is not a command');
  await castHook([['c956', 'JOB FIREFIGHTER', 'third_person']]);
  ok((await resident('third_person'))?.job === 'Police officer', 'a second job change within a week is refused');
  r = await admin('/admin/pet', { handle: 'second.person', pet: 'fox', own: true });
  ok(r.status === 200 && (await resident('second.person'))?.pet === 'fox', 'admin grants a rare pet (manual sale)');
  await castHook([['c957', 'pet bunny', 'second.person']]);
  await castHook([['c958', 'pet fox', 'second.person']]);
  ok((await resident('second.person'))?.pet === 'fox', 'an owned rare pet can be picked again after switching');
  await castHook([['c951', 'pet dog', 'third_person'], ['c959', 'no pet', 'third_person']]);
  ok(!(await resident('third_person'))?.pet, 'NO PET removes it; an old comment is not replayed');
  r = await stripeEvent('evt_7', { id: 'cs_7', payment_status: 'paid', payment_link: 'plink_owl', custom_fields: [{ key: 'instagramhandle', text: { value: 'owl.buyer' } }] });
  ok(r.status === 200 && (await resident('owl.buyer'))?.pet === 'owl', 'buying a rare pet moves the buyer in with it', await r.clone().json().catch(() => null));
  r = await admin('/admin/job', { handle: 'third_person', job: 'Firefighter' });
  ok(r.status === 200 && (await resident('third_person'))?.job === 'Firefighter', 'admin can set a job past the weekly limit');
  ({ data } = await loadCity());
  try { validateCityData(data); ok(true, 'city still valid with jobs and pets'); } catch (e) { ok(false, 'city still valid with jobs and pets', String(e)); }

  console.log('\nCity simulation');
  const sim = async () => (await (await fetch(`${BASE}/api/city/town.json`)).json()).sim;
  r = await admin('/admin/sim/tick', {});
  let tick = await r.json();
  ok(r.status === 200 && typeof tick.stats?.health === 'number', 'a tick runs and reports stats', tick);
  await admin('/admin/job', { handle: 'new_person1', job: 'Firefighter' });
  r = await admin('/admin/sim/start', { kind: 'fire', target: 'second.person' });
  const fire = await r.json();
  ok(r.status === 200 && fire.kind === 'fire' && fire.needed === 2 && fire.target === 'second.person', 'admin starts a fire at a house (2 firefighters needed)', fire);
  let sv = await sim();
  ok(sv.open.some((i) => i.id === fire.id && i.label === 'Kitchen fire'), 'town.json lists the open fire', sv.open);
  await castHook([['c960', 'RESPOND 🚒', 'third_person'], ['c961', 'on my way!', 'lurker']]);
  sv = await sim();
  ok(sv.open.find((i) => i.id === fire.id)?.responders.join() === 'third_person', 'a firefighter responds; a non-resident does not count', sv.open);
  await castHook([['c962', 'omw', 'new_person1']]);
  sv = await sim();
  const done = sv.recent.find((i) => i.id === fire.id);
  ok(done?.status === 'resolved' && done.responders.length === 2 && !sv.open.some((i) => i.id === fire.id), 'the second firefighter resolves the fire', done);
  ok((await resident('third_person'))?.coins === 10 && (await resident('new_person1'))?.coins === 10, 'both heroes earn 10 town coins');
  ok(sv.ofTheWeek.some((h) => h.title.startsWith('KFD') && ['third_person', 'new_person1'].includes(h.handle)), 'KFD firefighter of the week', sv.ofTheWeek);
  await castHook([['c962', 'omw', 'new_person1']]);
  ok((await resident('new_person1'))?.coins === 10, 'an old RESPOND comment is not replayed');
  await castHook([['c963', 'on duty', 'combo.person']]);
  ok((await resident('combo.person'))?.coins === 2, 'RESPOND with no call to answer is a paid shift (2 coins)');
  await castHook([['c964', 'respond', 'combo.person']]);
  ok((await resident('combo.person'))?.coins === 2, 'one paid shift per day');
  await admin('/admin/sim/start', { kind: 'burglary', target: 'combo.person', hours: -1 });
  r = await admin('/admin/sim/start', { kind: 'fire', target: 'vet.newcomer', hours: -1 });
  const late = await r.json();
  tick = await (await admin('/admin/sim/tick', {})).json();
  ok(tick.failed.length === 2, 'incidents past their deadline fail on the next tick', tick);
  sv = await sim();
  const repair = sv.open.find((i) => i.kind === 'repair' && i.target === 'vet.newcomer');
  ok(!!repair && sv.recent.some((i) => i.id === late.id && i.status === 'failed'), 'a failed fire leaves damage for a carpenter to repair', sv.open);
  await admin('/admin/job', { handle: 'owl.buyer', job: 'Carpenter' });
  await castHook([['c965', 'respond', 'owl.buyer']]);
  sv = await sim();
  ok(!sv.open.some((i) => i.id === repair?.id) && (await resident('owl.buyer'))?.coins === 15, 'a carpenter repairs it and earns 15 coins');
  r = await admin('/admin/coins', { handle: 'combo.person', add: 200 });
  ok(r.status === 200 && (await r.json()).coins === 202, 'admin gives coins');
  await castHook([['c966', 'PET OWL', 'combo.person']]);
  const cp = await resident('combo.person');
  ok(cp?.pet === 'owl' && cp?.coins === 52, 'a rare pet can be bought with 150 town coins', cp);
  r = await admin('/admin/sim/tick', { force: true });
  tick = await r.json();
  ok(!!tick.started, 'a forced tick starts a random incident', tick);
  ({ data } = await loadCity());
  try { validateCityData(data); ok(true, 'city still valid with coins'); } catch (e) { ok(false, 'city still valid with coins', String(e)); }

  console.log('\nPolitics: elections, approval, the mayor\'s fund');
  const pol = async () => (await (await fetch(`${BASE}/api/city/town.json`)).json()).politics;
  const anns = async () => (await (await admin('/admin/announcements')).json()).map((a) => a.text);
  ok((await anns()).some((t) => /Kitchen fire at @second\.person's house! Firefighters: comment RESPOND \(2 needed\)/.test(t)), 'starting a fire queues a call for firefighters on Instagram', (await anns()).slice(0, 3));
  let pv = await pol();
  if (!pv.election) {
    r = await admin('/admin/election/start', {});
    ok(r.status === 200, 'admin opens nominations', r.status);
  } else ok(pv.election.phase === 'nominations', 'nominations opened on their own (no mayor yet at the first tick)', pv.election);
  await castHook([['c970', 'RUN FOR MAYOR 🗳️', 'third_person'], ['c971', "I'm running for mayor", 'combo.person'], ['c972', 'run for mayor', 'lurker']]);
  pv = await pol();
  ok(pv.election.candidates.includes('third_person') && pv.election.candidates.includes('combo.person') && !pv.election.candidates.includes('lurker'), 'residents stand with RUN FOR MAYOR; non-residents cannot', pv.election);
  r = await admin('/admin/election/advance', {});
  pv = await pol();
  ok(pv.election?.phase === 'voting' && !!pv.election.pollId, 'nominations close into a town-wide vote', pv.election);
  ok((await anns()).some((t) => t.startsWith('🗳️ Voting is open!')), 'voting announced');
  await castHook([['c973', 'VOTE @combo.person', 'second.person'], ['c974', 'vote for @combo.person!', 'new_person1'], ['c975', 'VOTE @third_person', 'owl.buyer'], ['c976', 'I like @third_person', 'vet.newcomer']]);
  let townNow = await (await fetch(`${BASE}/api/city/town.json`)).json();
  const ep = townNow.polls.find((p) => p.id === pv.election.pollId);
  ok(ep?.total === 3, 'VOTE comments on any post count; others do not', ep);
  r = await admin('/admin/election/advance', {});
  pv = await pol();
  ok(pv.mayor?.handle === 'combo.person' && !pv.election && typeof pv.mayor.approval === 'number', 'the winner becomes mayor with an approval rating', pv);
  await castHook([['c977', 'PROTEST', 'third_person'], ['c978', 'protest!', 'second.person']]);
  pv = await pol();
  ok(pv.protest === undefined && !pv.election, 'there are no protests: PROTEST comments do nothing', pv);
  ok((await anns()).some((t) => t.startsWith('🎉 Congratulations @combo.person')), 'the new mayor is congratulated', (await anns()).slice(0, 2));
  const annRows = await (await admin('/admin/announcements')).json();
  const nomRow = annRows.find((a) => a.text.startsWith('🗳️ Voting is open'));
  ok(!!nomRow?.expires_at && Date.parse(nomRow.expires_at) - Date.parse(nomRow.created_at) >= 40 * 3600_000, 'an election announcement stays valid until voting ends (survives a reply pause)', nomRow);
  r = await admin('/admin/coins', { handle: 'combo.person', add: 1 });
  await castHook([['c984', 'FUND HEALTH', 'combo.person'], ['c985', 'fund health', 'third_person']]);
  const simNow = (await (await fetch(`${BASE}/api/city/town.json`)).json()).sim;
  ok(typeof simNow.treasury === 'number', 'FUND is only for the mayor and needs treasury (no crash with a small treasury)', simNow.treasury);

  console.log('\nVillas and skyscrapers (limit 3 each in tests)');
  const homesNow = async () => (await (await fetch(`${BASE}/api/city/town.json`)).json()).homes;
  await castHook([
    ['c990', 'i need a villa 🏝️', 'third_person'],
    ['c991', 'VILLA pls', 'second.person'],
    ['c992', 'skyscraper!', 'new_person1'],
    ['c993', 'villa', 'villa.newbie'],
    ['c994', 'villa please', 'owl.buyer'],
    ['c995', 'the lighthouse tower looks so cozy at night', 'lurker'],
    ['c996', 'villainous plot', 'vet.newcomer'],
  ]);
  let hv = await homesNow();
  const tpv = await resident('third_person');
  ok(tpv?.home === 'villa' && tpv?.homeNo === 1 && (await resident('second.person'))?.homeNo === 2, 'the first commenters get numbered villas in comment order', tpv);
  ok((await resident('new_person1'))?.home === 'skyscraper', 'SKYSCRAPER gives a skyscraper');
  const nb = await resident('villa.newbie');
  ok(nb?.home === 'villa' && nb?.homeNo === 3, 'someone new moves in straight into a villa', nb);
  ok(!(await resident('owl.buyer'))?.home && hv.villa.taken === 3 && hv.villa.limit === 3, 'once the edition is gone, later comments get nothing', hv);
  ok(!(await resident('lurker')) && !(await resident('vet.newcomer'))?.home, '"lighthouse tower" in a long comment and "villainous" do not count');
  ok((await anns()).some((t) => t.startsWith('🏝️ All 3 villas')), 'selling out is announced');
  await castHook([['c997', 'skyscraper', 'third_person']]);
  ok((await resident('third_person'))?.home === 'villa', 'one special home per person');
  r = await admin('/admin/home', { handle: 'third_person', home: 'house' });
  ok(r.status === 200 && !(await resident('third_person'))?.home && (await homesNow()).villa.taken === 2, 'admin can take a home back, freeing it', await homesNow());
  r = await admin('/admin/home', { handle: 'owl.buyer', home: 'villa' });
  const ob = await r.json();
  ok(r.status === 200 && ob.no === 4, 'the freed villa goes to the next person with a new number', ob);
  await castHook([['c998', 'villa please', 'third_person']]);
  const wl = (await (await fetch(`${BASE}/api/city/town.json`)).json()).cityCash?.waitlist?.homes ?? [];
  ok(wl.map((x) => x.handle).join() === 'owl.buyer,third_person' && wl.every((x) => x.price === 50000), 'past the free ones, villa requests queue for the city to pay ($50,000), in comment order', wl);
  ({ data } = await loadCity());
  try { validateCityData(data); ok(true, 'city still valid with villas and skyscrapers'); } catch (e) { ok(false, 'city still valid with villas and skyscrapers', String(e)); }

  console.log('\nDMs (after App Review)');
  const dm = (sender, text) => {
    const b = JSON.stringify({ object: 'instagram', entry: [{ id: SECRETS.IG_USER_ID, time: 1, messaging: [{ sender: { id: sender }, recipient: { id: SECRETS.IG_USER_ID }, message: { mid: 'm' + sender, text } }] }] });
    return fetch(`${BASE}/webhooks/instagram`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRETS.IG_APP_SECRET).update(b).digest('hex'), 'content-type': 'application/json' }, body: b });
  };
  r = await dm('555', 'MOVE IN please');
  ({ data } = await loadCity());
  const dmp = data.residents.find((x) => x.id === 'dm_person');
  ok(r.status === 200 && dmp?.follower === true, 'DM MOVE IN joins and records the follower badge', dmp);
  ok(dmReplies.some((x) => x.recipient.id === '555' && x.text.includes('/?r=dm_person') && !x.text.includes('Follow')), 'follower gets their link without a follow nudge', dmReplies);
  r = await dm('556', 'MOVE OUT');
  ({ data } = await loadCity());
  ok(r.status === 200 && !data.residents.some((x) => x.id === 'via_webhook') && data.residents.some((x) => x.id.startsWith('vacant.lot.')), 'DM MOVE OUT removes the name and leaves a vacant lot');
  try { validateCityData(data); ok(true, 'city still valid after moving out'); } catch (e) { ok(false, 'city still valid after moving out', String(e)); }

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
  // Default path: no Instagram token on the runner, the Worker relays the calls with its own token.
  published = null;
  const relayEnv = { ...process.env, KINSBURG_URL: BASE, ADMIN_TOKEN: SECRETS.ADMIN_TOKEN, IG_ACCESS_TOKEN: '', IG_USER_ID: '' };
  try {
    await promisify(execFile)('node', ['scripts/reel/publish.mjs', '--date', '2026-11-11', '--out', pubDir, '--poll-seconds', '1', '--publish'], { cwd: root, env: relayEnv, encoding: 'utf8' });
  } catch (e) {
    console.log('  relay publish stderr:', String(e.stderr).trim().split('\n').slice(0, 14).join('\n'));
  }
  ok(published?.container.media_type === 'REELS' && published.creation_id === 'cont1', 'publish without an Instagram token posts through the Worker relay', published);
  r = await admin('/admin/ig', { method: 'POST', path: 'me/messages', params: { message: '{}' } });
  ok(r.status === 400, 'relay refuses calls other than Reel posting', r.status);
  r = await admin('/admin/ig', { method: 'GET', path: 'me', params: { fields: 'id,username,followers_count' } });
  ok(r.status === 400, 'relay refuses other reads', r.status);
  r = await admin('/admin/ig', { whoami: true });
  const who = await r.json();
  ok(r.status === 200 && who.user_id === SECRETS.IG_USER_ID && who.username === 'kinsburgtown' && who.matchesStoredUserId === true && !JSON.stringify(who).includes(SECRETS.IG_ACCESS_TOKEN), 'whoami confirms the token and account without revealing the token', who);
  r = await fetch(`${BASE}/admin/ig`, { method: 'POST', body: JSON.stringify({ check: true }) });
  ok(r.status === 401, 'relay needs the admin token', r.status);
  rmSync(pubDir, { recursive: true, force: true });

  console.log('\nbuild what you ask + bestie neighbours');
  const pop0 = (await loadCity()).data.residents.length;
  const cashNow = async () => (await (await admin('/admin/cash')).json()).cash;
  const cash0 = await cashNow();
  FOLLOWERS = 44; // four new followers since the last poll
  COMMENTS.m2[0].push(
    { id: 'b1', text: 'build a pool please', username: 'lurker', like_count: 5 },
    { id: 'b2', text: 'can we get a ferris wheel', username: 'third_person', like_count: 9 },
    { id: 'b3', text: 'pool pls 🏊', username: 'second.person', like_count: 3 },
    { id: 'b4', text: 'no more pools', username: 'grumpy', like_count: 50 },
    { id: 'f1', text: 'MOVE IN @Bestie.One', username: 'friend_a' },
    { id: 'f2', text: 'MOVE IN @third_person', username: 'new_person1' }, // both already live here
  );
  await runSchedules();
  let t = await (await fetch(`${BASE}/api/city/town.json`)).json();
  const reqOf = (k) => t.requests?.find((x) => x.kind === k);
  ok(reqOf('pool')?.likes === 8 && reqOf('pool')?.count === 2 && reqOf('ferris')?.likes === 9, 'build requests are counted with their likes', t.requests);
  ok(!t.requests?.some((x) => x.likes >= 50), '"no more pools" is not a request');
  ({ data } = await loadCity());
  const fa = data.residents.find((x) => x.id === 'friend_a');
  ok(data.residents.length === pop0 + 2 && fa, 'MOVE IN @friend moves the commenter in and holds one plot', data.residents.length - pop0);
  ok(t.holds?.length === 1 && t.holds[0].number === fa.number + 1, 'the held plot is the one right after the commenter', t.holds);
  ok(data.residents.some((x) => x.id === `vacant.lot.${fa.number + 1}`) && !data.residents.some((x) => x.id === 'bestie.one'), 'the friend is not added until they ask; the plot shows as held');
  ok(t.besties?.some(([a, b]) => a === 'new_person1' && b === 'third_person'), 'two existing residents become besties without a hold', t.besties);
  const cash1 = await cashNow();
  ok(cash1 - cash0 === 1500 + 4 * 1500, 'city cash: $1,500 for the move-in and $1,500 for each of 4 new followers', { cash0, cash1 });
  FOLLOWERS = 42;
  await runSchedules();
  FOLLOWERS = 44;
  await runSchedules();
  ok((await cashNow()) === cash1, 'an unfollow and refollow never pays twice');

  // the ferris wheel ($125,000) is the most-liked: the city can't afford it yet, so it saves up
  r = await admin('/admin/builds', { run: true });
  j = await r.json();
  ok(j.run?.built?.length === 0 && j.run?.waiting?.kind === 'ferris' && (await cashNow()) === cash1, 'too little cash: nothing is built and the top request heads the waitlist (nothing cheaper jumps ahead)', j.run);
  await admin('/admin/cash', { amount: 150000, note: 'test grant' });
  j = await (await admin('/admin/builds', { run: true })).json();
  ok(j.run?.built?.join() === 'ferris,pool', 'with the money, the most-liked requests get built, most likes first', j.run);
  ok((await cashNow()) === cash1 && j.run?.waiting?.type === 'home' && j.run.waiting.handle === 'third_person', 'their prices ($125,000 + $25,000) come off city cash; a villa already given free is dropped, the next waits', { cash: await cashNow(), waiting: j.run?.waiting });
  ok(j.builds?.find((x) => x.kind === 'pool')?.by === 'lurker' && j.builds?.find((x) => x.kind === 'ferris')?.likes === 9, 'each build credits the most-liked asker', j.builds);
  ok(j.builds?.every((x) => Number.isInteger(x.pop) && x.pop > 0), 'each build records the city size it was made at (it picks the site)', j.builds?.map((x) => x.pop));
  await admin('/admin/cash', { amount: 50000, note: 'test grant' });
  j = await (await admin('/admin/builds', { run: true })).json();
  const tpPaid = await resident('third_person');
  ok(j.run?.built?.length === 0 && j.builds.length === 2, 'built requests are not built twice', j.run);
  const day1 = (await (await fetch(`${BASE}/api/city/town.json`)).json()).cityCash?.today;
  ok(day1?.prev?.after != null && day1?.income?.adjust?.amount === 50000 && day1?.residents > 0 && Array.isArray(day1?.wall) && day1.ledgerId > 0, "the day's summary records yesterday, income since, residents and the comment wall (for the episode)", day1);
  ok(tpPaid?.home === 'villa' && tpPaid?.homeNo === 5 && j.run?.homes?.[0] === 'third_person:villa#5' && (await cashNow()) === cash1, 'the city pays $50,000 for the queued villa: villa #5', { home: tpPaid, run: j.run });
  const led = (await (await admin('/admin/cash')).json()).ledger;
  ok(led.some((x) => x.kind === 'home' && x.amount === -50000) && led.some((x) => x.kind === 'build' && x.amount === -125000) && led.some((x) => x.kind === 'follows' && x.amount === 6000), 'every dollar is in the ledger', led.slice(0, 6));

  COMMENTS.m2[0].push({ id: 'f3', text: 'MOVE IN', username: 'bestie.one' });
  await runSchedules();
  ({ data } = await loadCity());
  t = await (await fetch(`${BASE}/api/city/town.json`)).json();
  ok(data.residents.find((x) => x.id === 'bestie.one')?.number === fa.number + 1 && data.residents.length === pop0 + 2, 'the friend moves into the held plot next door', { friend: data.residents.find((x) => x.id === 'bestie.one')?.number, expected: fa.number + 1, residents: data.residents.length, wanted: pop0 + 2 });
  ok(!t.holds?.length && t.besties?.some(([a, b]) => a === 'bestie.one' && b === 'friend_a'), 'they are besties and the hold is gone', { holds: t.holds, besties: t.besties });
  ok((await cashNow()) === cash1 + 1500, 'moving into a held plot pays the city $1,500 too');
  try { validateCityData(data); ok(true, 'city still valid with holds and builds'); } catch (e) { ok(false, 'city still valid with holds and builds', String(e)); }

  const st = await (await admin('/admin/stats')).json();
  console.log(`\nfinal: ${st.residents} residents, processed comments ${JSON.stringify(st.processedComments)}, stripe ${JSON.stringify(st.stripeEvents)}`);
} catch (err) {
  failures++;
  console.error('ERROR', err);
} finally {
  if (failures) {
    const errs = wlog.split('\n').filter((l) => /failed|error|Error/.test(l)).slice(-15);
    if (errs.length) console.log('\nworker log (errors):\n' + errs.join('\n'));
  }
  wrangler?.kill('SIGINT');
  mock.close();
  rmSync(devVars, { force: true });
  rmSync(state, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
