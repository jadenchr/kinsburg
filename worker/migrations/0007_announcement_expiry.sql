-- Each announcement stays worth posting until its own time (an incident's deadline, the end of
-- nominations or voting) instead of a fixed 12 hours, so a reply pause doesn't drop election news.
ALTER TABLE announcements ADD COLUMN expires_at TEXT;
-- rows queued before this change (the first election call): keep them for 3 days
UPDATE announcements SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+3 days') WHERE expires_at IS NULL;
