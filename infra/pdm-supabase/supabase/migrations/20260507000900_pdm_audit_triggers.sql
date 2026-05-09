-- Trigger: writing a row to pdm.locks => audit row.
create or replace function pdm.trg_locks_audit() returns trigger
language plpgsql
security definer
set search_path = pdm, public
as $$
begin
  if (TG_OP = 'INSERT') then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (NEW.user_id, 'check_out', 'lock', NEW.id, jsonb_build_object('file_id', NEW.file_id));
    return NEW;
  end if;
  return NEW;
end;
$$;

create trigger locks_audit_insert
  after insert on pdm.locks
  for each row execute function pdm.trg_locks_audit();

-- Update pdm.check_in to write its own audit row (we keep the trigger above for
-- pure direct inserts; check_in inserts a version row, which we audit separately).
create or replace function pdm.check_in(
  p_file_id uuid, p_sha256 text, p_size bigint, p_comment text
) returns pdm.versions
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_lock_id uuid;
  v_caller uuid := auth.uid();
  v_next_num int;
  v_parent_version uuid;
  v_new_version pdm.versions;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  select id into v_lock_id
  from pdm.locks
  where file_id = p_file_id and user_id = v_caller and released_at is null
  for update;

  if v_lock_id is null then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;

  select coalesce(max(version_num), 0) + 1, max(id)
  into v_next_num, v_parent_version
  from pdm.versions where file_id = p_file_id;

  insert into pdm.versions (
    file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id
  )
  values (p_file_id, v_next_num, p_sha256, p_size, v_caller, p_comment, v_parent_version)
  returning * into v_new_version;

  update pdm.files set latest_version_id = v_new_version.id where id = p_file_id;
  update pdm.locks set released_at = now() where id = v_lock_id;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (
    v_caller,
    'check_in',
    'version',
    v_new_version.id,
    jsonb_build_object('file_id', p_file_id, 'version_num', v_next_num, 'sha256', p_sha256)
  );

  return v_new_version;
end;
$$;

-- Update pdm.force_unlock to write an audit row with the reason.
create or replace function pdm.force_unlock(p_lock_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  if not pdm.is_admin() then raise exception 'admin role required to force-unlock'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason is required for force-unlock';
  end if;

  update pdm.locks
  set released_at = now(), force_released_by = v_caller
  where id = p_lock_id and released_at is null;

  if not found then raise exception 'lock % not active or not found', p_lock_id; end if;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (v_caller, 'force_unlock', 'lock', p_lock_id, jsonb_build_object('reason', p_reason));
end;
$$;

-- Update pdm.cancel_checkout similarly.
create or replace function pdm.cancel_checkout(p_file_id uuid) returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_lock_id uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;

  update pdm.locks
  set released_at = now()
  where file_id = p_file_id and user_id = v_caller and released_at is null
  returning id into v_lock_id;

  if v_lock_id is null then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (v_caller, 'cancel_checkout', 'lock', v_lock_id, jsonb_build_object('file_id', p_file_id));
end;
$$;
