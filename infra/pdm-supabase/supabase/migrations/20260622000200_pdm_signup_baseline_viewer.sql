-- C-1 security fix: auto-provision trigger granted every open self-signup an
-- immediate GLOBAL 'editor' role (vault_id IS NULL).
--
-- With enable_signup=true and enable_confirmations=false, anyone holding the
-- public anon key could self-register, log in instantly, and — because the
-- baseline role was a GLOBAL editor — immediately list/download every file in
-- the production vault AND upload/modify files in ANY vault (can_edit_in accepts
-- a vault_id IS NULL row for every vault; the storage SELECT/INSERT policies are
-- satisfied by any role row). This re-opened exactly the critical hole that
-- 20260511000700 was written to close.
--
-- Fix: change the auto-provisioned baseline from 'editor' to 'viewer'. A fresh
-- account can then read (still gated by RLS / role presence) but CANNOT
-- upload/modify until an admin promotes it. The trigger keeps the same
-- error-swallowing + ON CONFLICT DO NOTHING posture so it never blocks signup
-- and never overwrites a curated role.
--
-- CREATE OR REPLACE on pdm.handle_new_user() only. We deliberately do NOT
-- re-run a backfill: existing accounts keep whatever role they already have
-- (the 20260619000700 backfill already ran), and ON CONFLICT DO NOTHING means
-- this never demotes anyone. Idempotent.

create or replace function pdm.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  -- Baseline is now 'viewer' (no upload/modify). An admin promotes officers /
  -- subteam leads / members to editor/admin via the Role Editor. We deliberately
  -- do NOT auto-grant editor/admin/owner: the signup 'subteam' lives in
  -- user-controlled raw_user_meta_data, so promoting on it would let anyone
  -- self-select a privileged role and escalate.
  insert into pdm.user_roles (user_id, vault_id, role, granted_at)
  values (new.id, null, 'viewer', now())
  on conflict (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do nothing;
  return new;
exception
  when others then
    -- Never block signup on a provisioning failure; surface it in the logs.
    raise warning 'pdm.handle_new_user: failed to provision role for % : %', new.id, sqlerrm;
    return new;
end;
$$;
