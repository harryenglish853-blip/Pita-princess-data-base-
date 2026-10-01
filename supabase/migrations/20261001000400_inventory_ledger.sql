-- =============================================================================
-- 0004 INVENTORY LEDGER
-- Every inventory movement is an immutable row in inventory_transactions.
-- inventory_balances is a maintained projection of the ledger (sum of
-- quantities per location/product) plus the weighted average cost. Both are
-- written ONLY by app.post_inventory_txn() inside the same database
-- transaction, under a row lock, so they cannot drift apart.
-- =============================================================================

create type public.inventory_txn_type as enum (
  'RECEIPT',
  'PHYSICAL_COUNT',
  'PHYSICAL_VARIANCE',
  'WASTE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'POS_THEORETICAL_CONSUMPTION',
  'PRODUCTION',
  'COMMISSARY_RECEIPT',
  'COMMISSARY_TRANSFER',
  'MANUAL_ADJUSTMENT',
  'RETURN_TO_VENDOR',
  'CORRECTION'
);

create table public.inventory_transactions (
  id bigint generated always as identity primary key,
  txn_uuid uuid not null default gen_random_uuid() unique,
  location_id uuid not null references public.locations(id),
  product_id uuid not null references public.products(id),
  txn_type public.inventory_txn_type not null,
  quantity numeric(16, 4) not null,               -- signed, in the product's inventory unit
  unit_cost numeric(14, 4) not null default 0 check (unit_cost >= 0),
  extended_cost numeric(18, 4) not null,          -- quantity * unit_cost (signed)
  balance_after numeric(16, 4) not null,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  storage_location_id uuid references public.storage_locations(id),
  source_type text not null check (source_type ~ '^[a-z_]+$'),
  source_id text,
  reference text,
  vendor_id uuid references public.vendors(id),
  reason text,
  notes text,
  reverses_txn_id bigint references public.inventory_transactions(id),
  account_id uuid not null references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  constraint inventory_txn_sign check (
    case txn_type
      when 'RECEIPT' then quantity > 0
      when 'TRANSFER_IN' then quantity > 0
      when 'COMMISSARY_RECEIPT' then quantity > 0
      when 'WASTE' then quantity < 0
      when 'TRANSFER_OUT' then quantity < 0
      when 'COMMISSARY_TRANSFER' then quantity < 0
      when 'RETURN_TO_VENDOR' then quantity < 0
      when 'PHYSICAL_COUNT' then quantity = 0
      else quantity <> 0
    end)
);
comment on table public.inventory_transactions is 'Immutable inventory ledger. Corrections are new rows, never edits.';
create index inventory_txn_product_idx on public.inventory_transactions (location_id, product_id, occurred_at);
create index inventory_txn_type_idx on public.inventory_transactions (txn_type, occurred_at);
create index inventory_txn_source_idx on public.inventory_transactions (source_type, source_id);
create index inventory_txn_employee_idx on public.inventory_transactions (employee_id, occurred_at) where employee_id is not null;

create trigger inventory_transactions_immutable
  before update or delete on public.inventory_transactions
  for each row execute function app.prevent_mutation();
create trigger inventory_transactions_no_truncate
  before truncate on public.inventory_transactions
  for each statement execute function app.prevent_mutation();

create table public.inventory_balances (
  location_id uuid not null references public.locations(id),
  product_id uuid not null references public.products(id),
  quantity numeric(16, 4) not null default 0,
  avg_cost numeric(14, 4) check (avg_cost is null or avg_cost >= 0),
  last_txn_id bigint references public.inventory_transactions(id),
  last_received_at timestamptz,
  last_counted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (location_id, product_id)
);
comment on table public.inventory_balances is 'Perpetual (book) inventory, maintained only by app.post_inventory_txn().';

