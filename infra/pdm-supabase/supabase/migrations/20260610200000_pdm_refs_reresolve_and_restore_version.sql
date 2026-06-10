-- Wave 2 of the 2026-06-09 vault audit: two findings.
--
-- 1. REFS RE-RESOLUTION (HIGH bug): record_refs resolves hints only at the
--    parent's check-in. A child file added LATER never resolves — Where-Used
--    stays silently empty for assemblies checked in before their parts.
--    Fix: triggers on pdm.files re-run the same unique-basename rule when a
--    file is created (and when its first version lands, to pin
--    child_version_id), plus a one-time backfill for existing rows.
--
-- 2. RESTORE VERSION (HIGH missing feature): "Get this version" only
--    downloads a read-only copy; there was no way to make an old version
--    the latest again. pdm.restore_version() is a check-in of an old
--    version's content: requires the caller's active lock, creates the next
--    version pointing at the same content sha (no re-upload — storage is
--    content-addressed), carries the old version's data-card properties and
--    refs forward, releases the lock. Mirrors check_in's skip-unchanged path.

-- ---------------------------------------------------------------------------
-- 1a. Re-resolution trigger.
-- ---------------------------------------------------------------------------
create or replace function pdm.reresolve_refs_for_file()
returns trigger language plpgsql security definer set search_path = pdm, public as $$
declare
  v_count int;
begin
  -- Same rule as record_refs: only a UNIQUE case-insensitive basename match
  -- in the vault resolves. (Count includes this row — a second same-named
  -- file makes the name ambiguous and we leave existing refs untouched.)
  select count(*) into v_count
  from pdm.files
  where vault_id = new.vault_id and lower(name) = lower(new.name);

  if v_count = 1 then
    update pdm.refs r
    set child_file_id = new.id,
        child_version_id = coalesce(new.latest_version_id, r.child_version_id)
    from pdm.versions pv
    join pdm.files pf on pf.id = pv.file_id
    where pv.id = r.parent_version_id
      and pf.vault_id = new.vault_id
      and r.child_file_id is null
      and lower(regexp_replace(r.child_path_hint, '^.*[/\\]', '')) = lower(new.name);
  end if;

  -- First version landing (or any latest change): pin child_version_id on
  -- rows already resolved to this file that never got one (file existed
  -- before its first version when resolution happened at INSERT time).
  if new.latest_version_id is not null then
    update pdm.refs
    set child_version_id = new.latest_version_id
    where child_file_id = new.id and child_version_id is null;
  end if;

  return new;
end; $$;

drop trigger if exists refs_reresolve_on_file_insert on pdm.files;
create trigger refs_reresolve_on_file_insert
  after insert on pdm.files
  for each row execute function pdm.reresolve_refs_for_file();

drop trigger if exists refs_reresolve_on_file_latest on pdm.files;
create trigger refs_reresolve_on_file_latest
  after update of latest_version_id on pdm.files
  for each row
  when (new.latest_version_id is distinct from old.latest_version_id)
  execute function pdm.reresolve_refs_for_file();

-- The trigger probes unresolved hints by basename on every file create.
create index if not exists refs_unresolved_basename_idx
  on pdm.refs (lower(regexp_replace(child_path_hint, '^.*[/\\]', '')))
  where child_file_id is null;

-- ---------------------------------------------------------------------------
-- 1b. One-time backfill: resolve existing dangling hints whose basename now
--     has a unique match in the parent's vault.
-- ---------------------------------------------------------------------------
update pdm.refs r
set child_file_id = c.id,
    child_version_id = c.latest_version_id
from pdm.versions pv
join pdm.files pf on pf.id = pv.file_id
join pdm.files c on c.vault_id = pf.vault_id
where pv.id = r.parent_version_id
  and r.child_file_id is null
  and lower(c.name) = lower(regexp_replace(r.child_path_hint, '^.*[/\\]', ''))
  and (select count(*) from pdm.files c2
       where c2.vault_id = pf.vault_id and lower(c2.name) = lower(c.name)) = 1;

