-- Agora after 6.0.2:
--   1. The CFO can change anything in Abacus. Approvals often happen in
--      person (at the exec meeting, in the shop), and the CFO places the
--      orders, so they approve a part on their own say-so, set any status,
--      record orders on parts they imported, delete approved or ordered
--      parts, and move parts to another subteam or car. It is a capability,
--      purchasing.override, given to the CFO role; Admin can give it to
--      another role. Every such step is in the part's history under their
--      name, and an approval in person is an approval row noting it.
--   Execs delete reimbursements entered by mistake from the app: the
--   reimbursements_delete policy (20261001010000) already allows it.

-- 1. The capability ----------------------------------------------------------------------

insert into pm.capabilities (key, label, description, scope) values
  ('purchasing.override', 'Purchasing: override',
   'Approve parts alone (approvals given in person), set any status, move and delete any part', 'org')
on conflict (key) do update
  set label = excluded.label, description = excluded.description, scope = excluded.scope;

insert into pm.role_capabilities (role_id, capability_key)
select r.id, 'purchasing.override' from pm.roles r where r.key = 'cfo'
on conflict (role_id, capability_key) do nothing;

create or replace function purchasing.can_override()
returns boolean language sql stable security definer set search_path = '' as $$
  select pm.has_capability((select auth.uid()), 'purchasing.override', null);
$$;

