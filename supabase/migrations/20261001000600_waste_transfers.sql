-- =============================================================================
-- 0006 WASTE AND TRANSFERS
-- The person who logs waste or moves product is ALWAYS the verified actor:
-- there is no employee_id parameter, so nobody can attribute an action to
-- someone else.
-- =============================================================================

create table public.waste_reasons (
  code text primary key check (code ~ '^[A-Z_]{2,30}$'),
  label text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true
);
insert into public.waste_reasons (code, label, sort_order) values
  ('EXPIRED', 'Expired', 10),
  ('SPOILED', 'Spoiled', 20),
  ('DROPPED', 'Dropped', 30),
  ('OVERCOOKED', 'Overcooked', 40),
  ('INCORRECT_PREP', 'Incorrect preparation', 50),
  ('CUSTOMER_RETURN', 'Customer return', 60),
  ('PREP_WASTE', 'Prep waste', 70),
  ('DAMAGED', 'Damaged', 80),
  ('QUALITY_ISSUE', 'Quality issue', 90),
  ('EQUIPMENT_FAILURE', 'Equipment failure', 100),
  ('OTHER', 'Other', 110);

create table public.waste_entries (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  product_id uuid not null references public.products(id),
  quantity numeric(16, 4) not null check (quantity > 0),
  unit_code text not null references public.units(code),
  quantity_inv numeric(16, 4) not null check (quantity_inv > 0),
  unit_cost numeric(14, 4) not null check (unit_cost >= 0),
  total_cost numeric(14, 2) not null check (total_cost >= 0),
  reason_code text not null references public.waste_reasons(code),
  storage_location_id uuid references public.storage_locations(id),
  notes text check (notes is null or length(notes) <= 500),
  photo_path text,
  occurred_at timestamptz not null default now(),
  account_id uuid not null references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  inventory_txn_id bigint not null references public.inventory_transactions(id),
  idempotency_key uuid unique,
  created_at timestamptz not null default now()
);
create index waste_entries_occurred_idx on public.waste_entries (occurred_at desc);
create index waste_entries_product_idx on public.waste_entries (product_id, occurred_at desc);
create index waste_entries_employee_idx on public.waste_entries (employee_id, occurred_at desc);
create trigger waste_entries_immutable before update or delete on public.waste_entries
  for each row execute function app.prevent_mutation();

