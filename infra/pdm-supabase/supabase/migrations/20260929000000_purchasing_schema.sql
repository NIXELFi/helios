-- Purchasing (Phase A of docs/superpowers/specs/2026-09-28-purchasing-and-finance-design.md)
--
-- The parts list that replaces the Airtable cost tracker: every part from
-- "we'll need this" (PLANNED) through exec approval, ordering, shipping and
-- receipt. Any team member may request parts for their subteam; nothing is
-- bought without exec approval.
--
-- Security model: every table is SELECT-only for `authenticated`, filtered by
-- RLS. All writes go through SECURITY DEFINER RPCs below that check the
-- caller's capabilities with pm.has_capability(), the same way the rest of
-- Helios does. Every member sees the whole parts list (as they did in
-- Airtable) but can only add or edit parts for their own subteam, and sees
-- only their own subteam's budget. Money (budget lines, the ledger) is
-- exec-only.

create schema if not exists purchasing;
grant usage on schema purchasing to authenticated, service_role;

-- 1. Capabilities + grants ---------------------------------------------------

insert into pm.capabilities (key, label, description, scope) values
  ('purchasing.view',    'Purchasing: view',    'See parts and budgets in scope',                   'subteam'),
  ('purchasing.request', 'Purchasing: request', 'Add parts and send them for approval in scope',    'subteam'),
  ('purchasing.approve', 'Purchasing: approve', 'Approve or deny purchase requests',                'org'),
  ('purchasing.order',   'Purchasing: order',   'Record orders, tracking and deliveries',           'org'),
  ('finance.view',       'Finance: view',       'See the ledger, balances and reimbursements',      'org'),
  ('finance.edit',       'Finance: edit',       'Edit the ledger, enter balances, import statements','org')
on conflict (key) do update
  set label = excluded.label, description = excluded.description, scope = excluded.scope;

-- Owner + Executive get everything. Any member (Lead, VP, Engineer) can
-- request in their subteam; Viewer can only look.
insert into pm.role_capabilities (role_id, capability_key)
select r.id, c.key
from pm.roles r
join pm.capabilities c on (c.key like 'purchasing.%' or c.key like 'finance.%')
where r.key in ('owner', 'executive')
   or (r.key in ('lead', 'vp', 'engineer') and c.key in ('purchasing.view', 'purchasing.request'))
   or (r.key = 'viewer' and c.key = 'purchasing.view')
on conflict (role_id, capability_key) do nothing;

