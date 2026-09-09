-- Vault change-signature in ONE request instead of four RLS'd exact counts.
--
-- Measured in prod (pg_stat_statements, 123 days to 2026-09-09): the four
-- head-count requests behind useVaultCursor were 37.7% of ALL database time,
-- and the versions count alone (387k calls, mean 1,434 ms, ~1M buffers/call)
-- was 32%. The cost is not the counting — it is RLS: versions_read /
-- files_read call pdm.is_member_in() ONCE PER ROW, which is why
-- pdm.user_roles (112 rows) had accumulated 2.93 BILLION sequential scans.
-- The same counts run as the table owner take 11 ms.
--
-- So: check membership ONCE here, then count without RLS as the definer.
--
-- The counts are a CHANGE SIGNAL ONLY. They deliberately include rows RLS
-- would hide from the caller (another user's unpublished draft file), so they
-- are NOT a row count the caller is entitled to see — the client compares
-- signatures and never displays these numbers. A non-member gets all zeros,
-- which is a stable signature, so a non-member never triggers a reconcile.
create or replace function pdm.vault_cursor(p_vault_id uuid)
returns table (live_files bigint, versions bigint, live_folders bigint, active_locks bigint)
language sql stable security definer set search_path = pdm, public as $$
  select
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.files f where f.vault_id = p_vault_id and f.deleted_at is null) else 0 end,
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.versions v join pdm.files f on f.id = v.file_id where f.vault_id = p_vault_id) else 0 end,
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.folders fo where fo.vault_id = p_vault_id and fo.deleted_at is null) else 0 end,
    case when pdm.is_member_in(p_vault_id) then
      (select count(*) from pdm.locks l join pdm.files f on f.id = l.file_id where f.vault_id = p_vault_id and l.released_at is null) else 0 end;
$$;
revoke all on function pdm.vault_cursor(uuid) from public, anon;
grant execute on function pdm.vault_cursor(uuid) to authenticated;
