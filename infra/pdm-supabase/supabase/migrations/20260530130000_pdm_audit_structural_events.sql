-- Audit-log completeness: capture structural + role events that previously went
-- unlogged. Existing coverage: check_out / lock_released / check_in /
-- cancel_checkout / force_unlock. Missing (added here): file & folder
-- create/rename/move/delete, and role grant/change/revoke.
--
-- All trigger functions are SECURITY DEFINER so an editor's own INSERT/UPDATE
-- can write the audit row (clients have no direct INSERT on pdm.audit_log).
-- user_id = auth.uid() (NULL for service-role / import writes — acceptable;
-- audit_log.user_id is nullable).

-- Files: create / rename / move / delete.
create or replace function pdm.trg_files_audit() returns trigger
language plpgsql security definer set search_path = pdm, public as $$
begin
  if TG_OP = 'INSERT' then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (auth.uid(), 'file_create', 'file', NEW.id,
            jsonb_build_object('name', NEW.name, 'folder_id', NEW.folder_id, 'vault_id', NEW.vault_id));
    return NEW;
  elsif TG_OP = 'UPDATE' then
    -- Only structural changes are audited; latest_version_id churn (every
    -- check_in updates it) must NOT spam the feed.
    if NEW.name is distinct from OLD.name then
      insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (auth.uid(), 'file_rename', 'file', NEW.id,
              jsonb_build_object('old_name', OLD.name, 'new_name', NEW.name));
    end if;
    if NEW.folder_id is distinct from OLD.folder_id then
      insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (auth.uid(), 'file_move', 'file', NEW.id,
              jsonb_build_object('old_folder_id', OLD.folder_id, 'new_folder_id', NEW.folder_id));
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (auth.uid(), 'file_delete', 'file', OLD.id,
            jsonb_build_object('name', OLD.name, 'folder_id', OLD.folder_id, 'vault_id', OLD.vault_id));
    return OLD;
  end if;
  return null;
end; $$;

create trigger files_audit
  after insert or update or delete on pdm.files
  for each row execute function pdm.trg_files_audit();

-- Folders: create / rename / move / delete.
create or replace function pdm.trg_folders_audit() returns trigger
language plpgsql security definer set search_path = pdm, public as $$
begin
  if TG_OP = 'INSERT' then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (auth.uid(), 'folder_create', 'folder', NEW.id,
            jsonb_build_object('name', NEW.name, 'parent_id', NEW.parent_id, 'vault_id', NEW.vault_id));
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.name is distinct from OLD.name then
      insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (auth.uid(), 'folder_rename', 'folder', NEW.id,
              jsonb_build_object('old_name', OLD.name, 'new_name', NEW.name));
    end if;
    if NEW.parent_id is distinct from OLD.parent_id then
      insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (auth.uid(), 'folder_move', 'folder', NEW.id,
              jsonb_build_object('old_parent_id', OLD.parent_id, 'new_parent_id', NEW.parent_id));
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (auth.uid(), 'folder_delete', 'folder', OLD.id,
            jsonb_build_object('name', OLD.name, 'parent_id', OLD.parent_id, 'vault_id', OLD.vault_id));
    return OLD;
  end if;
  return null;
end; $$;

create trigger folders_audit
  after insert or update or delete on pdm.folders
  for each row execute function pdm.trg_folders_audit();

-- Roles: grant / change / revoke.
create or replace function pdm.trg_user_roles_audit() returns trigger
language plpgsql security definer set search_path = pdm, public as $$
begin
  if TG_OP = 'INSERT' then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (auth.uid(), 'role_grant', 'user_role', NEW.user_id,
            jsonb_build_object('role', NEW.role));
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.role is distinct from OLD.role then
      insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
      values (auth.uid(), 'role_change', 'user_role', NEW.user_id,
              jsonb_build_object('old_role', OLD.role, 'new_role', NEW.role));
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (auth.uid(), 'role_revoke', 'user_role', OLD.user_id,
            jsonb_build_object('role', OLD.role));
    return OLD;
  end if;
  return null;
end; $$;

create trigger user_roles_audit
  after insert or update or delete on pdm.user_roles
  for each row execute function pdm.trg_user_roles_audit();
