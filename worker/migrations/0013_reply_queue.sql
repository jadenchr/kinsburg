-- Hand-picked replies waiting to go out (POST /admin/reply { queue: true }). The 15-minute cron
-- sends them at the reply pace (per run, daily cap) and never while Instagram is blocking comments.
CREATE TABLE reply_queue (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  sent_at    TEXT
);
CREATE INDEX reply_queue_status ON reply_queue (status, created_at);
