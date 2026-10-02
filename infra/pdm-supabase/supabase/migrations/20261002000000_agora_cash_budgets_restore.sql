-- Agora, after the first week in use:
--   1. Reimbursements can be paid in cash, from the cash box or withdrawn at
--      the bank, not only by check.
--   2. Execs set up seasons and budget lines in the app (there was an RPC for
--      lines but nothing to create a season with).
--   3. Order totals: an order confirmation's tax, shipping and fees are spread
--      over the parts bought together, per part, and an estimated sales tax
--      rate shows a rough all-in cost before anything is bought.
--      Execs can upload Airtable rows that were already Ordered or Received,
--      and undo an order recorded by mistake.
--   4. A one-time restore of the standalone SDM ledger (sdm-purchasing-tool's
--      export) into an empty Agora, from the app.
--   5. Each car has its own subteams; accounts added by mistake can be deleted.

-- 1. Cash reimbursements --------------------------------------------------------

alter table finance.reimbursements
  add column paid_with text check (paid_with in ('check', 'cash_box', 'bank_cash'));
comment on column finance.reimbursements.paid_with is
  'check, cash_box (cash from the team cash box) or bank_cash (cash withdrawn from checking)';
comment on column finance.reimbursements.check_txn_id is
  'The ledger line that paid it: the check, or the cash withdrawal';
update finance.reimbursements set paid_with = 'check' where status = 'paid' and check_number is not null;

-- The guard from 20261001010000, now also keeping how a paid reimbursement was paid.
create or replace function finance.guard_reimbursement_writes()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then return coalesce(new, old); end if;   -- the RPCs (definer) and the service role
  if tg_op = 'INSERT' then
    if new.user_id = auth.uid() then
      raise exception 'ask for your own reimbursement under Get reimbursed' using errcode = '42501';
    end if;
    if new.status not in ('owed', 'requested') then
      raise exception 'a new reimbursement is owed or requested' using errcode = '42501';
    end if;
    if new.paid_with is not null or new.check_txn_id is not null or new.paid_date is not null
       or nullif(btrim(coalesce(new.check_number, '')), '') is not null then
      raise exception 'a new reimbursement isn''t paid yet: pay it with the buttons' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.user_id = auth.uid() then
    raise exception 'another exec has to handle your own reimbursement' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.user_id is distinct from old.user_id
      or new.decided_by is distinct from old.decided_by or new.check_txn_id is distinct from old.check_txn_id
      or new.paid_with is distinct from old.paid_with) then
    raise exception 'approve, decline and pay with the buttons, not by editing the row' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status = 'paid' and (new.amount_cents is distinct from old.amount_cents
      or new.paid_date is distinct from old.paid_date or new.check_number is distinct from old.check_number) then
    raise exception 'a paid reimbursement''s amount and check can''t change' using errcode = '42501';
  end if;
  return coalesce(new, old);
end; $$;

-- Pay reimbursements by check or in cash. With p_add_to_ledger:
--   check     one uncashed check from checking (one person only), as before;
--   cash_box  one withdrawal from the Cash Box account (made if missing):
--             the cash box has no statement, so this line is its record;
--   bank_cash one withdrawal from checking, dated the day the cash came out.
--             When the statement arrives, its withdrawal line is recognised
--             as this one (same amount within 3 days) and not added twice.
-- pay_reimbursements() stays for older clients and pays by check.
create or replace function finance.record_reimbursement_payment(
  p_ids bigint[], p_method text, p_paid_date date, p_check_number text, p_add_to_ledger boolean)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_names text; v_total bigint; v_txn bigint; v_acct bigint; v_reasons text;
  v_date date := coalesce(p_paid_date, purchasing.team_day());
  v_check text := nullif(btrim(coalesce(p_check_number, '')), '');
