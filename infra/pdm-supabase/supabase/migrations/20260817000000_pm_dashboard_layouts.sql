-- Shared dashboard layouts. The tabs/widgets of a dashboard scope (a subteam,
-- or the all-team dashboard) become one shared layout for the whole team,
-- persisted server-side so it survives reboots, reinstalls, and machine
-- switches — read by everyone, editable only by someone with the
-- pm.manage_dashboard capability in that scope (Lead/VP of the subteam, or
-- Executive/Owner for the all-team dashboard). Companion to
-- 20260617008000_pm_dashboard_photos.sql, same scope + gating model.
-- Every statement is idempotent.

create table if not exists pm.dashboard_layouts (
  id          uuid primary key default gen_random_uuid(),
  subteam_id  uuid references pm.subteams(id) on delete cascade,  -- NULL = all-team dashboard
  config      jsonb not null,
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now()
);

-- One layout per scope. subteam_id is nullable, so uniqueness goes through a
-- sentinel coalesce (same trick as role_memberships_uniq).
create unique index if not exists dashboard_layouts_scope_uniq
  on pm.dashboard_layouts (coalesce(subteam_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table pm.dashboard_layouts enable row level security;

-- Read: any authenticated member sees the shared layout.
drop policy if exists dashboard_layouts_read on pm.dashboard_layouts;
create policy dashboard_layouts_read on pm.dashboard_layouts
  for select to authenticated using (true);

-- Write (insert/update/delete): manage_dashboard in that scope. has_capability
-- with a NULL subteam_id resolves to org-scoped holders (Executive/Owner) only —
-- exactly who should manage the all-team dashboard.
drop policy if exists dashboard_layouts_write on pm.dashboard_layouts;
create policy dashboard_layouts_write on pm.dashboard_layouts
  for all to authenticated
  using (pm.has_capability(auth.uid(), 'pm.manage_dashboard', subteam_id))
  with check (pm.has_capability(auth.uid(), 'pm.manage_dashboard', subteam_id));

grant select, insert, update, delete on pm.dashboard_layouts to authenticated;

-- Upsert RPC: PostgREST can't target the expression index in an on_conflict
-- param, so the save goes through this function. SECURITY INVOKER on purpose —
-- the RLS write policy above stays the single authority on who may save.
create or replace function pm.save_dashboard_layout(stid uuid, cfg jsonb)
returns void
language plpgsql volatile security invoker set search_path = pm, public as $fn$
begin
  -- Layouts are small (tabs of widget descriptors); reject anything that isn't.
  if pg_column_size(cfg) > 262144 then
    raise exception 'dashboard layout too large';
  end if;
  insert into pm.dashboard_layouts (subteam_id, config, updated_by, updated_at)
  values (stid, cfg, auth.uid(), now())
  on conflict ((coalesce(subteam_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  do update set config = excluded.config,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at;
end;
$fn$;

-- Functions default EXECUTE to PUBLIC — revoking only from anon is a no-op.
revoke execute on function pm.save_dashboard_layout(uuid, jsonb) from public, anon;
grant execute on function pm.save_dashboard_layout(uuid, jsonb) to authenticated;
