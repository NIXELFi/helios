-- Revisions: a human-meaningful revision number stamped onto a specific
-- version, distinct from the auto-incrementing version_num. Numeric scheme
-- (1, 2, 3 …), advanced MANUALLY by an editor via "Set Revision" (SW-PDM's
-- Set Revision command). No workflow / state machine — a revision is just
-- stamped on demand onto the file's current latest version.

alter table pdm.versions add column if not exists revision int;

-- At most one version per file may carry a given revision number.
create unique index if not exists versions_file_revision_unique
  on pdm.versions(file_id, revision) where revision is not null;

-- Stamp a revision onto a file's latest version. With p_revision NULL the next
-- number is auto-assigned (max for the file + 1, starting at 1); an explicit
-- value is used as-is (must be positive and not collide with an existing
-- revision for that file — enforced by the unique index). Editor+ only.
create or replace function pdm.set_revision(p_file_id uuid, p_revision int default null)
returns pdm.versions
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_latest uuid;
  v_next int;
  v_result pdm.versions;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;
  select role into v_role from pdm.user_roles where user_id = v_caller;
  if v_role is null or v_role not in ('owner', 'admin', 'editor') then
    raise exception 'editor role required to set revision';
  end if;

  select latest_version_id into v_latest from pdm.files where id = p_file_id;
  if v_latest is null then
    raise exception 'file % has no version to stamp a revision on', p_file_id;
  end if;

  if p_revision is not null then
    if p_revision <= 0 then
      raise exception 'revision must be a positive integer';
    end if;
    v_next := p_revision;
  else
    select coalesce(max(revision), 0) + 1 into v_next from pdm.versions where file_id = p_file_id;
  end if;

  update pdm.versions set revision = v_next where id = v_latest
  returning * into v_result;

  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
  values (v_caller, 'set_revision', 'version', v_latest,
          jsonb_build_object('file_id', p_file_id, 'revision', v_next));

  return v_result;
end;
$$;

-- public proxy + pdm-schema alias (clients use db.schema='pdm').
create or replace function public.pdm_set_revision(p_file_id uuid, p_revision int default null)
returns pdm.versions
language sql security definer set search_path = pdm, public
as $$ select pdm.set_revision(p_file_id, p_revision); $$;

create or replace function pdm.pdm_set_revision(p_file_id uuid, p_revision int default null)
returns pdm.versions
language sql security definer set search_path = pdm, public
as $$ select pdm.set_revision(p_file_id, p_revision); $$;

revoke all on function pdm.set_revision(uuid, int) from public, anon;
revoke all on function public.pdm_set_revision(uuid, int) from public, anon;
revoke all on function pdm.pdm_set_revision(uuid, int) from public, anon;
grant execute on function pdm.set_revision(uuid, int) to authenticated;
grant execute on function public.pdm_set_revision(uuid, int) to authenticated;
grant execute on function pdm.pdm_set_revision(uuid, int) to authenticated;
