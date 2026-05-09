-- Enable Supabase realtime on the tables that drive auto-sync in the desktop
-- Vault module. Subscribers receive INSERT/UPDATE notifications via the
-- `supabase_realtime` publication, gated by RLS so users only get events for
-- rows they can already SELECT.
--
-- Tables added:
--   pdm.versions — auto-pull when a new version lands
--   pdm.locks    — show lock acquire/release without polling
--   pdm.files    — pick up new files appearing in the current folder

ALTER PUBLICATION supabase_realtime ADD TABLE pdm.versions;
ALTER PUBLICATION supabase_realtime ADD TABLE pdm.locks;
ALTER PUBLICATION supabase_realtime ADD TABLE pdm.files;
