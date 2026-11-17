-- Permission to appear in videos. A person grants it by commenting CAST ME on one of our posts
-- (only for themselves: the comment's author). It's removed by an admin after a DM; a removed
-- grant stays removed until the person comments CAST ME again.
CREATE TABLE cast_ok (
  handle     TEXT PRIMARY KEY,
  comment_id TEXT,                         -- the comment that granted it (null if granted by admin)
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- every comment id already checked for CAST ME, so an old comment never re-grants after removal
CREATE TABLE cast_seen (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
