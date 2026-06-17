-- Phase 1i: shared dashboard photos. A subteam (or the all-team) dashboard can
-- carry images, editable only by someone with the pm.manage_dashboard capability
-- in that scope (Lead+ of the subteam, or Executive/Owner) — read by everyone.
-- This is gated on the NEW capability model directly (a brand-new feature, so no
-- legacy behavior to preserve), independent of the later RLS cutover.

-- Private bucket for the image blobs.
insert into storage.buckets (id, name, public)
values ('dashboard-photos', 'dashboard-photos', false)
on conflict (id) do nothing;

create table if not exists pm.dashboard_photos (
  id          uuid primary key default gen_random_uuid(),
  subteam_id  uuid references pm.subteams(id) on delete cascade,  -- NULL = all-team dashboard
  storage_path text not null,
  caption     text,
  sort_order  int not null default 0,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists dashboard_photos_subteam_idx on pm.dashboard_photos (subteam_id);

alter table pm.dashboard_photos enable row level security;
-- Read: any authenticated member sees dashboard photos.
drop policy if exists dashboard_photos_read on pm.dashboard_photos;
create policy dashboard_photos_read on pm.dashboard_photos for select to authenticated using (true);
-- Write (insert/update/delete): manage_dashboard in that scope. has_capability with
-- a NULL subteam_id resolves to org-scoped holders (Executive/Owner) only — exactly
-- who should manage the all-team dashboard.
drop policy if exists dashboard_photos_write on pm.dashboard_photos;
create policy dashboard_photos_write on pm.dashboard_photos for all to authenticated
  using (pm.has_capability(auth.uid(), 'pm.manage_dashboard', subteam_id))
  with check (pm.has_capability(auth.uid(), 'pm.manage_dashboard', subteam_id));
grant select, insert, update, delete on pm.dashboard_photos to authenticated;

-- Storage gate: photos live at `{subteam_id | 'all'}/{uuid}`. This helper maps the
-- first path segment to the capability check (and never errors on the 'all' segment).
create or replace function pm.can_manage_dash_path(seg text)
returns boolean language plpgsql stable security definer set search_path = pm, public as $fn$
begin
  if seg is null or seg = 'all' then
    return pm.has_capability(auth.uid(), 'pm.manage_dashboard', null);
  end if;
  begin
    return pm.has_capability(auth.uid(), 'pm.manage_dashboard', seg::uuid);
  exception when others then
    return false;
  end;
end;
$fn$;
grant execute on function pm.can_manage_dash_path(text) to authenticated;

-- Storage policies on the bucket.
drop policy if exists dash_photo_read on storage.objects;
create policy dash_photo_read on storage.objects
  for select to authenticated using (bucket_id = 'dashboard-photos');
drop policy if exists dash_photo_insert on storage.objects;
create policy dash_photo_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'dashboard-photos' and pm.can_manage_dash_path((storage.foldername(name))[1]));
drop policy if exists dash_photo_delete on storage.objects;
create policy dash_photo_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'dashboard-photos' and pm.can_manage_dash_path((storage.foldername(name))[1]));
