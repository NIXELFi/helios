-- v4.4.6 / post-release reconciliation: this migration now MIRRORS the
-- task_owners owner-sync trigger that is actually LIVE on prod.
--
-- Background: prod had already received two task_owners trigger fixes that were
-- never committed to this repo -- prod ledger migrations 20260618004103
-- (pm_task_owners_fix_sync_order) and 20260618004807
-- (pm_task_owners_primary_replace_semantics). Prod's deliberate design is
-- "replace the owner": changing a task's Owner from A to B REMOVES A's primary
-- membership entirely (other co-owners persist). The ORIGINAL version of this
-- file instead DEMOTED A to a co-owner -- a different UX -- so it was NOT applied
-- to prod (it would have regressed prod's design) and is recorded in the prod
-- migration ledger as a no-op. This file is rewritten to the exact prod trigger
-- so a fresh rebuild reproduces prod, and so this migration can never overwrite
-- the live 004807 definition.
--
-- NOTE: the narrow "two is_primary rows from a stale membership" edge case the
-- audit flagged is intentionally NOT addressed here -- fixing it would need a
-- separate, reconciled change on top of prod's replace-semantics design.

create or replace function pm.sync_owner_to_task_owners()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'pm', 'public'
as $$
begin
  -- Drop the prior PRIMARY membership when the primary owner changes or is
  -- cleared. Co-owner rows (is_primary=false) are left untouched, so the Owner
  -- dropdown has familiar "replace the owner" semantics while co-owners persist.
  if tg_op = 'UPDATE' and old.owner_id is not null and old.owner_id is distinct from new.owner_id then
    delete from pm.task_owners where task_id = new.id and owner_id = old.owner_id and is_primary;
  end if;
  if new.owner_id is not null then
    insert into pm.task_owners (task_id, owner_id, is_primary)
      values (new.id, new.owner_id, true)
      on conflict (task_id, owner_id) do update set is_primary = true;
  end if;
  return null;
end; $$;
