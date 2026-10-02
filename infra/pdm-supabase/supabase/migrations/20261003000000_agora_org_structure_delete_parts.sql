-- Agora after 6.0.1:
--   1. Which subteams each car has comes from Helios's org structure
--      (pm.project_subteams, edited in Admin > Org Structure), not a second
--      map of Agora's own. purchasing.car_subteams (20261002000000) goes;
--      add_items checks the org structure instead.
--   2. Execs can delete parts (mistakes, test rows, or clearing Abacus before
--      restoring the old ledger), except parts matched to a ledger charge.
--   3. Parts carry a funding source, as the Airtable sheets did ("Chase
--      Account", "Dean's funding"): free text members fill in, so it can be
--      typed, pasted, uploaded from Airtable and filled down like the rest.

-- 0. Funding source ----------------------------------------------------------------------

alter table purchasing.items add column funding_source text not null default '';
comment on column purchasing.items.funding_source is 'Where the money is meant to come from, as written (Airtable''s "Funding Source")';

-- update_item() from 20261001000000 with funding_source among the fields a
-- requester may edit while the part is still in planning.
create or replace function purchasing.update_item(p_id uuid, p_patch jsonb)
returns purchasing.items language plpgsql security definer set search_path = '' as $$
declare
  v_item purchasing.items; v_old purchasing.items; v_exec boolean := purchasing.is_exec(); k text;
  v_requester_fields text[] := array['title', 'priority', 'justification', 'needed_by', 'vendor',
    'product_url', 'part_number', 'quantity', 'unit_price_cents', 'tax_shipping_cents',
    'total_estimate_cents', 'notes', 'helios_ref', 'funding_source'];
  v_buyer_fields text[] := array['vendor_order_id', 'actual_total_cents', 'carrier', 'tracking_number',
    'est_delivery', 'payment_method', 'paid_by', 'ordered_at'];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into v_item from purchasing.items where id = p_id for update;
  if not found then raise exception 'no such item' using errcode = 'P0002'; end if;
  v_old := v_item;
  -- checked before looking at the patch, so an empty one can't read an item
  if not (v_exec or purchasing.can_request_item(p_id)) then
    raise exception 'you can only edit items for your own subteam' using errcode = '42501';
  end if;
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'nothing to change' using errcode = '22023'; end if;
  perform purchasing.check_amounts(p_patch);
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
    funding_source       = case when p_patch ? 'funding_source' then left(btrim(coalesce(p_patch ->> 'funding_source', '')), 100) else funding_source end,
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

  -- Approvals are for what was asked. If what is being bought or what it
  -- costs changes while it waits, earlier approvals no longer count.
  if v_old.status = 'READY' and (
       v_item.title is distinct from v_old.title or v_item.vendor is distinct from v_old.vendor
    or v_item.product_url is distinct from v_old.product_url or v_item.part_number is distinct from v_old.part_number
    or v_item.quantity is distinct from v_old.quantity or v_item.unit_price_cents is distinct from v_old.unit_price_cents
    or v_item.tax_shipping_cents is distinct from v_old.tax_shipping_cents
    or v_item.total_estimate_cents is distinct from v_old.total_estimate_cents
    or v_item.actual_total_cents is distinct from v_old.actual_total_cents) then
    delete from purchasing.approvals where item_id = p_id;
    if found then
      insert into purchasing.events (actor_id, item_id, field, new_value)
      values (auth.uid(), p_id, 'approval', 'reset: the item changed while waiting for approval');
    end if;
  end if;
  return v_item;
end; $$;

-- import_items() from 20261002000000, taking funding_source too.
create or replace function purchasing.import_items(p_project uuid, p_subteam uuid, p_rows jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_name text; v_season uuid; v_row jsonb; v_id uuid; v_status text; n int := 0;
begin
  if not purchasing.is_exec() then raise exception 'only execs import parts with their history' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'no rows to add' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'import at most 1000 rows at a time' using errcode = '22023'; end if;
  if not exists (select 1 from pm.projects where id = p_project) or not exists (select 1 from pm.subteams where id = p_subteam) then
    raise exception 'pick a car and a subteam' using errcode = '22023';
  end if;
  v_name := purchasing.display_name(v_uid);
  select id into v_season from purchasing.seasons where is_current;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    if coalesce(btrim(v_row ->> 'title'), '') = '' then continue; end if;
    perform purchasing.check_amounts(v_row);
    v_status := coalesce(nullif(v_row ->> 'status', ''), 'PLANNED');
    if v_status not in ('PLANNED', 'READY', 'ORDERED', 'RECEIVED', 'HAVE') then
      raise exception 'unknown status % on %', v_status, v_row ->> 'title' using errcode = '22023';
    end if;
    insert into purchasing.items (
      title, status, priority, season_id, requester_id, requester_name, justification, needed_by, date_needed_raw,
      vendor, product_url, part_number, quantity, unit_price_cents, tax_shipping_cents, total_estimate_cents,
      notes, ready_at, source, history_imported_by, funding_source)
    values (
      left(btrim(v_row ->> 'title'), 200), v_status,
      case when v_row ->> 'priority' in ('HIGH', 'Medium', 'Low') then v_row ->> 'priority' else 'Medium' end,
      v_season, v_uid, v_name, coalesce(v_row ->> 'justification', ''),
      nullif(v_row ->> 'needed_by', '')::date, coalesce(v_row ->> 'date_needed_raw', ''),
      nullif(btrim(v_row ->> 'vendor'), ''), coalesce(v_row ->> 'product_url', ''), coalesce(v_row ->> 'part_number', ''),
      coalesce(nullif(v_row ->> 'quantity', '')::numeric, 1),
      nullif(v_row ->> 'unit_price_cents', '')::bigint, nullif(v_row ->> 'tax_shipping_cents', '')::bigint,
      coalesce(nullif(v_row ->> 'total_estimate_cents', '')::bigint,
               round(coalesce(nullif(v_row ->> 'quantity', '')::numeric, 1)
                     * nullif(v_row ->> 'unit_price_cents', '')::bigint)::bigint
               + coalesce(nullif(v_row ->> 'tax_shipping_cents', '')::bigint, 0)),
      coalesce(v_row ->> 'notes', ''), case when v_status <> 'PLANNED' then now() end,
      coalesce(nullif(v_row ->> 'source', ''), 'import'),
      case when v_status in ('ORDERED', 'RECEIVED') then v_uid end,
      left(btrim(coalesce(v_row ->> 'funding_source', '')), 100))
    returning id into v_id;
    insert into purchasing.item_allocations (item_id, project_id, subteam_id, percent) values (v_id, p_project, p_subteam, 100);
    n := n + 1;
  end loop;
  return n;
end; $$;

-- 1. Subteams per car from the org structure ------------------------------------------

drop trigger if exists item_allocations_car_subteam on purchasing.item_allocations;
drop trigger if exists budget_line_subteams_car_subteam on purchasing.budget_line_subteams;
drop function if exists purchasing.car_subteam_from_part();
drop function if exists purchasing.car_subteam_from_budget();
drop function if exists purchasing.set_car_subteam(uuid, uuid, boolean);
drop table if exists purchasing.car_subteams;

-- For 6.0.1 clients until they update: the old map is now the org structure.
-- Reading it shows the org structure; set_car_subteam edits the org structure
-- with its own rule (org.manage_structure). Remove in a later release.
create view purchasing.car_subteams with (security_invoker = true) as
  select project_id, subteam_id from pm.project_subteams;
grant select on purchasing.car_subteams to authenticated, service_role;
create or replace function purchasing.set_car_subteam(p_project uuid, p_subteam uuid, p_on boolean)
returns void language sql security invoker set search_path = '' as $$
  select pm.set_project_subteam(p_project, p_subteam, p_on);
$$;
revoke all on function purchasing.set_car_subteam(uuid, uuid, boolean) from public, anon;
grant execute on function purchasing.set_car_subteam(uuid, uuid, boolean) to authenticated, service_role;

-- add_items() as in 20261002000000 (plus funding_source), checking the org structure: a member
-- adds parts only to a subteam the org structure puts on that car (or one
-- that already has parts there). A car the org structure says nothing about
-- takes any subteam.
create or replace function purchasing.add_items(
  p_project uuid, p_subteam uuid, p_rows jsonb, p_ready boolean default false)
returns setof uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_name text; v_row jsonb; v_id uuid; v_ids uuid[] := '{}';
  v_season uuid; v_code text; v_total bigint := 0; v_exec boolean := purchasing.is_exec();
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not (v_exec or pm.has_capability(v_uid, 'purchasing.request', p_subteam)) then
    raise exception 'you can only request parts for your own subteam' using errcode = '42501';
  end if;
  -- a subteam that already has parts on the car keeps adding to it, even when
  -- an exec set the car up without it
  if not v_exec and exists (select 1 from pm.project_subteams where project_id = p_project)
     and not exists (select 1 from pm.project_subteams where project_id = p_project and subteam_id = p_subteam)
     and not exists (select 1 from purchasing.item_allocations where project_id = p_project and subteam_id = p_subteam) then
    raise exception 'that subteam isn''t on this car (Admin > Org Structure)' using errcode = '42501';
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
    perform purchasing.check_amounts(v_row);
    insert into purchasing.items (
      title, status, priority, season_id, requester_id, requester_name, justification, needed_by, date_needed_raw,
      vendor, product_url, part_number, quantity, unit_price_cents, tax_shipping_cents,
      total_estimate_cents, notes, ready_at, source, funding_source)
    values (
      left(btrim(v_row ->> 'title'), 200),
      case when p_ready then 'READY' else 'PLANNED' end,
      case when v_row ->> 'priority' in ('HIGH', 'Medium', 'Low') then v_row ->> 'priority' else 'Medium' end,
      v_season, v_uid, v_name, coalesce(v_row ->> 'justification', ''),
      nullif(v_row ->> 'needed_by', '')::date, left(coalesce(v_row ->> 'date_needed_raw', ''), 100),
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
      case when p_ready then now() end,
      coalesce(nullif(left(v_row ->> 'source', 200), ''), 'app'),
      left(btrim(coalesce(v_row ->> 'funding_source', '')), 100))
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

-- 2. Deleting parts ----------------------------------------------------------------------

-- Execs: delete parts that never got as far as spending money: planned,
-- waiting for approval, denied, cancelled, or already had. An approved or
-- ordered part is committed or spent and counts toward its budget, so it is
-- cancelled (or its order undone) first, a separate step that shows in its
-- history. Not a part a reimbursement points at either. The parts history
-- (purchasing.events, which has no foreign key to items) keeps who deleted it
-- and the whole part as it was; approvals and notifications go with it.
create or replace function purchasing.delete_items(p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_codes text; n int;
begin
  if not purchasing.is_exec() then raise exception 'only execs delete parts' using errcode = '42501'; end if;
  perform 1 from purchasing.items where id = any (p_ids) order by id for update;
  select string_agg(code, ', ' order by code) into v_codes from purchasing.items
  where id = any (p_ids) and (finance_txn_id is not null or status not in ('PLANNED', 'READY', 'DENIED', 'CANCELLED', 'HAVE'));
  if v_codes is not null then
    raise exception 'approved, ordered and charge-matched parts can''t be deleted: %. Cancel them, or undo the order, first.', v_codes
      using errcode = '22023';
  end if;
  select string_agg(i.code, ', ' order by i.code) into v_codes from purchasing.items i
  where i.id = any (p_ids) and exists (select 1 from finance.reimbursements r where r.item_id = i.id);
  if v_codes is not null then
    raise exception '% % a reimbursement pointing at it', v_codes,
      case when position(',' in v_codes) > 0 then 'have' else 'has' end using errcode = '22023';
  end if;
  perform purchasing.log_deleted(p_ids);
  delete from purchasing.items where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end; $$;

-- What a deleted part was, in its history: code, title, and the whole row
-- with its split as JSON.
create or replace function purchasing.log_deleted(p_ids uuid[])
returns void language sql security definer set search_path = '' as $$
  insert into purchasing.events (actor_id, item_id, field, old_value, new_value)
  select auth.uid(), i.id, 'deleted', i.code || ' ' || i.title,
         (to_jsonb(i) || jsonb_build_object('item_allocations',
           (select coalesce(jsonb_agg(to_jsonb(a) - 'item_id'), '[]') from purchasing.item_allocations a where a.item_id = i.id)))::text
  from purchasing.items i where i.id = any (p_ids);
$$;

-- Execs: empty Abacus so the old ledger can be restored (restore_ledger only
-- fills an empty Agora). Only while the books are empty too: then no part's
-- spending is recorded anywhere else, and the restore brings the parts list
-- back. Every part is logged as above.
create or replace function purchasing.clear_parts_for_restore()
returns int language plpgsql security definer set search_path = '' as $$
declare v_busy text; n int;
begin
  if not (finance.can_edit() and purchasing.is_exec()) then
    raise exception 'only execs can empty Abacus for a restore' using errcode = '42501';
  end if;
  lock table purchasing.items in exclusive mode;
  select string_agg(what, ', ') into v_busy from (
    select format('%s ledger lines', count(*)) what from finance.transactions having count(*) > 0
    union all select format('%s statements', count(*)) from finance.statements having count(*) > 0
    union all select format('%s weekly balances', count(*)) from finance.balance_entries having count(*) > 0
    union all select format('%s reimbursements', count(*)) from finance.reimbursements having count(*) > 0
    union all select format('%s invoices', count(*)) from finance.evidence having count(*) > 0
    union all select format('%s uploads', count(*)) from finance.imports having count(*) > 0
  ) x;
  if v_busy is not null then
    raise exception 'the books already have %, so a restore can''t run and Abacus was left as it is', v_busy using errcode = '55000';
  end if;
  perform purchasing.log_deleted(array(select id from purchasing.items));
  delete from purchasing.items where id is not null;
  get diagnostics n = row_count;
  return n;
end; $$;

revoke all on function purchasing.log_deleted(uuid[]) from public, anon, authenticated;
revoke all on function purchasing.clear_parts_for_restore() from public, anon;
grant execute on function purchasing.clear_parts_for_restore() to authenticated, service_role;
revoke all on function purchasing.delete_items(uuid[]) from public, anon;
grant execute on function purchasing.delete_items(uuid[]) to authenticated, service_role;
