-- 2026-06-19 refs lifecycle fixes — three audit findings.
--
-- H7 (HIGH): refs re-resolve triggers don't fire on deleted_at changes.
--   delete_file / restore_file UPDATE deleted_at but the two existing triggers
--   only fire on INSERT or UPDATE OF latest_version_id.  As a result:
--     • After delete_file the child ref still shows as resolved (child_file_id
--       is non-null even though the child is in the recycle bin).
--     • After restore_file the dangling refs stay broken until the next
--       latest_version_id bump.
--   Fix: new trigger function + AFTER UPDATE OF deleted_at trigger.
--     – On delete (deleted_at becomes NOT NULL): null out child_file_id and
--       child_version_id on every ref that points at this file as a child.
--     – On restore (deleted_at becomes NULL): re-run the exact same forward-
--       resolution logic as reresolve_refs_for_file() so dangling hints whose
--       basename now matches this (uniquely-named) live file get resolved.
--       Reuses the trigger-body logic inline rather than calling the other
--       trigger function (which returns NEW — not directly callable as a plain
--       function).
--
-- M9 (MED): restore_version copies stale child_version_id refs verbatim.
--   restore_version (20260610200000) inserts child refs copied from the old
--   target version.  Those rows already have child_file_id set, so the
--   reresolve_refs_for_file trigger that fires afterwards (via the
--   latest_version_id update) only touches rows WHERE child_file_id IS NULL —
--   it skips the just-inserted rows.  The new version therefore pins child
--   versions from the past.
--   Fix: after copying the old refs in restore_version, immediately update
--   child_version_id to each child file's current latest_version_id for any
--   child file that is still live (deleted_at is null and latest_version_id is
--   not null).
--
-- M11 (MED): record_refs rejects versions whose author_id IS NULL (imported).
--   import_version (20260524000000) sets author_id = NULL because no Supabase
--   user corresponds to the external system actor.  record_refs joins on
--   v.author_id = v_caller; NULL = UUID is never TRUE, so v_vault_id stays
--   null and the function raises "not authorized" for any imported version.
--   Fix: relax the lookup so that a vault editor/admin can also record refs for
--   a version they did NOT author — the existing auth.uid() check and the
--   can_edit_in() gate preserve the security intent (the caller must be an
--   authenticated, authorised member of the vault; they just aren't the
--   author).  The original guard remains for normal (non-null author_id)
--   versions so authors-only semantics are preserved where applicable.

-- ---------------------------------------------------------------------------
-- H7: trigger function for deleted_at changes.
-- ---------------------------------------------------------------------------
create or replace function pdm.handle_file_deleted_at_change()
returns trigger language plpgsql security definer set search_path = pdm, public as $$
declare
  v_count int;
begin
  -- ── File was soft-deleted ─────────────────────────────────────────────────
  -- Null out child_file_id + child_version_id on every ref that names this
  -- file as its child, so the UI sees those refs as unresolved/deleted.
  if new.deleted_at is not null and old.deleted_at is null then
    update pdm.refs
    set child_file_id = null,
        child_version_id = null
    where child_file_id = new.id;
    return new;
  end if;

  -- ── File was restored from the recycle bin ────────────────────────────────
  -- Re-run the same unique-basename resolution the insert/latest triggers use:
  -- only resolve when this file is the SOLE live file with this basename in the
  -- vault.  (If another live file has the same name, leave hints unresolved —
  -- identical to the behaviour in reresolve_refs_for_file.)
  if new.deleted_at is null and old.deleted_at is not null then
    select count(*) into v_count
    from pdm.files
    where vault_id = new.vault_id
      and lower(name) = lower(new.name)
      and deleted_at is null;

    if v_count = 1 then
      update pdm.refs r
      set child_file_id   = new.id,
          child_version_id = coalesce(new.latest_version_id, r.child_version_id)
      from pdm.versions pv
      join pdm.files    pf on pf.id = pv.file_id
      where pv.id = r.parent_version_id
        and pf.vault_id = new.vault_id
        and r.child_file_id is null
        and lower(regexp_replace(r.child_path_hint, '^.*[/\\]', '')) = lower(new.name);
    end if;

    -- Also pin child_version_id on any ref that was already resolved to this
    -- file but lacked a version pin (e.g. was resolved while the file had no
    -- version yet).
    if new.latest_version_id is not null then
      update pdm.refs
      set child_version_id = new.latest_version_id
      where child_file_id = new.id and child_version_id is null;
    end if;
  end if;

  return new;
end; $$;

drop trigger if exists refs_reresolve_on_file_deleted_at on pdm.files;
create trigger refs_reresolve_on_file_deleted_at
  after update of deleted_at on pdm.files
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function pdm.handle_file_deleted_at_change();

