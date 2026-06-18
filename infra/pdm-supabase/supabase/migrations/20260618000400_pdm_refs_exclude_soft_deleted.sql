-- v4.4.6 fix: ref resolution counts soft-deleted files in the basename match.
--
-- record_refs (20260530120000) and reresolve_refs_for_file (20260610200000)
-- resolve a child hint only when its basename has a UNIQUE match in the vault.
-- The count + lookup don't exclude soft-deleted (recycle-bin) files, so a
-- same-named file that was EVER deleted still counts toward the match: it makes
-- the live name look "ambiguous" (count >= 2) and the ref silently never
-- resolves -- Where-Used quietly fails. Add "and deleted_at is null" to every
-- count and lookup in both functions so only LIVE files participate. CREATE OR
-- REPLACE only; bodies otherwise unchanged. Idempotent.

create or replace function pdm.record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_vault_id uuid;
  v_hint text;
  v_base text;
  v_child_file uuid;
  v_child_ver uuid;
  v_match_count int;
  v_written int := 0;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  select f.vault_id into v_vault_id
  from pdm.versions v
  join pdm.files f on f.id = v.file_id
  where v.id = p_parent_version_id and v.author_id = v_caller;

  if v_vault_id is null then
    raise exception 'not authorized to record refs for version % (not author or not found)', p_parent_version_id;
  end if;

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
    v_child_ver := null;
    if v_match_count = 1 then
      select id, latest_version_id into v_child_file, v_child_ver
      from pdm.files
      where vault_id = v_vault_id and lower(name) = lower(v_base) and deleted_at is null;
    end if;

    insert into pdm.refs (parent_version_id, child_path_hint, child_file_id, child_version_id)
    values (p_parent_version_id, v_hint, v_child_file, v_child_ver)
    on conflict (parent_version_id, child_path_hint) do update
      set child_file_id = excluded.child_file_id,
          child_version_id = excluded.child_version_id;
    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

create or replace function pdm.reresolve_refs_for_file()
returns trigger language plpgsql security definer set search_path = pdm, public as $$
declare
  v_count int;
begin
  -- A soft-deleted file shouldn't (re)resolve refs to itself; if NEW is deleted,
  -- there is nothing to point at.
  if new.deleted_at is not null then
    return new;
  end if;

  -- Same rule as record_refs: only a UNIQUE case-insensitive basename match
  -- among LIVE files in the vault resolves.
  select count(*) into v_count
  from pdm.files
  where vault_id = new.vault_id and lower(name) = lower(new.name) and deleted_at is null;

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

  if new.latest_version_id is not null then
    update pdm.refs
    set child_version_id = new.latest_version_id
    where child_file_id = new.id and child_version_id is null;
  end if;

  return new;
end; $$;
