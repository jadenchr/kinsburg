#!/usr/bin/env node
// Seed the Kinsburg D1 database (residents + pre-built snapshot shards).
//   node scripts/seed-d1.mjs demo [count=1200]   1,200 demo residents, demo:true   (local D1)
//   node scripts/seed-d1.mjs real                 empty city: @kinsburgtown is resident #1 (monument), demo:false
// Flags: --remote --yes   write to the real Cloudflare D1 (wipes residents!) instead of local
//        --persist-to DIR local state dir (same as `wrangler dev --persist-to`)
//        --sql-only       just write the SQL file and print its path
//        --shard-size N   default 5000 (must match SHARD_SIZE in wrangler.jsonc)
// Migrations are applied first (idempotent).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { encodeShards, JOBS, DEFAULT_SHARD_SIZE } from '../shared/residents-format.mjs';
import { demoResidents } from './generate-demo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--persist-to', '--shard-size'].includes(args[i - 1])));
const mode = pos[0];
if (mode !== 'demo' && mode !== 'real') {
  console.error('usage: node scripts/seed-d1.mjs demo [count] | real  [--remote --yes] [--persist-to DIR] [--sql-only]');
  process.exit(2);
}
const remote = flag('--remote');
if (remote && !flag('--yes')) {
  console.error('Refusing to wipe the remote database without --yes.');
  process.exit(2);
}
const shardSize = parseInt(opt('--shard-size', String(DEFAULT_SHARD_SIZE)), 10);
const persist = opt('--persist-to');

const residents =
  mode === 'demo'
    ? demoResidents(Math.max(1, parseInt(pos[1] ?? '1200', 10) || 1200), 'kinsburg')
    : [{ handle: 'kinsburgtown', number: 1, joinedDay: 1, job: 'Architect', houseStyle: 0, perks: ['monument'] }];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const PERK_BIT = { star: 1, goldRoof: 2, monument: 4, street: 8 };
const sql = [
  'DELETE FROM residents;', 'DELETE FROM city_shards;', 'DELETE FROM processed_comments;', 'DELETE FROM events;',
  'DELETE FROM stripe_events;',
  `INSERT INTO meta (key, value) VALUES ('rev', '1'), ('demo', '${mode === 'demo'}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
];
for (let i = 0; i < residents.length; i += 200) {
  const vals = residents.slice(i, i + 200).map((r) => {
    const mask = r.perks.reduce((m, p) => m | PERK_BIT[p], 0);
    return `(${r.number}, ${q(r.handle)}, ${r.joinedDay}, ${JOBS.indexOf(r.job)}, ${r.houseStyle}, ${mask}, 'seed')`;
  });
  sql.push(`INSERT INTO residents (number, handle, joined_day, job, house_style, perks, source) VALUES\n${vals.join(',\n')};`);
}
// D1 caps one SQL statement at 100 KB, so long shard bodies are appended in pieces.
encodeShards(residents, shardSize).forEach((rows, s) => {
  const body = JSON.stringify(rows);
  const PIECE = 60_000;
  sql.push(`INSERT INTO city_shards (shard, rev, count, body) VALUES (${s}, 1, ${rows.length}, ${q(body.slice(0, PIECE))});`);
  for (let i = PIECE; i < body.length; i += PIECE) sql.push(`UPDATE city_shards SET body = body || ${q(body.slice(i, i + PIECE))} WHERE shard = ${s};`);
});
sql.push(`INSERT INTO events (kind, detail) VALUES ('seed', ${q(JSON.stringify({ mode, residents: residents.length }))});`);

const outDir = join(root, 'worker', '.seed');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${mode}.sql`);
writeFileSync(file, sql.join('\n') + '\n');
console.log(`seed: ${mode}, ${residents.length} residents, ${Math.ceil(residents.length / shardSize)} shard(s) -> ${file}`);
if (flag('--sql-only')) process.exit(0);

const target = remote ? ['--remote'] : ['--local', ...(persist ? ['--persist-to', persist] : [])];
const wrangler = (...a) => execFileSync('npx', ['wrangler', ...a], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } });
wrangler('d1', 'migrations', 'apply', 'kinsburg', ...target);
wrangler('d1', 'execute', 'kinsburg', ...target, `--file=${file}`);
console.log(`seed: done (${remote ? 'remote' : 'local'} D1)`);
