-- =============================================================================
-- 0005 RECEIVING, DELIVERY DISCREPANCIES, INVOICE DOCUMENTS, PURCHASE ORDERS
-- Receiving a delivery is ONE atomic database transaction:
--   receiving event + lines + inventory ledger rows + balances + average cost +
--   vendor price / price history + discrepancies + alerts + audit log.
-- Inventory increases ONLY by the quantity actually accepted (received_qty).
-- =============================================================================

-- Purchase orders (used by receiving now; the ordering workflow is phase 3).
create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number bigint generated always as identity unique,
  vendor_id uuid not null references public.vendors(id),
  location_id uuid not null references public.locations(id),
  status text not null default 'draft' check (status in ('draft', 'placed', 'partially_received', 'received', 'cancelled')),
  expected_delivery_date date,
  estimated_total numeric(14, 2),
  notes text,
  created_by uuid not null references public.account_profiles(id),
  created_at timestamptz not null default now(),
  placed_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger purchase_orders_touch before update on public.purchase_orders for each row execute function app.touch_updated_at();

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  unit_code text not null references public.units(code),
  suggested_qty numeric(16, 4),
  quantity numeric(16, 4) not null check (quantity > 0),
  unit_price numeric(14, 4),
  created_at timestamptz not null default now(),
  unique (purchase_order_id, product_id)
);

create table public.receiving_events (
  id uuid primary key default gen_random_uuid(),
  receipt_number bigint generated always as identity unique,
  vendor_id uuid not null references public.vendors(id),
  location_id uuid not null references public.locations(id),
  invoice_number text check (invoice_number is null or invoice_number ~ '^[A-Za-z0-9_./#-]{1,40}$'),
  delivery_date date not null,
  purchase_order_id uuid references public.purchase_orders(id),
  status text not null default 'received' check (status in ('received', 'reviewed')),
  has_discrepancies boolean not null default false,
  received_total numeric(14, 2) not null default 0,
  invoiced_total numeric(14, 2) not null default 0,
  credit_due_estimate numeric(14, 2) not null default 0,
  temperature_ok boolean,
  notes text check (notes is null or length(notes) <= 1000),
  account_id uuid not null references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  received_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.account_profiles(id),
  review_notes text,
  idempotency_key uuid unique,
  created_at timestamptz not null default now()
);
-- Duplicate invoice protection.
create unique index receiving_events_invoice_uq on public.receiving_events (vendor_id, upper(invoice_number))
  where invoice_number is not null;
create index receiving_events_date_idx on public.receiving_events (delivery_date desc);
create index receiving_events_employee_idx on public.receiving_events (employee_id, received_at desc);

create table public.receiving_items (
  id uuid primary key default gen_random_uuid(),
  receiving_event_id uuid not null references public.receiving_events(id),
  line_no integer not null,
  product_id uuid not null references public.products(id),
  unit_code text not null references public.units(code),
  ordered_qty numeric(16, 4) check (ordered_qty is null or ordered_qty >= 0),
  received_qty numeric(16, 4) not null check (received_qty >= 0),
  invoiced_qty numeric(16, 4) check (invoiced_qty is null or invoiced_qty >= 0),
  rejected_qty numeric(16, 4) not null default 0 check (rejected_qty >= 0),
  reject_reason text check (reject_reason is null or reject_reason in ('DAMAGED', 'TEMPERATURE', 'QUALITY', 'WRONG_ITEM', 'EXPIRED', 'OTHER')),
  issue_type text check (issue_type is null or issue_type in ('WRONG_ITEM', 'SUBSTITUTION', 'BACK_ORDER', 'DAMAGED_PRODUCT', 'TEMPERATURE_ISSUE')),
  unit_price numeric(14, 4) check (unit_price is null or unit_price >= 0),
  expected_price numeric(14, 4),
  received_qty_inv numeric(16, 4) not null,
  unit_cost_inv numeric(14, 4),
  received_value numeric(14, 2) not null default 0,
  invoiced_value numeric(14, 2),
  notes text check (notes is null or length(notes) <= 500),
  inventory_txn_id bigint references public.inventory_transactions(id),
  created_at timestamptz not null default now(),
  unique (receiving_event_id, line_no)
);
create index receiving_items_product_idx on public.receiving_items (product_id);

create type public.discrepancy_type as enum (
  'SHORT_SHIPMENT', 'OVER_SHIPMENT', 'WRONG_ITEM', 'DAMAGED_PRODUCT', 'REJECTED_PRODUCT',
  'MISSING_PRODUCT', 'INCORRECT_PRICE', 'INVOICE_QUANTITY_DIFFERENCE', 'TEMPERATURE_ISSUE',
  'SUBSTITUTION', 'BACK_ORDER');

