-- =============================================================================
-- 0011 VENDOR ORDER LOG
-- Orders are PLACED on the vendor's own website (Sysco, Greco, ...). This adds
-- LOGGING what was ordered here, so the restaurant has a record of every order
-- and receiving can check the delivery against it (short/over shipments).
-- No vendor integration and no vendor passwords.
-- =============================================================================

alter table public.purchase_orders
  add column vendor_confirmation text check (vendor_confirmation is null or length(vendor_confirmation) <= 60),
  add column placed_by uuid references public.account_profiles(id),
  add column cancelled_at timestamptz,
  add column cancel_reason text;

-- p = { id?, vendor_id, status: 'draft'|'placed', expected_delivery_date, vendor_confirmation, notes,
--       items: [{ product_id, quantity, unit_code, unit_price }] }
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
  v_loc uuid := app.primary_location_id();
  v_date date := nullif(p ->> 'expected_delivery_date', '')::date;
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
    delete from public.purchase_order_items where purchase_order_id = v_po.id;
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
    v_unit := coalesce(nullif(v_item ->> 'unit_code', ''), v_prod.purchase_unit, v_prod.inventory_unit);
    perform app.unit_factor_to_inventory(v_prod.id, v_unit); -- must be convertible
    if exists (select 1 from public.purchase_order_items where purchase_order_id = v_po.id and product_id = v_prod.id) then
      perform app.fail('VALIDATION', v_prod.name || ' is listed twice.');
    end if;
    insert into public.purchase_order_items (purchase_order_id, product_id, unit_code, quantity, unit_price, suggested_qty)
    values (v_po.id, v_prod.id, v_unit, round(v_qty, 4), v_price, nullif(v_item ->> 'suggested_qty', '')::numeric);
    v_total := v_total + round(v_qty * coalesce(v_price, 0), 2);
    v_n := v_n + 1;
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
      ', est. ' || app.fmt_money(v_total) || ')',
    'purchase_orders', v_po.id::text, null, v_vendor.id, v_loc, null,
    jsonb_build_object('items', v_n, 'estimated_total', v_total, 'expected_delivery_date', v_date,
                       'vendor_confirmation', nullif(trim(p ->> 'vendor_confirmation'), '')));

  return jsonb_build_object('id', v_po.id, 'po_number', v_po.po_number, 'status', v_status, 'estimated_total', v_total);
end;
$$;

create or replace function public.cancel_purchase_order(p_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('orders.manage');
  v_po public.purchase_orders;
  v_vendor text;
begin
  if coalesce(length(trim(p_reason)), 0) < 3 then
    perform app.fail('VALIDATION', 'Give a reason for cancelling the order.');
  end if;
  update public.purchase_orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = trim(p_reason)
   where id = p_id and status in ('draft', 'placed')
  returning * into v_po;
  if v_po.id is null then
    perform app.fail('CONFLICT', 'Only draft or placed (not yet received) orders can be cancelled.');
  end if;
  select name into v_vendor from public.vendors where id = v_po.vendor_id;
  perform app.audit(v_actor, 'order.cancelled', 'operations',
    app.actor_label(v_actor) || ' cancelled ' || v_vendor || ' order #' || v_po.po_number,
    'purchase_orders', v_po.id::text, null, v_po.vendor_id, v_po.location_id, null, null, p_reason);
end;
$$;

-- Orders waiting to be delivered, for the receiving screen. Prices are only
-- returned to management, never to the shared employee login.
create or replace function public.open_orders_for_receiving(p_vendor_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.perform');
  v_prices boolean := v_actor.account_role in ('owner', 'manager');
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', po.id, 'po_number', po.po_number, 'expected_delivery_date', po.expected_delivery_date,
      'placed_at', po.placed_at, 'vendor_confirmation', po.vendor_confirmation,
      'items', (select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'quantity', i.quantity, 'unit_code', i.unit_code,
                                                    'unit_price', case when v_prices then i.unit_price end) order by p.name)
                  from public.purchase_order_items i join public.products p on p.id = i.product_id
                 where i.purchase_order_id = po.id))
      order by po.expected_delivery_date nulls last, po.po_number), '[]'::jsonb)
    from public.purchase_orders po
   where po.vendor_id = p_vendor_id and po.status in ('placed', 'partially_received'));
end;
$$;

revoke execute on function public.save_purchase_order(jsonb), public.cancel_purchase_order(uuid, text),
  public.open_orders_for_receiving(uuid) from public, anon;
grant execute on function public.save_purchase_order(jsonb), public.cancel_purchase_order(uuid, text),
  public.open_orders_for_receiving(uuid) to authenticated;
