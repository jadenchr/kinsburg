-- Kinsburg D1 schema. Apply: npx wrangler d1 migrations apply DB --local   (or --remote)

-- Authoritative resident list. number = move-in order (1-based) = plot order in the layout engine.
CREATE TABLE residents (
  number      INTEGER PRIMARY KEY,           -- rowid alias: MAX(number) and range scans read few rows
  handle      TEXT    NOT NULL UNIQUE,       -- lowercase Instagram handle, also Resident.id
  joined_day  INTEGER NOT NULL,              -- city day (Day 1 = founding day, UTC)
  job         INTEGER NOT NULL,              -- index into JOBS (shared/residents-format.mjs)
  house_style INTEGER NOT NULL,              -- 0..11
  perks       INTEGER NOT NULL DEFAULT 0,    -- bitmask: star 1, goldRoof 2, monument 4, street 8
  source      TEXT    NOT NULL,              -- comment | webhook | stripe | admin | seed | dm
  ig_user_id  TEXT,                          -- Instagram-scoped id when known
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Pre-built compact snapshots served to browsers (one row per shard of SHARD_SIZE residents).
-- body = JSON Row[]; rev = city revision when last written (cache-busting version).
CREATE TABLE city_shards (
  shard      INTEGER PRIMARY KEY,
  rev        INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  body       TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Small key/value settings: rev (city revision), demo flag, refreshed Instagram token.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('rev', '0'), ('demo', 'false');

-- Every MOVE IN comment we acted on (poller + webhook share it, so nobody joins or gets a reply twice).
CREATE TABLE processed_comments (
  comment_id TEXT PRIMARY KEY,
  media_id   TEXT,
  handle     TEXT,
  result     TEXT NOT NULL,                  -- joined | exists | invalid | blocked | abusive
  replied    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Audit log.
CREATE TABLE events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  kind   TEXT NOT NULL,
  handle TEXT,
  detail TEXT
);

CREATE TABLE blocked (
  handle     TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Stripe webhook idempotency + manual-review queue.
CREATE TABLE stripe_events (
  event_id   TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'processing', -- processing | done | review | pending | ignored
  handle     TEXT,
  perk       TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