create table public.delivery_discrepancies (
  id uuid primary key default gen_random_uuid(),
  receiving_event_id uuid not null references public.receiving_events(id),
  receiving_item_id uuid references public.receiving_items(id),
  discrepancy_type public.discrepancy_type not null,
  product_id uuid references public.products(id),
  quantity_difference numeric(16, 4),
  unit_code text references public.units(code),
  amount_estimate numeric(14, 2),
  description text not null,
  status text not null default 'open' check (status in ('open', 'credit_requested', 'resolved', 'dismissed')),
  resolution_notes text,
  resolved_by uuid references public.account_profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index delivery_discrepancies_open_idx on public.delivery_discrepancies (status, created_at desc);

create table public.invoice_documents (
  id uuid primary key default gen_random_uuid(),
  receiving_event_id uuid references public.receiving_events(id),
  vendor_id uuid references public.vendors(id),
  storage_bucket text not null default 'invoices',
  storage_path text not null unique,
  file_name text not null check (length(file_name) <= 200),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 15728640),
  upload_status text not null default 'pending' check (upload_status in ('pending', 'uploaded', 'failed')),
  -- Future OCR. Extracted values are suggestions only and are NEVER posted without human confirmation.
  ocr_status text not null default 'none' check (ocr_status in ('none', 'queued', 'extracted', 'confirmed', 'rejected')),
  ocr_extracted jsonb,
  ocr_confirmed_by uuid references public.account_profiles(id),
  ocr_confirmed_at timestamptz,
  account_id uuid not null references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  uploaded_at timestamptz not null default now()
);
create index invoice_documents_event_idx on public.invoice_documents (receiving_event_id);

