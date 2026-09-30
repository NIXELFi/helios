-- The SOLIDWORKS add-in bridge needs id/vault/folder/name/latest for every
-- live file the caller can read, across ALL vaults, to build its path map.
-- Under RLS that was 14 paginated requests at a mean of 207 ms each (383k
-- calls, 22 hours of database time in 123 days) because files_read ran a
-- membership check per row on every page.
--
-- Same shape as the previous pull, same visibility rule (published, or the
-- caller's own draft — pdm.files_read's exact predicate), but the membership
-- set is computed once and the scan is a single indexed pass as the definer.
-- The `order by id` matches the paginated builder it replaces, so the
-- range-based paging in fetchAllRows keeps working unchanged.
create or replace function pdm.bridge_live_files()
returns table (id uuid, vault_id uuid, folder_id uuid, name text, latest_version_id uuid)
language sql stable security definer set search_path = pdm, public as $$
  select f.id, f.vault_id, f.folder_id, f.name, f.latest_version_id
  from pdm.files f
  where f.deleted_at is null
    and f.vault_id in (select pdm.my_vault_ids())
    and (f.published_at is not null or f.created_by = (select auth.uid()))
  order by f.id;
$$;
revoke all on function pdm.bridge_live_files() from public, anon;
grant execute on function pdm.bridge_live_files() to authenticated;
