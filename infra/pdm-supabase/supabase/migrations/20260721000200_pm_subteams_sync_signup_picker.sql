-- Keep the signup subteam picker in step with the org registry (audit M1).
--
-- Two subteam tables exist: pm.subteams (the canonical org registry, edited in
-- the Org Structure panel) and pdm.subteams (the anon-readable list the signup
-- screen's picker reads, 20260529010000). The only UI that ever managed
-- pdm.subteams was the vault AdminScreen — orphaned since the Org module
-- shipped and now deleted — so the picker list could silently drift from the
-- real org: a subteam created in Org Structure never became choosable at
-- signup. (20260617006000 already declared these RPCs the successor of that
-- panel; the sync is the missing piece.)
--
-- Fix: the pm structure RPCs mirror their change into pdm.subteams BY NAME.
--   * create → insert the name if the picker doesn't have it
--   * rename → follow the rename; if the new name already exists in the
--     picker, drop the old row instead (merge)
--   * delete → remove the name from the picker
-- One-time backfill inserts registry names the picker is missing. Existing
-- picker-only rows (legacy names that predate the registry) are left alone —
-- signup subteams are stored as plain text in auth metadata, so nothing
-- references pdm.subteams rows by id. Bodies otherwise verbatim from
-- 20260617006000_pm_structure_editing.sql.

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
  -- Signup-picker sync: make the new subteam choosable at signup.
  insert into pdm.subteams (name, sort_order, created_by)
    select btrim(p_name), coalesce(max(sort_order), 0) + 1, auth.uid() from pdm.subteams
    on conflict (name) do nothing;
  return v_id;
end; $$;

create or replace function pm.update_subteam(p_id uuid, p_name text, p_color text)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_old_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not pm.has_capability(auth.uid(), 'org.manage_structure', null) then
    raise exception 'not authorized to edit org structure' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'subteam name is required' using errcode = '22023'; end if;
  select name into v_old_name from pm.subteams where id = p_id;
  -- slug is intentionally left stable (it keys saved dashboard layouts).
  update pm.subteams set name = btrim(p_name), color = nullif(btrim(p_color), ''), updated_at = now() where id = p_id;
  -- Signup-picker sync: follow the rename; when the new name is already in the
  -- picker, the rows merge (drop the stale old one).
  if v_old_name is not null and v_old_name <> btrim(p_name) then
    begin
      update pdm.subteams set name = btrim(p_name) where name = v_old_name;
    exception when unique_violation then
      delete from pdm.subteams where name = v_old_name;
    end;
  end if;
end; $$;

-- Delete a subteam, but only when nothing depends on it (the caller reassigns first).
create or replace function pm.delete_subteam(p_id uuid)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_name text;
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
  select name into v_name from pm.subteams where id = p_id;
  delete from pm.project_subteams where subteam_id = p_id;
  delete from pm.subteams where id = p_id;
  -- Signup-picker sync: a removed subteam shouldn't be offered to new signups.
  -- (Accounts keep their choice — signup subteam is plain text in auth metadata.)
  if v_name is not null then
    delete from pdm.subteams where name = v_name;
  end if;
end; $$;

-- One-time backfill: registry subteams the picker doesn't offer yet.
insert into pdm.subteams (name, sort_order)
  select s.name,
         (select coalesce(max(sort_order), 0) from pdm.subteams)
           + row_number() over (order by s.name)
    from pm.subteams s
   where not exists (select 1 from pdm.subteams p where p.name = s.name);