-- ---------------------------------------------------------------------------
-- M9: restore_version — re-pin child_version_id to current latest after copy.
-- ---------------------------------------------------------------------------
create or replace function pdm.restore_version(p_file_id uuid, p_version_id uuid)
returns pdm.versions
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller    uuid := auth.uid();
  v_vault     uuid;
  v_lock_id   uuid;
  v_target    pdm.versions;
  v_latest_id uuid;
  v_latest_sha text;
  v_next_num  int;
  v_new       pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  select vault_id into v_vault from pdm.files where id = p_file_id;
  if v_vault is null then raise exception 'file not found'; end if;
  if not pdm.can_edit_in(v_vault) then
    raise exception 'editor role required to restore a version';
  end if;

  -- Caller must hold the active lock (restore IS a check-in).
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

  -- Already-latest content: no-op path (mirrors check_in skip-unchanged).
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

  insert into pdm.versions (file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id, properties)
    values (p_file_id, v_next_num, v_target.sha256, v_target.size_bytes, v_caller,
            'Restored from v' || v_target.version_num
              || coalesce(' — ' || nullif(trim(v_target.comment), ''), ''),
            v_latest_id, v_target.properties)
    returning * into v_new;

  -- Copy the old version's refs forward.  Then immediately re-pin
  -- child_version_id to each child's CURRENT latest so the restored version
  -- doesn't carry stale version pointers from the past.
  insert into pdm.refs (parent_version_id, child_path_hint, child_file_id, child_version_id)
    select v_new.id, child_path_hint, child_file_id, child_version_id
    from pdm.refs where parent_version_id = v_target.id;

  -- M9 fix: update child_version_id to current latest for every live child.
  update pdm.refs r
  set child_version_id = cf.latest_version_id
  from pdm.files cf
  where r.parent_version_id = v_new.id
    and r.child_file_id = cf.id
    and cf.deleted_at is null
    and cf.latest_version_id is not null
    and cf.latest_version_id is distinct from r.child_version_id;

  update pdm.files
     set latest_version_id = v_new.id,
         published_at = coalesce(published_at, now())
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

-- Re-apply the public + pdm-schema aliases (unchanged bodies — just proxies).
create or replace function pdm.pdm_restore_version(p_file_id uuid, p_version_id uuid)
returns pdm.versions language sql security definer set search_path = pdm, public
as $$ select pdm.restore_version(p_file_id, p_version_id); $$;
create or replace function public.pdm_restore_version(p_file_id uuid, p_version_id uuid)
returns pdm.versions language sql security definer set search_path = pdm, public
as $$ select pdm.restore_version(p_file_id, p_version_id); $$;

revoke all on function pdm.restore_version(uuid, uuid)        from public, anon;
revoke all on function pdm.pdm_restore_version(uuid, uuid)    from public, anon;
revoke all on function public.pdm_restore_version(uuid, uuid) from public, anon;
grant execute on function pdm.restore_version(uuid, uuid)        to authenticated;
grant execute on function pdm.pdm_restore_version(uuid, uuid)    to authenticated;
grant execute on function public.pdm_restore_version(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- M11: record_refs — allow authorised vault members to record refs for
--      imported versions (author_id IS NULL).
-- ---------------------------------------------------------------------------
create or replace function pdm.record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller      uuid := auth.uid();
  v_vault_id    uuid;
  v_hint        text;
  v_base        text;
  v_child_file  uuid;
  v_child_ver   uuid;
  v_match_count int;
  v_written     int := 0;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  -- Primary path: caller is the author of the version (normal check-in flow).
  select f.vault_id into v_vault_id
  from pdm.versions v
  join pdm.files f on f.id = v.file_id
  where v.id = p_parent_version_id
    and v.author_id = v_caller;

  -- M11 fix: fallback path for imported versions (author_id IS NULL).
  -- Any authenticated vault editor or admin may record refs for an imported
  -- version.  pdm.can_edit_in() enforces the role gate.
  if v_vault_id is null then
    select f.vault_id into v_vault_id
    from pdm.versions v
    join pdm.files f on f.id = v.file_id
    where v.id = p_parent_version_id
      and v.author_id is null;

    if v_vault_id is not null then
      -- Confirm the caller has edit rights in this vault.
      if not pdm.can_edit_in(v_vault_id) then
        raise exception 'not authorized to record refs for version % (not author or not found)', p_parent_version_id;
      end if;
    end if;
  end if;

  if v_vault_id is null then
    raise exception 'not authorized to record refs for version % (not author or not found)', p_parent_version_id;
  end if;

  -- Idempotent: clear any prior refs for this parent version, then re-insert.
  delete from pdm.refs where parent_version_id = p_parent_version_id;

  foreach v_hint in array coalesce(p_child_hints, array[]::text[]) loop
    v_base := regexp_replace(v_hint, '^.*[/\\]', '');
    if v_base is null or length(trim(v_base)) = 0 then
      continue;
    end if;

    -- Only LIVE files count toward the unique-basename rule.
    select count(*) into v_match_count
    from pdm.files
    where vault_id = v_vault_id and lower(name) = lower(v_base) and deleted_at is null;

    v_child_file := null;
    v_child_ver  := null;
    if v_match_count = 1 then
      select id, latest_version_id into v_child_file, v_child_ver
      from pdm.files
      where vault_id = v_vault_id and lower(name) = lower(v_base) and deleted_at is null;
    end if;

    insert into pdm.refs (parent_version_id, child_path_hint, child_file_id, child_version_id)
    values (p_parent_version_id, v_hint, v_child_file, v_child_ver)
    on conflict (parent_version_id, child_path_hint) do update
      set child_file_id    = excluded.child_file_id,
          child_version_id = excluded.child_version_id;
    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

-- Re-apply the public + pdm-schema proxies (bodies unchanged).
create or replace function public.pdm_record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language sql
security definer
set search_path = pdm, public
as $$ select pdm.record_refs(p_parent_version_id, p_child_hints); $$;

create or replace function pdm.pdm_record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language sql
security definer
set search_path = pdm, public
as $$ select pdm.record_refs(p_parent_version_id, p_child_hints); $$;

revoke all on function pdm.record_refs(uuid, text[])         from public, anon;
revoke all on function public.pdm_record_refs(uuid, text[])  from public, anon;
revoke all on function pdm.pdm_record_refs(uuid, text[])     from public, anon;
grant execute on function pdm.record_refs(uuid, text[])        to authenticated;
grant execute on function public.pdm_record_refs(uuid, text[]) to authenticated;
grant execute on function pdm.pdm_record_refs(uuid, text[])    to authenticated;
