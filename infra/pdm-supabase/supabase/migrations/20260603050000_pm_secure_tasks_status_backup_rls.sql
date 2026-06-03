-- Close the anon/authenticated exposure on pm.tasks_status_backup, the one-time
-- backup captured during the 7->5 task-status redesign
-- (20260603000000_pm_status_redesign_7_to_5.sql). The advisor flagged it as
-- RLS-disabled (critical): with the table sitting in an exposed schema, anyone
-- with the anon key could read/modify every row.
--
-- No client code reads this table (it is a migration artifact), and service_role
-- bypasses RLS — so backup/restore still works. Enabling RLS with no policy =
-- deny-all to anon/authenticated, which is the desired secure state for an
-- internal table. The resulting "RLS enabled, no policy" notice is INFO-level
-- and intentional.
alter table pm.tasks_status_backup enable row level security;

-- Defense in depth: strip the table-level grants so a future stray policy can't
-- silently re-expose it to client roles.
revoke all on pm.tasks_status_backup from anon, authenticated;
