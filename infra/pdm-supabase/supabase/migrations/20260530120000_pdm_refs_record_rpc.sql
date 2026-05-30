-- Assembly references: let a check-in record its child references.
-- pdm.refs already exists (parent_version_id, child_path_hint, child_file_id);
-- add version pinning, then a SECURITY DEFINER RPC the client calls after a
-- successful check_in. Clients still cannot write pdm.refs directly (RLS).

alter table pdm.refs
  add column if not exists child_version_id uuid references pdm.versions(id) on delete set null;

-- Record (replace) the references for a parent version the caller just authored.
-- Each hint is resolved to a file in the SAME vault by basename (case-insensitive);
-- a UNIQUE basename match pins child_file_id + child_version_id (the child's
-- current latest version). Zero / ambiguous matches keep the raw hint with NULL
-- child ids ("unresolved"). Returns the number of ref rows written.
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

  -- Only the author of the parent version may record its references (the
  -- version was just created by this caller's check_in / add_and_lock).
  select f.vault_id into v_vault_id
  from pdm.versions v
  join pdm.files f on f.id = v.file_id
  where v.id = p_parent_version_id and v.author_id = v_caller;

  if v_vault_id is null then
    raise exception 'not authorized to record refs for version % (not author or not found)', p_parent_version_id;
  end if;

  -- Idempotent: clear any prior refs for this parent version, then re-insert.
  delete from pdm.refs where parent_version_id = p_parent_version_id;

  foreach v_hint in array coalesce(p_child_hints, array[]::text[]) loop
    -- basename: last segment after '/' or '\'.
    v_base := regexp_replace(v_hint, '^.*[/\\]', '');
    if v_base is null or length(trim(v_base)) = 0 then
      continue;
    end if;

    select count(*) into v_match_count
    from pdm.files
    where vault_id = v_vault_id and lower(name) = lower(v_base);

    v_child_file := null;
    v_child_ver := null;
    if v_match_count = 1 then
      select id, latest_version_id into v_child_file, v_child_ver
      from pdm.files
      where vault_id = v_vault_id and lower(name) = lower(v_base);
    end if;

    -- PK is (parent_version_id, child_path_hint); guard against duplicate
    -- hints in the input array.
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

-- Public-schema proxy (clients on the public schema).
create or replace function public.pdm_record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language sql
security definer
set search_path = pdm, public
as $$ select pdm.record_refs(p_parent_version_id, p_child_hints); $$;

-- pdm-schema alias: supabase-js clients (tests + desktop app) set
-- db.schema='pdm', so client.rpc('pdm_record_refs') resolves here.
create or replace function pdm.pdm_record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language sql
security definer
set search_path = pdm, public
as $$ select pdm.record_refs(p_parent_version_id, p_child_hints); $$;

revoke all on function pdm.record_refs(uuid, text[]) from public, anon;
revoke all on function public.pdm_record_refs(uuid, text[]) from public, anon;
revoke all on function pdm.pdm_record_refs(uuid, text[]) from public, anon;
grant execute on function pdm.record_refs(uuid, text[]) to authenticated;
grant execute on function public.pdm_record_refs(uuid, text[]) to authenticated;
grant execute on function pdm.pdm_record_refs(uuid, text[]) to authenticated;
