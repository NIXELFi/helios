-- Fix H2 from ultrareview 2026-05-11:
-- pdm.files has FKs to vault_id and folder_id independently, but nothing
-- enforces that the referenced folder belongs to the same vault. A row can be
-- inserted with folder_id pointing at a folder in a different vault, producing
-- cross-vault leakage once vault-scoped RLS lands.
--
-- This migration adds a BEFORE INSERT OR UPDATE trigger that asserts
--   NEW.folder_id IS NULL
--   OR (SELECT vault_id FROM pdm.folders WHERE id = NEW.folder_id) = NEW.vault_id

create or replace function pdm.trg_files_check_vault_consistency() returns trigger
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_folder_vault uuid;
begin
  if NEW.folder_id is null then
    return NEW;
  end if;

  select vault_id into v_folder_vault
  from pdm.folders
  where id = NEW.folder_id;

  if v_folder_vault is null then
    raise exception 'folder % not found', NEW.folder_id;
  end if;

  if v_folder_vault <> NEW.vault_id then
    raise exception 'folder % belongs to vault %, but file is being placed in vault %',
      NEW.folder_id, v_folder_vault, NEW.vault_id;
  end if;

  return NEW;
end;
$$;

drop trigger if exists files_check_vault_consistency on pdm.files;
create trigger files_check_vault_consistency
  before insert or update on pdm.files
  for each row execute function pdm.trg_files_check_vault_consistency();
