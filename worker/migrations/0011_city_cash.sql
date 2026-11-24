-- City cash: the city's budget in dollars (shared/economy.mjs). Every dollar in or out is a ledger
-- row, so the balance is SUM(amount) and every change can be traced.
--   kind: seed | move_in | follows | build | home | adjust
--   ref:  unique per event where it must only happen once ('join:<handle>', 'build:<id>', 'home:<comment>')
CREATE TABLE city_ledger (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  kind   TEXT NOT NULL,
  amount INTEGER NOT NULL,
  handle TEXT,
  ref    TEXT,
  note   TEXT
);
CREATE UNIQUE INDEX city_ledger_ref ON city_ledger (ref) WHERE ref IS NOT NULL;

-- Villas and skyscrapers asked for after the free first 100: the city pays for them in comment
-- order when it can afford them. One waiting request per person.
CREATE TABLE home_queue (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('villa', 'skyscraper')),
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  status     TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'built', 'dropped'))
);
CREATE UNIQUE INDEX home_queue_one_waiting ON home_queue (handle) WHERE status = 'waiting';

-- Starting budget: $1,500 for every resident who has already moved in (not the city's own account
-- or the placeholder rows that keep evicted or held lots in place).
INSERT INTO city_ledger (kind, amount, note)
SELECT 'seed', COUNT(*) * 1500, 'starting budget: $1,500 per resident so far'
FROM residents
WHERE handle <> 'kinsburgtown' AND handle NOT LIKE 'vacant.lot.%';