create or replace function purchasing.can(cap text, stid uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select pm.has_capability((select auth.uid()), cap, stid);
$$;

-- 2. Tables -----------------------------------------------------------------

create table purchasing.seasons (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,          -- e.g. '2026-27'
  starts_on  date,
  ends_on    date,
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index seasons_one_current on purchasing.seasons (is_current) where is_current;

-- A budget line belongs to one car (project) and can cover several subteams
-- (one Aero budget covers Aero Design and Aero Manufacturing).
create table purchasing.budget_lines (
  id           uuid primary key default gen_random_uuid(),
  season_id    uuid not null references purchasing.seasons(id) on delete cascade,
  project_id   uuid not null references pm.projects(id) on delete cascade,
  name         text not null,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  notes        text not null default '',
  unique (season_id, project_id, name)
);
create table purchasing.budget_line_subteams (
  budget_line_id uuid not null references purchasing.budget_lines(id) on delete cascade,
  subteam_id     uuid not null references pm.subteams(id) on delete cascade,
  primary key (budget_line_id, subteam_id)
);

create sequence purchasing.item_code_seq;

create table purchasing.items (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique
                         default ('SDM-' || lpad(nextval('purchasing.item_code_seq')::text, 4, '0')),
  title                text not null check (btrim(title) <> ''),
  status               text not null default 'PLANNED' check (status in (
                         'PLANNED', 'READY', 'APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED',
                         'DELIVERED', 'RECEIVED', 'RECONCILED', 'DENIED', 'CANCELLED', 'HAVE')),
  priority             text not null default 'Medium' check (priority in ('HIGH', 'Medium', 'Low')),
  season_id            uuid references purchasing.seasons(id),
  requester_id         uuid references auth.users(id) on delete set null,
  requester_name       text not null default '',
  justification        text not null default '',
  needed_by            date,
  date_needed_raw      text not null default '',   -- Airtable "DATE NEEDED": meaning unconfirmed
  vendor               text,
  product_url          text not null default '',
  part_number          text not null default '',
  quantity             numeric,
  unit_price_cents     bigint,
  tax_shipping_cents   bigint,
  total_estimate_cents bigint,
  notes                text not null default '',
  helios_ref           text not null default '',
  ready_at             timestamptz,
  approved_at          timestamptz,
  denied_reason        text not null default '',
  purchaser_id         uuid references auth.users(id) on delete set null,
  payment_method       text not null default '',   -- card label, 'check', 'ASU', 'personal'
  paid_by              text not null default '',   -- a member who paid (reimbursement)
  vendor_order_id      text,
  actual_total_cents   bigint,
  ordered_at           date,
  carrier              text not null default '',
  tracking_number      text not null default '',
  tracking_status      text not null default '',
  shipped_at           timestamptz,
  est_delivery         date,
  delivered_at         timestamptz,
  received_at          timestamptz,
  reconciled_at        timestamptz,
  source               text not null default 'app',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index items_status on purchasing.items (status);
create index items_order on purchasing.items (vendor_order_id);

-- Which car + subteam an item belongs to. Percentages sum to 100; shared
-- purchases (a chassis tube order for both cars) are split here.
create table purchasing.item_allocations (
  item_id    uuid not null references purchasing.items(id) on delete cascade,
  project_id uuid not null references pm.projects(id),
  subteam_id uuid not null references pm.subteams(id),
  percent    numeric(5, 2) not null check (percent > 0 and percent <= 100),
  primary key (item_id, project_id, subteam_id)
);
create index item_allocations_subteam on purchasing.item_allocations (subteam_id);

create table purchasing.approvals (
  item_id  uuid not null references purchasing.items(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  decision text not null check (decision in ('approve', 'deny')),
  note     text not null default '',
  at       timestamptz not null default now(),
  primary key (item_id, user_id)
);

create table purchasing.settings (
  key   text primary key,
  value text not null
);
insert into purchasing.settings (key, value) values
  ('approvals_required', '2'),
  ('requester_counts_as_approver', 'false'),
  ('delivery_person_id', '')          -- packages are shipped to this person
on conflict (key) do nothing;

create table purchasing.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  item_id    uuid references purchasing.items(id) on delete cascade,
  kind       text not null,
  message    text not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user on purchasing.notifications (user_id, read_at);

-- Audit trail: every change to every item (who, when, field, old, new).
create table purchasing.events (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor_id  uuid,
  item_id   uuid,
  field     text not null,
  old_value text,
  new_value text
);
create index events_item on purchasing.events (item_id, at);

-- 3. Helpers -----------------------------------------------------------------

create or replace function purchasing.item_cost(i purchasing.items)
returns bigint language sql immutable as $$
  select coalesce(
    i.actual_total_cents,
    i.total_estimate_cents,
    case when i.quantity is not null and i.unit_price_cents is not null
         then round(i.quantity * i.unit_price_cents)::bigint + coalesce(i.tax_shipping_cents, 0) end,
    0);
$$;

create or replace function purchasing.is_exec()
returns boolean language sql stable security definer set search_path = '' as $$
  select pm.has_capability((select auth.uid()), 'purchasing.approve', null);
$$;

-- Is the caller on the team at all (purchasing.view in any subteam, or org-wide)?
create or replace function purchasing.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from pm.role_memberships m
    join pm.role_capabilities rc on rc.role_id = m.role_id
    where m.user_id = (select auth.uid()) and rc.capability_key = 'purchasing.view');
$$;

-- Can the caller see this item? The parts list is open to the whole team, so
-- any member can see every subteam's parts (costs included, as in Airtable).
-- Budgets are not: see budget_rows().
create or replace function purchasing.can_see_item(p_item uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select purchasing.is_member()
      or exists (
        select 1 from purchasing.items i
        where i.id = p_item and i.requester_id = (select auth.uid()));
$$;

create or replace function purchasing.can_request_item(p_item uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from purchasing.item_allocations a
    where a.item_id = p_item
      and pm.has_capability((select auth.uid()), 'purchasing.request', a.subteam_id));
$$;

create or replace function purchasing.display_name(uid uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(u.raw_user_meta_data ->> 'display_name', ''), u.email::text, 'someone')
  from auth.users u where u.id = uid;
$$;

create or replace function purchasing.notify(p_users uuid[], p_item uuid, p_kind text, p_message text)
returns void language sql security definer set search_path = '' as $$
  insert into purchasing.notifications (user_id, item_id, kind, message)
  select distinct u, p_item, p_kind, p_message from unnest(p_users) u where u is not null;
$$;

-- Everyone who holds an org-wide capability (the execs).
create or replace function purchasing.users_with(cap text)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.user_id), '{}')
  from pm.role_memberships m
  join pm.role_capabilities rc on rc.role_id = m.role_id
  where rc.capability_key = cap and m.subteam_id is null;
$$;

create or replace function purchasing.setting(p_key text)
returns text language sql stable security definer set search_path = '' as $$
  select value from purchasing.settings where key = p_key;
$$;

-- 4. Audit trigger -------------------------------------------------------------

create or replace function purchasing.audit_items()
returns trigger language plpgsql security definer set search_path = '' as $$
declare k text; o jsonb; n jsonb;
begin
  if tg_op = 'INSERT' then
    insert into purchasing.events (actor_id, item_id, field, new_value)
    values ((select auth.uid()), new.id, '*created*', new.title);
    return new;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if k <> 'updated_at' and (o -> k) is distinct from (n -> k) then
      insert into purchasing.events (actor_id, item_id, field, old_value, new_value)
      values ((select auth.uid()), new.id, k, o ->> k, n ->> k);
    end if;
  end loop;
  new.updated_at := now();
  return new;
end; $$;

create trigger items_audit_insert after insert on purchasing.items
  for each row execute function purchasing.audit_items();
create trigger items_audit_update before update on purchasing.items
  for each row execute function purchasing.audit_items();

-- 5. RLS: reads only; writes go through the RPCs below --------------------------

alter table purchasing.seasons              enable row level security;
alter table purchasing.budget_lines         enable row level security;
alter table purchasing.budget_line_subteams enable row level security;
alter table purchasing.items                enable row level security;
alter table purchasing.item_allocations     enable row level security;
alter table purchasing.approvals            enable row level security;
alter table purchasing.settings             enable row level security;
alter table purchasing.notifications        enable row level security;
alter table purchasing.events               enable row level security;

create policy seasons_read on purchasing.seasons for select to authenticated
  using (pm.is_org_member());
create policy budget_lines_read on purchasing.budget_lines for select to authenticated
  using (purchasing.is_exec());
create policy budget_line_subteams_read on purchasing.budget_line_subteams for select to authenticated
  using (purchasing.is_exec());
create policy items_read on purchasing.items for select to authenticated
  using (purchasing.can_see_item(id));
create policy item_allocations_read on purchasing.item_allocations for select to authenticated
  using (purchasing.can_see_item(item_id));
create policy approvals_read on purchasing.approvals for select to authenticated
  using (purchasing.can_see_item(item_id));
create policy settings_read on purchasing.settings for select to authenticated
  using (pm.is_org_member());
create policy notifications_read on purchasing.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy events_read on purchasing.events for select to authenticated
  using (purchasing.can_see_item(item_id));

grant select on all tables in schema purchasing to authenticated;
grant all on all tables in schema purchasing to service_role;
grant usage, select on all sequences in schema purchasing to service_role;

-- 6. RPCs ------------------------------------------------------------------------

-- Add one or many rows to a subteam's list (the sheet's blank row and paste).
-- p_rows: [{title, quantity, unit_price_cents, tax_shipping_cents,
--           total_estimate_cents, vendor, part_number, product_url, notes,
--           needed_by, priority, justification}]
-- One notification for the whole batch when sent straight for approval.
create or replace function purchasing.add_items(
  p_project uuid, p_subteam uuid, p_rows jsonb, p_ready boolean default false)
returns setof uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_name text; v_row jsonb; v_id uuid; v_ids uuid[] := '{}';
  v_season uuid; v_code text; v_total bigint := 0;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not (purchasing.is_exec() or pm.has_capability(v_uid, 'purchasing.request', p_subteam)) then
    raise exception 'you can only request parts for your own subteam' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to add' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'add at most 500 rows at a time' using errcode = '22023';
  end if;
  v_name := purchasing.display_name(v_uid);
  select id into v_season from purchasing.seasons where is_current;
  select code into v_code from pm.subteams where id = p_subteam;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    if coalesce(btrim(v_row ->> 'title'), '') = '' then continue; end if;
    insert into purchasing.items (
      title, status, priority, season_id, requester_id, requester_name, justification, needed_by,
      vendor, product_url, part_number, quantity, unit_price_cents, tax_shipping_cents,
      total_estimate_cents, notes, ready_at)
    values (
      left(btrim(v_row ->> 'title'), 200),
      case when p_ready then 'READY' else 'PLANNED' end,
      case when v_row ->> 'priority' in ('HIGH', 'Medium', 'Low') then v_row ->> 'priority' else 'Medium' end,
      v_season, v_uid, v_name, coalesce(v_row ->> 'justification', ''),
      nullif(v_row ->> 'needed_by', '')::date,
      nullif(btrim(v_row ->> 'vendor'), ''), coalesce(v_row ->> 'product_url', ''),
      coalesce(v_row ->> 'part_number', ''),
      coalesce(nullif(v_row ->> 'quantity', '')::numeric, 1),
      nullif(v_row ->> 'unit_price_cents', '')::bigint,
      nullif(v_row ->> 'tax_shipping_cents', '')::bigint,
      coalesce(nullif(v_row ->> 'total_estimate_cents', '')::bigint,
               round(coalesce(nullif(v_row ->> 'quantity', '')::numeric, 1)
                     * nullif(v_row ->> 'unit_price_cents', '')::bigint)::bigint
               + coalesce(nullif(v_row ->> 'tax_shipping_cents', '')::bigint, 0)),
      coalesce(v_row ->> 'notes', ''),
      case when p_ready then now() end)
    returning id into v_id;
    insert into purchasing.item_allocations (item_id, project_id, subteam_id, percent)
    values (v_id, p_project, p_subteam, 100);
    v_ids := v_ids || v_id;
    return next v_id;
  end loop;

  if p_ready and array_length(v_ids, 1) > 0 then
    select coalesce(sum(purchasing.item_cost(i)), 0) into v_total from purchasing.items i where i.id = any (v_ids);
    perform purchasing.notify(
      array(select u from unnest(purchasing.users_with('purchasing.approve')) u where u <> v_uid),
      v_ids[1], 'ready',
      case when array_length(v_ids, 1) = 1
        then v_name || ' requested ' || (select code || ' ' || title from purchasing.items where id = v_ids[1])
             || ' for ' || coalesce(v_code, 'a subteam') || ' ($' || to_char(v_total / 100.0, 'FM999999990.00') || '). Needs approval.'
        else v_name || ' sent ' || array_length(v_ids, 1) || ' requests for ' || coalesce(v_code, 'a subteam')
             || ' ($' || to_char(v_total / 100.0, 'FM999999990.00') || '). Needs approval.' end);
  end if;
end; $$;

-- Edit fields. Requesters may edit what they asked for while it's still in
-- planning; order, payment and tracking fields are exec-only.
create or replace function purchasing.update_item(p_id uuid, p_patch jsonb)
returns purchasing.items language plpgsql security definer set search_path = '' as $$
declare
  v_item purchasing.items; v_exec boolean := purchasing.is_exec(); k text;
  v_requester_fields text[] := array['title', 'priority', 'justification', 'needed_by', 'vendor',
    'product_url', 'part_number', 'quantity', 'unit_price_cents', 'tax_shipping_cents',
    'total_estimate_cents', 'notes', 'helios_ref'];
  v_buyer_fields text[] := array['vendor_order_id', 'actual_total_cents', 'carrier', 'tracking_number',
    'est_delivery', 'payment_method', 'paid_by', 'ordered_at'];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into v_item from purchasing.items where id = p_id for update;
  if not found then raise exception 'no such item' using errcode = 'P0002'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (v_requester_fields) or k = any (v_buyer_fields)) then
      raise exception 'field % cannot be edited', k using errcode = '22023';
    end if;
    if not v_exec then
      if k = any (v_buyer_fields) then
        raise exception 'only execs can set %', k using errcode = '42501';
      end if;
      if not purchasing.can_request_item(p_id) then
        raise exception 'you can only edit items for your own subteam' using errcode = '42501';
      end if;
      if v_item.status not in ('PLANNED', 'READY') then
        raise exception 'only execs can edit an item once it is approved' using errcode = '42501';
      end if;
    end if;
  end loop;

  update purchasing.items set
    title                = case when p_patch ? 'title' then left(btrim(p_patch ->> 'title'), 200) else title end,
    priority             = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    justification        = case when p_patch ? 'justification' then coalesce(p_patch ->> 'justification', '') else justification end,
    needed_by            = case when p_patch ? 'needed_by' then nullif(p_patch ->> 'needed_by', '')::date else needed_by end,
    vendor               = case when p_patch ? 'vendor' then nullif(btrim(p_patch ->> 'vendor'), '') else vendor end,
    product_url          = case when p_patch ? 'product_url' then coalesce(p_patch ->> 'product_url', '') else product_url end,
    part_number          = case when p_patch ? 'part_number' then coalesce(p_patch ->> 'part_number', '') else part_number end,
    quantity             = case when p_patch ? 'quantity' then nullif(p_patch ->> 'quantity', '')::numeric else quantity end,
    unit_price_cents     = case when p_patch ? 'unit_price_cents' then nullif(p_patch ->> 'unit_price_cents', '')::bigint else unit_price_cents end,
    tax_shipping_cents   = case when p_patch ? 'tax_shipping_cents' then nullif(p_patch ->> 'tax_shipping_cents', '')::bigint else tax_shipping_cents end,
    total_estimate_cents = case when p_patch ? 'total_estimate_cents' then nullif(p_patch ->> 'total_estimate_cents', '')::bigint else total_estimate_cents end,
    notes                = case when p_patch ? 'notes' then coalesce(p_patch ->> 'notes', '') else notes end,
    helios_ref           = case when p_patch ? 'helios_ref' then coalesce(p_patch ->> 'helios_ref', '') else helios_ref end,
    vendor_order_id      = case when p_patch ? 'vendor_order_id' then nullif(p_patch ->> 'vendor_order_id', '') else vendor_order_id end,
    actual_total_cents   = case when p_patch ? 'actual_total_cents' then nullif(p_patch ->> 'actual_total_cents', '')::bigint else actual_total_cents end,
    carrier              = case when p_patch ? 'carrier' then coalesce(p_patch ->> 'carrier', '') else carrier end,
    tracking_number      = case when p_patch ? 'tracking_number' then coalesce(p_patch ->> 'tracking_number', '') else tracking_number end,
    est_delivery         = case when p_patch ? 'est_delivery' then nullif(p_patch ->> 'est_delivery', '')::date else est_delivery end,
    payment_method       = case when p_patch ? 'payment_method' then coalesce(p_patch ->> 'payment_method', '') else payment_method end,
    paid_by              = case when p_patch ? 'paid_by' then coalesce(p_patch ->> 'paid_by', '') else paid_by end,
    ordered_at           = case when p_patch ? 'ordered_at' then nullif(p_patch ->> 'ordered_at', '')::date else ordered_at end
  where id = p_id
  returning * into v_item;

  -- keep the estimate in step with quantity x unit price unless it was set directly
  if (p_patch ? 'quantity' or p_patch ? 'unit_price_cents' or p_patch ? 'tax_shipping_cents')
     and not p_patch ? 'total_estimate_cents'
     and v_item.quantity is not null and v_item.unit_price_cents is not null then
    update purchasing.items
       set total_estimate_cents = round(v_item.quantity * v_item.unit_price_cents)::bigint + coalesce(v_item.tax_shipping_cents, 0)
     where id = p_id returning * into v_item;
  end if;
  return v_item;