-- p = { idempotency_key, product_id, quantity, unit_code, reason_code, storage_location_id, notes }
create or replace function public.log_waste(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('waste.log');
  v_key uuid := nullif(p ->> 'idempotency_key', '')::uuid;
  v_prior jsonb;
  v_prod public.products;
  v_loc uuid := app.primary_location_id();
  v_qty numeric := nullif(p ->> 'quantity', '')::numeric;
  v_unit text;
  v_qty_inv numeric(16, 4);
  v_reason public.waste_reasons;
  v_storage uuid := nullif(p ->> 'storage_location_id', '')::uuid;
  v_txn public.inventory_transactions;
  v_id uuid := gen_random_uuid();
  v_total numeric(14, 2);
  v_result jsonb;
begin
  v_prior := app.idempotent_result(v_key, 'waste.log');
  if v_prior is not null then
    return v_prior;
  end if;
  select * into v_prod from public.products where id = nullif(p ->> 'product_id', '')::uuid;
  if v_prod.id is null or not v_prod.is_active then
    perform app.fail('VALIDATION', 'Choose an active product.');
  end if;
  if v_qty is null or v_qty <= 0 or v_qty > 10000 then
    perform app.fail('VALIDATION', 'Enter a quantity greater than 0 (max 10,000).');
  end if;
  select * into v_reason from public.waste_reasons where code = p ->> 'reason_code' and is_active;
  if v_reason.code is null then
    perform app.fail('VALIDATION', 'Choose a waste reason.');
  end if;
  if v_reason.code = 'OTHER' and coalesce(length(trim(p ->> 'notes')), 0) < 3 then
    perform app.fail('VALIDATION', 'Add a note when the reason is Other.');
  end if;
  if v_storage is not null and not exists (select 1 from public.storage_locations
                                            where id = v_storage and location_id = v_loc and is_active) then
    perform app.fail('VALIDATION', 'Choose a valid storage area.');
  end if;
  v_unit := coalesce(nullif(p ->> 'unit_code', ''), v_prod.inventory_unit);
  v_qty_inv := app.to_inventory_qty(v_prod.id, v_qty, v_unit);
  if v_qty_inv <= 0 then
    perform app.fail('VALIDATION', 'Quantity is too small.');
  end if;

  v_txn := app.post_inventory_txn(v_actor, v_loc, v_prod.id, 'WASTE', -v_qty_inv, null,
    'waste_entry', v_id::text, now(), v_storage, null, null, v_reason.code, nullif(trim(p ->> 'notes'), ''));
  v_total := round(v_qty_inv * v_txn.unit_cost, 2);

  insert into public.waste_entries (id, location_id, product_id, quantity, unit_code, quantity_inv, unit_cost, total_cost,
    reason_code, storage_location_id, notes, account_id, employee_id, inventory_txn_id, idempotency_key)
  values (v_id, v_loc, v_prod.id, v_qty, v_unit, v_qty_inv, v_txn.unit_cost, v_total,
    v_reason.code, v_storage, nullif(trim(p ->> 'notes'), ''), v_actor.account_id, v_actor.employee_id, v_txn.id, v_key);

  perform app.audit(v_actor, 'waste.logged', 'operations',
    app.actor_label(v_actor) || ' logged ' || trim(to_char(v_qty, 'FM999999990.####')) || ' ' || v_unit || ' ' ||
      v_prod.name || ' waste (' || v_reason.label || ', ' || app.fmt_money(v_total) || ')',
    'waste_entries', v_id::text, v_prod.id, null, v_loc, null,
    jsonb_build_object('quantity', v_qty, 'unit', v_unit, 'quantity_inv', v_qty_inv, 'unit_cost', v_txn.unit_cost,
                       'total_cost', v_total, 'reason', v_reason.code),
    v_reason.code);

  if v_total > app.setting_numeric('alerts.high_waste_value', 50) then
    perform app.raise_alert('HIGH_WASTE', 'warning', 'High waste: ' || v_prod.name,
      app.actor_label(v_actor) || ' logged ' || trim(to_char(v_qty, 'FM999999990.####')) || ' ' || v_unit || ' of ' ||
        v_prod.name || ' (' || v_reason.label || ') worth ' || app.fmt_money(v_total) || '.',
      'waste_entries', v_id::text, '/waste', 'waste:' || v_id, v_prod.id, null, v_loc,
      jsonb_build_object('total_cost', v_total));
  end if;

  v_result := jsonb_build_object('waste_entry_id', v_id, 'quantity_inv', v_qty_inv, 'inventory_unit', v_prod.inventory_unit,
                                 'unit_cost', v_txn.unit_cost, 'total_cost', v_total, 'balance_after', v_txn.balance_after);
  perform app.idempotent_store(v_key, 'waste.log', v_result);
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Transfers
--   storage  : between storage areas in one location; completes immediately
--              (TRANSFER_OUT + TRANSFER_IN, net zero for the location)
--   location : between locations (restaurant <-> commissary, future stores);
--              SENT posts the outbound side, RECEIVED posts the inbound side.
-- -----------------------------------------------------------------------------
create table public.inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_number bigint generated always as identity unique,
  transfer_type text not null check (transfer_type in ('storage', 'location')),
  status text not null check (status in ('draft', 'sent', 'in_transit', 'received', 'reconciled', 'cancelled')),
  from_location_id uuid not null references public.locations(id),
  to_location_id uuid not null references public.locations(id),
  from_storage_location_id uuid references public.storage_locations(id),
  to_storage_location_id uuid references public.storage_locations(id),
  has_differences boolean not null default false,
  notes text check (notes is null or length(notes) <= 500),
  created_by uuid not null references public.account_profiles(id),
  created_employee_id uuid references public.employees(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  received_at timestamptz,
  received_by uuid references public.account_profiles(id),
  received_employee_id uuid references public.employees(id),
  cancelled_at timestamptz,
  cancelled_by uuid references public.account_profiles(id),
  idempotency_key uuid unique,
  constraint transfers_storage_same_location check (transfer_type <> 'storage' or from_location_id = to_location_id),
  constraint transfers_location_different check (transfer_type <> 'location' or from_location_id <> to_location_id),
  constraint transfers_storage_areas check (transfer_type <> 'storage' or (from_storage_location_id is not null
                                              and to_storage_location_id is not null
                                              and from_storage_location_id <> to_storage_location_id))
);
create index inventory_transfers_created_idx on public.inventory_transfers (created_at desc);

create table public.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.inventory_transfers(id),
  product_id uuid not null references public.products(id),
  unit_code text not null references public.units(code),
  quantity numeric(16, 4) not null check (quantity > 0),
  quantity_inv numeric(16, 4) not null check (quantity_inv > 0),
  received_quantity_inv numeric(16, 4) check (received_quantity_inv is null or received_quantity_inv >= 0),
  unit_cost numeric(14, 4),
  out_txn_id bigint references public.inventory_transactions(id),
  in_txn_id bigint references public.inventory_transactions(id),
  unique (transfer_id, product_id)
);