begin
  if p_method is null or p_method not in ('check', 'cash_box', 'bank_cash') then
    raise exception 'paid by check, from the cash box, or with cash from the bank' using errcode = '22023';
  end if;
  if not finance.can_edit() then raise exception 'only execs pay reimbursements' using errcode = '42501'; end if;
  -- a row without an amount would be marked paid without being in the check or the cash
  select string_agg(distinct btrim(person_name) || coalesce(' (' || nullif(left(reason, 40), '') || ')', ''), ', ') into v_names
    from finance.reimbursements where id = any (coalesce(p_ids, '{}')) and coalesce(amount_cents, 0) <= 0;
  if v_names is not null then
    raise exception 'enter the amount first: %', v_names using errcode = '22023';
  end if;
  -- the cash box has no statement: its withdrawal line is the only record of the cash going out
  if p_method = 'cash_box' and not coalesce(p_add_to_ledger, false) then
    raise exception 'cash from the cash box has to go in the ledger' using errcode = '22023';
  end if;
  if p_method = 'check' then
    v_txn := finance.pay_reimbursements(p_ids, v_date, v_check, coalesce(p_add_to_ledger, false));
    update finance.reimbursements set paid_with = 'check' where id = any (p_ids);
    return v_txn;
  end if;

  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'pick at least one' using errcode = '22023'; end if;
  perform 1 from finance.reimbursements where id = any (p_ids) for update;
  if (select count(*) from finance.reimbursements where id = any (p_ids)) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'some of those reimbursements don''t exist' using errcode = 'P0002';
  end if;
  if exists (select 1 from finance.reimbursements where id = any (p_ids) and user_id = auth.uid()) then
    raise exception 'another exec has to pay your own reimbursement' using errcode = '42501';
  end if;
  if exists (select 1 from finance.reimbursements where id = any (p_ids) and status in ('requested', 'denied')) then
    raise exception 'approve the requests before paying them' using errcode = '22023';
  end if;
  if exists (select 1 from finance.reimbursements where id = any (p_ids) and status = 'paid') then
    raise exception 'some of those were already paid' using errcode = '22023';
  end if;

  if coalesce(p_add_to_ledger, false) then
    select sum(amount_cents), string_agg(distinct btrim(person_name), ', '), string_agg(reason, '; ')
      into v_total, v_names, v_reasons
      from finance.reimbursements where id = any (p_ids);
    if p_method = 'cash_box' then
      select id into v_acct from finance.accounts where kind = 'holding' and name ilike 'cash%box%' order by active desc, id limit 1;
      if v_acct is null then
        insert into finance.accounts (name, kind, notes)
        values ('Cash Box', 'holding', 'Cash kept by the team. Enter its count under Weekly balances.')
        returning id into v_acct;
      end if;
    else
      select id into v_acct from finance.accounts where kind = 'checking' and active order by id limit 1;
      if v_acct is null then raise exception 'no checking account' using errcode = 'P0002'; end if;
    end if;
    insert into finance.transactions (account_id, date, amount_cents, description, kind, category, source, notes)
    values (v_acct, v_date, -v_total,
            case when p_method = 'cash_box' then 'Cash from the cash box: reimbursement to ' else 'Cash withdrawal: reimbursement to ' end
              || v_names || ': ' || left(v_reasons, 300),
            'withdrawal', 'Reimbursement', 'manual', 'Paid in cash for ' || array_length(p_ids, 1) || ' reimbursement(s)')
    returning id into v_txn;
  end if;

  update finance.reimbursements set
    status = 'paid', paid_with = p_method, paid_date = coalesce(paid_date, v_date),
    check_txn_id = coalesce(v_txn, check_txn_id)
  where id = any (p_ids);
  perform purchasing.notify(
    array(select distinct user_id from finance.reimbursements where id = any (p_ids)), null, 'reimbursement',
    'Your reimbursement was paid in cash.');
  return v_txn;
end; $$;

-- 2. Seasons and budget lines -------------------------------------------------------

-- Execs create or rename a season and choose the current one (new parts and
-- the Budgets page use the current season).
create or replace function purchasing.upsert_season(
  p_id uuid, p_name text, p_starts_on date, p_ends_on date, p_current boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := p_id;
begin
  if not purchasing.is_exec() then raise exception 'only execs set up seasons' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'name the season, e.g. 2026-27' using errcode = '22023'; end if;
  if p_starts_on is not null and p_ends_on is not null and p_ends_on < p_starts_on then
    raise exception 'the season ends before it starts' using errcode = '22023';
  end if;
  if coalesce(p_current, false) then
    update purchasing.seasons set is_current = false where is_current and id is distinct from v_id;
  end if;
  if v_id is null then
    insert into purchasing.seasons (name, starts_on, ends_on, is_current)
    values (btrim(p_name), p_starts_on, p_ends_on,
            coalesce(p_current, false) or not exists (select 1 from purchasing.seasons where is_current))
    returning id into v_id;
  else
    update purchasing.seasons set name = btrim(p_name), starts_on = p_starts_on, ends_on = p_ends_on,
      is_current = case when p_current then true else is_current end
    where id = v_id;
    if not found then raise exception 'no such season' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end; $$;

create or replace function purchasing.delete_budget_line(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not purchasing.is_exec() then raise exception 'only execs set budgets' using errcode = '42501'; end if;
  delete from purchasing.budget_lines where id = p_id;
  if not found then raise exception 'no such budget line' using errcode = 'P0002'; end if;
end; $$;

-- 3. Order totals ---------------------------------------------------------------------

-- Sales tax isn't on most requests (members aren't asked to work it out), so
-- approvals show an estimate at this rate where an item has no tax/shipping.
insert into purchasing.settings (key, value) values ('estimated_tax_percent', '8.1')
on conflict (key) do nothing;

-- Record a vendor order with each part's real share of the order total. The
-- app reads the order confirmation (subtotal, shipping, tax, fees) and spreads
-- the extras over the parts by their price; p_lines carries the result:
--   [{id, actual_total_cents, tax_shipping_cents}]
-- Unlike record_order(), nothing is guessed here: the shares must add up to
-- p_total_cents when it is given.
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

-- Parts imported already Ordered or Received never went through approvals.
-- Whoever imported them can't also put an order and its cost on them;
-- another exec has to (the two-person rule that approvals give other parts).
alter table purchasing.items add column history_imported_by uuid;
comment on column purchasing.items.history_imported_by is
  'The exec who imported this part already ordered or received (import_items), skipping approvals';

create or replace function purchasing.check_not_own_import(p_ids uuid[])
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_codes text;
begin
  select string_agg(code, ', ') into v_codes from purchasing.items
  where id = any (p_ids) and approved_at is null and history_imported_by = auth.uid();
  if v_codes is not null then
    raise exception 'you imported % without approvals, so another exec has to record its order', v_codes using errcode = '42501';
  end if;
end; $$;

-- Bring in Airtable rows with their history. add_items() starts every row
-- at PLANNED or READY, and set_status() rightly refuses to move an unapproved
-- part to ORDERED, so rows Airtable already had as Ordered or Received could
-- not be uploaded. Execs import them as they were; members can't (their
-- uploads go through add_items()).
-- p_rows: as add_items(), plus status (PLANNED, READY, ORDERED, RECEIVED, HAVE)
-- and source (e.g. 'airtable:IC Team/Aero-Grid view.csv row 4').
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
      notes, ready_at, source, history_imported_by)
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
      case when v_status in ('ORDERED', 'RECEIVED') then v_uid end)
    returning id into v_id;
    insert into purchasing.item_allocations (item_id, project_id, subteam_id, percent) values (v_id, p_project, p_subteam, 100);
    n := n + 1;
  end loop;
  return n;
