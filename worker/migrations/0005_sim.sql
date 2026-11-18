-- City simulation (phase 2): incidents residents respond to, town coins, daily shifts.

-- town coins: earned by responding and working shifts, spent on rare pets. Never real money.
ALTER TABLE residents ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;

-- something happening in town that residents with the right job can respond to
CREATE TABLE incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                       -- INCIDENTS key in shared/sim.mjs
  target      TEXT,                                -- resident handle whose house it's at (null: town-wide)
  needed      INTEGER NOT NULL,                    -- responders needed
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'failed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deadline    TEXT NOT NULL,
  closed_at   TEXT,
  cause       INTEGER                              -- incident that led to this one (fire -> repair)
);
CREATE INDEX incidents_open ON incidents (status, deadline);

CREATE TABLE responses (
  incident_id INTEGER NOT NULL,
  handle      TEXT NOT NULL,
  comment_id  TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (incident_id, handle)
);
CREATE INDEX responses_at ON responses (at);

-- one paid shift per resident per city day (RESPOND with no call to answer)
CREATE TABLE shifts (
  handle TEXT NOT NULL,
  day    INTEGER NOT NULL,
  PRIMARY KEY (handle, day)
);

-- every comment id already checked for RESPOND
CREATE TABLE sim_seen (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
