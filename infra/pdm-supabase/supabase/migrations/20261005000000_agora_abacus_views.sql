-- Agora: Abacus views, as in Airtable. A view is a saved way of looking at
-- the parts list: which statuses and priorities show, only the viewer's own
-- parts or those missing a price, vendor or link, how they're grouped and
-- sorted, and which columns are hidden (the config, read by the app's
-- lib/views.ts). Shared views are on everyone's view bar; a personal one
-- only on its owner's. Anyone on the team can make one; its owner or an exec
-- can change or delete it.

create table purchasing.views (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> '' and length(name) <= 60),
  config     jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
  shared     boolean not null default true,
  owner_id   uuid references auth.users(id) on delete set null,
  owner_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table purchasing.views enable row level security;
create policy views_read on purchasing.views for select to authenticated
  using (purchasing.is_member() and (shared or owner_id = (select auth.uid())));
grant select on purchasing.views to authenticated;
grant all on purchasing.views to service_role;

-- Create (p_id null) or change a view. Returns its id.
create or replace function purchasing.save_view(p_id uuid, p_name text, p_config jsonb, p_shared boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  if not purchasing.is_member() then raise exception 'only team members save views' using errcode = '42501'; end if;
  if v_name = '' then raise exception 'give the view a name' using errcode = '22023'; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' or length(p_config::text) > 4000 then
    raise exception 'that view''s settings aren''t valid' using errcode = '22023';
  end if;
  if p_id is null then
    insert into purchasing.views (name, config, shared, owner_id, owner_name)
    values (left(v_name, 60), p_config, coalesce(p_shared, true), auth.uid(), purchasing.display_name(auth.uid()))
    returning id into v_id;
    return v_id;
  end if;
  update purchasing.views set name = left(v_name, 60), config = p_config, shared = coalesce(p_shared, shared), updated_at = now()
  where id = p_id and (owner_id = auth.uid() or purchasing.is_exec())
  returning id into v_id;
  if v_id is null then
    raise exception 'only whoever made that view, or an exec, can change it' using errcode = '42501';
  end if;
  return v_id;
end; $$;

create or replace function purchasing.delete_view(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from purchasing.views where id = p_id and (owner_id = auth.uid() or purchasing.is_exec());
  if not found then
    raise exception 'only whoever made that view, or an exec, can delete it' using errcode = '42501';
  end if;
end; $$;

revoke all on function purchasing.save_view(uuid, text, jsonb, boolean), purchasing.delete_view(uuid) from public, anon;
grant execute on function purchasing.save_view(uuid, text, jsonb, boolean), purchasing.delete_view(uuid) to authenticated, service_role;