-- p = { idempotency_key, transfer_type, from_storage_location_id, to_storage_location_id,
--       from_location_id, to_location_id, notes, items: [{product_id, quantity, unit_code}] }
create or replace function public.create_transfer(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('transfers.perform');
  v_key uuid := nullif(p ->> 'idempotency_key', '')::uuid;
  v_prior jsonb;
  v_type text := p ->> 'transfer_type';
  v_from_loc uuid; v_to_loc uuid;
  v_from_sl public.storage_locations; v_to_sl public.storage_locations;
  v_from_l public.locations; v_to_l public.locations;
  v_id uuid := gen_random_uuid();
  v_no bigint;
  v_item jsonb;
  v_prod public.products;
  v_unit text;
  v_qty numeric;
  v_qty_inv numeric(16, 4);
  v_out public.inventory_transactions;
  v_in public.inventory_transactions;
  v_item_id uuid;
  v_count int := 0;
  v_desc text[] := '{}';
  v_out_type public.inventory_txn_type;
  v_result jsonb;
begin
  v_prior := app.idempotent_result(v_key, 'transfer.create');
  if v_prior is not null then
    return v_prior;
  end if;
  if v_type not in ('storage', 'location') then
    perform app.fail('VALIDATION', 'Choose a transfer type.');
  end if;
  if coalesce(jsonb_typeof(p -> 'items'), '') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    perform app.fail('VALIDATION', 'Add at least one item to transfer.');
  end if;
  if jsonb_array_length(p -> 'items') > 100 then
    perform app.fail('VALIDATION', 'At most 100 items per transfer.');
  end if;

  if v_type = 'storage' then
    select * into v_from_sl from public.storage_locations where id = nullif(p ->> 'from_storage_location_id', '')::uuid and is_active;
    select * into v_to_sl from public.storage_locations where id = nullif(p ->> 'to_storage_location_id', '')::uuid and is_active;
    if v_from_sl.id is null or v_to_sl.id is null then
      perform app.fail('VALIDATION', 'Choose where the product is coming from and going to.');
    end if;
    if v_from_sl.id = v_to_sl.id then
      perform app.fail('VALIDATION', 'From and To must be different storage areas.');
    end if;
    if v_from_sl.location_id <> v_to_sl.location_id then
      perform app.fail('VALIDATION', 'Both storage areas must be in the same location. Use a location transfer instead.');
    end if;
    v_from_loc := v_from_sl.location_id; v_to_loc := v_to_sl.location_id;
  else
    if not app.has_permission('commissary.manage') and not app.has_permission('inventory.adjust') then
      perform app.fail('FORBIDDEN', 'Only management can send product to another location.');
    end if;
    select * into v_from_l from public.locations where id = nullif(p ->> 'from_location_id', '')::uuid and is_active;
    select * into v_to_l from public.locations where id = nullif(p ->> 'to_location_id', '')::uuid and is_active;
    if v_from_l.id is null or v_to_l.id is null or v_from_l.id = v_to_l.id then
      perform app.fail('VALIDATION', 'Choose two different locations.');
    end if;
    v_from_loc := v_from_l.id; v_to_loc := v_to_l.id;
  end if;

  insert into public.inventory_transfers (id, transfer_type, status, from_location_id, to_location_id,
    from_storage_location_id, to_storage_location_id, notes, created_by, created_employee_id, sent_at,
    received_at, received_by, received_employee_id, idempotency_key)
  values (v_id, v_type, case when v_type = 'storage' then 'received' else 'sent' end, v_from_loc, v_to_loc,
    v_from_sl.id, v_to_sl.id, nullif(trim(p ->> 'notes'), ''), v_actor.account_id, v_actor.employee_id, now(),
    case when v_type = 'storage' then now() end,
    case when v_type = 'storage' then v_actor.account_id end,
    case when v_type = 'storage' then v_actor.employee_id end, v_key)
  returning transfer_number into v_no;

  v_out_type := case when v_from_l.location_type = 'commissary' then 'COMMISSARY_TRANSFER' else 'TRANSFER_OUT' end;

  for v_item in select * from jsonb_array_elements(p -> 'items') loop
    select * into v_prod from public.products where id = nullif(v_item ->> 'product_id', '')::uuid;
    if v_prod.id is null or not v_prod.is_active then
      perform app.fail('VALIDATION', 'Choose an active product for every line.');
    end if;
    v_qty := nullif(v_item ->> 'quantity', '')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then
      perform app.fail('VALIDATION', v_prod.name || ': enter a quantity greater than 0.');
    end if;
    v_unit := coalesce(nullif(v_item ->> 'unit_code', ''), v_prod.inventory_unit);
    v_qty_inv := app.to_inventory_qty(v_prod.id, v_qty, v_unit);
    if v_qty_inv <= 0 then
      perform app.fail('VALIDATION', v_prod.name || ': quantity is too small.');
    end if;
    if exists (select 1 from public.transfer_items where transfer_id = v_id and product_id = v_prod.id) then
      perform app.fail('VALIDATION', v_prod.name || ' is listed twice.');
    end if;

    v_item_id := gen_random_uuid();
    v_out := app.post_inventory_txn(v_actor, v_from_loc, v_prod.id, v_out_type, -v_qty_inv, null,
      'transfer_item', v_item_id::text, now(), v_from_sl.id, 'Transfer #' || v_no);
    if v_type = 'storage' then
      v_in := app.post_inventory_txn(v_actor, v_to_loc, v_prod.id, 'TRANSFER_IN', v_qty_inv, v_out.unit_cost,
        'transfer_item', v_item_id::text, now(), v_to_sl.id, 'Transfer #' || v_no);
    end if;
    insert into public.transfer_items (id, transfer_id, product_id, unit_code, quantity, quantity_inv,
      received_quantity_inv, unit_cost, out_txn_id, in_txn_id)
    values (v_item_id, v_id, v_prod.id, v_unit, v_qty, v_qty_inv,
      case when v_type = 'storage' then v_qty_inv end, v_out.unit_cost, v_out.id, v_in.id);
    v_count := v_count + 1;
    v_desc := v_desc || (trim(to_char(v_qty, 'FM999999990.####')) || ' ' || v_unit || ' ' || v_prod.name);
    v_in := null;
  end loop;

  perform app.audit(v_actor, 'transfer.created', 'operations',
    app.actor_label(v_actor) || ' transferred ' || array_to_string(v_desc, ', ') || ' from ' ||
      coalesce(v_from_sl.name, v_from_l.name) || ' to ' || coalesce(v_to_sl.name, v_to_l.name),
    'inventory_transfers', v_id::text, case when v_count = 1 then v_prod.id end, null, v_from_loc, null,
    jsonb_build_object('transfer_number', v_no, 'type', v_type, 'items', v_count));

  v_result := jsonb_build_object('transfer_id', v_id, 'transfer_number', v_no,
                                 'status', case when v_type = 'storage' then 'received' else 'sent' end);
  perform app.idempotent_store(v_key, 'transfer.create', v_result);
  return v_result;
end;
$$;

-- Receive a location transfer. p_items: [{transfer_item_id, received_quantity}] in INVENTORY units.
create or replace function public.receive_transfer(p_transfer_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('transfers.perform');
  v_tr public.inventory_transfers;
  v_it record;
  v_recv numeric(16, 4);
  v_in public.inventory_transactions;
  v_diff boolean := false;
  v_lines text[] := '{}';
  v_in_type public.inventory_txn_type;
begin
  select * into v_tr from public.inventory_transfers where id = p_transfer_id for update;
  if v_tr.id is null then
    perform app.fail('NOT_FOUND', 'Transfer not found.');
  end if;
  if v_tr.status not in ('sent', 'in_transit') then
    perform app.fail('CONFLICT', 'Transfer #' || v_tr.transfer_number || ' is ' || v_tr.status || ' and cannot be received.');
  end if;
  v_in_type := case when (select location_type from public.locations where id = v_tr.from_location_id) = 'commissary'
                    then 'COMMISSARY_RECEIPT' else 'TRANSFER_IN' end;

  for v_it in
    select ti.*, pr.name as product_name, pr.inventory_unit
      from public.transfer_items ti join public.products pr on pr.id = ti.product_id
     where ti.transfer_id = v_tr.id order by pr.name
  loop
    select nullif(x ->> 'received_quantity', '')::numeric into v_recv
      from jsonb_array_elements(p_items) x where (x ->> 'transfer_item_id')::uuid = v_it.id;
    if v_recv is null then
      perform app.fail('VALIDATION', 'Enter the received quantity for ' || v_it.product_name || '.');
    end if;
    if v_recv < 0 or v_recv > 100000 then
      perform app.fail('VALIDATION', v_it.product_name || ': received quantity is invalid.');
    end if;
    v_recv := round(v_recv, 4);
    if v_recv > 0 then
      v_in := app.post_inventory_txn(v_actor, v_tr.to_location_id, v_it.product_id, v_in_type, v_recv, v_it.unit_cost,
        'transfer_item', v_it.id::text, now(), null, 'Transfer #' || v_tr.transfer_number);
    end if;
    update public.transfer_items set received_quantity_inv = v_recv, in_txn_id = v_in.id where id = v_it.id;
    if v_recv <> v_it.quantity_inv then
      v_diff := true;
      v_lines := v_lines || (v_it.product_name || ': sent ' || v_it.quantity_inv || ', received ' || v_recv || ' ' || v_it.inventory_unit);
    end if;
    v_in := null;
  end loop;

  update public.inventory_transfers
     set status = 'received', received_at = now(), received_by = v_actor.account_id,
         received_employee_id = v_actor.employee_id, has_differences = v_diff
   where id = v_tr.id;

  perform app.audit(v_actor, 'transfer.received', 'operations',
    app.actor_label(v_actor) || ' received transfer #' || v_tr.transfer_number ||
      case when v_diff then ' with differences' else '' end,
    'inventory_transfers', v_tr.id::text, null, null, v_tr.to_location_id, null,
    jsonb_build_object('differences', v_lines));

  if v_diff then
    perform app.raise_alert('TRANSFER_DIFFERENCE', 'warning', 'Transfer #' || v_tr.transfer_number || ' received with differences',
      array_to_string(v_lines, '; '), 'inventory_transfers', v_tr.id::text, '/transfers/' || v_tr.id,
      'transfer:' || v_tr.id, null, null, v_tr.to_location_id);
  end if;
  return jsonb_build_object('transfer_id', v_tr.id, 'has_differences', v_diff, 'differences', to_jsonb(v_lines));
end;
$$;

create or replace function public.cancel_transfer(p_transfer_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('transfers.perform');
  v_tr public.inventory_transfers;
  v_it record;
begin
  if not app.is_management() then
    perform app.fail('FORBIDDEN', 'Only management can cancel transfers.');
  end if;
  if coalesce(length(trim(p_reason)), 0) < 3 then
    perform app.fail('VALIDATION', 'Give a reason for cancelling.');
  end if;
  select * into v_tr from public.inventory_transfers where id = p_transfer_id for update;
  if v_tr.id is null then
    perform app.fail('NOT_FOUND', 'Transfer not found.');
  end if;
  if v_tr.status not in ('sent', 'in_transit', 'draft') then
    perform app.fail('CONFLICT', 'Only transfers that have not been received can be cancelled.');
  end if;
  -- Return the product to the sending location (reversal rows, never deletes).
  for v_it in select * from public.transfer_items where transfer_id = v_tr.id and out_txn_id is not null loop
    perform app.post_inventory_txn(v_actor, v_tr.from_location_id, v_it.product_id, 'CORRECTION', v_it.quantity_inv,
      v_it.unit_cost, 'transfer_item', v_it.id::text, now(), v_tr.from_storage_location_id,
      'Cancel transfer #' || v_tr.transfer_number, null, 'TRANSFER_CANCELLED', p_reason, v_it.out_txn_id);
  end loop;
  update public.inventory_transfers set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor.account_id
   where id = v_tr.id;
  perform app.audit(v_actor, 'transfer.cancelled', 'operations',
    app.actor_label(v_actor) || ' cancelled transfer #' || v_tr.transfer_number,
    'inventory_transfers', v_tr.id::text, null, null, v_tr.from_location_id, null, null, p_reason);
end;
$$;

-- Pending inbound transfers (for the receiving side, including employees).
create or replace function public.list_open_transfers()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('transfers.perform');
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'transfer_number', t.transfer_number, 'status', t.status, 'sent_at', t.sent_at,
      'from_location', fl.name, 'to_location', tl.name, 'notes', t.notes,
      'items', (select jsonb_agg(jsonb_build_object('id', ti.id, 'product_id', ti.product_id, 'product_name', p.name,
                 'quantity_inv', ti.quantity_inv, 'inventory_unit', p.inventory_unit) order by p.name)
                from public.transfer_items ti join public.products p on p.id = ti.product_id where ti.transfer_id = t.id))
      order by t.sent_at), '[]'::jsonb)
    from public.inventory_transfers t
    join public.locations fl on fl.id = t.from_location_id
    join public.locations tl on tl.id = t.to_location_id
   where t.status in ('sent', 'in_transit'));
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants
-- -----------------------------------------------------------------------------
alter table public.waste_reasons enable row level security;
alter table public.waste_entries enable row level security;
alter table public.inventory_transfers enable row level security;
alter table public.transfer_items enable row level security;
revoke all on public.waste_reasons, public.waste_entries, public.inventory_transfers, public.transfer_items from anon, authenticated;

grant select on public.waste_reasons to authenticated;
create policy waste_reasons_select on public.waste_reasons for select to authenticated using ((select app.can_read_operational()));

grant select on public.waste_entries to authenticated;
create policy waste_entries_select on public.waste_entries for select to authenticated
  using ((select app.has_permission('waste.review')));

grant select on public.inventory_transfers, public.transfer_items to authenticated;
create policy inventory_transfers_select on public.inventory_transfers for select to authenticated
  using ((select app.is_management()));
create policy transfer_items_select on public.transfer_items for select to authenticated
  using ((select app.is_management()));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.log_waste(jsonb), public.create_transfer(jsonb), public.receive_transfer(uuid, jsonb),
  public.cancel_transfer(uuid, text), public.list_open_transfers() from public, anon;
grant execute on function public.log_waste(jsonb), public.create_transfer(jsonb), public.receive_transfer(uuid, jsonb),
  public.cancel_transfer(uuid, text), public.list_open_transfers() to authenticated;
