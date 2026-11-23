-- "Build what you ask" and bestie neighbours (shared/builds.mjs).

-- Every comment that asks for something the city can build. One row per comment; likes are
-- refreshed from Instagram on each comment check while the request is open.
CREATE TABLE build_requests (
  comment_id TEXT PRIMARY KEY,
  media_id   TEXT NOT NULL,
  handle     TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- key in BUILDS
  likes      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'open', -- open | built | expired
  build_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX build_requests_open ON build_requests (status, kind);

-- Things the city built, in build order. The browser puts build #id on build site #id, so ids are
-- never reused or deleted (a removed build keeps its row with removed = 1).
CREATE TABLE builds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  by_handle  TEXT NOT NULL,          -- who asked first among the winning requests
  day        INTEGER NOT NULL,       -- city day it was built
  likes      INTEGER NOT NULL DEFAULT 0,
  requests   INTEGER NOT NULL DEFAULT 1,
  removed    INTEGER NOT NULL DEFAULT 0,
  built_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- A house plot held for a bestie ("MOVE IN @friend"). The plot's resident row is
-- 'vacant.lot.<number>' until the friend comments MOVE IN and the row is renamed to them.
CREATE TABLE bestie_holds (
  number     INTEGER PRIMARY KEY,    -- resident number of the held plot
  for_handle TEXT NOT NULL,
  by_handle  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'held', -- held | claimed | lapsed
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX bestie_holds_for ON bestie_holds (for_handle, status);

-- Bestie pairs, stored once with a < b.
CREATE TABLE besties (
  a          TEXT NOT NULL,
  b          TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (a, b)
);