-- Idempotency for client retries / double taps (one row per request key).
create table public.idempotency_keys (
  key uuid primary key,
  account_id uuid not null references public.account_profiles(id),
  action text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function app.idempotent_result(p_key uuid, p_action text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select result from public.idempotency_keys
   where key = p_key and account_id = auth.uid() and action = p_action
$$;

create or replace function app.idempotent_store(p_key uuid, p_action text, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null then
    return;
  end if;
  insert into public.idempotency_keys (key, account_id, action, result)
  values (p_key, auth.uid(), p_action, p_result);
exception when unique_violation then
  perform app.fail('DUPLICATE', 'This request was already submitted.');
end;
$$;

-- Prevent changing a product's inventory unit once it has ledger history:
-- every stored quantity is expressed in that unit.
create or replace function app.guard_product_inventory_unit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.inventory_unit is distinct from old.inventory_unit
     and exists (select 1 from public.inventory_transactions where product_id = old.id) then
    perform app.fail('VALIDATION', 'The inventory unit of "' || old.name ||
      '" cannot change because it already has inventory history. Create a new product instead.');
  end if;
  return new;
end;
$$;
create trigger products_guard_inventory_unit before update on public.products
  for each row execute function app.guard_product_inventory_unit();

-- -----------------------------------------------------------------------------
-- THE posting function. Every inventory movement in the system goes through it.
-- -----------------------------------------------------------------------------
create or replace function app.post_inventory_txn(
  p_actor app.actor,
  p_location_id uuid,
  p_product_id uuid,
  p_type public.inventory_txn_type,
  p_quantity numeric,
  p_unit_cost numeric,                 -- NULL = value at current average cost
  p_source_type text,
  p_source_id text default null,
  p_occurred_at timestamptz default null,
  p_storage_location_id uuid default null,
  p_reference text default null,
  p_vendor_id uuid default null,
  p_reason text default null,
  p_notes text default null,
  p_reverses_txn_id bigint default null)
returns public.inventory_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bal public.inventory_balances;
  v_prod public.products;
  v_qty numeric(16, 4) := round(p_quantity, 4);
  v_cost numeric(14, 4);
  v_new_qty numeric(16, 4);
  v_new_avg numeric(14, 4);
  v_txn public.inventory_transactions;
  v_inbound_costed boolean;
begin
  if p_actor.account_id is null then
    perform app.fail('NOT_AUTHENTICATED', 'Missing actor.');
  end if;
  select * into v_prod from public.products where id = p_product_id;
  if v_prod.id is null then
    perform app.fail('NOT_FOUND', 'Product not found.');
  end if;
  if not exists (select 1 from public.locations where id = p_location_id) then
    perform app.fail('NOT_FOUND', 'Location not found.');
  end if;
  if v_qty is null or (v_qty = 0 and p_type <> 'PHYSICAL_COUNT') then
    perform app.fail('VALIDATION', 'Quantity must not be zero.');
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    perform app.fail('VALIDATION', 'Cost cannot be negative.');
  end if;

  insert into public.inventory_balances (location_id, product_id, quantity)
  values (p_location_id, p_product_id, 0)
  on conflict do nothing;
  select * into v_bal from public.inventory_balances
   where location_id = p_location_id and product_id = p_product_id
   for update;

  v_inbound_costed := v_qty > 0 and p_unit_cost is not null
    and p_type in ('RECEIPT', 'COMMISSARY_RECEIPT', 'TRANSFER_IN', 'PRODUCTION');

  v_cost := round(coalesce(p_unit_cost, v_bal.avg_cost, v_prod.current_cost, 0), 4);
  v_new_qty := v_bal.quantity + v_qty;

  if v_inbound_costed then
    if v_bal.quantity <= 0 or v_bal.avg_cost is null then
      v_new_avg := v_cost;
    else
      v_new_avg := round((v_bal.quantity * v_bal.avg_cost + v_qty * v_cost) / (v_bal.quantity + v_qty), 4);
    end if;
  else
    v_new_avg := coalesce(v_bal.avg_cost, case when v_cost > 0 then v_cost end);
  end if;

  insert into public.inventory_transactions (
    location_id, product_id, txn_type, quantity, unit_cost, extended_cost, balance_after,
    occurred_at, storage_location_id, source_type, source_id, reference, vendor_id,
    reason, notes, reverses_txn_id, account_id, employee_id)
  values (
    p_location_id, p_product_id, p_type, v_qty, v_cost, round(v_qty * v_cost, 4), v_new_qty,
    coalesce(p_occurred_at, now()), p_storage_location_id, p_source_type, p_source_id, p_reference, p_vendor_id,
    p_reason, p_notes, p_reverses_txn_id, p_actor.account_id, p_actor.employee_id)
  returning * into v_txn;

  update public.inventory_balances
     set quantity = v_new_qty,
         avg_cost = v_new_avg,
         last_txn_id = v_txn.id,
         last_received_at = case when p_type in ('RECEIPT', 'COMMISSARY_RECEIPT') then now() else last_received_at end,
         updated_at = now()
   where location_id = p_location_id and product_id = p_product_id;

  return v_txn;
end;
$$;

-- -----------------------------------------------------------------------------
-- Stock status (text labels, never color alone)
-- -----------------------------------------------------------------------------
create or replace function app.stock_status(p_qty numeric, p_min numeric, p_reorder numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_qty, 0) <= 0 then 'OUT_OF_STOCK'
    when p_min is not null and p_qty <= p_min then 'CRITICAL'
    when p_reorder is not null and p_qty <= p_reorder then 'LOW_STOCK'
    else 'HEALTHY'
  end
$$;
grant execute on function app.stock_status(numeric, numeric, numeric) to authenticated, service_role;

-- On-hand view for management screens (RLS of base tables applies: security_invoker).
create view public.inventory_on_hand
with (security_invoker = true) as
select
  l.id as location_id,
  p.id as product_id,
  p.item_code,
  p.name as product_name,
  p.category_id,
  c.name as category_name,
  coalesce(c.is_food, true) as is_food,
  p.inventory_unit,
  p.is_active,
  coalesce(b.quantity, 0) as quantity,
  coalesce(b.avg_cost, p.current_cost) as unit_cost,
  round(greatest(coalesce(b.quantity, 0), 0) * coalesce(b.avg_cost, p.current_cost), 2) as inventory_value,
  p.current_cost,
  p.last_cost,
  lp.par_level,
  lp.min_level,
  lp.reorder_level,
  lp.safety_stock,
  app.stock_status(coalesce(b.quantity, 0), lp.min_level, lp.reorder_level) as stock_status,
  b.last_counted_at,
  b.last_received_at,
  b.updated_at as balance_updated_at
from public.products p
cross join public.locations l
left join public.inventory_balances b on b.product_id = p.id and b.location_id = l.id
left join public.location_products lp on lp.product_id = p.id and lp.location_id = l.id
left join public.categories c on c.id = p.category_id
where l.is_active
  and (lp.is_stocked or b.product_id is not null);

-- -----------------------------------------------------------------------------
-- Manual inventory adjustment (authorized users only, reason required)
-- -----------------------------------------------------------------------------
create or replace function public.adjust_inventory(
  p_product_id uuid,
  p_location_id uuid,
  p_new_quantity numeric,
  p_expected_current numeric,
  p_reason text,
  p_notes text,
  p_idempotency_key uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('inventory.adjust');
  v_prior jsonb := app.idempotent_result(p_idempotency_key, 'inventory.adjust');
  v_bal public.inventory_balances;
  v_prod public.products;
  v_delta numeric(16, 4);
  v_txn public.inventory_transactions;
  v_result jsonb;
  v_loc uuid := coalesce(p_location_id, app.primary_location_id());
begin
  if v_prior is not null then
    return v_prior;
  end if;
  if p_reason not in ('COUNT_CORRECTION', 'DAMAGE', 'MISSING', 'DONATION', 'TRANSFER_ERROR', 'SYSTEM_CORRECTION', 'OTHER') then
    perform app.fail('VALIDATION', 'Choose a reason for the adjustment.');
  end if;
  if p_reason = 'OTHER' and coalesce(length(trim(p_notes)), 0) < 3 then
    perform app.fail('VALIDATION', 'Explain the adjustment in the notes when the reason is Other.');
  end if;
  if p_new_quantity is null or p_new_quantity < 0 or p_new_quantity > 1000000 then
    perform app.fail('VALIDATION', 'New quantity must be between 0 and 1,000,000.');
  end if;
  select * into v_prod from public.products where id = p_product_id;
  if v_prod.id is null then
    perform app.fail('NOT_FOUND', 'Product not found.');
  end if;

  insert into public.inventory_balances (location_id, product_id, quantity)
  values (v_loc, p_product_id, 0) on conflict do nothing;
  select * into v_bal from public.inventory_balances
   where location_id = v_loc and product_id = p_product_id for update;

  if p_expected_current is null or round(p_expected_current, 4) <> v_bal.quantity then
    perform app.fail('CONFLICT', 'The quantity changed to ' || v_bal.quantity || ' ' || v_prod.inventory_unit ||
      ' while you were editing. Review it and try again.');
  end if;

  v_delta := round(p_new_quantity, 4) - v_bal.quantity;
  if v_delta = 0 then
    perform app.fail('VALIDATION', 'The new quantity is the same as the current quantity.');
  end if;

  v_txn := app.post_inventory_txn(v_actor, v_loc, p_product_id, 'MANUAL_ADJUSTMENT', v_delta, null,
    'adjustment', null, now(), null, null, null, p_reason, nullif(trim(p_notes), ''));

  perform app.audit(v_actor, 'inventory.adjusted', 'inventory',
    app.actor_label(v_actor) || ' adjusted ' || v_prod.name || ' from ' || v_bal.quantity || ' to ' ||
      round(p_new_quantity, 4) || ' ' || v_prod.inventory_unit || ' (' || replace(lower(p_reason), '_', ' ') || ')',
    'inventory_transactions', v_txn.id::text, p_product_id, null, v_loc,
    jsonb_build_object('quantity', v_bal.quantity),
    jsonb_build_object('quantity', round(p_new_quantity, 4), 'adjustment', v_delta),
    p_reason, jsonb_build_object('notes', p_notes));

  v_result := jsonb_build_object('transaction_id', v_txn.id, 'previous_quantity', v_bal.quantity,
                                 'adjustment', v_delta, 'new_quantity', v_txn.balance_after);
  perform app.idempotent_store(p_idempotency_key, 'inventory.adjust', v_result);
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Ledger integrity check (owner tool + automated tests)
-- -----------------------------------------------------------------------------
create or replace function public.ledger_integrity_check()
returns table (location_id uuid, product_id uuid, balance_quantity numeric, ledger_quantity numeric, difference numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (app.has_permission('audit.view') or current_user in ('postgres', 'service_role')) then
    perform app.fail('FORBIDDEN', 'Owner only.');
  end if;
  return query
    with ledger as (
      select t.location_id, t.product_id, sum(t.quantity) as qty
        from public.inventory_transactions t group by 1, 2)
    select coalesce(b.location_id, l.location_id), coalesce(b.product_id, l.product_id),
           coalesce(b.quantity, 0)::numeric, coalesce(l.qty, 0)::numeric,
           (coalesce(b.quantity, 0) - coalesce(l.qty, 0))::numeric
      from public.inventory_balances b
      full join ledger l on l.location_id = b.location_id and l.product_id = b.product_id
     where coalesce(b.quantity, 0) <> coalesce(l.qty, 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- Product save (atomic: product + conversions + stocking levels + storage
-- assignments + primary vendor item). Management with products.manage.
-- -----------------------------------------------------------------------------
create or replace function public.save_product(p jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('products.manage');
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_loc uuid := coalesce(nullif(p ->> 'location_id', '')::uuid, app.primary_location_id());
  v_conv jsonb;
  v_store jsonb;
  v_vendor jsonb := p -> 'vendor';
  v_vp public.vendor_products;
  v_price numeric;
  v_factor numeric;
  v_inv_unit text := p ->> 'inventory_unit';
  v_name text := trim(p ->> 'name');
  v_next_sort int;
  v_store_ids uuid[];
begin
  if v_name is null or length(v_name) = 0 then
    perform app.fail('VALIDATION', 'Product name is required.');
  end if;
  if coalesce(p ->> 'item_code', '') !~ '^[A-Z0-9_-]{1,20}$' then
    perform app.fail('VALIDATION', 'Item ID must be 1-20 capital letters, numbers, dashes or underscores.');
  end if;
  if not exists (select 1 from public.units where code = v_inv_unit) then
    perform app.fail('VALIDATION', 'Choose an inventory unit.');
  end if;
  if exists (select 1 from public.products where item_code = p ->> 'item_code' and id is distinct from v_id) then
    perform app.fail('DUPLICATE', 'Item ID ' || (p ->> 'item_code') || ' is already used.');
  end if;
  if nullif(p ->> 'barcode', '') is not null and exists (
       select 1 from public.products where barcode = p ->> 'barcode' and id is distinct from v_id) then
    perform app.fail('DUPLICATE', 'That barcode is already assigned to another product.');
  end if;

  if v_id is null then
    insert into public.products (item_code, name, description, category_id, subcategory, sku, barcode,
      inventory_unit, purchase_unit, recipe_unit, pack_size, current_cost, contract_cost, primary_vendor_id,
      shelf_life_days, track_expiration, notes, is_active)
    values (p ->> 'item_code', v_name, nullif(p ->> 'description', ''), nullif(p ->> 'category_id', '')::uuid,
      nullif(p ->> 'subcategory', ''), nullif(p ->> 'sku', ''), nullif(p ->> 'barcode', ''),
      v_inv_unit, nullif(p ->> 'purchase_unit', ''), nullif(p ->> 'recipe_unit', ''), nullif(p ->> 'pack_size', ''),
      coalesce(nullif(p ->> 'current_cost', '')::numeric, 0), nullif(p ->> 'contract_cost', '')::numeric,
      nullif(v_vendor ->> 'vendor_id', '')::uuid,
      nullif(p ->> 'shelf_life_days', '')::int, coalesce((p ->> 'track_expiration')::boolean, false),
      nullif(p ->> 'notes', ''), coalesce((p ->> 'is_active')::boolean, true))
    returning id into v_id;
  else
    update public.products set
      item_code = p ->> 'item_code', name = v_name, description = nullif(p ->> 'description', ''),
      category_id = nullif(p ->> 'category_id', '')::uuid, subcategory = nullif(p ->> 'subcategory', ''),
      sku = nullif(p ->> 'sku', ''), barcode = nullif(p ->> 'barcode', ''),
      inventory_unit = v_inv_unit, purchase_unit = nullif(p ->> 'purchase_unit', ''),
      recipe_unit = nullif(p ->> 'recipe_unit', ''), pack_size = nullif(p ->> 'pack_size', ''),
      current_cost = coalesce(nullif(p ->> 'current_cost', '')::numeric, current_cost),
      contract_cost = nullif(p ->> 'contract_cost', '')::numeric,
      primary_vendor_id = nullif(v_vendor ->> 'vendor_id', '')::uuid,
      shelf_life_days = nullif(p ->> 'shelf_life_days', '')::int,
      track_expiration = coalesce((p ->> 'track_expiration')::boolean, false),
      notes = nullif(p ->> 'notes', ''), is_active = coalesce((p ->> 'is_active')::boolean, true)
    where id = v_id;
    if not found then
      perform app.fail('NOT_FOUND', 'Product not found.');
    end if;
  end if;

  -- Conversions: replace the set (the inventory unit itself needs no row).
  if p ? 'conversions' then
    delete from public.product_unit_conversions
     where product_id = v_id
       and unit_code not in (select c ->> 'unit_code' from jsonb_array_elements(p -> 'conversions') c);
    for v_conv in select * from jsonb_array_elements(p -> 'conversions') loop
      if v_conv ->> 'unit_code' = v_inv_unit then
        continue;
      end if;
      if coalesce((v_conv ->> 'inventory_units_per_unit')::numeric, 0) <= 0 then
        perform app.fail('VALIDATION', 'Each conversion needs a quantity greater than zero.');
      end if;
      insert into public.product_unit_conversions (product_id, unit_code, inventory_units_per_unit)
      values (v_id, v_conv ->> 'unit_code', (v_conv ->> 'inventory_units_per_unit')::numeric)
      on conflict (product_id, unit_code) do update
        set inventory_units_per_unit = excluded.inventory_units_per_unit
        where public.product_unit_conversions.inventory_units_per_unit is distinct from excluded.inventory_units_per_unit;
    end loop;
  end if;

  -- Purchase / recipe units must be convertible.
  if nullif(p ->> 'purchase_unit', '') is not null then
    perform app.unit_factor_to_inventory(v_id, p ->> 'purchase_unit');
  end if;
  if nullif(p ->> 'recipe_unit', '') is not null then
    perform app.unit_factor_to_inventory(v_id, p ->> 'recipe_unit');
  end if;

  -- Stocking levels for the location.
  if p ? 'levels' then
    insert into public.location_products (location_id, product_id, is_stocked, par_level, min_level, reorder_level, safety_stock, par_type)
    values (v_loc, v_id, true,
      nullif(p #>> '{levels,par_level}', '')::numeric, nullif(p #>> '{levels,min_level}', '')::numeric,
      nullif(p #>> '{levels,reorder_level}', '')::numeric, nullif(p #>> '{levels,safety_stock}', '')::numeric,
      coalesce(nullif(p #>> '{levels,par_type}', ''), 'static'))
    on conflict (location_id, product_id) do update set
      is_stocked = true, par_level = excluded.par_level, min_level = excluded.min_level,
      reorder_level = excluded.reorder_level, safety_stock = excluded.safety_stock, par_type = excluded.par_type;
  else
    insert into public.location_products (location_id, product_id) values (v_loc, v_id) on conflict do nothing;
  end if;

  -- Storage assignments (keep existing count order; append new ones at the end).
  if p ? 'storage' then
    select coalesce(array_agg((s ->> 'storage_location_id')::uuid), '{}') into v_store_ids
      from jsonb_array_elements(p -> 'storage') s;
    -- Only storage areas of the location being edited are replaced; other locations keep theirs.
    if exists (select 1 from unnest(v_store_ids) sid
                where not exists (select 1 from public.storage_locations where id = sid and location_id = v_loc)) then
      perform app.fail('VALIDATION', 'Storage areas must belong to this location.');
    end if;
    delete from public.product_storage_locations
     where product_id = v_id and storage_location_id <> all (v_store_ids)
       and storage_location_id in (select id from public.storage_locations where location_id = v_loc);
    update public.product_storage_locations set is_primary = false
     where product_id = v_id and storage_location_id in (select id from public.storage_locations where location_id = v_loc);
    for v_store in select * from jsonb_array_elements(p -> 'storage') loop
      select coalesce(max(sort_order), 0) + 10 into v_next_sort
        from public.product_storage_locations where storage_location_id = (v_store ->> 'storage_location_id')::uuid;
      insert into public.product_storage_locations (product_id, storage_location_id, shelf_label, sort_order, is_primary)
      values (v_id, (v_store ->> 'storage_location_id')::uuid, nullif(v_store ->> 'shelf_label', ''), v_next_sort,
              coalesce((v_store ->> 'is_primary')::boolean, false))
      on conflict (product_id, storage_location_id) do update
        set shelf_label = excluded.shelf_label, is_primary = excluded.is_primary;
    end loop;
  end if;

  -- Primary vendor item & price.
  if v_vendor is not null and nullif(v_vendor ->> 'vendor_id', '') is not null then
    if not exists (select 1 from public.units where code = v_vendor ->> 'order_unit') then
      perform app.fail('VALIDATION', 'Choose the vendor order unit.');
    end if;
    v_factor := app.unit_factor_to_inventory(v_id, v_vendor ->> 'order_unit');
    v_price := nullif(v_vendor ->> 'current_price', '')::numeric;
    if v_price is not null and v_price < 0 then
      perform app.fail('VALIDATION', 'Price cannot be negative.');
    end if;
    select * into v_vp from public.vendor_products
     where vendor_id = (v_vendor ->> 'vendor_id')::uuid and product_id = v_id for update;
    if v_vp.id is null then
      insert into public.vendor_products (vendor_id, product_id, vendor_sku, vendor_description, order_unit, current_price, price_updated_at)
      values ((v_vendor ->> 'vendor_id')::uuid, v_id, nullif(v_vendor ->> 'vendor_sku', ''),
              nullif(v_vendor ->> 'vendor_description', ''), v_vendor ->> 'order_unit', v_price,
              case when v_price is not null then now() end);
    else
      update public.vendor_products set vendor_sku = nullif(v_vendor ->> 'vendor_sku', ''),
        vendor_description = nullif(v_vendor ->> 'vendor_description', ''), order_unit = v_vendor ->> 'order_unit',
        current_price = v_price,
        price_updated_at = case when v_price is distinct from v_vp.current_price then now() else price_updated_at end,
        is_active = true
       where id = v_vp.id;
    end if;
    if v_price is not null and (v_vp.id is null or v_price is distinct from v_vp.current_price
                                or v_vp.order_unit is distinct from v_vendor ->> 'order_unit') then
      insert into public.price_history (vendor_id, product_id, unit_code, old_price, new_price, change_amount, change_pct,
                                        source, account_id, employee_id)
      values ((v_vendor ->> 'vendor_id')::uuid, v_id, v_vendor ->> 'order_unit',
              case when v_vp.order_unit = v_vendor ->> 'order_unit' then v_vp.current_price end, v_price,
              case when v_vp.order_unit = v_vendor ->> 'order_unit' then v_price - v_vp.current_price end,
              case when v_vp.order_unit = v_vendor ->> 'order_unit' and v_vp.current_price > 0
                   then round((v_price - v_vp.current_price) / v_vp.current_price * 100, 4) end,
              'manual', v_actor.account_id, v_actor.employee_id);
    end if;
    if v_price is not null then
      update public.products set current_cost = round(v_price / v_factor, 4) where id = v_id;
    end if;
  end if;

  return v_id;
end;
$$;

-- Shelf-to-sheet: set the exact count order for one storage area.
create or replace function public.set_count_order(p_storage_location_id uuid, p_items jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('products.manage');
  v_item jsonb;
  v_i int := 0;
  v_name text;
begin
  select name into v_name from public.storage_locations where id = p_storage_location_id;
  if v_name is null then
    perform app.fail('NOT_FOUND', 'Storage area not found.');
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    update public.product_storage_locations
       set sort_order = v_i * 10,
           shelf_label = case when v_item ? 'shelf_label' then nullif(trim(v_item ->> 'shelf_label'), '') else shelf_label end
     where storage_location_id = p_storage_location_id and product_id = (v_item ->> 'product_id')::uuid;
    if not found then
      perform app.fail('VALIDATION', 'A product in the list is not assigned to ' || v_name || '.');
    end if;
  end loop;
  perform app.audit(v_actor, 'counts.order_changed', 'inventory',
    app.actor_label(v_actor) || ' rearranged the count order for ' || v_name,
    'storage_locations', p_storage_location_id::text, p_new => p_items);
end;
$$;

-- -----------------------------------------------------------------------------
-- Catalog for operational forms. No costs, so it is safe for the shared
-- employee login (with a verified employee session).
-- -----------------------------------------------------------------------------
create or replace function public.operational_catalog()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor(null);
  v_loc uuid := app.primary_location_id();
begin
  return jsonb_build_object(
    'location_id', v_loc,
    'units', (select coalesce(jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'kind', u.kind,
                       'base_factor', u.base_factor) order by u.sort_order, u.code), '[]'::jsonb)
                from public.units u),
    'storage_locations', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'location_id', s.location_id)
                       order by s.sort_order, s.name), '[]'::jsonb)
                from public.storage_locations s where s.is_active),
    'vendors', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'code', v.code, 'name', v.name,
                       'vendor_type', v.vendor_type) order by v.name), '[]'::jsonb)
                from public.vendors v where v.is_active),
    'products', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', p.id, 'item_code', p.item_code, 'name', p.name, 'barcode', p.barcode,
                       'category', c.name, 'inventory_unit', p.inventory_unit, 'purchase_unit', p.purchase_unit,
                       'primary_vendor_id', p.primary_vendor_id,
                       'primary_storage_location_id', (select psl.storage_location_id from public.product_storage_locations psl
                                                       where psl.product_id = p.id and psl.is_primary limit 1),
                       'conversions', (select coalesce(jsonb_object_agg(pc.unit_code, pc.inventory_units_per_unit), '{}'::jsonb)
                                         from public.product_unit_conversions pc where pc.product_id = p.id))
                       order by p.name), '[]'::jsonb)
                from public.products p left join public.categories c on c.id = p.category_id
               where p.is_active));
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants
-- -----------------------------------------------------------------------------
alter table public.inventory_transactions enable row level security;
alter table public.inventory_balances enable row level security;
alter table public.idempotency_keys enable row level security;
revoke all on public.inventory_transactions, public.inventory_balances, public.idempotency_keys from anon, authenticated;
revoke all on public.inventory_on_hand from anon, authenticated;

grant select on public.inventory_transactions to authenticated;
create policy inventory_transactions_select on public.inventory_transactions for select to authenticated
  using ((select app.has_permission('inventory.view')));

grant select on public.inventory_balances to authenticated;
create policy inventory_balances_select on public.inventory_balances for select to authenticated
  using ((select app.has_permission('inventory.view')));

grant select on public.inventory_on_hand to authenticated;
-- idempotency_keys: no API access.

revoke execute on all functions in schema app from public, anon;
grant execute on function app.stock_status(numeric, numeric, numeric) to authenticated, service_role;

revoke execute on function public.adjust_inventory(uuid, uuid, numeric, numeric, text, text, uuid),
  public.ledger_integrity_check(), public.save_product(jsonb), public.set_count_order(uuid, jsonb),
  public.operational_catalog() from public, anon;
grant execute on function public.adjust_inventory(uuid, uuid, numeric, numeric, text, text, uuid),
  public.ledger_integrity_check(), public.save_product(jsonb), public.set_count_order(uuid, jsonb),
  public.operational_catalog() to authenticated;
