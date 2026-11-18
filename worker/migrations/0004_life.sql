-- City life, phase 1: residents choose their job (JOB DOCTOR) and a pet (PET DOG).

-- pet in the yard: index into PETS in shared/residents-format.mjs (0 = none)
ALTER TABLE residents ADD COLUMN pet INTEGER NOT NULL DEFAULT 0;
-- rare pets bought (bit = 1 << pet index); free pets need no bit
ALTER TABLE residents ADD COLUMN pets_owned INTEGER NOT NULL DEFAULT 0;
-- city day of the last chosen job (null = never chosen; the first choice is always allowed)
ALTER TABLE residents ADD COLUMN job_changed_day INTEGER;

-- every comment id already checked for JOB / PET commands
CREATE TABLE life_seen (
  comment_id TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