-- -----------------------------------------------------------------------------
-- submit_receiving
-- p = { idempotency_key, vendor_id, invoice_number, delivery_date, purchase_order_id,
--       temperature_ok, notes,
--       lines: [{ product_id, unit_code, ordered_qty, received_qty, invoiced_qty,
--                 rejected_qty, reject_reason, issue_type, unit_price, notes }] }
-- -----------------------------------------------------------------------------
create or replace function public.submit_receiving(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.perform');
  v_key uuid := nullif(p ->> 'idempotency_key', '')::uuid;
  v_prior jsonb;
  v_vendor public.vendors;
  v_loc uuid := coalesce(nullif(p ->> 'location_id', '')::uuid, app.primary_location_id());
  v_event_id uuid;
  v_receipt_no bigint;
  v_line jsonb;
  v_line_no int := 0;
  v_prod public.products;
  v_unit text;
  v_factor numeric;
  v_ordered numeric; v_received numeric; v_invoiced numeric; v_rejected numeric; v_price numeric;
  v_received_inv numeric(16, 4);
  v_cost_inv numeric(14, 4);
  v_item_id uuid;
  v_txn public.inventory_transactions;
  v_vp public.vendor_products;
  v_order_factor numeric;
  v_new_vendor_price numeric(14, 4);
  v_pct numeric;
  v_expected numeric(14, 4);
  v_disc_count int := 0;
  v_disc_total numeric(14, 2) := 0;
  v_received_total numeric(14, 2) := 0;
  v_invoiced_total numeric(14, 2) := 0;
  v_invoice text := nullif(upper(trim(p ->> 'invoice_number')), '');
  v_date date := nullif(p ->> 'delivery_date', '')::date;
  v_txn_type public.inventory_txn_type;
  v_supply_loc uuid;
  v_existing record;
  v_threshold numeric := app.setting_numeric('alerts.price_increase_pct', 5);
  v_disc_desc text[] := '{}';
  v_result jsonb;
  v_po public.purchase_orders;
begin
  v_prior := app.idempotent_result(v_key, 'receiving.submit');
  if v_prior is not null then
    return v_prior;
  end if;

  select * into v_vendor from public.vendors where id = nullif(p ->> 'vendor_id', '')::uuid;
  if v_vendor.id is null or not v_vendor.is_active then
    perform app.fail('VALIDATION', 'Choose an active vendor.');
  end if;
  if v_date is null or v_date > (now() at time zone app.org_timezone())::date + 1
     or v_date < (now() at time zone app.org_timezone())::date - 60 then
    perform app.fail('VALIDATION', 'Delivery date must be within the last 60 days.');
  end if;
  if v_vendor.vendor_type = 'external' and v_invoice is null then
    perform app.fail('VALIDATION', 'Enter the invoice number from the ' || v_vendor.name || ' invoice.');
  end if;
  if v_invoice is not null and v_invoice !~ '^[A-Z0-9_./#-]{1,40}$' then
    perform app.fail('VALIDATION', 'Invoice number may contain letters, numbers and - / . # only.');
  end if;
  if coalesce(jsonb_typeof(p -> 'lines'), '') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then
    perform app.fail('VALIDATION', 'Add at least one item.');
  end if;
  if jsonb_array_length(p -> 'lines') > 200 then
    perform app.fail('VALIDATION', 'A delivery can have at most 200 lines.');
  end if;

  if v_invoice is not null then
    select re.receipt_number, re.received_at, coalesce(e.display_name, ap.display_name) as who
      into v_existing
      from public.receiving_events re
      join public.account_profiles ap on ap.id = re.account_id
      left join public.employees e on e.id = re.employee_id
     where re.vendor_id = v_vendor.id and upper(re.invoice_number) = v_invoice;
    if v_existing.receipt_number is not null then
      perform app.fail('DUPLICATE', v_vendor.name || ' invoice #' || v_invoice || ' was already received by ' ||
        v_existing.who || ' on ' || to_char(v_existing.received_at at time zone app.org_timezone(), 'Mon DD at HH12:MI AM') ||
        ' (receipt #' || v_existing.receipt_number || ').');
    end if;
  end if;

  if nullif(p ->> 'purchase_order_id', '') is not null then
    select * into v_po from public.purchase_orders where id = (p ->> 'purchase_order_id')::uuid;
    if v_po.id is null or v_po.vendor_id <> v_vendor.id then
      perform app.fail('VALIDATION', 'That purchase order does not belong to ' || v_vendor.name || '.');
    end if;
  end if;

  if v_vendor.vendor_type = 'commissary' then
    v_txn_type := 'COMMISSARY_RECEIPT';
    v_supply_loc := v_vendor.supplying_location_id;
  else
    v_txn_type := 'RECEIPT';
  end if;

  insert into public.receiving_events (vendor_id, location_id, invoice_number, delivery_date, purchase_order_id,
    temperature_ok, notes, account_id, employee_id, idempotency_key)
  values (v_vendor.id, v_loc, v_invoice, v_date, v_po.id,
    (p ->> 'temperature_ok')::boolean, nullif(trim(p ->> 'notes'), ''), v_actor.account_id, v_actor.employee_id, v_key)
  returning id, receipt_number into v_event_id, v_receipt_no;

  for v_line in select * from jsonb_array_elements(p -> 'lines') loop
    v_line_no := v_line_no + 1;
    select * into v_prod from public.products where id = nullif(v_line ->> 'product_id', '')::uuid;
    if v_prod.id is null or not v_prod.is_active then
      perform app.fail('VALIDATION', 'Line ' || v_line_no || ': choose an active product.');
    end if;
    v_unit := coalesce(nullif(v_line ->> 'unit_code', ''), v_prod.purchase_unit, v_prod.inventory_unit);
    v_factor := app.unit_factor_to_inventory(v_prod.id, v_unit);

    v_ordered := nullif(v_line ->> 'ordered_qty', '')::numeric;
    v_received := coalesce(nullif(v_line ->> 'received_qty', '')::numeric, 0);
    v_invoiced := nullif(v_line ->> 'invoiced_qty', '')::numeric;
    v_rejected := coalesce(nullif(v_line ->> 'rejected_qty', '')::numeric, 0);
    v_price := nullif(v_line ->> 'unit_price', '')::numeric;

    if v_received < 0 or v_rejected < 0 or coalesce(v_ordered, 0) < 0 or coalesce(v_invoiced, 0) < 0
       or v_received > 100000 or v_rejected > 100000 or coalesce(v_ordered, 0) > 100000 or coalesce(v_invoiced, 0) > 100000 then
      perform app.fail('VALIDATION', 'Line ' || v_line_no || ' (' || v_prod.name || '): quantities must be between 0 and 100,000.');
    end if;
    if v_received = 0 and v_rejected = 0 and coalesce(v_ordered, 0) = 0 and coalesce(v_invoiced, 0) = 0 then
      perform app.fail('VALIDATION', 'Line ' || v_line_no || ' (' || v_prod.name || '): enter a quantity.');
    end if;
    if v_price is not null and (v_price < 0 or v_price > 100000) then
      perform app.fail('VALIDATION', 'Line ' || v_line_no || ' (' || v_prod.name || '): price must be between 0 and 100,000.');
    end if;
    if v_rejected > 0 and nullif(v_line ->> 'reject_reason', '') is null then
      perform app.fail('VALIDATION', 'Line ' || v_line_no || ' (' || v_prod.name || '): choose why product was rejected.');
    end if;

    v_received_inv := round(v_received * v_factor, 4);
    v_cost_inv := case when v_price is not null then round(v_price / v_factor, 4) end;

    -- Expected price from the vendor item, expressed per the received unit.
    select * into v_vp from public.vendor_products where vendor_id = v_vendor.id and product_id = v_prod.id;
    v_expected := null;
    v_order_factor := null;
    if v_vp.id is not null then
      v_order_factor := app.unit_factor_to_inventory(v_prod.id, v_vp.order_unit);
      if v_vp.current_price is not null then
        v_expected := round(v_vp.current_price / v_order_factor * v_factor, 4);
      end if;
    end if;

    insert into public.receiving_items (receiving_event_id, line_no, product_id, unit_code, ordered_qty, received_qty,
      invoiced_qty, rejected_qty, reject_reason, issue_type, unit_price, expected_price, received_qty_inv, unit_cost_inv,
      received_value, invoiced_value, notes)
    values (v_event_id, v_line_no, v_prod.id, v_unit, v_ordered, v_received, v_invoiced, v_rejected,
      nullif(v_line ->> 'reject_reason', ''), nullif(v_line ->> 'issue_type', ''), v_price, v_expected,
      v_received_inv, v_cost_inv,
      round(v_received * coalesce(v_price, 0), 2),
      case when v_invoiced is not null and v_price is not null then round(v_invoiced * v_price, 2) end,
      nullif(trim(v_line ->> 'notes'), ''))
    returning id into v_item_id;

    v_received_total := v_received_total + round(v_received * coalesce(v_price, 0), 2);
    v_invoiced_total := v_invoiced_total + round(coalesce(v_invoiced, v_received) * coalesce(v_price, 0), 2);

    -- Inventory: only what was actually accepted.
    if v_received_inv > 0 then
      if v_supply_loc is not null then
        -- Internal supplier: product leaves the commissary's book inventory.
        v_txn := app.post_inventory_txn(v_actor, v_supply_loc, v_prod.id, 'COMMISSARY_TRANSFER', -v_received_inv,
          v_cost_inv, 'receiving_item', v_item_id::text, now(), null, 'Receipt #' || v_receipt_no, v_vendor.id);
        if v_cost_inv is null then
          v_cost_inv := v_txn.unit_cost;
          update public.receiving_items set unit_cost_inv = v_cost_inv where id = v_item_id;
        end if;
      end if;
      v_txn := app.post_inventory_txn(v_actor, v_loc, v_prod.id, v_txn_type, v_received_inv, v_cost_inv,
        'receiving_item', v_item_id::text, now(), null,
        coalesce(v_vendor.name || ' invoice #' || v_invoice, 'Receipt #' || v_receipt_no), v_vendor.id);
      update public.receiving_items set inventory_txn_id = v_txn.id where id = v_item_id;
    end if;

    -- Costs & price history (external vendors with a price).
    if v_cost_inv is not null and v_vendor.vendor_type = 'external' then
      update public.products set last_cost = v_cost_inv where id = v_prod.id;
      if v_vp.id is null then
        insert into public.vendor_products (vendor_id, product_id, order_unit, current_price, price_updated_at)
        values (v_vendor.id, v_prod.id, v_unit, v_price, now())
        returning * into v_vp;
        insert into public.price_history (vendor_id, product_id, unit_code, old_price, new_price, source, source_id, account_id, employee_id)
        values (v_vendor.id, v_prod.id, v_unit, null, v_price, 'receiving', v_item_id::text, v_actor.account_id, v_actor.employee_id);
      else
        -- Price per vendor order unit, computed from the invoice price without intermediate rounding.
        v_new_vendor_price := case when v_vp.order_unit = v_unit then v_price
                                   else round(v_price * v_order_factor / v_factor, 4) end;
        if v_vp.current_price is null or abs(v_new_vendor_price - v_vp.current_price) >= 0.005 then
          v_pct := case when v_vp.current_price > 0
                        then round((v_new_vendor_price - v_vp.current_price) / v_vp.current_price * 100, 4) end;
          insert into public.price_history (vendor_id, product_id, unit_code, old_price, new_price, change_amount, change_pct,
                                            source, source_id, account_id, employee_id)
          values (v_vendor.id, v_prod.id, v_vp.order_unit, v_vp.current_price, v_new_vendor_price,
                  v_new_vendor_price - v_vp.current_price, v_pct, 'receiving', v_item_id::text,
                  v_actor.account_id, v_actor.employee_id);
          update public.vendor_products set current_price = v_new_vendor_price, price_updated_at = now() where id = v_vp.id;
          if v_pct is not null and v_pct > v_threshold then
            perform app.raise_alert('PRICE_INCREASE', case when v_pct > v_threshold * 2 then 'critical' else 'warning' end::public.alert_severity,
              'Price increase: ' || v_vendor.name || ' ' || v_prod.name,
              v_prod.name || ' ' || app.fmt_money(v_vp.current_price) || ' → ' ||
                app.fmt_money(v_new_vendor_price) || ' per ' || v_vp.order_unit ||
                ' (+' || to_char(v_pct, 'FM9990.00') || '%)',
              'products', v_prod.id::text, '/inventory/products/' || v_prod.id,
              'price:' || v_vendor.id || ':' || v_prod.id || ':' || v_new_vendor_price,
              v_prod.id, v_vendor.id, v_loc,
              jsonb_build_object('old_price', v_vp.current_price, 'new_price', v_new_vendor_price, 'change_pct', v_pct));
          end if;
        end if;
      end if;
      if v_prod.primary_vendor_id is null or v_prod.primary_vendor_id = v_vendor.id then
        update public.products set current_cost = v_cost_inv where id = v_prod.id;
      end if;
    end if;

    -- Discrepancies
    if v_ordered is not null and v_ordered > 0 and v_received = 0 and v_rejected = 0 then
      insert into public.delivery_discrepancies (receiving_event_id, receiving_item_id, discrepancy_type, product_id,
        quantity_difference, unit_code, amount_estimate, description)
      values (v_event_id, v_item_id, 'MISSING_PRODUCT', v_prod.id, -v_ordered, v_unit,
        case when v_price is not null then round(v_ordered * v_price, 2) end,
        v_prod.name || ': ordered ' || trim(to_char(v_ordered, 'FM999999990.####')) || ' ' || v_unit || ', none delivered');
      v_disc_desc := v_disc_desc || ('MISSING ' || v_prod.name);
    elsif v_ordered is not null and v_received + v_rejected < v_ordered then
      insert into public.delivery_discrepancies (receiving_event_id, receiving_item_id, discrepancy_type, product_id,
        quantity_difference, unit_code, amount_estimate, description)
      values (v_event_id, v_item_id, 'SHORT_SHIPMENT', v_prod.id, (v_received + v_rejected) - v_ordered, v_unit,
        case when v_price is not null then round((v_ordered - v_received - v_rejected) * v_price, 2) end,
        v_prod.name || ': ordered ' || trim(to_char(v_ordered, 'FM999999990.####')) || ' ' || v_unit ||
          ', delivered ' || trim(to_char(v_received + v_rejected, 'FM999999990.####')));
      v_disc_desc := v_disc_desc || ('SHORT ' || v_prod.name);
    elsif v_ordered is not null and v_received + v_rejected > v_ordered then
      insert into public.delivery_discrepancies (receiving_event_id, receiving_item_id, discrepancy_type, product_id,
        quantity_difference, unit_code, amount_estimate, description)
      values (v_event_id, v_item_id, 'OVER_SHIPMENT', v_prod.id, (v_received + v_rejected) - v_ordered, v_unit,
        case when v_price is not null then round((v_received + v_rejected - v_ordered) * v_price, 2) end,
        v_prod.name || ': ordered ' || trim(to_char(v_ordered, 'FM999999990.####')) || ' ' || v_unit ||
          ', delivered ' || trim(to_char(v_received + v_rejected, 'FM999999990.####')));
      v_disc_desc := v_disc_desc || ('OVER ' || v_prod.name);
    end if;

    if v_rejected > 0 then
      insert into public.delivery_discrepancies (receiving_event_id, receiving_item_id, discrepancy_type, product_id,
        quantity_difference, unit_code, amount_estimate, description)
      values (v_event_id, v_item_id,
        case v_line ->> 'reject_reason' when 'DAMAGED' then 'DAMAGED_PRODUCT' when 'TEMPERATURE' then 'TEMPERATURE_ISSUE'
             when 'WRONG_ITEM' then 'WRONG_ITEM' else 'REJECTED_PRODUCT' end::public.discrepancy_type,
        v_prod.id, -v_rejected, v_unit,
        case when v_price is not null then round(v_rejected * v_price, 2) end,
        v_prod.name || ': rejected ' || trim(to_char(v_rejected, 'FM999999990.####')) || ' ' || v_unit ||
          ' (' || replace(lower(v_line ->> 'reject_reason'), '_', ' ') || ')');
      v_disc_desc := v_disc_desc || ('REJECTED ' || v_prod.name);
    end if;

    if v_invoiced is not null and v_invoiced <> v_received then
      insert into public.delivery_discrepancies (receiving_event_id, receiving_item_id, discrepancy_type, product_id,
        quantity_difference, unit_code, amount_estimate, description)
      values (v_event_id, v_item_id,
        'INVOICE_QUANTITY_DIFFERENCE', v_prod.id, v_invoiced - v_received, v_unit,
        case when v_price is not null then round((v_invoiced - v_received) * v_price, 2) end,
        v_prod.name || ': invoiced ' || trim(to_char(v_invoiced, 'FM999999990.####')) || ' ' || v_unit ||
          ', received ' || trim(to_char(v_received, 'FM999999990.####')) ||
          case when v_invoiced > v_received then ' — possible billing issue' else '' end);
      v_disc_desc := v_disc_desc || ('INVOICE QTY ' || v_prod.name);
    end if;

    if nullif(v_line ->> 'issue_type', '') is not null then
      insert into public.delivery_discrepancies (receiving_event_id, receiving_item_id, discrepancy_type, product_id,
        unit_code, description)
      values (v_event_id, v_item_id,
        (v_line ->> 'issue_type')::public.discrepancy_type, v_prod.id, v_unit,
        v_prod.name || ': ' || replace(lower(v_line ->> 'issue_type'), '_', ' ') ||
          coalesce(' — ' || nullif(trim(v_line ->> 'notes'), ''), ''));
      v_disc_desc := v_disc_desc || (replace(v_line ->> 'issue_type', '_', ' ') || ' ' || v_prod.name);
    end if;

    if v_prod.contract_cost is not null and v_cost_inv is not null and v_cost_inv > v_prod.contract_cost + 0.0001 then
      insert into public.delivery_discrepancies (receiving_event_id, receiving_item_id, discrepancy_type, product_id,
        quantity_difference, unit_code, amount_estimate, description)
      values (v_event_id, v_item_id,
        'INCORRECT_PRICE', v_prod.id, null, v_unit,
        round((v_cost_inv - v_prod.contract_cost) * round(coalesce(v_invoiced, v_received) * v_factor, 4), 2),
        v_prod.name || ': invoice price ' || app.fmt_money(v_price) || ' per ' || v_unit ||
          ' is above the contract cost');
      v_disc_desc := v_disc_desc || ('PRICE ' || v_prod.name);
    end if;
  end loop;

  -- Credit due = what we were billed for but did not accept, plus overcharges.
  -- (Short/missing/rejected amounts are the value of affected goods and are shown
  -- per discrepancy; they are not added here to avoid double counting.)
  select count(*), coalesce(sum(amount_estimate) filter (where discrepancy_type in ('INVOICE_QUANTITY_DIFFERENCE', 'INCORRECT_PRICE')
                                                          and amount_estimate > 0), 0)
    into v_disc_count, v_disc_total
    from public.delivery_discrepancies where receiving_event_id = v_event_id;

  update public.receiving_events
     set received_total = v_received_total, invoiced_total = v_invoiced_total,
         has_discrepancies = v_disc_count > 0, credit_due_estimate = v_disc_total
   where id = v_event_id;

  if v_po.id is not null then
    update public.purchase_orders set status = 'received' where id = v_po.id and status in ('placed', 'partially_received');
  end if;

  perform app.audit(v_actor, 'receiving.received', 'operations',
    app.actor_label(v_actor) || ' received ' || v_vendor.name || ' delivery' ||
      coalesce(' #' || v_invoice, '') || ' (' || v_line_no || ' item' || case when v_line_no = 1 then '' else 's' end ||
      case when v_disc_count > 0 then ', ' || v_disc_count || ' discrepanc' || case when v_disc_count = 1 then 'y' else 'ies' end else '' end || ')',
    'receiving_events', v_event_id::text, null, v_vendor.id, v_loc, null,
    jsonb_build_object('receipt_number', v_receipt_no, 'invoice_number', v_invoice, 'lines', v_line_no,
                       'received_total', v_received_total, 'discrepancies', v_disc_count));

  if v_disc_count > 0 then
    perform app.raise_alert('DELIVERY_DISCREPANCY', 'warning',
      'Delivery discrepancy: ' || v_vendor.name || coalesce(' invoice #' || v_invoice, ' receipt #' || v_receipt_no),
      array_to_string(v_disc_desc, '; ') ||
        case when v_disc_total > 0 then ' — possible credit due ' || app.fmt_money(v_disc_total) else '' end ||
        '. Received by ' || app.actor_label(v_actor) || '.',
      'receiving_events', v_event_id::text, '/receiving/' || v_event_id,
      'receiving:' || v_event_id, null, v_vendor.id, v_loc,
      jsonb_build_object('discrepancy_count', v_disc_count, 'credit_due_estimate', v_disc_total));
  end if;

  v_result := jsonb_build_object('receiving_event_id', v_event_id, 'receipt_number', v_receipt_no,
    'discrepancy_count', v_disc_count, 'credit_due_estimate', v_disc_total,
    'discrepancies', (select coalesce(jsonb_agg(jsonb_build_object('type', d.discrepancy_type, 'description', d.description,
                         'amount_estimate', d.amount_estimate) order by d.created_at), '[]'::jsonb)
                        from public.delivery_discrepancies d where d.receiving_event_id = v_event_id));
  perform app.idempotent_store(v_key, 'receiving.submit', v_result);
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Management review of deliveries and discrepancies
-- -----------------------------------------------------------------------------
create or replace function public.review_receiving(p_receiving_event_id uuid, p_notes text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.review');
  v_ev public.receiving_events;
  v_vendor text;
begin
  update public.receiving_events
     set status = 'reviewed', reviewed_at = now(), reviewed_by = v_actor.account_id,
         review_notes = nullif(trim(p_notes), '')
   where id = p_receiving_event_id and status = 'received'
  returning * into v_ev;
  if v_ev.id is null then
    perform app.fail('CONFLICT', 'This delivery was not found or is already reviewed.');
  end if;
  select name into v_vendor from public.vendors where id = v_ev.vendor_id;
  perform app.audit(v_actor, 'receiving.reviewed', 'operations',
    app.actor_label(v_actor) || ' reviewed ' || v_vendor || ' delivery' || coalesce(' #' || v_ev.invoice_number, ''),
    'receiving_events', v_ev.id::text, null, v_ev.vendor_id, v_ev.location_id);
end;
$$;

create or replace function public.resolve_discrepancy(p_discrepancy_id uuid, p_status text, p_notes text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.review');
  v_d public.delivery_discrepancies;
  v_open int;
begin
  if p_status not in ('credit_requested', 'resolved', 'dismissed', 'open') then
    perform app.fail('VALIDATION', 'Unknown status.');
  end if;
  if p_status in ('resolved', 'dismissed') and coalesce(length(trim(p_notes)), 0) < 3 then
    perform app.fail('VALIDATION', 'Add a short note describing the resolution.');
  end if;
  update public.delivery_discrepancies
     set status = p_status, resolution_notes = coalesce(nullif(trim(p_notes), ''), resolution_notes),
         resolved_by = case when p_status in ('resolved', 'dismissed') then v_actor.account_id end,
         resolved_at = case when p_status in ('resolved', 'dismissed') then now() end
   where id = p_discrepancy_id
  returning * into v_d;
  if v_d.id is null then
    perform app.fail('NOT_FOUND', 'Discrepancy not found.');
  end if;
  perform app.audit(v_actor, 'receiving.discrepancy_' || case p_status when 'credit_requested' then 'credit' else p_status end, 'operations',
    app.actor_label(v_actor) || ' marked discrepancy "' || v_d.description || '" ' || replace(p_status, '_', ' '),
    'delivery_discrepancies', v_d.id::text, v_d.product_id, null, null, null, null, p_notes);

  select count(*) into v_open from public.delivery_discrepancies
   where receiving_event_id = v_d.receiving_event_id and status in ('open', 'credit_requested');
  if v_open = 0 then
    update public.alerts set status = 'resolved', resolved_at = now(), resolved_by = v_actor.account_id
     where dedupe_key = 'receiving:' || v_d.receiving_event_id and status <> 'resolved';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Invoice photos/files. The web server calls register_invoice_document() (which
-- checks permission + employee identity and records attribution), uploads the
-- file to the private "invoices" bucket using the server-only key, then calls
-- mark_invoice_uploaded(). Viewing uses short-lived signed URLs issued by the
-- server after can_view_invoice_document() returns true.
-- -----------------------------------------------------------------------------
create or replace function public.register_invoice_document(
  p_receiving_event_id uuid, p_file_name text, p_mime_type text, p_size_bytes integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.perform');
  v_ev public.receiving_events;
  v_id uuid := gen_random_uuid();
  v_ext text;
  v_path text;
begin
  select * into v_ev from public.receiving_events where id = p_receiving_event_id;
  if v_ev.id is null then
    perform app.fail('NOT_FOUND', 'Delivery not found.');
  end if;
  -- The shared employee login may only attach invoices to deliveries from the last 2 days.
  if v_actor.account_role = 'employee' and v_ev.received_at < now() - interval '2 days' then
    perform app.fail('FORBIDDEN', 'Ask a manager to attach invoices to older deliveries.');
  end if;
  v_ext := case p_mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
                            when 'image/heic' then 'heic' when 'application/pdf' then 'pdf' end;
  if v_ext is null then
    perform app.fail('VALIDATION', 'Upload a photo (JPG, PNG, WEBP, HEIC) or a PDF.');
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 15728640 then
    perform app.fail('VALIDATION', 'Files must be smaller than 15 MB.');
  end if;
  v_path := to_char(v_ev.delivery_date, 'YYYY/MM') || '/' || v_ev.id || '/' || v_id || '.' || v_ext;
  insert into public.invoice_documents (id, receiving_event_id, vendor_id, storage_path, file_name, mime_type, size_bytes,
                                        account_id, employee_id)
  values (v_id, v_ev.id, v_ev.vendor_id, v_path, left(coalesce(nullif(trim(p_file_name), ''), 'invoice.' || v_ext), 200),
          p_mime_type, p_size_bytes, v_actor.account_id, v_actor.employee_id);
  perform app.audit(v_actor, 'receiving.invoice_uploaded', 'operations',
    app.actor_label(v_actor) || ' attached an invoice ' || case when p_mime_type like 'image/%' then 'photo' else 'file' end ||
      ' to receipt #' || v_ev.receipt_number,
    'invoice_documents', v_id::text, null, v_ev.vendor_id, v_ev.location_id);
  return jsonb_build_object('document_id', v_id, 'bucket', 'invoices', 'path', v_path);
end;
$$;

create or replace function public.mark_invoice_uploaded(p_document_id uuid, p_success boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.perform');
begin
  update public.invoice_documents
     set upload_status = case when p_success then 'uploaded' else 'failed' end
   where id = p_document_id and account_id = v_actor.account_id and upload_status = 'pending';
end;
$$;

create or replace function public.can_view_invoice_document(p_document_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_doc public.invoice_documents;
begin
  if not app.has_permission('receiving.review') then
    perform app.fail('FORBIDDEN', 'Not allowed to view invoices.');
  end if;
  select * into v_doc from public.invoice_documents where id = p_document_id and upload_status = 'uploaded';
  return v_doc.storage_path;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants: management reads receiving data; all writes via functions.
-- -----------------------------------------------------------------------------
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.receiving_events enable row level security;
alter table public.receiving_items enable row level security;
alter table public.delivery_discrepancies enable row level security;
alter table public.invoice_documents enable row level security;

revoke all on public.purchase_orders, public.purchase_order_items, public.receiving_events, public.receiving_items,
  public.delivery_discrepancies, public.invoice_documents from anon, authenticated;

grant select on public.purchase_orders, public.purchase_order_items to authenticated;
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using ((select app.has_permission('orders.manage')) or (select app.has_permission('receiving.review')));
create policy purchase_order_items_select on public.purchase_order_items for select to authenticated
  using ((select app.has_permission('orders.manage')) or (select app.has_permission('receiving.review')));

grant select on public.receiving_events, public.receiving_items, public.delivery_discrepancies, public.invoice_documents to authenticated;
create policy receiving_events_select on public.receiving_events for select to authenticated
  using ((select app.has_permission('receiving.review')));
create policy receiving_items_select on public.receiving_items for select to authenticated
  using ((select app.has_permission('receiving.review')));
create policy delivery_discrepancies_select on public.delivery_discrepancies for select to authenticated
  using ((select app.has_permission('receiving.review')));
create policy invoice_documents_select on public.invoice_documents for select to authenticated
  using ((select app.has_permission('receiving.review')));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.submit_receiving(jsonb), public.review_receiving(uuid, text),
  public.resolve_discrepancy(uuid, text, text), public.register_invoice_document(uuid, text, text, integer),
  public.mark_invoice_uploaded(uuid, boolean), public.can_view_invoice_document(uuid) from public, anon;
grant execute on function public.submit_receiving(jsonb), public.review_receiving(uuid, text),
  public.resolve_discrepancy(uuid, text, text), public.register_invoice_document(uuid, text, text, integer),
  public.mark_invoice_uploaded(uuid, boolean), public.can_view_invoice_document(uuid) to authenticated;