-- Approve parts on the caller's word alone: an approval in their name with
-- the note ("approved in person" if none), and the part is APPROVED. Parts
-- already approved or further along are left as they are. Internal: called
-- only by the RPCs below, after they check purchasing.override.
create or replace function purchasing.approve_in_person(p_ids uuid[], p_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_ids uuid[]; v_note text := coalesce(nullif(btrim(p_note), ''), 'approved in person');
begin
  select coalesce(array_agg(id), '{}') into v_ids from purchasing.items
  where id = any (p_ids) and status not in ('APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED');
  if cardinality(v_ids) = 0 then return; end if;
  insert into purchasing.approvals (item_id, user_id, decision, note)
  select x, v_uid, 'approve', v_note from unnest(v_ids) x
  on conflict (item_id, user_id) do update set decision = 'approve', note = excluded.note, at = now();
  insert into purchasing.events (actor_id, item_id, field, new_value)
  select v_uid, x, 'approval', 'approve (override) ' || v_note from unnest(v_ids) x;
  update purchasing.items set status = 'APPROVED', approved_at = coalesce(approved_at, now()), denied_reason = ''
  where id = any (v_ids);
end; $$;

-- 2. Approving and moving parts through their statuses ------------------------------------

-- set_status() from 20261001000000. A purchasing.override holder may set
-- APPROVED (an approval in person) and move a part that isn't approved
-- straight to ordered, shipped or received (approving it on the way).
create or replace function purchasing.set_status(p_ids uuid[], p_status text, p_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_exec boolean := purchasing.is_exec(); v_item purchasing.items;
  v_ready uuid[] := '{}'; v_delivered uuid[] := '{}'; v_name text; v_delivery uuid;
  v_override boolean := purchasing.can_override(); v_approved uuid[] := '{}';
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_status not in ('PLANNED', 'READY', 'APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED',
                      'RECEIVED', 'RECONCILED', 'DENIED', 'CANCELLED', 'HAVE') then
    raise exception 'unknown status %', p_status using errcode = '22023';
  end if;
  for v_item in select * from purchasing.items where id = any (p_ids) for update loop
    if v_item.status = p_status then continue; end if;
    -- the CFO (purchasing.override) approves on their own: approvals given in person
    -- (an ordered part set back to Approved just changes status, below)
    if v_override and p_status = 'APPROVED' and v_item.status not in ('APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED') then
      perform purchasing.approve_in_person(array[v_item.id], p_note);
      v_approved := v_approved || v_item.id;
      continue;
    end if;
    if v_override and p_status in ('ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED')
       and v_item.status not in ('APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED') then
      perform purchasing.approve_in_person(array[v_item.id], p_note);
      v_item.status := 'APPROVED';
    end if;
    if p_status = 'APPROVED' and not v_override then
      raise exception '% needs two exec approvals: use Approve, not a status change', v_item.code using errcode = '42501';
    end if;
    if p_status in ('ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED')
       and v_item.status not in ('APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED') then
      raise exception '% hasn''t been approved yet', v_item.code using errcode = '42501';
    end if;
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
  if array_length(v_approved, 1) > 0 then
    perform purchasing.notify(
      array(select u from unnest(purchasing.users_with('purchasing.order')) u where u <> v_uid), v_approved[1], 'approved',
      'Approved, ready to buy: ' || (select string_agg(code || ' ' || title, ', ') from purchasing.items where id = any (v_approved)));
    perform purchasing.notify(
      array(select distinct requester_id from purchasing.items where id = any (v_approved)
            and requester_id <> v_uid and not (requester_id = any (purchasing.users_with('purchasing.order')))),
      v_approved[1], 'approved', 'Your part was approved by ' || v_name || '.');
  end if;
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

-- record_order() from 20261002000000: the CFO may record an order on parts
-- not yet approved, approving them in person.
create or replace function purchasing.record_order(
  p_ids uuid[], p_order_id text, p_payment text, p_ordered_on date default null,
  p_total_cents bigint default null, p_paid_by text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_sum bigint; v_left bigint; v_share bigint; r record; n int; i int := 0;
begin
  if not pm.has_capability(v_uid, 'purchasing.order', null) then
    raise exception 'only execs record orders' using errcode = '42501';
  end if;
  if purchasing.can_override() then
    perform purchasing.approve_in_person(p_ids, 'approved in person when the order was recorded');
  end if;
  if exists (select 1 from purchasing.items x where x.id = any (p_ids)
             and x.status not in ('APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED')) then
    raise exception 'only approved items can be ordered' using errcode = '42501';
  end if;
  if p_total_cents < 0 then raise exception 'an order total can''t be negative' using errcode = '22023'; end if;
  perform purchasing.check_not_own_import(p_ids);
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
      vendor_order_id = coalesce(nullif(btrim(p_order_id), ''), vendor_order_id),
      payment_method = coalesce(nullif(p_payment, ''), payment_method),
      paid_by = coalesce(nullif(p_paid_by, ''), paid_by),
      ordered_at = coalesce(p_ordered_on, ordered_at, purchasing.team_day()),
      purchaser_id = coalesce(purchaser_id, v_uid), actual_total_cents = coalesce(v_share, actual_total_cents)
    where id = r.id;
  end loop;
end; $$;

-- record_order_lines() from 20261002000000, the same way.
create or replace function purchasing.record_order_lines(
  p_lines jsonb, p_order_id text, p_payment text, p_ordered_on date default null,
  p_total_cents bigint default null, p_paid_by text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_ids uuid[]; v_sum bigint;
begin
  if not pm.has_capability(v_uid, 'purchasing.order', null) then
    raise exception 'only execs record orders' using errcode = '42501';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'pick the parts in this order' using errcode = '22023';
  end if;
  select array_agg((l ->> 'id')::uuid), sum((l ->> 'actual_total_cents')::bigint)
    into v_ids, v_sum from jsonb_array_elements(p_lines) l;
  if exists (select 1 from jsonb_array_elements(p_lines) l
             where (l ->> 'actual_total_cents')::bigint is null or (l ->> 'actual_total_cents')::bigint < 0) then
    raise exception 'each part needs its share of the order, and none can be negative' using errcode = '22023';
  end if;
  if p_total_cents is not null and v_sum <> p_total_cents then
    raise exception 'the parts add up to $%, not the order total of $%',
      to_char(v_sum / 100.0, 'FM999999990.00'), to_char(p_total_cents / 100.0, 'FM999999990.00') using errcode = '22023';
  end if;
  if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
    raise exception 'a part is in the order twice' using errcode = '22023';
  end if;
  perform 1 from purchasing.items where id = any (v_ids) for update;
  if (select count(*) from purchasing.items where id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'some of those parts don''t exist' using errcode = 'P0002';
  end if;
  if purchasing.can_override() then
    perform purchasing.approve_in_person(v_ids, 'approved in person when the order was recorded');
  end if;
  perform purchasing.check_not_own_import(v_ids);
  if exists (select 1 from purchasing.items x where x.id = any (v_ids)
             and x.status not in ('APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED')) then
    raise exception 'only approved items can be ordered' using errcode = '42501';
  end if;
  update purchasing.items i set
    status = case when i.status in ('ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED') then i.status else 'ORDERED' end,
    vendor_order_id = coalesce(nullif(btrim(p_order_id), ''), i.vendor_order_id),
    payment_method = coalesce(nullif(p_payment, ''), i.payment_method),
    paid_by = coalesce(nullif(p_paid_by, ''), i.paid_by),
    ordered_at = coalesce(p_ordered_on, i.ordered_at, purchasing.team_day()),
    purchaser_id = coalesce(i.purchaser_id, v_uid),
    actual_total_cents = (l ->> 'actual_total_cents')::bigint,
    tax_shipping_cents = coalesce(nullif(l ->> 'tax_shipping_cents', '')::bigint, i.tax_shipping_cents)
  from jsonb_array_elements(p_lines) l
  where i.id = (l ->> 'id')::uuid;
end; $$;

-- add_tracking() from 20261001000000, the same way.
create or replace function purchasing.add_tracking(p_ids uuid[], p_number text, p_carrier text default '', p_eta date default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_delivery uuid; v_names text;
begin
  if not pm.has_capability(v_uid, 'purchasing.order', null) then
    raise exception 'only execs add tracking' using errcode = '42501';
  end if;
  if purchasing.can_override() then
    perform purchasing.approve_in_person(p_ids, 'approved in person when tracking was added');
  end if;
  if exists (select 1 from purchasing.items x where x.id = any (p_ids)
             and x.status not in ('APPROVED', 'ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'RECONCILED')) then
    raise exception 'only approved items can be shipped' using errcode = '42501';
  end if;
  update purchasing.items set
    tracking_number = upper(regexp_replace(coalesce(p_number, ''), '[\s-]', '', 'g')),
    carrier = coalesce(nullif(p_carrier, ''), carrier), est_delivery = coalesce(p_eta, est_delivery),
    status = case when status in ('APPROVED', 'ORDERED', 'BACKORDERED') then 'SHIPPED' else status end,
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

-- 20261002000000's rule that whoever imported a part already ordered can't
-- also record its order doesn't hold the CFO, who approves in person.
create or replace function purchasing.check_not_own_import(p_ids uuid[])
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_codes text;
begin
  select string_agg(code, ', ') into v_codes from purchasing.items
  where id = any (p_ids) and approved_at is null and history_imported_by = auth.uid() and not purchasing.can_override();
  if v_codes is not null then
    raise exception 'you imported % without approvals, so another exec has to record its order', v_codes using errcode = '42501';
  end if;
end; $$;

create or replace function purchasing.guard_own_import()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.history_imported_by = auth.uid() and old.approved_at is null and new.status not in ('PLANNED', 'READY')
     and not purchasing.can_override()
     and (new.actual_total_cents is distinct from old.actual_total_cents or new.vendor_order_id is distinct from old.vendor_order_id
          or new.payment_method is distinct from old.payment_method or new.paid_by is distinct from old.paid_by
          or new.ordered_at is distinct from old.ordered_at) then
    raise exception 'you imported % without approvals, so another exec has to record its order', old.code using errcode = '42501';
  end if;
  return new;
end; $$;

-- 3. Deleting and moving parts -------------------------------------------------------------

-- delete_items() from 20261003000000. The CFO deletes any part except one
-- matched to a ledger charge, which is the evidence for that charge
-- (unmatch it in the ledger first). A reimbursement pointing at a deleted
-- part keeps its amount and reason and loses the link.
create or replace function purchasing.delete_items(p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_codes text; n int; v_override boolean := purchasing.can_override();
begin
  if not purchasing.is_exec() then raise exception 'only execs delete parts' using errcode = '42501'; end if;
  perform 1 from purchasing.items where id = any (p_ids) order by id for update;
  -- the CFO deletes any part except one matched to a ledger charge (unmatch it in the ledger first)
  select string_agg(code, ', ' order by code) into v_codes from purchasing.items
  where id = any (p_ids) and finance_txn_id is not null;
  if v_codes is not null and v_override then
    raise exception 'parts matched to a ledger charge can''t be deleted: %. Unmatch them in the ledger first.', v_codes
      using errcode = '22023';
  end if;
  select string_agg(code, ', ' order by code) into v_codes from purchasing.items
  where id = any (p_ids) and not v_override
    and (finance_txn_id is not null or status not in ('PLANNED', 'READY', 'DENIED', 'CANCELLED', 'HAVE'));
  if v_codes is not null then
    raise exception 'approved, ordered and charge-matched parts can''t be deleted: %. Cancel them, or undo the order, first.', v_codes
      using errcode = '22023';
  end if;
  select string_agg(i.code, ', ' order by i.code) into v_codes from purchasing.items i
  where i.id = any (p_ids) and not v_override and exists (select 1 from finance.reimbursements r where r.item_id = i.id);
  if v_codes is not null then
    raise exception '% % a reimbursement pointing at it', v_codes,
      case when position(',' in v_codes) > 0 then 'have' else 'has' end using errcode = '22023';
  end if;
  perform purchasing.log_deleted(p_ids);
  delete from purchasing.items where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end; $$;

-- The CFO moves parts to another car or subteam (filed under the wrong tab,
-- say). A part split over several subteams becomes all the new one's. A
-- charge whose split was made from its parts is split again.
create or replace function purchasing.move_items(p_ids uuid[], p_project uuid, p_subteam uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare n int; v_to text; v_txn bigint;
begin
  if not purchasing.can_override() then
    raise exception 'only the CFO moves parts to another subteam' using errcode = '42501';
  end if;
  select p.car_code || ' ' || s.code into v_to from pm.projects p, pm.subteams s where p.id = p_project and s.id = p_subteam;
  if v_to is null then raise exception 'no such car or subteam' using errcode = 'P0002'; end if;
  perform 1 from purchasing.items where id = any (p_ids) order by id for update;
  insert into purchasing.events (actor_id, item_id, field, old_value, new_value)
  select auth.uid(), i.id, 'subteam',
         (select string_agg(p.car_code || ' ' || s.code || case when a.percent < 100 then ' ' || a.percent::float || '%' else '' end, ', ')
            from purchasing.item_allocations a join pm.projects p on p.id = a.project_id join pm.subteams s on s.id = a.subteam_id
           where a.item_id = i.id),
         v_to
  from purchasing.items i where i.id = any (p_ids)
    and not exists (select 1 from purchasing.item_allocations a where a.item_id = i.id
                    and a.project_id = p_project and a.subteam_id = p_subteam and a.percent = 100);
  delete from purchasing.item_allocations where item_id = any (p_ids);
  insert into purchasing.item_allocations (item_id, project_id, subteam_id, percent)
  select id, p_project, p_subteam, 100 from purchasing.items where id = any (p_ids);
  get diagnostics n = row_count;
  for v_txn in select distinct finance_txn_id from purchasing.items where id = any (p_ids) and finance_txn_id is not null loop
    perform finance.split_from_parts(v_txn);
  end loop;
  return n;
end; $$;

-- 4. Grants ----------------------------------------------------------------------------------

revoke all on function purchasing.approve_in_person(uuid[], text) from public, anon, authenticated;
revoke all on function purchasing.move_items(uuid[], uuid, uuid), purchasing.can_override() from public, anon;
grant execute on function purchasing.move_items(uuid[], uuid, uuid), purchasing.can_override() to authenticated, service_role;
