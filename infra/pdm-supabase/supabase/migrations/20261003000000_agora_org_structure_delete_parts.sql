-- Agora after 6.0.1:
--   1. Which subteams each car has comes from Helios's org structure
--      (pm.project_subteams, edited in Admin > Org Structure), not a second
--      map of Agora's own. purchasing.car_subteams (20261002000000) goes;
--      add_items checks the org structure instead.
--   2. Execs can delete parts (mistakes, test rows, or clearing Abacus before
--      restoring the old ledger), except parts matched to a ledger charge.

-- 1. Subteams per car from the org structure ------------------------------------------

drop trigger if exists item_allocations_car_subteam on purchasing.item_allocations;
drop trigger if exists budget_line_subteams_car_subteam on purchasing.budget_line_subteams;
drop function if exists purchasing.car_subteam_from_part();
drop function if exists purchasing.car_subteam_from_budget();
drop function if exists purchasing.set_car_subteam(uuid, uuid, boolean);
drop table if exists purchasing.car_subteams;

-- add_items() as in 20261002000000, checking the org structure: a member
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
      total_estimate_cents, notes, ready_at, source)
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
      coalesce(nullif(left(v_row ->> 'source', 200), ''), 'app'))
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

-- Execs: delete parts from the list. Not a part matched to a ledger charge:
-- unlink it in the Ledger first, so the books never lose their evidence. The
-- parts history (purchasing.events, which has no foreign key to items) keeps a
-- line saying who deleted what; approvals and notifications go with the part.
create or replace function purchasing.delete_items(p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_codes text; n int;
begin
  if not purchasing.is_exec() then raise exception 'only execs delete parts' using errcode = '42501'; end if;
  perform 1 from purchasing.items where id = any (p_ids) for update;
  select string_agg(code, ', ') into v_codes from purchasing.items where id = any (p_ids) and finance_txn_id is not null;
  if v_codes is not null then
    raise exception '% % matched to a ledger charge: unlink it in the Ledger first', v_codes,
      case when position(',' in v_codes) > 0 then 'are' else 'is' end using errcode = '22023';
  end if;
  insert into purchasing.events (actor_id, item_id, field, old_value, new_value)
  select auth.uid(), id, 'deleted', code || ' ' || title, null from purchasing.items where id = any (p_ids);
  delete from purchasing.items where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end; $$;

revoke all on function purchasing.delete_items(uuid[]) from public, anon;
grant execute on function purchasing.delete_items(uuid[]) to authenticated, service_role;
