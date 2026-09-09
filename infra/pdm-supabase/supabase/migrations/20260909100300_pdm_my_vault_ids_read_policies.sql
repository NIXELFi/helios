-- Vault read policies: resolve the caller's vault membership ONCE per query.
--
-- pdm.is_member_in(vault_id) is a security-definer function taking a ROW
-- column, so Postgres must call it for every candidate row — 112 rows in
-- pdm.user_roles scanned again and again. Prod, 2026-09-09: 2.93 BILLION
-- sequential scans of pdm.user_roles (111 billion tuples) since 2026-05-07,
-- about 271 calls per second around the clock, and a versions count that
-- takes 11 ms as the owner took a mean of 1,434 ms under this policy.
--
-- Replace the per-row call with set membership against a row-independent
-- subquery: `vault_id in (select pdm.my_vault_ids())`. Being independent of
-- the row, the planner runs it once as a hashed SubPlan and probes the hash
-- per row.
--
-- EQUIVALENCE: my_vault_ids() returns exactly the vaults v for which
-- is_member_in(v) is true — a GLOBAL role row (vault_id null) grants every
-- vault, otherwise exactly the listed vaults; both read the same
-- pdm.user_roles rows for the same auth.uid(). The ONE difference is a NULL
-- vault id: is_member_in(NULL) is TRUE for a global role holder, while
-- `null in (...)` is NULL and therefore denies. That case is unreachable for
-- the rows these policies guard — files.vault_id and folders.vault_id are
-- NOT NULL with FKs to pdm.vaults, and versions/locks/refs resolve their
-- vault through file_vault_id/version_vault_id off NOT NULL FK columns, so a
-- row can only ever carry the id of a vault that exists.
--
-- Note this is a SET of ids, not a boolean: a caller with no roles gets an
-- empty set, so every row is denied, exactly as before.
create or replace function pdm.my_vault_ids()
returns setof uuid language sql stable security definer set search_path = pdm, public as $$
  select v.id from pdm.vaults v
  where exists (
    select 1 from pdm.user_roles ur
    where ur.user_id = (select auth.uid()) and (ur.vault_id is null or ur.vault_id = v.id)
  );
$$;
revoke all on function pdm.my_vault_ids() from public, anon;
grant execute on function pdm.my_vault_ids() to authenticated;

-- files: vault member AND (published or own draft) — the draft privacy from
-- 20260603100000 is unchanged.
drop policy if exists files_read on pdm.files;
create policy files_read on pdm.files for select to authenticated
  using (vault_id in (select pdm.my_vault_ids())
         and (published_at is not null or created_by = (select auth.uid())));

drop policy if exists folders_read on pdm.folders;
create policy folders_read on pdm.folders for select to authenticated
  using (vault_id in (select pdm.my_vault_ids()));

-- versions/locks carry file_id, refs carries parent_version_id → the vault
-- still resolves through the definer helpers (NOT an inline subquery on
-- pdm.files, which would run under the caller's files RLS and wrongly deny a
-- teammate's unpublished draft — see 20260610100000).
drop policy if exists versions_read on pdm.versions;
create policy versions_read on pdm.versions for select to authenticated
  using (pdm.file_vault_id(file_id) in (select pdm.my_vault_ids()));

drop policy if exists locks_read on pdm.locks;
create policy locks_read on pdm.locks for select to authenticated
  using (pdm.file_vault_id(file_id) in (select pdm.my_vault_ids()));

drop policy if exists refs_read on pdm.refs;
create policy refs_read on pdm.refs for select to authenticated
  using (pdm.version_vault_id(parent_version_id) in (select pdm.my_vault_ids()));

-- pdm.audit_log / pdm.user_roles / pdm.subteams read policies are deliberately
-- left alone: none of them calls is_member_in on a row column (audit_log tests
-- for any role row at all, user_roles uses is_admin_in, subteams is `true`),
-- and none of them is a table the app pages through. Write policies are
-- untouched throughout.
