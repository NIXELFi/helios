-- Keep the signup subteam picker's pdm.subteams half in step with the org
-- registry (audit M1 follow-through), and retire the orphaned legacy picker
-- RPCs.
--
-- The signup picker reads public.list_signup_subteams(), a de-duplicated
-- UNION of pdm.subteams (the 20260529010000 seed list) and pm.subteams (the
-- canonical org registry) since 20260621000000 — so subteams CREATED in Org
-- Structure already appear at signup. What drifts is the pdm half: RENAMING a
-- registry subteam leaves its old name still offered by a matching pdm seed
-- row, and DELETING one leaves the pdm row offering a subteam that no longer
-- exists. The only UI that could ever fix pdm.subteams was the vault
-- AdminScreen — orphaned since the Org module shipped, deleted in this
-- change.
--
-- Fix: an AFTER trigger ON pm.subteams mirrors changes into pdm.subteams BY
-- NAME. A trigger rather than editing the pm RPCs (20260617006000) because
-- the registry has TWO writers: those RPCs AND the PM module's subteam
-- editor, which updates pm.subteams by direct DML (pm/lib/mutations.ts) —
-- RPC-level sync would silently miss half the writes.
--   * insert → offer the name in the pdm half too (harmless overlap with the
--     union, keeps the halves consistent)
--   * rename → follow; if the new name already exists in pdm, drop the stale
--     old row instead (merge)
--   * delete → remove the name from the pdm half
-- The pm 'Unknown' repair sentinel (20260618000000) is skipped throughout —
-- list_signup_subteams filters it, and mirroring it into pdm.subteams (which
-- has no such filter) would leak it to any direct reader. Existing pdm-only
-- rows (legacy seed names with no registry counterpart) are left alone:
-- signup subteams are stored as plain text in auth metadata, nothing
-- references pdm.subteams rows by id.
-- SECURITY DEFINER: pm writers (org.manage_structure holders / pm admins via
-- RLS) hold no DML grant on pdm.subteams, and shouldn't.

create or replace function pm.trg_subteams_sync_signup_picker()
returns trigger
language plpgsql
security definer
set search_path = pm, pdm, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.name <> 'Unknown' then
      insert into pdm.subteams (name, sort_order, created_by)
        select new.name, coalesce(max(sort_order), 0) + 1, new.created_by from pdm.subteams
        on conflict (name) do nothing;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.name is distinct from new.name and old.name <> 'Unknown' and new.name <> 'Unknown' then
      begin
        update pdm.subteams set name = new.name where name = old.name;
      exception when unique_violation then
        delete from pdm.subteams where name = old.name;
      end;
    end if;
    return new;
  else
    if old.name <> 'Unknown' then
      delete from pdm.subteams where name = old.name;
    end if;
    return old;
  end if;
end;
$$;

drop trigger if exists subteams_sync_signup_picker on pm.subteams;
create trigger subteams_sync_signup_picker
  after insert or update of name or delete on pm.subteams
  for each row execute function pm.trg_subteams_sync_signup_picker();

-- One-time cleanup of drift that already happened: pdm rows whose name is a
-- FORMER registry name have no way to be identified retroactively, but rows
-- shadow-deleted registry names can't be told apart from intentional
-- pdm-only seeds — so no destructive backfill. Going forward the trigger
-- keeps the halves aligned.

-- ---------------------------------------------------------------------------
-- Retire the legacy pdm picker RPCs (create_subteam/delete_subteam,
-- 20260529010000). Their only UI was the deleted AdminScreen, no released
-- client can reach them, and they still gate on the UNSCOPED pdm.is_admin()
-- (the C-3 class 20260622000100 fixed elsewhere) — so a per-vault admin
-- could perturb the signup picker directly. Functions stay (dropping would
-- break nothing but this is additive-only); execution rights go.
-- ---------------------------------------------------------------------------
revoke all on function pdm.create_subteam(text)          from public, anon, authenticated;
revoke all on function pdm.delete_subteam(uuid)          from public, anon, authenticated;
revoke all on function pdm.pdm_create_subteam(text)      from public, anon, authenticated;
revoke all on function pdm.pdm_delete_subteam(uuid)      from public, anon, authenticated;
revoke all on function public.pdm_create_subteam(text)   from public, anon, authenticated;
revoke all on function public.pdm_delete_subteam(uuid)   from public, anon, authenticated;
