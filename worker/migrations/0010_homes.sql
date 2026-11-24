-- Limited-edition homes: the first 100 villas and 100 skyscrapers, claimed by commenting.
-- home: index into HOMES in shared/residents-format.mjs (0 = ordinary house); home_no: 1..100.
ALTER TABLE residents ADD COLUMN home INTEGER NOT NULL DEFAULT 0;
ALTER TABLE residents ADD COLUMN home_no INTEGER;
-- each number is given out once per kind
CREATE UNIQUE INDEX residents_home_no ON residents (home, home_no) WHERE home > 0;

-- every comment id already checked for VILLA / SKYSCRAPER
CREATE TABLE homes_seen (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