end; $$;

-- 4. Restore the standalone ledger ----------------------------------------------------
--
-- The CFO kept the books in a standalone tool (sdm-purchasing-tool) before
-- Agora. Its export (python -m sdm.export_helios) holds the accounts,
-- statements, every ledger line and its split, invoices, weekly balances,
-- reimbursements, budgets, resolved discrepancies, vendors and the Airtable
-- parts list. This loads it into an EMPTY Agora in one transaction, keeping
-- the old ids so discrepancy keys still line up. It refuses if anything is
-- already there: it never merges into or overwrites live books.
--   p_cars:     {"IC": <project id>, "EV": <project id>, "Team": <project id>}
--               Team-wide ledger splits stay team-wide (no car); "Team" says
--               which car whole-team parts and budget lines go under (every
--               part and budget line belongs to a car). Only needed if the
--               export has any.
--   p_subteams: {"<subteam name in the export>": <subteam id>, ...}
--   p_season_start: when the current season began. Spending before it (last
--               year's competition, say) doesn't count toward its budgets.
create or replace function finance.restore_ledger(p_data jsonb, p_cars jsonb, p_subteams jsonb, p_season_start date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_busy text; v_season uuid; v_name text; v_line uuid; v_skipped text[] := '{}'; b jsonb;
  v_items int;
begin
  if not (finance.can_edit() and purchasing.is_exec()) then
    raise exception 'only execs can restore the books' using errcode = '42501';
  end if;
  if p_data ->> 'source' is distinct from 'sdm-ledger' then
    raise exception 'that isn''t an export from the SDM ledger' using errcode = '22023';
  end if;
  if coalesce(p_cars ->> 'IC', '') = '' or coalesce(p_cars ->> 'EV', '') = '' then
    raise exception 'pick which car is IC and which is EV' using errcode = '22023';
  end if;
  if p_season_start is null then
    raise exception 'enter the day this season started' using errcode = '22023';
  end if;
  if coalesce(p_cars ->> 'Team', '') = '' and (
       exists (select 1 from jsonb_array_elements(p_data -> 'budgets') x where x ->> 'program' = 'Team')
    or exists (select 1 from jsonb_array_elements(p_data -> 'line_item_allocations') x where x ->> 'program' = 'Team')) then
    raise exception 'pick which car whole-team parts and budgets go under' using errcode = '22023';
  end if;
  -- every subteam the export names must be mapped
  select string_agg(distinct n, ', ') into v_name
  from (
    select x ->> 'subteam' as n from jsonb_array_elements(p_data -> 'allocations') x
    union select x ->> 'subteam' from jsonb_array_elements(p_data -> 'line_item_allocations') x
    union select x ->> 'subteam' from jsonb_array_elements(p_data -> 'budgets') x
    union select x ->> 'subteam' from jsonb_array_elements(p_data -> 'evidence') x
  ) s where coalesce(n, '') <> '' and coalesce(p_subteams ->> n, '') = '';
  if v_name is not null then raise exception 'pick a subteam for: %', v_name using errcode = '22023'; end if;

  -- refuse unless the books and the parts list are empty
  select string_agg(what, ', ') into v_busy from (
    select format('%s ledger lines', count(*)) what from finance.transactions having count(*) > 0
    union all select format('%s statements', count(*)) from finance.statements having count(*) > 0
    union all select format('%s weekly balances', count(*)) from finance.balance_entries having count(*) > 0
    union all select format('%s reimbursements', count(*)) from finance.reimbursements having count(*) > 0
    union all select format('%s invoices', count(*)) from finance.evidence having count(*) > 0
    union all select format('%s uploads', count(*)) from finance.imports having count(*) > 0
    union all select format('%s parts', count(*)) from purchasing.items having count(*) > 0
  ) x;
  if v_busy is not null then
    raise exception 'Agora already has %. The restore only fills an empty Agora, so nothing was changed.', v_busy
      using errcode = '55000';
  end if;
  -- accounts made by hand with nothing on them yet are replaced by the export's
  update finance.accounts set paid_from_account_id = null where paid_from_account_id is not null;
  delete from finance.accounts where id is not null;
  delete from finance.discrepancy_resolutions where key is not null;

  -- categories and vendors (by name; the export's wording wins)
  insert into finance.categories (name, direction, description)
  select x ->> 'name', x ->> 'direction', coalesce(x ->> 'description', '')
  from jsonb_array_elements(p_data -> 'categories') x
  on conflict (name) do update set direction = excluded.direction, description = excluded.description;
  insert into finance.vendors (name, aliases, merchant_pattern, default_category, review_note)
  select x ->> 'name',
         coalesce(array(select btrim(a) from unnest(string_to_array(coalesce(x ->> 'aliases', ''), '|')) a where btrim(a) <> ''), '{}'),
         coalesce(x ->> 'merchant_pattern', ''),
         case when exists (select 1 from finance.categories c where c.name = x ->> 'default_category')
              then x ->> 'default_category' else 'Needs category' end,
         coalesce(x ->> 'review_note', '')
  from jsonb_array_elements(coalesce(p_data -> 'vendors', '[]')) x
  on conflict (name) do update set aliases = excluded.aliases, merchant_pattern = excluded.merchant_pattern,
    default_category = excluded.default_category, review_note = excluded.review_note;

  -- the ledger
  insert into finance.accounts (id, name, kind, last4, holder, credit_limit_cents, project_id, active, notes)
  select (x ->> 'id')::bigint, x ->> 'name', x ->> 'kind', nullif(x ->> 'last4', ''), nullif(x ->> 'holder', ''),
         (x ->> 'credit_limit_cents')::bigint, finance.restore_car(p_cars - 'Team', x ->> 'program_scope'),
         coalesce(x ->> 'active', '1') in ('1', 'true'), coalesce(x ->> 'notes', '')
  from jsonb_array_elements(p_data -> 'accounts') x;
  update finance.accounts a set paid_from_account_id = (x ->> 'paid_from_account_id')::bigint
  from jsonb_array_elements(p_data -> 'accounts') x
  where a.id = (x ->> 'id')::bigint and x ->> 'paid_from_account_id' is not null;

  insert into finance.statements (id, account_id, period_start, closing_date, opening_cents, ending_cents,
                                  net_charges_cents, purchases_cents, credits_cents, source_file, sha256, imported_at)
  select (x ->> 'id')::bigint, (x ->> 'account_id')::bigint, finance.restore_day(x ->> 'period_start'),
         finance.restore_day(x ->> 'closing_date'), (x ->> 'opening_cents')::bigint, (x ->> 'ending_cents')::bigint,
         (x ->> 'net_charges_cents')::bigint, (x ->> 'purchases_cents')::bigint, (x ->> 'credits_cents')::bigint,
         x ->> 'source_file', x ->> 'sha256', coalesce((x ->> 'imported_at')::timestamptz, now())
  from jsonb_array_elements(p_data -> 'statements') x;

  insert into finance.transactions (id, account_id, date, post_date, cleared_date, amount_cents, description, vendor, kind,
    category, reference, status, transfer_group, needs_review, review_note, source, source_key, statement_id, notes,
    allocation_basis, created_by, created_at, updated_at)
  select (x ->> 'id')::bigint, (x ->> 'account_id')::bigint, finance.restore_day(x ->> 'date'),
         finance.restore_day(x ->> 'post_date'), finance.restore_day(x ->> 'cleared_date'), (x ->> 'amount_cents')::bigint,
         coalesce(x ->> 'description', ''), x ->> 'vendor', x ->> 'kind',
         case when exists (select 1 from finance.categories c where c.name = x ->> 'category') then x ->> 'category' else 'Needs category' end,
         x ->> 'reference', coalesce(x ->> 'status', 'posted'), x ->> 'transfer_group',
         coalesce(x ->> 'needs_review', '0') in ('1', 'true'), coalesce(x ->> 'review_note', ''), coalesce(x ->> 'source', 'manual'),
         coalesce(x ->> 'source_key', 'sdm:txn:' || (x ->> 'id')), (x ->> 'statement_id')::bigint, coalesce(x ->> 'notes', ''),
         coalesce(x ->> 'allocation_basis', ''), null,
         coalesce((x ->> 'created_at')::timestamptz, now()), coalesce((x ->> 'updated_at')::timestamptz, now())
  from jsonb_array_elements(p_data -> 'transactions') x;

  insert into finance.txn_allocations (id, txn_id, project_id, subteam_id, amount_cents)
  select (x ->> 'id')::bigint, (x ->> 'txn_id')::bigint, finance.restore_car(p_cars - 'Team', x ->> 'program'),
         (p_subteams ->> (x ->> 'subteam'))::uuid, (x ->> 'amount_cents')::bigint
  from jsonb_array_elements(p_data -> 'allocations') x;

  insert into finance.evidence (id, kind, source_file, source_key, vendor, vendor_raw, order_ref, date, total_cents, items,
    project_id, subteam_id, status, ship_to, payment_hint, link, record_type, flags, txn_id, match_method, match_score)
  select (x ->> 'id')::bigint, x ->> 'kind', coalesce(x ->> 'source_file', ''), x ->> 'source_key', x ->> 'vendor',
         x ->> 'vendor_raw', x ->> 'order_ref', finance.restore_day(x ->> 'date'), (x ->> 'total_cents')::bigint,
         coalesce(x ->> 'items', ''), finance.restore_car(p_cars - 'Team', x ->> 'program'),
         (p_subteams ->> nullif(x ->> 'subteam', ''))::uuid, coalesce(x ->> 'status', ''), coalesce(x ->> 'ship_to', ''),
         coalesce(x ->> 'payment_hint', ''), coalesce(x ->> 'link', ''), coalesce(x ->> 'record_type', ''),
         coalesce(nullif(x ->> 'flags_json', ''), '[]')::jsonb, (x ->> 'txn_id')::bigint, coalesce(x ->> 'match_method', ''),
         coalesce((x ->> 'match_score')::real, 0)
  from jsonb_array_elements(p_data -> 'evidence') x;

  insert into finance.balance_entries (id, account_id, as_of, balance_cents, measure, confirmed, note, entered_by,
                                       entered_by_name, entered_at, source_key)
  select (x ->> 'id')::bigint, (x ->> 'account_id')::bigint, finance.restore_day(x ->> 'as_of'), (x ->> 'balance_cents')::bigint,
         coalesce(x ->> 'measure', 'balance'), coalesce(x ->> 'confirmed', '1') in ('1', 'true'), coalesce(x ->> 'note', ''),
         null, coalesce(x ->> 'entered_by', ''), coalesce((x ->> 'entered_at')::timestamptz, now()), x ->> 'source_key'
  from jsonb_array_elements(p_data -> 'balance_entries') x;

  insert into finance.reimbursements (id, person_name, amount_cents, reason, requested_date, status, paid_with,
                                      check_number, check_txn_id, paid_date, notes, source_key)
  select (x ->> 'id')::bigint, x ->> 'person', (x ->> 'amount_cents')::bigint, coalesce(x ->> 'reason', ''),
         finance.restore_day(x ->> 'requested_date'),
         case when coalesce(x ->> 'paid', '0') in ('1', 'true') then 'paid' else 'owed' end,
         case when coalesce(x ->> 'paid', '0') in ('1', 'true') and nullif(x ->> 'check_number', '') is not null then 'check' end,
         nullif(x ->> 'check_number', ''), (x ->> 'check_txn_id')::bigint, finance.restore_day(x ->> 'paid_date'),
         coalesce(x ->> 'notes', ''), coalesce(x ->> 'source_key', 'sdm:reimb:' || (x ->> 'id'))
  from jsonb_array_elements(p_data -> 'reimbursements') x;

  insert into finance.discrepancy_resolutions (key, resolved_by, resolved_by_name, resolved_at, note)
  select x ->> 'key', null, coalesce(x ->> 'resolved_by', ''), coalesce((x ->> 'resolved_at')::timestamptz, now()),
         coalesce(x ->> 'note', '')
  from jsonb_array_elements(p_data -> 'discrepancy_resolutions') x;

  -- budgets: a season per name in the export (an existing season of that name
  -- is reused), the latest one current unless a season is already current
  for v_name in select distinct x ->> 'season' from jsonb_array_elements(p_data -> 'budgets') x order by 1 loop
    select id into v_season from purchasing.seasons where name = v_name;
    if v_season is null then
      insert into purchasing.seasons (name) values (v_name) returning id into v_season;
    end if;
  end loop;
  if not exists (select 1 from purchasing.seasons) then
    insert into purchasing.seasons (name, starts_on, is_current)
    values (extract(year from p_season_start)::int || '-' || lpad(((extract(year from p_season_start)::int + 1) % 100)::text, 2, '0'),
            p_season_start, true);
  end if;
  if not exists (select 1 from purchasing.seasons where is_current) then
    update purchasing.seasons set is_current = true
    where id = (select id from purchasing.seasons order by name desc limit 1);
  end if;
  update purchasing.seasons set starts_on = p_season_start where is_current and starts_on is null;
  for b in select x from jsonb_array_elements(p_data -> 'budgets') x loop
    select id into v_season from purchasing.seasons where name = b ->> 'season';
    -- a line already set up for this car and season, or one already covering
    -- this subteam, is kept as it is
    if exists (select 1 from purchasing.budget_lines l
               left join purchasing.budget_line_subteams ls on ls.budget_line_id = l.id
               where l.season_id = v_season and l.project_id = finance.restore_car(p_cars, b ->> 'program')
                 and (l.name = b ->> 'subteam' or ls.subteam_id = (p_subteams ->> (b ->> 'subteam'))::uuid)) then
      v_skipped := v_skipped || format('%s %s (already set up)', b ->> 'program', b ->> 'subteam');
      continue;
    end if;
    insert into purchasing.budget_lines (season_id, project_id, name, amount_cents, notes)
    values (v_season, finance.restore_car(p_cars, b ->> 'program'), b ->> 'subteam', (b ->> 'amount_cents')::bigint,
            coalesce(b ->> 'notes', ''))
    returning id into v_line;
    insert into purchasing.budget_line_subteams (budget_line_id, subteam_id)
    values (v_line, (p_subteams ->> (b ->> 'subteam'))::uuid);
  end loop;

  -- the parts list
  select id into v_season from purchasing.seasons where is_current;
  insert into purchasing.items (code, title, status, priority, season_id, requester_id, requester_name, justification,
    needed_by, date_needed_raw, vendor, product_url, part_number, quantity, unit_price_cents, tax_shipping_cents,
    total_estimate_cents, notes, helios_ref, ready_at, approved_at, denied_reason, payment_method, vendor_order_id,
    actual_total_cents, ordered_at, carrier, tracking_number, tracking_status, shipped_at, est_delivery, delivered_at,
    received_at, reconciled_at, finance_txn_id, match_method, source, created_at, updated_at)
  select x ->> 'item_code', x ->> 'title', x ->> 'status', coalesce(x ->> 'priority', 'Medium'), v_season, null,
         coalesce(x ->> 'requester_name', ''), coalesce(x ->> 'justification', ''), finance.restore_day(x ->> 'needed_by'),
         coalesce(x ->> 'date_needed_raw', ''), x ->> 'vendor', coalesce(x ->> 'product_url', ''), coalesce(x ->> 'part_number', ''),
         (x ->> 'quantity')::numeric, (x ->> 'unit_price_cents')::bigint, (x ->> 'tax_shipping_cents')::bigint,
         (x ->> 'total_estimate_cents')::bigint, coalesce(x ->> 'notes', ''), coalesce(x ->> 'helios_ref', ''),
         (x ->> 'ready_at')::timestamptz, (x ->> 'approved_at')::timestamptz, coalesce(x ->> 'denied_reason', ''),
         coalesce((select a ->> 'name' from jsonb_array_elements(p_data -> 'accounts') a
                   where a ->> 'id' = x ->> 'payment_account_id'), x ->> 'payment_note', ''),
         x ->> 'vendor_order_id', (x ->> 'actual_total_cents')::bigint, finance.restore_day(x ->> 'ordered_at'),
         coalesce(x ->> 'carrier', ''), coalesce(x ->> 'tracking_number', ''), coalesce(x ->> 'tracking_status', ''),
         (x ->> 'shipped_at')::timestamptz, finance.restore_day(x ->> 'est_delivery'), (x ->> 'delivered_at')::timestamptz,
         (x ->> 'received_at')::timestamptz, (x ->> 'reconciled_at')::timestamptz, (x ->> 'txn_id')::bigint,
         coalesce(x ->> 'match_method', ''), coalesce(x ->> 'source', 'app'),
         coalesce((x ->> 'created_at')::timestamptz, now()), coalesce((x ->> 'updated_at')::timestamptz, now())
  from jsonb_array_elements(p_data -> 'line_items') x;
  get diagnostics v_items = row_count;

  insert into purchasing.item_allocations (item_id, project_id, subteam_id, percent)
  select i.id, finance.restore_car(p_cars, a ->> 'program'), (p_subteams ->> (a ->> 'subteam'))::uuid, (a ->> 'percent')::numeric
  from jsonb_array_elements(p_data -> 'line_item_allocations') a
  join jsonb_array_elements(p_data -> 'line_items') x on x ->> 'id' = a ->> 'item_id'
  join purchasing.items i on i.code = x ->> 'item_code'
  where finance.restore_car(p_cars, a ->> 'program') is not null;

  perform finance.sync_ids();

  return jsonb_build_object(
    'accounts', jsonb_array_length(p_data -> 'accounts'),
    'statements', jsonb_array_length(p_data -> 'statements'),
    'transactions', jsonb_array_length(p_data -> 'transactions'),
    'invoices', jsonb_array_length(p_data -> 'evidence'),
    'balances', jsonb_array_length(p_data -> 'balance_entries'),
    'reimbursements', jsonb_array_length(p_data -> 'reimbursements'),
    'budget_lines', jsonb_array_length(p_data -> 'budgets') - coalesce(array_length(v_skipped, 1), 0),
    'parts', v_items,
    'skipped', to_jsonb(v_skipped));
end; $$;

create or replace function finance.restore_day(v text)
returns date language sql immutable set search_path = '' as $$
  select nullif(left(coalesce(v, ''), 10), '')::date;
$$;
-- 'IC' / 'EV' -> the chosen project; 'Team' (or nothing) -> no car.
create or replace function finance.restore_car(p_cars jsonb, p_program text)
returns uuid language sql immutable set search_path = '' as $$
  select nullif(p_cars ->> coalesce(p_program, ''), '')::uuid;
$$;

-- 5. Subteams per car, undoing an order, deleting an account --------------------------

-- Helios's subteams are shared by both cars ("Chassis"), but each car has its
-- own set (IC has Engine, EV has Battery). This is that set: the parts list
-- shows a car's own subteams, and members can only add parts to a subteam on
-- that car. Filled from budget lines and parts as they're added; execs edit it.
create table purchasing.car_subteams (
  project_id uuid not null references pm.projects(id) on delete cascade,
  subteam_id uuid not null references pm.subteams(id) on delete cascade,
  primary key (project_id, subteam_id)
);
alter table purchasing.car_subteams enable row level security;
create policy car_subteams_read on purchasing.car_subteams for select to authenticated using (pm.is_org_member());
grant select on purchasing.car_subteams to authenticated;
grant all on purchasing.car_subteams to service_role;

insert into purchasing.car_subteams (project_id, subteam_id)
select distinct project_id, subteam_id from purchasing.item_allocations
union select l.project_id, ls.subteam_id from purchasing.budget_lines l join purchasing.budget_line_subteams ls on ls.budget_line_id = l.id
on conflict do nothing;

create or replace function purchasing.car_subteam_from_part()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- only an exec's part puts a subteam on a car: the first member to add a
  -- part to a new car would otherwise lock every other subteam out of it
  if purchasing.is_exec() then
    insert into purchasing.car_subteams (project_id, subteam_id) values (new.project_id, new.subteam_id) on conflict do nothing;
  end if;
  return new;
end; $$;
create trigger item_allocations_car_subteam after insert on purchasing.item_allocations
  for each row execute function purchasing.car_subteam_from_part();
create or replace function purchasing.car_subteam_from_budget()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into purchasing.car_subteams (project_id, subteam_id)
  select l.project_id, new.subteam_id from purchasing.budget_lines l where l.id = new.budget_line_id
  on conflict do nothing;
  return new;
end; $$;
create trigger budget_line_subteams_car_subteam after insert on purchasing.budget_line_subteams
  for each row execute function purchasing.car_subteam_from_budget();

-- Execs: add a subteam to a car, or take it off (its parts stay where they are).
create or replace function purchasing.set_car_subteam(p_project uuid, p_subteam uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not purchasing.is_exec() then raise exception 'only execs change a car''s subteams' using errcode = '42501'; end if;
  if p_on then
    insert into purchasing.car_subteams (project_id, subteam_id) values (p_project, p_subteam) on conflict do nothing;
  else
    delete from purchasing.car_subteams where project_id = p_project and subteam_id = p_subteam;
  end if;
end; $$;

-- add_items() from 20261001000000, plus: a member adds parts only to a
-- subteam on that car (once the car's subteams are set up), and an Airtable
-- upload keeps its "DATE NEEDED" as written and where each row came from.
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
  if not v_exec and exists (select 1 from purchasing.car_subteams where project_id = p_project)
     and not exists (select 1 from purchasing.car_subteams where project_id = p_project and subteam_id = p_subteam) then
    raise exception 'that subteam isn''t on this car' using errcode = '42501';
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

-- record_order() from 20261001000000, but recording an order again (to add
-- the total, say) keeps what's already there unless something new is given;
-- before, a blank "member who paid" wiped it.
create or replace function purchasing.record_order(
  p_ids uuid[], p_order_id text, p_payment text, p_ordered_on date default null,
  p_total_cents bigint default null, p_paid_by text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_sum bigint; v_left bigint; v_share bigint; r record; n int; i int := 0;
begin
  if not pm.has_capability(v_uid, 'purchasing.order', null) then
    raise exception 'only execs record orders' using errcode = '42501';
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

-- Execs: undo an order recorded by mistake. The parts go back to Approved (or
-- Ready to order, if they never had approvals, e.g. imported from Airtable)
-- and the order details are cleared. Not once a part is received or matched
-- to its charge in the ledger.
create or replace function purchasing.undo_order(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_codes text;
begin
  if not pm.has_capability(auth.uid(), 'purchasing.order', null) then
    raise exception 'only execs undo orders' using errcode = '42501';
  end if;
  perform 1 from purchasing.items where id = any (p_ids) for update;
  select string_agg(code, ', ') into v_codes from purchasing.items
  where id = any (p_ids) and (finance_txn_id is not null or status not in ('ORDERED', 'BACKORDERED', 'SHIPPED', 'DELIVERED'));
  if v_codes is not null then
    raise exception 'only parts that are ordered and not yet received or matched to a charge can be undone: %', v_codes
      using errcode = '22023';
  end if;
  update purchasing.items set
    status = case when approved_at is not null then 'APPROVED' else 'READY' end,
    ready_at = coalesce(ready_at, now()),
    vendor_order_id = null, actual_total_cents = null, ordered_at = null, payment_method = '', paid_by = '',
    purchaser_id = null, carrier = '', tracking_number = '', tracking_status = '', est_delivery = null,
    shipped_at = null, delivered_at = null
  where id = any (p_ids);
end; $$;

-- Execs: delete an account added by mistake, while nothing is recorded
-- against it; otherwise it can be made inactive instead.
create or replace function finance.delete_account(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_used text;
begin
  if not finance.can_edit() then raise exception 'only execs change accounts' using errcode = '42501'; end if;
  select string_agg(what, ', ') into v_used from (
    select format('%s ledger lines', count(*)) what from finance.transactions where account_id = p_id having count(*) > 0
    union all select format('%s statements', count(*)) from finance.statements where account_id = p_id having count(*) > 0
    union all select format('%s weekly balances', count(*)) from finance.balance_entries where account_id = p_id having count(*) > 0
    union all select format('%s uploads', count(*)) from finance.imports where account_id = p_id having count(*) > 0
  ) x;
  if v_used is not null then
    raise exception 'this account has % recorded against it, so it can''t be deleted. Untick Active to hide it instead.', v_used
      using errcode = '23503';
  end if;
  update finance.accounts set paid_from_account_id = null where paid_from_account_id = p_id;
  delete from finance.accounts where id = p_id;
  if not found then raise exception 'no such account' using errcode = 'P0002'; end if;
end; $$;

-- 6. Grants -----------------------------------------------------------------------------

revoke all on function purchasing.car_subteam_from_part(), purchasing.car_subteam_from_budget() from public, anon, authenticated;
revoke all on function purchasing.check_not_own_import(uuid[]) from public, anon, authenticated;
revoke all on function purchasing.set_car_subteam(uuid, uuid, boolean), purchasing.undo_order(uuid[]), finance.delete_account(bigint)
  from public, anon;
grant execute on function purchasing.set_car_subteam(uuid, uuid, boolean), purchasing.undo_order(uuid[]), finance.delete_account(bigint)
  to authenticated, service_role;

revoke all on function finance.record_reimbursement_payment(bigint[], text, date, text, boolean),
  finance.restore_ledger(jsonb, jsonb, jsonb, date), finance.restore_day(text), finance.restore_car(jsonb, text),
  purchasing.upsert_season(uuid, text, date, date, boolean), purchasing.delete_budget_line(uuid),
  purchasing.record_order_lines(jsonb, text, text, date, bigint, text), purchasing.import_items(uuid, uuid, jsonb)
  from public, anon;
grant execute on function finance.record_reimbursement_payment(bigint[], text, date, text, boolean),
  finance.restore_ledger(jsonb, jsonb, jsonb, date),
  purchasing.upsert_season(uuid, text, date, date, boolean), purchasing.delete_budget_line(uuid),
  purchasing.record_order_lines(jsonb, text, text, date, bigint, text), purchasing.import_items(uuid, uuid, jsonb)
  to authenticated;
grant execute on function finance.record_reimbursement_payment(bigint[], text, date, text, boolean),
  finance.restore_ledger(jsonb, jsonb, jsonb, date), finance.restore_day(text), finance.restore_car(jsonb, text),
  purchasing.upsert_season(uuid, text, date, date, boolean), purchasing.delete_budget_line(uuid),
  purchasing.record_order_lines(jsonb, text, text, date, bigint, text), purchasing.import_items(uuid, uuid, jsonb)
  to service_role;
