-- Vaults
alter table pdm.vaults enable row level security;
create policy vaults_read on pdm.vaults
  for select to authenticated using (true);
create policy vaults_insert_admin on pdm.vaults
  for insert to authenticated with check (pdm.is_admin());
create policy vaults_update_admin on pdm.vaults
  for update to authenticated using (pdm.is_admin()) with check (pdm.is_admin());
create policy vaults_delete_admin on pdm.vaults
  for delete to authenticated using (pdm.is_admin());

-- Folders
alter table pdm.folders enable row level security;
create policy folders_read on pdm.folders
  for select to authenticated using (true);
create policy folders_insert_admin on pdm.folders
  for insert to authenticated with check (pdm.is_admin());
create policy folders_update_admin on pdm.folders
  for update to authenticated using (pdm.is_admin()) with check (pdm.is_admin());
create policy folders_delete_admin on pdm.folders
  for delete to authenticated using (pdm.is_admin());

-- Files
alter table pdm.files enable row level security;
create policy files_read on pdm.files
  for select to authenticated using (true);
create policy files_insert_admin on pdm.files
  for insert to authenticated with check (pdm.is_admin());
create policy files_update_admin on pdm.files
  for update to authenticated using (pdm.is_admin()) with check (pdm.is_admin());
create policy files_delete_admin on pdm.files
  for delete to authenticated using (pdm.is_admin());