-- ---------------------------------------------------------------------------
-- 2. restore_version: make an old version the new latest.
-- ---------------------------------------------------------------------------
create or replace function pdm.restore_version(p_file_id uuid, p_version_id uuid)
returns pdm.versions
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_vault uuid;
  v_lock_id uuid;
  v_target pdm.versions;
  v_latest_id uuid;
  v_latest_sha text;
  v_next_num int;
  v_new pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  select vault_id into v_vault from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not pdm.can_edit_in(v_vault) then
    raise exception 'editor role required to restore a version';
  end if;

  -- Same contract as check_in: the caller must hold the active lock. A
  -- restore IS a check-in (of an old version's content), so it also
  -- releases the lock on success.
  select id into v_lock_id from pdm.locks
    where file_id = p_file_id and user_id = v_caller and released_at is null for update;
  if v_lock_id is null then
    raise exception 'check the file out first — restoring a version checks in that version''s content';
  end if;

  select * into v_target from pdm.versions
    where id = p_version_id and file_id = p_file_id;
  if v_target.id is null then
    raise exception 'version % not found on file %', p_version_id, p_file_id;
  end if;

  select id, sha256 into v_latest_id, v_latest_sha
    from pdm.versions where file_id = p_file_id order by version_num desc limit 1;

  -- Restoring the content that is already latest: release the lock, don't
  -- duplicate history (mirrors check_in's skip-unchanged path).
  if v_latest_sha is not null and lower(v_latest_sha) = lower(v_target.sha256) then
    update pdm.locks set released_at = now() where id = v_lock_id;
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (v_caller, 'restore_version', 'version', v_latest_id,
        jsonb_build_object('file_id', p_file_id, 'restored_from_version_num', v_target.version_num, 'unchanged', true));
    select * into v_new from pdm.versions where id = v_latest_id;
    return v_new;
  end if;

  select coalesce(max(version_num), 0) + 1 into v_next_num
    from pdm.versions where file_id = p_file_id;

  -- Content is already in the bucket under this sha (content-addressed), so
  -- no upload happens anywhere in this flow. The old version's data card
  -- (properties) rides along; its refs are copied below — both describe the
  -- CONTENT, which is byte-identical.
  insert into pdm.versions (file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id, properties)
    values (p_file_id, v_next_num, v_target.sha256, v_target.size_bytes, v_caller,
            'Restored from v' || v_target.version_num
              || coalesce(' — ' || nullif(trim(v_target.comment), ''), ''),
            v_latest_id, v_target.properties)
    returning * into v_new;

  insert into pdm.refs (parent_version_id, child_path_hint, child_file_id, child_version_id)
    select v_new.id, child_path_hint, child_file_id, child_version_id
    from pdm.refs where parent_version_id = v_target.id;

  update pdm.files
     set latest_version_id = v_new.id, published_at = coalesce(published_at, now())
   where id = p_file_id;
  update pdm.locks set released_at = now() where id = v_lock_id;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'restore_version', 'version', v_new.id,
      jsonb_build_object('file_id', p_file_id, 'version_num', v_next_num,
                         'restored_from_version_id', p_version_id,
                         'restored_from_version_num', v_target.version_num,
                         'sha256', v_target.sha256));
  return v_new;
end; $$;

-- pdm-schema alias (desktop client uses db.schema='pdm') + public proxy.
create or replace function pdm.pdm_restore_version(p_file_id uuid, p_version_id uuid)
returns pdm.versions language sql security definer set search_path = pdm, public
as $$ select pdm.restore_version(p_file_id, p_version_id); $$;
create or replace function public.pdm_restore_version(p_file_id uuid, p_version_id uuid)
returns pdm.versions language sql security definer set search_path = pdm, public
as $$ select pdm.restore_version(p_file_id, p_version_id); $$;

revoke all on function pdm.restore_version(uuid, uuid) from public, anon;
revoke all on function pdm.pdm_restore_version(uuid, uuid) from public, anon;
revoke all on function public.pdm_restore_version(uuid, uuid) from public, anon;
grant execute on function pdm.restore_version(uuid, uuid) to authenticated;
grant execute on function pdm.pdm_restore_version(uuid, uuid) to authenticated;
grant execute on function public.pdm_restore_version(uuid, uuid) to authenticated;
