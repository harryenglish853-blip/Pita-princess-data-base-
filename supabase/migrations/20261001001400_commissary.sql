-- =============================================================================
-- 0014 COMMISSARY (Phase 4)
--  * Commissary orders: the restaurant orders from the central kitchen.
--    DRAFT -> SUBMITTED -> ACCEPTED -> PREPARING -> READY -> IN TRANSIT -> RECEIVED
--    (CANCELLED any time before it is received). Every change is kept in
--    commissary_order_events with who did it.
--  * The commissary records what it SENT; the restaurant confirms what it RECEIVED.
--    Inventory moves only on receipt and only by what was received:
--      commissary out = received, restaurant in = received; any difference to what
--      was sent/ordered is flagged (alert + audit).
--  * Submitting an order emails the commissary recipients (sent by the server,
--    logged in email_reports with the order id).
--  * Production: ingredients go out, the finished product comes in at the cost
--    of the ingredients used (Phase 5 recipes will pre-fill ingredients).
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('production.record', 'commissary', 'Record production batches (ingredients used, finished product made)')
on conflict (code) do nothing;
insert into public.role_permissions (role, permission_code) values
  ('owner', 'production.record'), ('manager', 'production.record')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Commissary orders
-- -----------------------------------------------------------------------------
create table public.commissary_orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  location_id uuid not null references public.locations(id),            -- restaurant that ordered
  commissary_location_id uuid not null references public.locations(id), -- central kitchen
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'accepted', 'preparing', 'ready', 'in_transit', 'received', 'cancelled')),
  needed_date date,
  notes text check (notes is null or length(notes) <= 1000),
  has_differences boolean not null default false,
  created_by uuid not null references public.account_profiles(id),
  created_employee_id uuid references public.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  submitted_by uuid references public.account_profiles(id),
  shipped_at timestamptz,
  received_at timestamptz,
  received_by uuid references public.account_profiles(id),
  received_employee_id uuid references public.employees(id),
  cancelled_at timestamptz,
  cancel_reason text,
  constraint commissary_orders_two_locations check (location_id <> commissary_location_id),
  constraint commissary_orders_needed check (status = 'draft' or status = 'cancelled' or needed_date is not null)
);
create index commissary_orders_status_idx on public.commissary_orders (status, needed_date);
create index commissary_orders_created_idx on public.commissary_orders (created_at desc);
create trigger commissary_orders_touch before update on public.commissary_orders
  for each row execute function app.touch_updated_at();

create table public.commissary_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commissary_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  unit_code text not null references public.units(code),
  quantity numeric(16, 4) not null check (quantity > 0),               -- ordered, in unit_code
  quantity_inv numeric(16, 4) not null check (quantity_inv > 0),
  sent_quantity numeric(16, 4) check (sent_quantity is null or sent_quantity >= 0),
  sent_quantity_inv numeric(16, 4) check (sent_quantity_inv is null or sent_quantity_inv >= 0),
  received_quantity numeric(16, 4) check (received_quantity is null or received_quantity >= 0),
  received_quantity_inv numeric(16, 4) check (received_quantity_inv is null or received_quantity_inv >= 0),
  unit_cost numeric(14, 4),                                             -- per inventory unit, at receipt
  out_txn_id bigint references public.inventory_transactions(id),
  in_txn_id bigint references public.inventory_transactions(id),
  unique (order_id, product_id)
);

create table public.commissary_order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.commissary_orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  note text,
  account_id uuid not null references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  actor_name text not null,
  occurred_at timestamptz not null default now()
);
create index commissary_order_events_order_idx on public.commissary_order_events (order_id, id);
-- Drafts can be deleted (cascade); history of everything else is append-only.
create or replace function app.co_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'IMMUTABLE: commissary order history cannot be changed' using errcode = 'PT403';
  end if;
  return old;
end;
$$;
create trigger commissary_order_events_immutable before update on public.commissary_order_events
  for each row execute function app.co_events_guard();

