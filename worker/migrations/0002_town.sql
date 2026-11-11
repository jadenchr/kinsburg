-- Town life: houses that grow with engagement, follower badge, elections/decisions, sponsors, orders.

-- engagement = comments a resident has left on our posts (content never stored);
-- level 0..3 is derived from it and drawn as extra floors; follower is known only from DMs.
ALTER TABLE residents ADD COLUMN engagement INTEGER NOT NULL DEFAULT 0;
ALTER TABLE residents ADD COLUMN level      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE residents ADD COLUMN follower   INTEGER NOT NULL DEFAULT 0;

-- every comment id we have counted for engagement / votes (MOVE IN joins use processed_comments)
CREATE TABLE seen_comments (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- an election (options are candidates) or a decision (options are choices); votes are comments
-- on the poll's Instagram post: "A", "vote B", or the option's word.
CREATE TABLE polls (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('election', 'decision')),
  question   TEXT NOT NULL,
  options    TEXT NOT NULL,              -- JSON [{ key: "A", label: "...", handle?: "..." }]
  media_id   TEXT,                       -- Instagram post whose comments are the votes
  opens_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  closes_at  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  result     TEXT                        -- JSON { winner, tally } once closed
);

CREATE TABLE votes (
  poll_id    TEXT NOT NULL,
  handle     TEXT NOT NULL,
  option     TEXT NOT NULL,
  comment_id TEXT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (poll_id, handle)          -- one vote per resident; the first one counts
);

CREATE TABLE sponsors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  message    TEXT NOT NULL,              -- short billboard line
  url        TEXT,
  starts_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ends_at    TEXT NOT NULL
);

-- things that need a person to fulfil (printed posters)
CREATE TABLE orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT UNIQUE,
  handle     TEXT,
  item       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done', 'refunded')),
  detail     TEXT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
