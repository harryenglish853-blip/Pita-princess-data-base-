-- =============================================================================
-- 0013 SUGGESTED ORDERS (Phase 3)
--   NEED - HAVE = SHORTAGE, rounded UP to whole vendor order units.
--   NEED (dynamic par, with >= 7 days of history):
--          forecast usage until the delivery AFTER this order arrives + safety stock
--   NEED (static par, or not enough history): the par level
--   HAVE = on hand (book) + incoming logged orders not yet received + incoming transfers
-- Usage history comes from the ledger (waste, theoretical sales usage,
-- production use, count variances, adjustments) over the last 28 days.
-- Opening counts (book was 0) are not usage and are excluded.
-- Every number behind a suggestion is returned so the WHY? button can show it,
-- and both the system suggestion and the manager's quantity are stored.
-- =============================================================================

alter table public.purchase_order_items add column suggestion_detail jsonb;
comment on column public.purchase_order_items.suggested_qty is 'System suggestion (order units) at the time the order was built.';
comment on column public.purchase_order_items.quantity is 'Quantity the manager actually ordered.';

-- Average daily usage of a product at a location over the last p_days days.
create or replace function app.daily_usage(p_location_id uuid, p_product_id uuid, p_days int default 28)
returns table (daily_usage numeric, observed_days int, usage_total numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with win as (
    select now() - make_interval(days => p_days) as start_at
  ),
  first_seen as (
    select min(occurred_at) as first_at from public.inventory_transactions
     where location_id = p_location_id and product_id = p_product_id
  ),
  used as (
    select coalesce(sum(-t.quantity), 0) as total
      from public.inventory_transactions t, win
     where t.location_id = p_location_id and t.product_id = p_product_id
       and t.occurred_at >= win.start_at
       and (
         t.txn_type in ('WASTE', 'POS_THEORETICAL_CONSUMPTION', 'MANUAL_ADJUSTMENT')
         or (t.txn_type = 'PRODUCTION' and t.quantity < 0)
         or (t.txn_type = 'CORRECTION' and t.source_type <> 'transfer_item')
         -- a count that corrects a real book quantity; an opening count (book was 0) is not usage
         or (t.txn_type = 'PHYSICAL_VARIANCE' and t.balance_after - t.quantity > 0)
       )
  ),
  obs as (
    select greatest(0, least(p_days, floor(extract(epoch from (now() - coalesce(f.first_at, now()))) / 86400)::int)) as days
      from first_seen f
  )
  select case when obs.days > 0 then round(greatest(used.total, 0) / obs.days, 4) else 0 end,
         obs.days,
         round(greatest(used.total, 0), 4)
    from used, obs
$$;

-- Next delivery date we can still order for, and the delivery after it.
create or replace function app.vendor_delivery_window(p_vendor_id uuid)
returns table (next_delivery date, following_delivery date, cutoff_date date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.vendors;
  v_local timestamp := now() at time zone app.org_timezone();
  v_today date := v_local::date;
  d date;
  v_next date;
  v_follow date;
begin
  select * into v from public.vendors where id = p_vendor_id;
  if coalesce(cardinality(v.delivery_days), 0) = 0 then
    return query select null::date, null::date, null::date;
    return;
  end if;
  for i in 1..21 loop
    d := v_today + i;
    -- the order for delivery d must be placed by (d - lead time) at the cutoff time
    if extract(dow from d)::smallint = any (v.delivery_days)
       and (d - v.lead_time_days > v_today
            or (d - v.lead_time_days = v_today and (v.order_cutoff_time is null or v_local::time < v.order_cutoff_time))) then
      if v_next is null then
        v_next := d;
      elsif v_follow is null then
        v_follow := d;
        exit;
      end if;
    end if;
  end loop;
  return query select v_next, v_follow, v_next - v.lead_time_days;
end;
$$;

create or replace function public.suggested_order(p_vendor_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('orders.manage');
  v_vendor public.vendors;
  v_loc uuid := app.primary_location_id();
  v_today date := (now() at time zone app.org_timezone())::date;
  w record;
  v_cover int;
  v_rows jsonb;
begin
  select * into v_vendor from public.vendors where id = p_vendor_id and is_active;
  if v_vendor.id is null then
    perform app.fail('NOT_FOUND', 'Vendor not found.');
  end if;
  select * into w from app.vendor_delivery_window(p_vendor_id);
  -- days the order must last: until the delivery AFTER the one we are ordering for (7 if unknown)
  v_cover := coalesce(w.following_delivery - v_today, 7);

  with items as (
    select p.id as product_id, p.name, p.inventory_unit, p.item_code,
           coalesce(vp.order_unit, p.purchase_unit, p.inventory_unit) as order_unit,
           vp.current_price as order_price, vp.vendor_sku,
           lp.par_level, lp.safety_stock, lp.par_type,
           greatest(coalesce(b.quantity, 0), 0) as on_hand
      from public.products p
      join public.location_products lp on lp.product_id = p.id and lp.location_id = v_loc and lp.is_stocked
      left join public.vendor_products vp on vp.product_id = p.id and vp.vendor_id = p_vendor_id and vp.is_active
      left join public.inventory_balances b on b.product_id = p.id and b.location_id = v_loc
     where p.is_active and p.primary_vendor_id = p_vendor_id
  ),
  calc as (
    select i.*,
           u.daily_usage, u.observed_days, u.usage_total,
           app.unit_factor_to_inventory(i.product_id, i.order_unit) as units_per_order_unit,
           coalesce((select sum(app.to_inventory_qty(poi.product_id, poi.quantity, poi.unit_code))
                       from public.purchase_order_items poi join public.purchase_orders po on po.id = poi.purchase_order_id
                      where poi.product_id = i.product_id and po.location_id = v_loc and po.status in ('placed', 'partially_received')), 0) as incoming_orders,
           coalesce((select sum(ti.quantity_inv) from public.transfer_items ti join public.inventory_transfers tr on tr.id = ti.transfer_id
                      where ti.product_id = i.product_id and tr.to_location_id = v_loc and tr.status in ('sent', 'in_transit')), 0) as incoming_transfers
      from items i
      cross join lateral app.daily_usage(v_loc, i.product_id, 28) u
  ),
  need as (
    select c.*,
           case when c.par_type = 'dynamic' and c.observed_days >= 7 then 'forecast'
                when c.par_level is not null then 'par'
                when c.observed_days >= 7 then 'forecast'
                else 'none' end as method,
           round(c.daily_usage * v_cover, 4) as forecast_usage
      from calc c
  ),
  final as (
    select n.*,
           case n.method when 'forecast' then n.forecast_usage + coalesce(n.safety_stock, 0)
                         when 'par' then n.par_level else null end as need_qty,
           n.on_hand + n.incoming_orders + n.incoming_transfers as have_qty
      from need n
  ),
  rounded as (
    select f.*,
           greatest(coalesce(f.need_qty, 0) - f.have_qty, 0) as shortage,
           case when f.need_qty is null then 0
                else ceil(round(greatest(f.need_qty - f.have_qty, 0) / f.units_per_order_unit, 6)) end as suggested_qty
      from final f
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', r.product_id, 'name', r.name, 'item_code', r.item_code, 'inventory_unit', r.inventory_unit,
           'order_unit', r.order_unit, 'units_per_order_unit', r.units_per_order_unit, 'vendor_sku', r.vendor_sku,
           'order_price', r.order_price, 'method', r.method, 'par_type', r.par_type,
           'daily_usage', r.daily_usage, 'observed_days', r.observed_days, 'usage_28_days', r.usage_total,
           'coverage_days', v_cover, 'forecast_usage', r.forecast_usage, 'safety_stock', coalesce(r.safety_stock, 0),
           'par_level', r.par_level, 'need', r.need_qty, 'on_hand', r.on_hand,
           'incoming_orders', r.incoming_orders, 'incoming_transfers', r.incoming_transfers, 'have', r.have_qty,
           'shortage', r.shortage, 'suggested_qty', r.suggested_qty,
           'estimated_cost', case when r.order_price is not null then round(r.suggested_qty * r.order_price, 2) end)
         order by (r.suggested_qty > 0) desc, r.name), '[]'::jsonb)
    into v_rows
    from rounded r;

  return jsonb_build_object(
    'vendor', jsonb_build_object('id', v_vendor.id, 'name', v_vendor.name, 'ordering_url', v_vendor.ordering_url,
                                 'minimum_order', v_vendor.minimum_order, 'order_cutoff_time', v_vendor.order_cutoff_time),
    'next_delivery', w.next_delivery, 'following_delivery', w.following_delivery, 'cutoff_date', w.cutoff_date,
    'coverage_days', v_cover, 'generated_at', now(), 'items', v_rows);
end;
$$;

-- save_purchase_order: also store the system suggestion and its WHY for each line.
-- The suggestion is computed HERE (never taken from the browser), when the order
-- is built from the suggestion (p.use_suggestion) and kept when a draft is edited.
create or replace function public.save_purchase_order(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('orders.manage');
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_po public.purchase_orders;
  v_vendor public.vendors;
  v_status text := coalesce(nullif(p ->> 'status', ''), 'draft');
  v_item jsonb;
  v_prod public.products;
  v_qty numeric;
  v_price numeric;
  v_unit text;
  v_total numeric(14, 2) := 0;
  v_n int := 0;
  v_overrides int := 0;
  v_loc uuid := app.primary_location_id();
  v_date date := nullif(p ->> 'expected_delivery_date', '')::date;
  v_sugg numeric;
  v_detail jsonb;
  v_suggestions jsonb := '{}'::jsonb;
begin
  if v_status not in ('draft', 'placed') then
    perform app.fail('VALIDATION', 'Unknown order status.');
  end if;
  select * into v_vendor from public.vendors where id = nullif(p ->> 'vendor_id', '')::uuid and is_active;
  if v_vendor.id is null then
    perform app.fail('VALIDATION', 'Choose an active vendor.');
  end if;
  if coalesce(jsonb_typeof(p -> 'items'), '') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    perform app.fail('VALIDATION', 'Add at least one item to the order.');
  end if;
  if jsonb_array_length(p -> 'items') > 300 then
    perform app.fail('VALIDATION', 'An order can have at most 300 items.');
  end if;
  if v_date is not null and (v_date < (now() at time zone app.org_timezone())::date - 1
                             or v_date > (now() at time zone app.org_timezone())::date + 60) then
    perform app.fail('VALIDATION', 'Expected delivery must be within the next 60 days.');
  end if;

  if v_id is null then
    insert into public.purchase_orders (vendor_id, location_id, status, expected_delivery_date, notes, vendor_confirmation, created_by)
    values (v_vendor.id, v_loc, 'draft', v_date, nullif(trim(p ->> 'notes'), ''), nullif(trim(p ->> 'vendor_confirmation'), ''), v_actor.account_id)
    returning * into v_po;
  else
    select * into v_po from public.purchase_orders where id = v_id for update;
    if v_po.id is null then
      perform app.fail('NOT_FOUND', 'Order not found.');
    end if;
    if v_po.status <> 'draft' then
      perform app.fail('CONFLICT', 'Only draft orders can be edited. This order is ' || v_po.status || '.');
    end if;
    if v_po.vendor_id <> v_vendor.id then
      perform app.fail('VALIDATION', 'The vendor of an order cannot change.');
    end if;
    update public.purchase_orders
       set expected_delivery_date = v_date, notes = nullif(trim(p ->> 'notes'), ''),
           vendor_confirmation = nullif(trim(p ->> 'vendor_confirmation'), '')
     where id = v_po.id;
    select coalesce(jsonb_object_agg(product_id::text, suggestion_detail), '{}'::jsonb) into v_suggestions
      from public.purchase_order_items where purchase_order_id = v_po.id and suggestion_detail is not null;
    delete from public.purchase_order_items where purchase_order_id = v_po.id;
  end if;
  if coalesce((p ->> 'use_suggestion')::boolean, false) then
    select coalesce(jsonb_object_agg(i ->> 'product_id', i - 'name'), '{}'::jsonb) into v_suggestions
      from jsonb_array_elements(public.suggested_order(v_vendor.id) -> 'items') i;
  end if;

  for v_item in select * from jsonb_array_elements(p -> 'items') loop
    select * into v_prod from public.products where id = nullif(v_item ->> 'product_id', '')::uuid and is_active;
    if v_prod.id is null then
      perform app.fail('VALIDATION', 'Choose an active product for every line.');
    end if;
    v_qty := nullif(v_item ->> 'quantity', '')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then
      perform app.fail('VALIDATION', v_prod.name || ': enter a quantity greater than 0.');
    end if;
    v_price := nullif(v_item ->> 'unit_price', '')::numeric;
    if v_price is not null and (v_price < 0 or v_price > 100000) then
      perform app.fail('VALIDATION', v_prod.name || ': price must be between 0 and 100,000.');
    end if;
    v_detail := v_suggestions -> v_prod.id::text;
    v_sugg := (v_detail ->> 'suggested_qty')::numeric;
    v_unit := coalesce(nullif(v_item ->> 'unit_code', ''), v_prod.purchase_unit, v_prod.inventory_unit);
    perform app.unit_factor_to_inventory(v_prod.id, v_unit);
    if exists (select 1 from public.purchase_order_items where purchase_order_id = v_po.id and product_id = v_prod.id) then
      perform app.fail('VALIDATION', v_prod.name || ' is listed twice.');
    end if;
    insert into public.purchase_order_items (purchase_order_id, product_id, unit_code, quantity, unit_price, suggested_qty, suggestion_detail)
    values (v_po.id, v_prod.id, v_unit, round(v_qty, 4), v_price, v_sugg, v_detail);
    v_total := v_total + round(v_qty * coalesce(v_price, 0), 2);
    v_n := v_n + 1;
    if v_sugg is not null and (v_sugg <> round(v_qty, 4) or v_unit <> v_detail ->> 'order_unit') then
      v_overrides := v_overrides + 1;
    end if;
  end loop;

  update public.purchase_orders
     set estimated_total = v_total,
         status = v_status,
         placed_at = case when v_status = 'placed' then now() else null end,
         placed_by = case when v_status = 'placed' then v_actor.account_id else null end
   where id = v_po.id;

  perform app.audit(v_actor, case when v_status = 'placed' then 'order.placed' else 'order.drafted' end, 'operations',
    app.actor_label(v_actor) || case when v_status = 'placed' then ' logged ' else ' saved a draft ' end ||
      v_vendor.name || ' order #' || v_po.po_number || ' (' || v_n || ' item' || case when v_n = 1 then '' else 's' end ||
      ', est. ' || app.fmt_money(v_total) || ')' ||
      case when v_overrides > 0 then ' — ' || v_overrides || ' quantit' || case when v_overrides = 1 then 'y' else 'ies' end || ' changed from the suggestion' else '' end,
    'purchase_orders', v_po.id::text, null, v_vendor.id, v_loc, null,
    jsonb_build_object('items', v_n, 'estimated_total', v_total, 'expected_delivery_date', v_date,
                       'vendor_confirmation', nullif(trim(p ->> 'vendor_confirmation'), ''), 'overrides', v_overrides));

  return jsonb_build_object('id', v_po.id, 'po_number', v_po.po_number, 'status', v_status, 'estimated_total', v_total);
end;
$$;

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.suggested_order(uuid) from public, anon;
grant execute on function public.suggested_order(uuid) to authenticated;
