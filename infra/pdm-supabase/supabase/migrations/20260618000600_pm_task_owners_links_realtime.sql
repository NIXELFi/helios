-- v4.4.6 (Support D's realtime fix): publish pm.task_owners and pm.task_links to
-- Supabase Realtime so co-owner and link changes propagate live, matching the
-- other core pm tables.
--
-- Both tables have UPDATE and DELETE paths (owner promotion/demotion, link
-- removal), so they need REPLICA IDENTITY FULL for the realtime layer to deliver
-- the full old row and evaluate RLS on UPDATE/DELETE. Each ADD TABLE is wrapped
-- in a DO block that swallows duplicate_object so the migration is safe to
-- re-run (mirrors 20260511000400). Idempotent.

alter table pm.task_owners replica identity full;
alter table pm.task_links  replica identity full;

do $$
begin
  alter publication supabase_realtime add table pm.task_owners;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table pm.task_links;
exception
  when duplicate_object then null;
end
$$;
