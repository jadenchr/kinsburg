// City cash: the city's own budget in dollars (separate from the town coins residents earn).
// Plain ESM shared by the Worker and the browser. Types: economy.d.mts.
//
// Income   $1,500 for every new follower of the city account (counted above the highest follower
//          count seen, so unfollow-and-refollow never pays twice) and $1,500 for every move-in.
// Spending each day the city builds what people asked for, most-liked first, while it can afford
//          it; then the paid villas and skyscrapers (after the free first 100), in comment order.
//          The first thing it can't afford heads the WAITLIST and the city saves up for it: nothing
//          further down the list jumps ahead.
// Moving in stays free: a house is shown as worth $15,000, but it's the city's gift, not a cost
// (each move-in brings $1,500, so charging $15,000 would mean nothing ever got built).

export const CASH_PER_FOLLOWER = 1500;
export const CASH_PER_MOVE_IN = 1500;
/** What a new resident's house is worth (shown, never charged). */
export const HOUSE_VALUE = 15000;

/** Community build prices by size. */
export const PRICE_TIERS = [15000, 25000, 50000, 125000];
/** Size of each BUILDS kind (shared/builds.mjs); unknown kinds are tier 1. */
export const BUILD_TIER = {
  cafe: 0, bakery: 0, icecream: 0, pizza: 0, shop: 0, fountain: 0, garden: 0, playground: 0, statue: 0, treehouse: 0, skatepark: 0,
  park: 1, pool: 1, library: 1, carousel: 1, cinema: 1,
  museum: 2, castle: 2, stadium: 2, ship: 2, university: 2,
  ferris: 3, tower: 3,
};
export const buildPrice = (kind) => PRICE_TIERS[BUILD_TIER[kind] ?? 1];

/** Villas and skyscrapers after the free limited edition. */
export const HOME_PRICE = { villa: 50000, skyscraper: 125000 };

/**
 * Spend `cash` on `items` (already in priority order, each { price }), buying while it can afford the
 * next one and stopping at the first it can't: that one heads the waitlist. At most `max` items.
 * Returns { bought, waiting, cashAfter }, where waiting is the first unaffordable item (or null).
 */
export function planSpend(cash, items, max = Infinity) {
  let left = Math.max(0, Math.floor(cash));
  const bought = [];
  for (const it of items) {
    if (bought.length >= max) return { bought, waiting: null, cashAfter: left };
    if (it.price > left) return { bought, waiting: it, cashAfter: left };
    left -= it.price;
    bought.push(it);
  }
  return { bought, waiting: null, cashAfter: left };
}

/** "$125,000" */
export const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
