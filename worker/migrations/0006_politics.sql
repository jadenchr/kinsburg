-- Politics (phase 3): automatic elections, protests and recalls; announcements on Instagram.

-- residents standing in an election (RUN FOR MAYOR during nominations)
CREATE TABLE candidates (
  election_id TEXT NOT NULL,
  handle      TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (election_id, handle)
);

-- PROTEST comments against the sitting mayor; one per person per term (term = "handle:sinceDay")
CREATE TABLE protests (
  term       TEXT NOT NULL,
  handle     TEXT NOT NULL,
  comment_id TEXT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (term, handle)
);

-- every comment id already checked for RUN FOR MAYOR / PROTEST / FUND
CREATE TABLE politics_seen (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- things @kinsburgtown says under its latest post (calls for help, elections), posted at a human pace
CREATE TABLE announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  posted_at  TEXT,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'posted', 'skipped', 'failed')),
  detail     TEXT
);
CREATE INDEX announcements_queued ON announcements (status, id);
