-- PR #7 (PM v4) adds recurring calendar events. EventDialog ALWAYS sends
-- `recurrence` (z.enum(['none','daily','weekly','monthly']).default('none')) and
-- `recurrence_end`, and mutations.insertEvent does a full `.insert(e)` — so
-- without these columns EVERY calendar-event create/edit fails (PGRST204),
-- including plain one-offs.
--
-- text + CHECK rather than a new pg enum: avoids future `ALTER TYPE ADD VALUE`
-- transaction friction. NOT NULL DEFAULT 'none' backfills existing rows and
-- keeps non-recurring inserts valid (incl. an older client that omits the
-- field). recurrence_end is a nullable date (null when recurrence is 'none').
--
-- Rollback: ALTER TABLE pm.calendar_events
--   DROP COLUMN IF EXISTS recurrence, DROP COLUMN IF EXISTS recurrence_end;
ALTER TABLE pm.calendar_events
  ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'none'
    CHECK (recurrence IN ('none','daily','weekly','monthly')),
  ADD COLUMN IF NOT EXISTS recurrence_end date;
