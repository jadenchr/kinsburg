// City cash (shared/economy.mjs): the city's budget in dollars, kept as a ledger (migration 0011).
// Income: $1,500 per move-in (moveInStmt, from every join path) and per new follower
// (recordFollowers, from the poller). Spending happens in the daily build run (builds.ts).
import { CASH_PER_FOLLOWER, CASH_PER_MOVE_IN, HOME_PRICE, HOUSE_VALUE, PRICE_TIERS, buildPrice } from '../../shared/economy.mjs';
import { eventStmt } from './city';
import { type Env, intVar, json, log } from './env';
import type { IgClient } from './instagram';

type LedgerKind = 'seed' | 'move_in' | 'follows' | 'build' | 'home' | 'adjust';

/** One ledger row; a non-null `ref` happens at most once (unique index), so retries never double-count. */
export function ledgerStmt(env: Env, kind: LedgerKind, amount: number, opts: { handle?: string | null; ref?: string | null; note?: string | null } = {}) {
  return env.DB.prepare('INSERT INTO city_ledger (kind, amount, handle, ref, note) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING')
    .bind(kind, Math.round(amount), opts.handle ?? null, opts.ref ?? null, opts.note ?? null);
}

/** $1,500 for a new resident (never for the city's own account or placeholder lots). */
export function moveInStmt(env: Env, handle: string): D1PreparedStatement | null {
  if (!handle || handle === env.CITY_ACCOUNT.toLowerCase() || handle.startsWith('vacant.lot.')) return null;
  return ledgerStmt(env, 'move_in', CASH_PER_MOVE_IN, { handle, ref: `join:${handle}` });
}

export async function cityCash(env: Env): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS cash FROM city_ledger').first<{ cash: number }>();
  return Math.floor(r?.cash ?? 0);
}

async function getMetaNum(env: Env, key: string): Promise<number | null> {
  const r = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first<{ value: string }>();
  return r ? Number(r.value) : null;
}
const setMetaStmt = (env: Env, key: string, value: string | number) =>
  env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));

/**
 * New followers pay $1,500 each, counted above the highest follower count seen so far (so an
 * unfollow and refollow never pays twice). The first reading only sets the mark. At most every
 * FOLLOWERS_CHECK_MINUTES (default 60).
 */
export async function recordFollowers(env: Env, ig: IgClient, now = Date.now()) {
  if (!env.IG_USER_ID) return { skipped: 'no account' };
  const last = await getMetaNum(env, 'followers_checked_at');
  // intVar treats 0 as unset, but 0 here means "every poll" (tests)
  const mins = env.FOLLOWERS_CHECK_MINUTES === '0' ? 0 : intVar(env.FOLLOWERS_CHECK_MINUTES, 60);
  const every = mins * 60_000;
  if (last && now - last < every) return { skipped: 'checked recently' };
  let count: number;
  try {
    const me = await ig.get(env.IG_USER_ID, { fields: 'followers_count' });
    count = Number(me?.followers_count);
  } catch (err) {
    log('followers_failed', { error: String(err) });
    return { error: String(err) };
  }
  if (!Number.isFinite(count) || count < 0) return { error: 'no followers_count' };
  const peak = await getMetaNum(env, 'followers_peak');
  const stmts = [setMetaStmt(env, 'followers_checked_at', now), setMetaStmt(env, 'followers_count', count)];
  let paid = 0;
  if (peak === null) stmts.push(setMetaStmt(env, 'followers_peak', count));
  else if (count > peak) {
    paid = (count - peak) * CASH_PER_FOLLOWER;
    stmts.push(
      ledgerStmt(env, 'follows', paid, { ref: `follows:${peak}-${count}`, note: `${count - peak} new followers (${peak} → ${count})` }),
      setMetaStmt(env, 'followers_peak', count),
      eventStmt(env, 'cash_follows', null, { from: peak, to: count, paid }),
    );
  }
  await env.DB.batch(stmts);
  return { count, peak, paid };
}

/** What town.json shows: the balance, prices, recent money in and out, and the waitlist. */
export async function getCashPublic(env: Env) {
  const db = env.DB;
  const [cash, recent, builds, homes, followers] = await Promise.all([
    cityCash(env),
    db.prepare('SELECT at, kind, amount, handle, note FROM city_ledger ORDER BY id DESC LIMIT 12').all<{ at: string; kind: string; amount: number; handle: string | null; note: string | null }>(),
    db.prepare(
      `SELECT kind, SUM(likes) AS likes, COUNT(*) AS count FROM build_requests WHERE status = 'open'
       GROUP BY kind ORDER BY likes DESC, count DESC, MIN(created_at) ASC LIMIT 10`,
    ).all<{ kind: string; likes: number; count: number }>(),
    db.prepare(`SELECT handle, kind, at FROM home_queue WHERE status = 'waiting' ORDER BY at, comment_id LIMIT 50`).all<{ handle: string; kind: 'villa' | 'skyscraper'; at: string }>(),
    getMetaNum(env, 'followers_count'),
  ]);
  return {
    cash,
    followers,
    income: { follower: CASH_PER_FOLLOWER, moveIn: CASH_PER_MOVE_IN },
    prices: { house: HOUSE_VALUE, tiers: PRICE_TIERS, villa: HOME_PRICE.villa, skyscraper: HOME_PRICE.skyscraper },
    recent: recent.results,
    waitlist: {
      builds: builds.results.map((b) => ({ ...b, price: buildPrice(b.kind) })),
      homes: homes.results.map((h) => ({ ...h, price: HOME_PRICE[h.kind] })),
    },
  };
}

/** GET /admin/cash (balance + last 50 ledger rows) · POST /admin/cash { amount, note } adds or removes money. */
export async function cashAdmin(env: Env, req: Request, body: any): Promise<Response> {
  if (req.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM city_ledger ORDER BY id DESC LIMIT 50').all();
    return json({ cash: await cityCash(env), ledger: rows.results });
  }
  const amount = Math.round(Number(body?.amount));
  if (!Number.isFinite(amount) || amount === 0) return json({ error: 'amount (a non-zero number of dollars) required' }, 400);
  await env.DB.batch([ledgerStmt(env, 'adjust', amount, { note: String(body?.note ?? 'admin adjustment').slice(0, 200) })]);
  return json({ cash: await cityCash(env) });
}
