-- Hyperlinks on tasks: attach labeled external URLs (Drive docs, drawings, specs,
-- meeting notes, …) to a task. Scoped to tasks for v1 — the only PM entity with a
-- detail panel to host links. Mirrors pm.task_comments (child rows, same RLS shape).
-- Applied to the hosted dev project (dlmyixonuyckxkknolku) via MCP apply_migration.

create table pm.task_links (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references pm.tasks(id) on delete cascade,
  -- http/https only — the desktop opener refuses anything else, and this keeps a
  -- file:// or javascript: URL from ever being stored.
  url        text not null check (url ~* '^https?://'),
  label      text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid()
);
create index task_links_task_idx on pm.task_links (task_id);

alter table pm.task_links enable row level security;
create policy "members read task_links" on pm.task_links for select
  using (
    pm.is_project_member(auth.uid(), (select project_id from pm.tasks where id = task_links.task_id))
    or pm.can_read_pm(auth.uid())
  );
create policy "editors write task_links" on pm.task_links for all
  using (pm.can_edit_task(auth.uid(), task_id))
  with check (pm.can_edit_task(auth.uid(), task_id));

grant select, insert, update, delete on pm.task_links to authenticated;
