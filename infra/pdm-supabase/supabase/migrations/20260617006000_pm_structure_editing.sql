-- Phase 1g: make the org structure fully editable from the Admin module.
--  * pm.projects gains an editable `program` (ic/ev) so the EV vs IC split is
--    explicit data, not guessed from the name.
--  * Guarded RPCs (org.manage_structure) to create/rename/delete subteams
--    (restores the subteam management lost when the Vault admin panel was removed)
--    and to set a project's program. Subteams stay GLOBAL; per-car membership is
--    the project_subteams map, so "EV Chassis" + "IC Chassis" = two subteams each
--    mapped to their car. Idempotent.

alter table pm.projects add column if not exists program text check (program in ('ic', 'ev'));
update pm.projects set program = 'ev' where car_code = 'SDM27e' and program is null;
update pm.projects set program = 'ic' where car_code in ('SDM26', 'SDM27') and program is null;

create or replace function pm.set_project_program(p_project_id uuid, p_program text)
returns void language plpgsql security definer set search_path = pm, public as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(auth.uid(), 'org.manage_structure', null) then
    raise exception 'not authorized to edit org structure' using errcode = '42501';
  end if;
  if p_program is not null and p_program not in ('ic', 'ev') then
    raise exception 'invalid program %', p_program using errcode = '22023';
  end if;
  update pm.projects set program = p_program, updated_at = now() where id = p_project_id;
end; $$;

-- Create a subteam (optionally mapping it to a car in one step).
create or replace function pm.create_subteam(p_name text, p_code text, p_color text, p_project_id uuid default null)
returns uuid language plpgsql security definer set search_path = pm, public as $$
declare v_id uuid; v_code text; v_slug text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(auth.uid(), 'org.manage_structure', null) then
    raise exception 'not authorized to edit org structure' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'subteam name is required' using errcode = '22023'; end if;
  v_code := upper(coalesce(nullif(btrim(p_code), ''), left(regexp_replace(p_name, '[^a-zA-Z0-9]', '', 'g'), 4)));
  v_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
  -- keep slug unique (it keys per-scope dashboard configs)
  if exists (select 1 from pm.subteams where slug = v_slug) then
    v_slug := v_slug || '-' || substr(gen_random_uuid()::text, 1, 4);
  end if;
  insert into pm.subteams (name, code, slug, color, created_by)
    values (btrim(p_name), v_code, v_slug, nullif(btrim(p_color), ''), auth.uid())
    returning id into v_id;
  if p_project_id is not null then
    insert into pm.project_subteams (project_id, subteam_id) values (p_project_id, v_id) on conflict do nothing;
  end if;
  return v_id;
end; $$;

create or replace function pm.update_subteam(p_id uuid, p_name text, p_color text)
returns void language plpgsql security definer set search_path = pm, public as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(auth.uid(), 'org.manage_structure', null) then
    raise exception 'not authorized to edit org structure' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'subteam name is required' using errcode = '22023'; end if;
  -- slug is intentionally left stable (it keys saved dashboard layouts).
  update pm.subteams set name = btrim(p_name), color = nullif(btrim(p_color), ''), updated_at = now() where id = p_id;
end; $$;

-- Delete a subteam, but only when nothing depends on it (the caller reassigns first).
create or replace function pm.delete_subteam(p_id uuid)
returns void language plpgsql security definer set search_path = pm, public as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(auth.uid(), 'org.manage_structure', null) then
    raise exception 'not authorized to edit org structure' using errcode = '42501';
  end if;
  if exists (select 1 from pm.tasks where subteam_id = p_id) then
    raise exception 'this subteam still has tasks — reassign them first' using errcode = '42501';
  end if;
  if exists (select 1 from pm.subsystems where subteam_id = p_id) then
    raise exception 'this subteam still has subsystems — remove them first' using errcode = '42501';
  end if;
  if exists (select 1 from pm.role_memberships where subteam_id = p_id) then
    raise exception 'this subteam still has members — reassign them first' using errcode = '42501';
  end if;
  delete from pm.project_subteams where subteam_id = p_id;
  delete from pm.subteams where id = p_id;
end; $$;

grant execute on function
  pm.set_project_program(uuid, text),
  pm.create_subteam(text, text, text, uuid),
  pm.update_subteam(uuid, text, text),
  pm.delete_subteam(uuid)
  to authenticated;