end; $$;

-- Move items through the state machine. Requesters: PLANNED <-> READY,
-- cancel planning items, confirm RECEIVED. Execs may set anything.
create or replace function purchasing.set_status(p_ids uuid[], p_status text, p_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_exec boolean := purchasing.is_exec(); v_item purchasing.items;
  v_ready uuid[] := '{}'; v_delivered uuid[] := '{}'; v_name text; v_delivery uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_status not in ('PLANNED', 'READY', 'APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED',
                      'RECEIVED', 'RECONCILED', 'DENIED', 'CANCELLED', 'HAVE') then
    raise exception 'unknown status %', p_status using errcode = '22023';
  end if;
  for v_item in select * from purchasing.items where id = any (p_ids) for update loop
    if v_item.status = p_status then continue; end if;
    if not v_exec then
      if not purchasing.can_request_item(v_item.id) then
        raise exception '% is not in your subteam', v_item.code using errcode = '42501';
      end if;
      if not ((v_item.status, p_status) in (('PLANNED', 'READY'), ('READY', 'PLANNED'),
              ('PLANNED', 'CANCELLED'), ('READY', 'CANCELLED'), ('ORDERED', 'RECEIVED'),
              ('SHIPPED', 'RECEIVED'), ('DELIVERED', 'RECEIVED'))) then
        raise exception 'you can''t move % from % to %', v_item.code, v_item.status, p_status using errcode = '42501';
      end if;
    end if;
    if p_status = 'READY' then
      delete from purchasing.approvals where item_id = v_item.id;   -- a resubmission starts over
      v_ready := v_ready || v_item.id;
    elsif p_status = 'DELIVERED' then
      v_delivered := v_delivered || v_item.id;
    end if;
    update purchasing.items set
      status        = p_status,
      ready_at      = case when p_status = 'READY' then now() else ready_at end,
      approved_at   = case when p_status = 'APPROVED' then coalesce(approved_at, now()) else approved_at end,
      denied_reason = case when p_status = 'DENIED' then coalesce(p_note, '') else denied_reason end,
      shipped_at    = case when p_status = 'SHIPPED' then coalesce(shipped_at, now()) else shipped_at end,
      delivered_at  = case when p_status = 'DELIVERED' then coalesce(delivered_at, now()) else delivered_at end,
      received_at   = case when p_status = 'RECEIVED' then coalesce(received_at, now()) else received_at end,
      reconciled_at = case when p_status = 'RECONCILED' then coalesce(reconciled_at, now()) else reconciled_at end
    where id = v_item.id;
  end loop;

  v_name := purchasing.display_name(v_uid);
  if array_length(v_ready, 1) > 0 then
    perform purchasing.notify(
      array(select u from unnest(purchasing.users_with('purchasing.approve')) u where u <> v_uid),
      v_ready[1], 'ready',
      v_name || ' sent ' || array_length(v_ready, 1) || ' item(s) for approval: '
      || (select string_agg(code || ' ' || title, ', ') from purchasing.items where id = any (v_ready)));
  end if;
  if array_length(v_delivered, 1) > 0 then
    v_delivery := nullif(purchasing.setting('delivery_person_id'), '')::uuid;
    perform purchasing.notify(array[v_delivery], v_delivered[1], 'delivered',
      'Delivered to your place: '
      || (select string_agg(code || ' ' || title, ', ') from purchasing.items where id = any (v_delivered))
      || '. Please get it to the shop and let the requester know.');
    perform purchasing.notify(
      array(select requester_id from purchasing.items where id = any (v_delivered) and requester_id is distinct from v_delivery),
      v_delivered[1], 'delivered', 'Your part was delivered. Mark it received once you have it.');
  end if;
end; $$;

-- Approve or deny. Two distinct execs approve (setting); a requester's own
-- approval doesn't count; one deny stops it.
create or replace function purchasing.decide(p_id uuid, p_decision text, p_note text default '')
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_item purchasing.items; v_count int; v_required int;
  v_self_counts boolean; v_name text;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not purchasing.is_exec() then raise exception 'only execs approve purchases' using errcode = '42501'; end if;
  if p_decision not in ('approve', 'deny') then raise exception 'decision must be approve or deny' using errcode = '22023'; end if;
  select * into v_item from purchasing.items where id = p_id for update;
  if not found then raise exception 'no such item' using errcode = 'P0002'; end if;
  if v_item.status <> 'READY' then
    raise exception '% isn''t waiting for approval', v_item.code using errcode = '22023';
  end if;
  insert into purchasing.approvals (item_id, user_id, decision, note) values (p_id, v_uid, p_decision, coalesce(p_note, ''))
  on conflict (item_id, user_id) do update set decision = excluded.decision, note = excluded.note, at = now();
  insert into purchasing.events (actor_id, item_id, field, new_value) values (v_uid, p_id, 'approval', p_decision || ' ' || coalesce(p_note, ''));

  v_name := purchasing.display_name(v_uid);
  if p_decision = 'deny' then
    update purchasing.items set status = 'DENIED', denied_reason = coalesce(p_note, '') where id = p_id;
    perform purchasing.notify(array[v_item.requester_id], p_id, 'denied',
      v_item.code || ' ' || v_item.title || ' was denied by ' || v_name || coalesce('. ' || nullif(p_note, ''), '.'));
    return 'DENIED';
  end if;

  v_required := coalesce(purchasing.setting('approvals_required')::int, 2);
  v_self_counts := coalesce(purchasing.setting('requester_counts_as_approver')::boolean, false);
  select count(*) into v_count from purchasing.approvals a
  where a.item_id = p_id and a.decision = 'approve'
    and pm.has_capability(a.user_id, 'purchasing.approve', null)
    and (v_self_counts or a.user_id is distinct from v_item.requester_id);
  if v_count >= v_required then
    update purchasing.items set status = 'APPROVED', approved_at = now() where id = p_id;
    perform purchasing.notify(purchasing.users_with('purchasing.order'), p_id, 'approved',
      'Approved, ready to buy: ' || v_item.code || ' ' || v_item.title || coalesce(' (' || v_item.vendor || ')', ''));
    -- Requesters who are also buyers already got the line above.
    perform purchasing.notify(
      array(select v_item.requester_id where not (v_item.requester_id = any (purchasing.users_with('purchasing.order')))),
      p_id, 'approved', v_item.code || ' ' || v_item.title || ' was approved.');
    return 'APPROVED';
  end if;
  return 'READY';
end; $$;

-- Several items bought in one vendor order. An order total is split across
-- them in proportion to their estimates.
create or replace function purchasing.record_order(
  p_ids uuid[], p_order_id text, p_payment text, p_ordered_on date default null,
  p_total_cents bigint default null, p_paid_by text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_sum bigint; v_left bigint; v_share bigint; r record; n int; i int := 0;
begin
  if not pm.has_capability(v_uid, 'purchasing.order', null) then
    raise exception 'only execs record orders' using errcode = '42501';
  end if;
  select coalesce(sum(greatest(purchasing.item_cost(x), 1)), 0), count(*) into v_sum, n
    from purchasing.items x where x.id = any (p_ids);
  v_left := p_total_cents;
  for r in select x.*, greatest(purchasing.item_cost(x), 1) as w from purchasing.items x
           where x.id = any (p_ids) order by x.id loop
    i := i + 1;
    v_share := case when p_total_cents is null then null
                    when i = n then v_left
                    else (p_total_cents * r.w / v_sum) end;
    if v_share is not null then v_left := v_left - v_share; end if;
    update purchasing.items set
      status = case when status in ('ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED') then status else 'ORDERED' end,
      vendor_order_id = nullif(p_order_id, ''), payment_method = coalesce(p_payment, ''),
      paid_by = coalesce(p_paid_by, ''), ordered_at = coalesce(p_ordered_on, current_date),
      purchaser_id = v_uid, actual_total_cents = coalesce(v_share, actual_total_cents)
    where id = r.id;
  end loop;
end; $$;

create or replace function purchasing.add_tracking(p_ids uuid[], p_number text, p_carrier text default '', p_eta date default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_delivery uuid; v_names text;
begin
  if not pm.has_capability(v_uid, 'purchasing.order', null) then
    raise exception 'only execs add tracking' using errcode = '42501';
  end if;
  update purchasing.items set
    tracking_number = upper(regexp_replace(coalesce(p_number, ''), '[\s-]', '', 'g')),
    carrier = coalesce(nullif(p_carrier, ''), carrier), est_delivery = coalesce(p_eta, est_delivery),
    status = case when status in ('APPROVED', 'ORDERED', 'BACKORDERED', 'READY') then 'SHIPPED' else status end,
    shipped_at = coalesce(shipped_at, now())
  where id = any (p_ids);
  select string_agg(code || ' ' || title, ', ') into v_names from purchasing.items where id = any (p_ids);
  v_delivery := nullif(purchasing.setting('delivery_person_id'), '')::uuid;
  perform purchasing.notify(array[v_delivery], p_ids[1], 'shipped',
    'On the way to you: ' || left(v_names, 200) || coalesce(', ETA ' || p_eta::text, '') || '.');
  perform purchasing.notify(
    array(select requester_id from purchasing.items where id = any (p_ids) and requester_id is distinct from v_delivery), p_ids[1], 'shipped',
    'Shipped: ' || left(v_names, 200) || coalesce(' (' || nullif(p_carrier, '') || ')', '') || '.');
end; $$;

create or replace function purchasing.mark_notifications_read()
returns void language sql security definer set search_path = '' as $$
  update purchasing.notifications set read_at = now() where user_id = auth.uid() and read_at is null;
$$;

-- Budget per line for the current (or given) season, only the lines the
-- caller may see. Until the finance ledger lands (Phase B), "spent" is what
-- was recorded on ordered items.
create or replace function purchasing.budget_rows(p_season uuid default null)
returns table (
  budget_line_id uuid, project_id uuid, project_code text, name text, subteam_ids uuid[],
  budget_cents bigint, spent_cents bigint, committed_cents bigint, planned_cents bigint)
language sql stable security definer set search_path = '' as $$
  with season as (
    select coalesce(p_season, (select id from purchasing.seasons where is_current)) as id
  ),
  shares as (
    select a.project_id, a.subteam_id, i.status,
           round(purchasing.item_cost(i) * a.percent / 100.0)::bigint as cents
    from purchasing.items i
    join purchasing.item_allocations a on a.item_id = i.id
    where i.status not in ('DENIED', 'CANCELLED', 'HAVE')
      and (i.season_id is null or i.season_id = (select id from season))
  ),
  lines as (
    select l.id, l.project_id, l.name, l.amount_cents,
           array_agg(ls.subteam_id) filter (where ls.subteam_id is not null) as subteams
    from purchasing.budget_lines l
    left join purchasing.budget_line_subteams ls on ls.budget_line_id = l.id
    where l.season_id = (select id from season)
    group by l.id
  ),
  line_of as (
    select s.*, (select l.id from lines l where l.project_id = s.project_id and s.subteam_id = any (l.subteams) limit 1) as line_id
    from shares s
  )
  select l.id, l.project_id, p.car_code, l.name, coalesce(l.subteams, '{}'),
         l.amount_cents,
         coalesce(sum(x.cents) filter (where x.status in ('ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED')), 0),
         coalesce(sum(x.cents) filter (where x.status = 'APPROVED'), 0),
         coalesce(sum(x.cents) filter (where x.status in ('PLANNED', 'READY')), 0)
  from lines l
  join pm.projects p on p.id = l.project_id
  left join line_of x on x.line_id = l.id
  where purchasing.is_exec()
     or exists (select 1 from unnest(l.subteams) st where pm.has_capability((select auth.uid()), 'purchasing.view', st))
  group by l.id, l.project_id, p.car_code, l.name, l.subteams, l.amount_cents
  union all
  -- spending on a subteam no budget line covers is shown, never dropped
  select null, x.project_id, p.car_code, '(no budget line) ' || st.name, array[x.subteam_id], 0,
         coalesce(sum(x.cents) filter (where x.status in ('ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED')), 0),
         coalesce(sum(x.cents) filter (where x.status = 'APPROVED'), 0),
         coalesce(sum(x.cents) filter (where x.status in ('PLANNED', 'READY')), 0)
  from line_of x
  join pm.projects p on p.id = x.project_id
  join pm.subteams st on st.id = x.subteam_id
  where x.line_id is null
    and (purchasing.is_exec() or pm.has_capability((select auth.uid()), 'purchasing.view', x.subteam_id))
  group by x.project_id, p.car_code, st.name, x.subteam_id;
$$;

-- Execs manage budget lines (season, car, name, amount, covered subteams).
create or replace function purchasing.upsert_budget_line(
  p_id uuid, p_season uuid, p_project uuid, p_name text, p_amount_cents bigint, p_subteams uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id;
begin
  if not purchasing.is_exec() then raise exception 'only execs set budgets' using errcode = '42501'; end if;
  if v_id is null then
    insert into purchasing.budget_lines (season_id, project_id, name, amount_cents)
    values (p_season, p_project, btrim(p_name), p_amount_cents) returning id into v_id;
  else
    update purchasing.budget_lines set name = btrim(p_name), amount_cents = p_amount_cents where id = v_id;
  end if;
  delete from purchasing.budget_line_subteams where budget_line_id = v_id;
  insert into purchasing.budget_line_subteams (budget_line_id, subteam_id)
  select v_id, unnest(coalesce(p_subteams, '{}'));
  return v_id;
end; $$;

revoke all on all functions in schema purchasing from public, anon;
grant execute on function
  purchasing.can(text, uuid), purchasing.is_exec(), purchasing.is_member(), purchasing.can_see_item(uuid),
  purchasing.item_cost(purchasing.items), purchasing.add_items(uuid, uuid, jsonb, boolean),
  purchasing.update_item(uuid, jsonb), purchasing.set_status(uuid[], text, text),
  purchasing.decide(uuid, text, text), purchasing.record_order(uuid[], text, text, date, bigint, text),
  purchasing.add_tracking(uuid[], text, text, date), purchasing.mark_notifications_read(),
  purchasing.budget_rows(uuid), purchasing.upsert_budget_line(uuid, uuid, uuid, text, bigint, uuid[])
to authenticated;
grant execute on all functions in schema purchasing to service_role;