create or replace function app.co_status_rank(p text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p when 'draft' then 0 when 'submitted' then 1 when 'accepted' then 2 when 'preparing' then 3
                when 'ready' then 4 when 'in_transit' then 5 when 'received' then 6 else -1 end
$$;

create or replace function app.co_event(p_actor app.actor, p_order uuid, p_from text, p_to text, p_note text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.commissary_order_events (order_id, from_status, to_status, note, account_id, employee_id, actor_name)
  values (p_order, p_from, p_to, nullif(trim(p_note), ''), p_actor.account_id, p_actor.employee_id, app.actor_label(p_actor));
$$;

create or replace function app.co_label(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p when 'in_transit' then 'IN TRANSIT' else upper(p) end
$$;

-- Products the commissary supplies (stocked at the commissary location).
create or replace function app.commissary_location_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.locations where location_type = 'commissary' and is_active order by created_at limit 1
$$;

-- p = { id?, status: 'draft'|'submitted', needed_date, notes, items: [{product_id, quantity, unit_code}] }
create or replace function public.save_commissary_order(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('commissary.manage');
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_status text := coalesce(nullif(p ->> 'status', ''), 'draft');
  v_o public.commissary_orders;
  v_ck uuid := app.commissary_location_id();
  v_loc uuid := app.primary_location_id();
  v_today date := (now() at time zone app.org_timezone())::date;
  v_date date := nullif(p ->> 'needed_date', '')::date;
  v_item jsonb;
  v_prod public.products;
  v_qty numeric;
  v_unit text;
  v_n int := 0;
  v_desc text[] := '{}';
begin
  if v_status not in ('draft', 'submitted') then
    perform app.fail('VALIDATION', 'Unknown order status.');
  end if;
  if v_ck is null then
    perform app.fail('VALIDATION', 'No commissary location is set up.');
  end if;
  if coalesce(jsonb_typeof(p -> 'items'), '') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    perform app.fail('VALIDATION', 'Add at least one item to the order.');
  end if;
  if jsonb_array_length(p -> 'items') > 200 then
    perform app.fail('VALIDATION', 'An order can have at most 200 items.');
  end if;
  if v_status = 'submitted' and v_date is null then
    perform app.fail('VALIDATION', 'Choose the date the restaurant needs this order.');
  end if;
  if v_date is not null and (v_date < v_today or v_date > v_today + 60) then
    perform app.fail('VALIDATION', 'The needed date must be between today and 60 days from now.');
  end if;

  if v_id is null then
    insert into public.commissary_orders (location_id, commissary_location_id, status, needed_date, notes, created_by, created_employee_id)
    values (v_loc, v_ck, 'draft', v_date, nullif(trim(p ->> 'notes'), ''), v_actor.account_id, v_actor.employee_id)
    returning * into v_o;
    perform app.co_event(v_actor, v_o.id, null, 'draft');
  else
    select * into v_o from public.commissary_orders where id = v_id for update;
    if v_o.id is null then
      perform app.fail('NOT_FOUND', 'Commissary order not found.');
    end if;
    if v_o.status <> 'draft' then
      perform app.fail('CONFLICT', 'Only draft orders can be edited. Order #' || v_o.order_number || ' is ' || app.co_label(v_o.status) || '.');
    end if;
    update public.commissary_orders set needed_date = v_date, notes = nullif(trim(p ->> 'notes'), '') where id = v_o.id;
    delete from public.commissary_order_items where order_id = v_o.id;
  end if;

  for v_item in select * from jsonb_array_elements(p -> 'items') loop
    select * into v_prod from public.products where id = nullif(v_item ->> 'product_id', '')::uuid and is_active;
    if v_prod.id is null then
      perform app.fail('VALIDATION', 'Choose an active product for every line.');
    end if;
    if not exists (select 1 from public.location_products where location_id = v_ck and product_id = v_prod.id and is_stocked) then
      perform app.fail('VALIDATION', v_prod.name || ' is not a commissary item.');
    end if;
    v_qty := nullif(v_item ->> 'quantity', '')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then
      perform app.fail('VALIDATION', v_prod.name || ': enter a quantity greater than 0.');
    end if;
    v_unit := coalesce(nullif(v_item ->> 'unit_code', ''), v_prod.inventory_unit);
    if exists (select 1 from public.commissary_order_items where order_id = v_o.id and product_id = v_prod.id) then
      perform app.fail('VALIDATION', v_prod.name || ' is listed twice.');
    end if;
    insert into public.commissary_order_items (order_id, product_id, unit_code, quantity, quantity_inv)
    values (v_o.id, v_prod.id, v_unit, round(v_qty, 4), app.to_inventory_qty(v_prod.id, v_qty, v_unit));
    v_n := v_n + 1;
    v_desc := v_desc || (trim(to_char(v_qty, 'FM999999990.####')) || ' ' || v_unit || ' ' || v_prod.name);
  end loop;

  if v_status = 'submitted' then
    update public.commissary_orders set status = 'submitted', submitted_at = now(), submitted_by = v_actor.account_id where id = v_o.id;
    perform app.co_event(v_actor, v_o.id, 'draft', 'submitted');
  end if;

  perform app.audit(v_actor, case when v_status = 'submitted' then 'commissary.order_submitted' else 'commissary.order_drafted' end, 'operations',
    app.actor_label(v_actor) || case when v_status = 'submitted' then ' submitted' else ' saved a draft of' end ||
      ' commissary order #' || v_o.order_number || ' (' || array_to_string(v_desc, ', ') || ')' ||
      coalesce(', needed ' || to_char(v_date, 'Dy Mon DD'), ''),
    'commissary_orders', v_o.id::text, null, null, v_loc, null,
    jsonb_build_object('items', v_n, 'needed_date', v_date));

  return jsonb_build_object('id', v_o.id, 'order_number', v_o.order_number, 'status', v_status);
end;
$$;

-- Commissary moves the order forward: accepted / preparing / ready.
create or replace function public.set_commissary_order_status(p_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('commissary.manage');
  v_o public.commissary_orders;
begin
  if p_status not in ('accepted', 'preparing', 'ready') then
    perform app.fail('VALIDATION', 'Unknown status.');
  end if;
  select * into v_o from public.commissary_orders where id = p_id for update;
  if v_o.id is null then
    perform app.fail('NOT_FOUND', 'Commissary order not found.');
  end if;
  if v_o.status in ('draft', 'cancelled', 'received', 'in_transit')
     or app.co_status_rank(p_status) <= app.co_status_rank(v_o.status) then
    perform app.fail('CONFLICT', 'Order #' || v_o.order_number || ' is ' || app.co_label(v_o.status) ||
      ' and cannot be marked ' || app.co_label(p_status) || '.');
  end if;
  update public.commissary_orders set status = p_status where id = v_o.id;
  perform app.co_event(v_actor, v_o.id, v_o.status, p_status, p_note);
  perform app.audit(v_actor, 'commissary.order_status', 'operations',
    app.actor_label(v_actor) || ' marked commissary order #' || v_o.order_number || ' ' || app.co_label(p_status),
    'commissary_orders', v_o.id::text, null, null, v_o.commissary_location_id, jsonb_build_object('status', v_o.status),
    jsonb_build_object('status', p_status), p_note);
  return jsonb_build_object('id', v_o.id, 'status', p_status);
end;
$$;

-- Commissary sends the order. p_items: [{item_id, sent_quantity}] in each line's ORDER unit.
-- No inventory moves yet: it moves when the restaurant confirms what arrived.
create or replace function public.ship_commissary_order(p_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('commissary.manage');
  v_o public.commissary_orders;
  v_it record;
  v_sent numeric;
  v_short text[] := '{}';
begin
  select * into v_o from public.commissary_orders where id = p_id for update;
  if v_o.id is null then
    perform app.fail('NOT_FOUND', 'Commissary order not found.');
  end if;
  if v_o.status not in ('submitted', 'accepted', 'preparing', 'ready') then
    perform app.fail('CONFLICT', 'Order #' || v_o.order_number || ' is ' || app.co_label(v_o.status) || ' and cannot be sent.');
  end if;
  if coalesce(jsonb_typeof(p_items), '') <> 'array' then
    perform app.fail('VALIDATION', 'Enter what is being sent.');
  end if;
  for v_it in select i.*, pr.name from public.commissary_order_items i join public.products pr on pr.id = i.product_id where i.order_id = v_o.id loop
    select nullif(x ->> 'sent_quantity', '')::numeric into v_sent
      from jsonb_array_elements(p_items) x where nullif(x ->> 'item_id', '')::uuid = v_it.id;
    if v_sent is null or v_sent < 0 or v_sent > 100000 then
      perform app.fail('VALIDATION', 'Enter how much ' || v_it.name || ' is being sent (0 if none).');
    end if;
    update public.commissary_order_items
       set sent_quantity = round(v_sent, 4),
           sent_quantity_inv = case when v_sent = 0 then 0 else app.to_inventory_qty(v_it.product_id, v_sent, v_it.unit_code) end
     where id = v_it.id;
    if round(v_sent, 4) <> v_it.quantity then
      v_short := v_short || (v_it.name || ': ordered ' || trim(to_char(v_it.quantity, 'FM999999990.####')) || ', sending ' ||
                             trim(to_char(v_sent, 'FM999999990.####')) || ' ' || v_it.unit_code);
    end if;
  end loop;
  update public.commissary_orders set status = 'in_transit', shipped_at = now() where id = v_o.id;
  perform app.co_event(v_actor, v_o.id, v_o.status, 'in_transit',
    case when cardinality(v_short) > 0 then array_to_string(v_short, '; ') end);
  perform app.audit(v_actor, 'commissary.order_shipped', 'operations',
    app.actor_label(v_actor) || ' sent commissary order #' || v_o.order_number ||
      case when cardinality(v_short) > 0 then ' (not as ordered: ' || array_to_string(v_short, '; ') || ')' else '' end,
    'commissary_orders', v_o.id::text, null, null, v_o.commissary_location_id, null,
    jsonb_build_object('changes', to_jsonb(v_short)));
  return jsonb_build_object('id', v_o.id, 'status', 'in_transit', 'changes', to_jsonb(v_short));
end;
$$;

-- Restaurant confirms what arrived. p_items: [{item_id, received_quantity}] in each line's ORDER unit.
-- Commissary out = restaurant in = received (moved at the commissary's average cost).
create or replace function public.receive_commissary_order(p_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.perform');
  v_o public.commissary_orders;
  v_it record;
  v_recv numeric;
  v_recv_inv numeric(16, 4);
  v_expected numeric;
  v_out public.inventory_transactions;
  v_in public.inventory_transactions;
  v_diff text[] := '{}';
  v_lines text[] := '{}';
  q text;
begin
  select * into v_o from public.commissary_orders where id = p_id for update;
  if v_o.id is null then
    perform app.fail('NOT_FOUND', 'Commissary order not found.');
  end if;
  if v_o.status not in ('submitted', 'accepted', 'preparing', 'ready', 'in_transit') then
    perform app.fail('CONFLICT', 'Commissary order #' || v_o.order_number || ' is ' || app.co_label(v_o.status) || ' and cannot be received.');
  end if;
  if coalesce(jsonb_typeof(p_items), '') <> 'array' then
    perform app.fail('VALIDATION', 'Enter what arrived.');
  end if;

  for v_it in
    select i.*, pr.name, pr.inventory_unit from public.commissary_order_items i join public.products pr on pr.id = i.product_id
     where i.order_id = v_o.id order by pr.name
  loop
    select nullif(x ->> 'received_quantity', '')::numeric into v_recv
      from jsonb_array_elements(p_items) x where nullif(x ->> 'item_id', '')::uuid = v_it.id;
    if v_recv is null or v_recv < 0 or v_recv > 100000 then
      perform app.fail('VALIDATION', 'Enter how much ' || v_it.name || ' arrived (0 if none).');
    end if;
    v_recv := round(v_recv, 4);
    v_recv_inv := case when v_recv = 0 then 0 else app.to_inventory_qty(v_it.product_id, v_recv, v_it.unit_code) end;
    if v_recv_inv > 0 then
      v_out := app.post_inventory_txn(v_actor, v_o.commissary_location_id, v_it.product_id, 'COMMISSARY_TRANSFER', -v_recv_inv, null,
        'commissary_order_item', v_it.id::text, now(), null, 'Commissary order #' || v_o.order_number);
      v_in := app.post_inventory_txn(v_actor, v_o.location_id, v_it.product_id, 'COMMISSARY_RECEIPT', v_recv_inv, v_out.unit_cost,
        'commissary_order_item', v_it.id::text, now(), null, 'Commissary order #' || v_o.order_number);
    end if;
    update public.commissary_order_items
       set received_quantity = v_recv, received_quantity_inv = v_recv_inv,
           unit_cost = v_out.unit_cost, out_txn_id = v_out.id, in_txn_id = v_in.id
     where id = v_it.id;
    q := trim(to_char(v_recv, 'FM999999990.####'));
    v_lines := v_lines || (q || ' ' || v_it.unit_code || ' ' || v_it.name);
    v_expected := coalesce(v_it.sent_quantity, v_it.quantity);
    if v_recv <> v_expected or v_recv <> v_it.quantity then
      v_diff := v_diff || (v_it.name || ': ordered ' || trim(to_char(v_it.quantity, 'FM999999990.####')) ||
        coalesce(', sent ' || trim(to_char(v_it.sent_quantity, 'FM999999990.####')), '') ||
        ', received ' || q || ' ' || v_it.unit_code ||
        ' (' || case when v_recv < v_expected then 'short ' || trim(to_char(v_expected - v_recv, 'FM999999990.####'))
                     when v_recv > v_expected then 'over ' || trim(to_char(v_recv - v_expected, 'FM999999990.####'))
                     else 'short ' || trim(to_char(v_it.quantity - v_recv, 'FM999999990.####')) || ' vs order' end || ')');
    end if;
    v_out := null; v_in := null;
  end loop;

  update public.commissary_orders
     set status = 'received', received_at = now(), received_by = v_actor.account_id,
         received_employee_id = v_actor.employee_id, has_differences = cardinality(v_diff) > 0
   where id = v_o.id;
  perform app.co_event(v_actor, v_o.id, v_o.status, 'received',
    case when cardinality(v_diff) > 0 then array_to_string(v_diff, '; ') end);
  perform app.audit(v_actor, 'commissary.order_received', 'operations',
    app.actor_label(v_actor) || ' received commissary order #' || v_o.order_number || ' (' || array_to_string(v_lines, ', ') || ')' ||
      case when cardinality(v_diff) > 0 then ' with differences' else '' end,
    'commissary_orders', v_o.id::text, null, null, v_o.location_id, null,
    jsonb_build_object('differences', to_jsonb(v_diff)));
  if cardinality(v_diff) > 0 then
    perform app.raise_alert('COMMISSARY_DIFFERENCE', 'warning',
      'Commissary order #' || v_o.order_number || ' arrived different from the order',
      array_to_string(v_diff, '; '), 'commissary_orders', v_o.id::text, '/commissary/' || v_o.id,
      'commissary:' || v_o.id, null, null, v_o.location_id);
  end if;
  return jsonb_build_object('id', v_o.id, 'status', 'received', 'differences', to_jsonb(v_diff));
end;
$$;

create or replace function public.cancel_commissary_order(p_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('commissary.manage');
  v_o public.commissary_orders;
begin
  if coalesce(length(trim(p_reason)), 0) < 3 then
    perform app.fail('VALIDATION', 'Give a reason for cancelling.');
  end if;
  select * into v_o from public.commissary_orders where id = p_id for update;
  if v_o.id is null then
    perform app.fail('NOT_FOUND', 'Commissary order not found.');
  end if;
  if v_o.status in ('received', 'cancelled') then
    perform app.fail('CONFLICT', 'Order #' || v_o.order_number || ' is ' || app.co_label(v_o.status) || ' and cannot be cancelled.');
  end if;
  update public.commissary_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = trim(p_reason) where id = v_o.id;
  perform app.co_event(v_actor, v_o.id, v_o.status, 'cancelled', p_reason);
  perform app.audit(v_actor, 'commissary.order_cancelled', 'operations',
    app.actor_label(v_actor) || ' cancelled commissary order #' || v_o.order_number,
    'commissary_orders', v_o.id::text, null, null, v_o.location_id, null, null, trim(p_reason));
end;
$$;

-- For the receiving screen (employees too): orders on their way, WITHOUT costs.
create or replace function public.incoming_commissary_orders()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.perform');
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'order_number', o.order_number, 'status', o.status, 'needed_date', o.needed_date,
      'shipped_at', o.shipped_at, 'notes', o.notes,
      'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'product_id', i.product_id, 'name', p.name,
                  'unit_code', i.unit_code, 'quantity', i.quantity, 'sent_quantity', i.sent_quantity) order by p.name)
                  from public.commissary_order_items i join public.products p on p.id = i.product_id where i.order_id = o.id))
      order by o.needed_date, o.order_number), '[]'::jsonb)
    from public.commissary_orders o
   where o.location_id = app.primary_location_id() and o.status in ('ready', 'in_transit'));
end;
$$;

-- -----------------------------------------------------------------------------
-- Production
-- -----------------------------------------------------------------------------
create table public.production_events (
  id uuid primary key default gen_random_uuid(),
  batch_number bigint generated always as identity unique,
  location_id uuid not null references public.locations(id),
  product_id uuid not null references public.products(id),           -- finished product
  unit_code text not null references public.units(code),
  quantity numeric(16, 4) not null check (quantity > 0),
  quantity_inv numeric(16, 4) not null check (quantity_inv > 0),
  total_cost numeric(14, 4) not null check (total_cost >= 0),
  unit_cost numeric(14, 4) not null check (unit_cost >= 0),            -- per inventory unit of the finished product
  notes text check (notes is null or length(notes) <= 500),
  produced_at timestamptz not null default now(),
  account_id uuid not null references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  output_txn_id bigint references public.inventory_transactions(id),
  idempotency_key uuid unique
);
create index production_events_product_idx on public.production_events (product_id, produced_at desc);

create table public.production_items (
  id uuid primary key default gen_random_uuid(),
  production_event_id uuid not null references public.production_events(id),
  product_id uuid not null references public.products(id),            -- ingredient
  unit_code text not null references public.units(code),
  quantity numeric(16, 4) not null check (quantity > 0),
  quantity_inv numeric(16, 4) not null check (quantity_inv > 0),
  unit_cost numeric(14, 4) not null,
  extended_cost numeric(18, 4) not null,
  txn_id bigint not null references public.inventory_transactions(id),
  unique (production_event_id, product_id)
);
create trigger production_events_immutable before update or delete on public.production_events
  for each row execute function app.prevent_mutation();
create trigger production_items_immutable before update or delete on public.production_items
  for each row execute function app.prevent_mutation();

-- p = { idempotency_key, location_id, product_id, quantity, unit_code, notes,
--       ingredients: [{product_id, quantity, unit_code}] }
create or replace function public.record_production(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('production.record');
  v_key uuid := nullif(p ->> 'idempotency_key', '')::uuid;
  v_prior jsonb;
  v_loc public.locations;
  v_out_prod public.products;
  v_qty numeric;
  v_unit text;
  v_qty_inv numeric(16, 4);
  v_id uuid := gen_random_uuid();
  v_no bigint;
  v_ing jsonb;
  v_prod public.products;
  v_iq numeric;
  v_iunit text;
  v_iq_inv numeric(16, 4);
  v_txn public.inventory_transactions;
  v_total numeric(18, 4) := 0;
  v_unit_cost numeric(14, 4);
  v_out public.inventory_transactions;
  v_desc text[] := '{}';
  v_items jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  v_prior := app.idempotent_result(v_key, 'production.record');
  if v_prior is not null then
    return v_prior;
  end if;
  select * into v_loc from public.locations where id = coalesce(nullif(p ->> 'location_id', '')::uuid, app.commissary_location_id()) and is_active;
  if v_loc.id is null then
    perform app.fail('VALIDATION', 'Choose where the product was made.');
  end if;
  select * into v_out_prod from public.products where id = nullif(p ->> 'product_id', '')::uuid and is_active;
  if v_out_prod.id is null then
    perform app.fail('VALIDATION', 'Choose the product that was made.');
  end if;
  v_qty := nullif(p ->> 'quantity', '')::numeric;
  if v_qty is null or v_qty <= 0 or v_qty > 100000 then
    perform app.fail('VALIDATION', 'Enter how much ' || v_out_prod.name || ' was made.');
  end if;
  v_unit := coalesce(nullif(p ->> 'unit_code', ''), v_out_prod.inventory_unit);
  v_qty_inv := app.to_inventory_qty(v_out_prod.id, v_qty, v_unit);
  if coalesce(jsonb_typeof(p -> 'ingredients'), '') <> 'array' or jsonb_array_length(p -> 'ingredients') = 0 then
    perform app.fail('VALIDATION', 'Add the ingredients that were used.');
  end if;
  if jsonb_array_length(p -> 'ingredients') > 60 then
    perform app.fail('VALIDATION', 'At most 60 ingredients per batch.');
  end if;

  v_no := nextval(pg_get_serial_sequence('public.production_events', 'batch_number'));

  for v_ing in select * from jsonb_array_elements(p -> 'ingredients') loop
    select * into v_prod from public.products where id = nullif(v_ing ->> 'product_id', '')::uuid and is_active;
    if v_prod.id is null then
      perform app.fail('VALIDATION', 'Choose an active product for every ingredient.');
    end if;
    if v_prod.id = v_out_prod.id then
      perform app.fail('VALIDATION', v_prod.name || ' cannot be an ingredient of itself.');
    end if;
    v_iq := nullif(v_ing ->> 'quantity', '')::numeric;
    if v_iq is null or v_iq <= 0 or v_iq > 100000 then
      perform app.fail('VALIDATION', v_prod.name || ': enter the quantity used.');
    end if;
    v_iunit := coalesce(nullif(v_ing ->> 'unit_code', ''), v_prod.inventory_unit);
    v_iq_inv := app.to_inventory_qty(v_prod.id, v_iq, v_iunit);
    if v_items @> jsonb_build_array(jsonb_build_object('product_id', v_prod.id)) then
      perform app.fail('VALIDATION', v_prod.name || ' is listed twice.');
    end if;
    v_txn := app.post_inventory_txn(v_actor, v_loc.id, v_prod.id, 'PRODUCTION', -v_iq_inv, null,
      'production_item', v_id::text, now(), null, 'Production batch #' || v_no);
    v_items := v_items || jsonb_build_array(jsonb_build_object('product_id', v_prod.id, 'unit_code', v_iunit, 'quantity', round(v_iq, 4),
      'quantity_inv', v_iq_inv, 'unit_cost', v_txn.unit_cost, 'extended_cost', -v_txn.extended_cost, 'txn_id', v_txn.id));
    v_total := v_total + (-v_txn.extended_cost);
    v_desc := v_desc || (trim(to_char(v_iq, 'FM999999990.####')) || ' ' || v_iunit || ' ' || v_prod.name);
  end loop;

  v_unit_cost := round(v_total / v_qty_inv, 4);
  v_out := app.post_inventory_txn(v_actor, v_loc.id, v_out_prod.id, 'PRODUCTION', v_qty_inv, v_unit_cost,
    'production_event', v_id::text, now(), null, 'Production batch #' || v_no);

  -- header and lines are written once, complete (both tables are append-only)
  insert into public.production_events (id, batch_number, location_id, product_id, unit_code, quantity, quantity_inv, total_cost, unit_cost,
    notes, account_id, employee_id, output_txn_id, idempotency_key)
  overriding system value
  values (v_id, v_no, v_loc.id, v_out_prod.id, v_unit, round(v_qty, 4), v_qty_inv, round(v_total, 4), v_unit_cost,
    nullif(trim(p ->> 'notes'), ''), v_actor.account_id, v_actor.employee_id, v_out.id, v_key);
  insert into public.production_items (production_event_id, product_id, unit_code, quantity, quantity_inv, unit_cost, extended_cost, txn_id)
  select v_id, (x ->> 'product_id')::uuid, x ->> 'unit_code', (x ->> 'quantity')::numeric, (x ->> 'quantity_inv')::numeric,
         (x ->> 'unit_cost')::numeric, (x ->> 'extended_cost')::numeric, (x ->> 'txn_id')::bigint
    from jsonb_array_elements(v_items) x;

  perform app.audit(v_actor, 'production.recorded', 'inventory',
    app.actor_label(v_actor) || ' made ' || trim(to_char(v_qty, 'FM999999990.####')) || ' ' || v_unit || ' ' || v_out_prod.name ||
      ' at ' || v_loc.name || ' from ' || array_to_string(v_desc, ', ') ||
      ' (cost ' || app.fmt_money(v_total) || ', ' || app.fmt_money(v_unit_cost) || ' per ' || v_out_prod.inventory_unit || ')',
    'production_events', v_id::text, v_out_prod.id, null, v_loc.id, null,
    jsonb_build_object('batch_number', v_no, 'total_cost', round(v_total, 2), 'unit_cost', v_unit_cost));

  v_result := jsonb_build_object('id', v_id, 'batch_number', v_no, 'total_cost', round(v_total, 2), 'unit_cost', v_unit_cost);
  perform app.idempotent_store(v_key, 'production.record', v_result);
  return v_result;
end;
$$;

-- Ingredients of the most recent batch of a product, to pre-fill the next one.
create or replace function public.last_production_template(p_product_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('production.record');
begin
  return (select jsonb_build_object('quantity', e.quantity, 'unit_code', e.unit_code,
            'ingredients', (select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'quantity', i.quantity, 'unit_code', i.unit_code))
                              from public.production_items i where i.production_event_id = e.id))
            from public.production_events e where e.product_id = p_product_id order by e.produced_at desc limit 1);
end;
$$;

-- -----------------------------------------------------------------------------
-- Email: commissary order recipients; log rows can point at the order
-- -----------------------------------------------------------------------------
alter table public.email_recipients add column receives_commissary_orders boolean not null default false;
alter table public.email_reports drop constraint email_reports_report_type_check;
alter table public.email_reports add constraint email_reports_report_type_check
  check (report_type in ('daily', 'weekly', 'test', 'commissary_order'));
alter table public.email_reports drop constraint email_reports_triggered_by_check;
alter table public.email_reports add constraint email_reports_triggered_by_check
  check (triggered_by in ('schedule', 'manual', 'event'));
alter table public.email_reports add column commissary_order_id uuid references public.commissary_orders(id);
create index email_reports_commissary_idx on public.email_reports (commissary_order_id) where commissary_order_id is not null;

-- -----------------------------------------------------------------------------
-- Suggested orders: open commissary orders count as already ordered
-- -----------------------------------------------------------------------------
create or replace function app.incoming_on_order(p_location_id uuid, p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(app.to_inventory_qty(poi.product_id, poi.quantity, poi.unit_code))
                     from public.purchase_order_items poi join public.purchase_orders po on po.id = poi.purchase_order_id
                    where poi.product_id = p_product_id and po.location_id = p_location_id
                      and po.status in ('placed', 'partially_received')), 0)
       + coalesce((select sum(coalesce(ci.sent_quantity_inv, ci.quantity_inv))
                     from public.commissary_order_items ci join public.commissary_orders co on co.id = ci.order_id
                    where ci.product_id = p_product_id and co.location_id = p_location_id
                      and co.status in ('submitted', 'accepted', 'preparing', 'ready', 'in_transit')), 0)
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
           app.incoming_on_order(v_loc, i.product_id) as incoming_orders,
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

-- -----------------------------------------------------------------------------
-- RLS & grants
-- -----------------------------------------------------------------------------
alter table public.commissary_orders enable row level security;
alter table public.commissary_order_items enable row level security;
alter table public.commissary_order_events enable row level security;
alter table public.production_events enable row level security;
alter table public.production_items enable row level security;
revoke all on public.commissary_orders, public.commissary_order_items, public.commissary_order_events,
  public.production_events, public.production_items from anon, authenticated;

grant select on public.commissary_orders, public.commissary_order_items, public.commissary_order_events to authenticated;
create policy commissary_orders_select on public.commissary_orders for select to authenticated
  using ((select app.has_permission('commissary.manage')));
create policy commissary_order_items_select on public.commissary_order_items for select to authenticated
  using ((select app.has_permission('commissary.manage')));
create policy commissary_order_events_select on public.commissary_order_events for select to authenticated
  using ((select app.has_permission('commissary.manage')));

grant select on public.production_events, public.production_items to authenticated;
create policy production_events_select on public.production_events for select to authenticated
  using ((select app.has_permission('production.record')) or (select app.has_permission('inventory.view')));
create policy production_items_select on public.production_items for select to authenticated
  using ((select app.has_permission('production.record')) or (select app.has_permission('inventory.view')));

create trigger commissary_orders_audit_guard before delete on public.commissary_orders
  for each row execute function app.prevent_mutation();

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.save_commissary_order(jsonb), public.set_commissary_order_status(uuid, text, text),
  public.ship_commissary_order(uuid, jsonb), public.receive_commissary_order(uuid, jsonb), public.cancel_commissary_order(uuid, text),
  public.incoming_commissary_orders(), public.record_production(jsonb), public.last_production_template(uuid) from public, anon;
grant execute on function public.save_commissary_order(jsonb), public.set_commissary_order_status(uuid, text, text),
  public.ship_commissary_order(uuid, jsonb), public.receive_commissary_order(uuid, jsonb), public.cancel_commissary_order(uuid, text),
  public.incoming_commissary_orders(), public.record_production(jsonb), public.last_production_template(uuid) to authenticated;
