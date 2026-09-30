-- Rollback for the 2026-09-09 read-policy rewrite: restores the policy bodies deployed in prod before it (captured 2026-09-09) and drops the new functions.
drop function if exists pdm.vault_cursor(uuid); drop function if exists pm.workspace_cursor(); drop function if exists pdm.bridge_live_files(); drop function if exists pdm.my_vault_ids(); drop index if exists pm.idx_tasks_updated_at;
drop policy if exists "members read activity" on pm.activity; create policy "members read activity" on pm.activity for select to authenticated using ((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read blocks" on pm.blocks; create policy "members read blocks" on pm.blocks for select to authenticated using ((pm.is_project_member(auth.uid(), ( SELECT pages.project_id
FROM pm.pages
WHERE (pages.id = blocks.page_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read build_records" on pm.build_records; create policy "members read build_records" on pm.build_records for select to authenticated using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = build_records.task_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read calendar_events" on pm.calendar_events; create policy "members read calendar_events" on pm.calendar_events for select to authenticated using ((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read milestones" on pm.milestones; create policy "members read milestones" on pm.milestones for select to authenticated using ((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read pages" on pm.pages; create policy "members read pages" on pm.pages for select to authenticated using ((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read projects" on pm.projects; create policy "members read projects" on pm.projects for select to authenticated using ((pm.is_project_member(auth.uid(), id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read task_comments" on pm.task_comments; create policy "members read task_comments" on pm.task_comments for select to authenticated using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = task_comments.task_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read task_dependencies" on pm.task_dependencies; create policy "members read task_dependencies" on pm.task_dependencies for select to authenticated using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = task_dependencies.successor_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read task_links" on pm.task_links; create policy "members read task_links" on pm.task_links for select to public using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = task_links.task_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read task_milestones" on pm.task_milestones; create policy "members read task_milestones" on pm.task_milestones for select to authenticated using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = task_milestones.task_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read task_owners" on pm.task_owners; create policy "members read task_owners" on pm.task_owners for select to public using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = task_owners.task_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read task_part_link" on pm.task_part_link; create policy "members read task_part_link" on pm.task_part_link for select to authenticated using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = task_part_link.task_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read task_subteams" on pm.task_subteams; create policy "members read task_subteams" on pm.task_subteams for select to public using ((pm.is_project_member(auth.uid(), ( SELECT tasks.project_id
FROM pm.tasks
WHERE (tasks.id = task_subteams.task_id))) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read tasks" on pm.tasks; create policy "members read tasks" on pm.tasks for select to authenticated using ((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read team_memberships" on pm.team_memberships; create policy "members read team_memberships" on pm.team_memberships for select to authenticated using ((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read vendors" on pm.vendors; create policy "members read vendors" on pm.vendors for select to authenticated using ((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())));
drop policy if exists "members read views" on pm.database_views; create policy "members read views" on pm.database_views for select to authenticated using (((pm.is_project_member(auth.uid(), project_id) OR pm.can_read_pm(auth.uid())) AND ((owner_id = auth.uid()) OR is_shared)));
drop policy if exists files_read on pdm.files; create policy files_read on pdm.files for select to authenticated using ((pdm.is_member_in(vault_id) AND ((published_at IS NOT NULL) OR (created_by = ( SELECT auth.uid() AS uid)))));
drop policy if exists folders_read on pdm.folders; create policy folders_read on pdm.folders for select to authenticated using (pdm.is_member_in(vault_id));
drop policy if exists locks_read on pdm.locks; create policy locks_read on pdm.locks for select to authenticated using (pdm.is_member_in(pdm.file_vault_id(file_id)));
drop policy if exists refs_read on pdm.refs; create policy refs_read on pdm.refs for select to authenticated using (pdm.is_member_in(pdm.version_vault_id(parent_version_id)));
drop policy if exists role_memberships_select_self on pm.role_memberships; create policy role_memberships_select_self on pm.role_memberships for select to authenticated using ((user_id = auth.uid()));
drop policy if exists versions_read on pdm.versions; create policy versions_read on pdm.versions for select to authenticated using (pdm.is_member_in(pdm.file_vault_id(file_id)));
