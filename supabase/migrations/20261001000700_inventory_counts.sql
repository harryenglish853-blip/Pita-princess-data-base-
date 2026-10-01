-- =============================================================================
-- 0007 PHYSICAL INVENTORY COUNTS
-- Sessions -> sheet entries (one per product per storage area, in shelf order)
-- -> revisions (every save, idempotent by client_mutation_id for offline sync)
-- -> variances (book as of submission vs physical) -> recount flags -> approve
-- -> post (PHYSICAL_VARIANCE ledger rows). Original count data is never deleted.
-- =============================================================================

create table public.inventory_count_sessions (
  id uuid primary key default gen_random_uuid(),
  count_number bigint generated always as identity unique,
  location_id uuid not null references public.locations(id),
  count_type text not null check (count_type in ('weekly_full', 'daily_critical', 'cycle', 'location', 'category', 'custom', 'month_end')),
  name text not null check (length(trim(name)) between 1 and 80),
  status text not null default 'IN_PROGRESS' check (status in ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'AWAITING_REVIEW',
                                                                 'RECOUNT_REQUIRED', 'APPROVED', 'POSTED', 'CANCELLED')),
  scope jsonb not null default '{}'::jsonb,
  as_of timestamptz,
  started_at timestamptz not null default now(),
  started_by uuid not null references public.account_profiles(id),
  started_employee_id uuid references public.employees(id),
  submitted_at timestamptz,
  submitted_by uuid references public.account_profiles(id),
  approved_at timestamptz,
  approved_by uuid references public.account_profiles(id),
  posted_at timestamptz,
  posted_by uuid references public.account_profiles(id),
  cancelled_at timestamptz,
  cancelled_by uuid references public.account_profiles(id),
  cancel_reason text,
  book_value numeric(14, 2),
  physical_value numeric(14, 2),
  variance_value numeric(14, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index count_sessions_one_open_full_uq on public.inventory_count_sessions (location_id)
  where count_type in ('weekly_full', 'month_end')
    and status in ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'AWAITING_REVIEW', 'RECOUNT_REQUIRED', 'APPROVED');
create index count_sessions_status_idx on public.inventory_count_sessions (status, started_at desc);
create trigger count_sessions_touch before update on public.inventory_count_sessions
  for each row execute function app.touch_updated_at();

alter table public.location_products add column count_daily boolean not null default false;
comment on column public.location_products.count_daily is 'Included in the Daily Critical Count.';

create table public.inventory_count_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.inventory_count_sessions(id),
  product_id uuid not null references public.products(id),
  storage_location_id uuid references public.storage_locations(id),
  shelf_label text,
  sort_order integer not null,
  previous_qty numeric(16, 4),
  counted_qty numeric(16, 4) check (counted_qty is null or counted_qty >= 0),
  components jsonb not null default '[]'::jsonb,
  version integer not null default 0,
  counted_at timestamptz,
  counted_by uuid references public.account_profiles(id),
  counted_employee_id uuid references public.employees(id),
  last_device_id text,
  is_added boolean not null default false,
  created_at timestamptz not null default now(),
  constraint count_entries_unique unique nulls not distinct (session_id, product_id, storage_location_id)
);
create index count_entries_session_idx on public.inventory_count_entries (session_id, sort_order);

create table public.inventory_count_revisions (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.inventory_count_entries(id),
  session_id uuid not null references public.inventory_count_sessions(id),
  old_qty numeric(16, 4),
  new_qty numeric(16, 4),
  components jsonb not null,
  account_id uuid not null references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  device_id text,
  client_mutation_id uuid not null unique,
  source text not null default 'online' check (source in ('online', 'offline_sync')),
  client_recorded_at timestamptz,
  created_at timestamptz not null default now()
);
create index count_revisions_entry_idx on public.inventory_count_revisions (entry_id, id);
create trigger count_revisions_immutable before update or delete on public.inventory_count_revisions
  for each row execute function app.prevent_mutation();

create table public.inventory_variances (
  session_id uuid not null references public.inventory_count_sessions(id),
  product_id uuid not null references public.products(id),
  book_qty numeric(16, 4) not null,
  physical_qty numeric(16, 4) not null,
  variance_qty numeric(16, 4) not null,
  variance_pct numeric(12, 2),
  unit_cost numeric(14, 4) not null,
  book_value numeric(14, 2) not null,
  physical_value numeric(14, 2) not null,
  variance_value numeric(14, 2) not null,
  recount_required boolean not null default false,
  recount_verified_at timestamptz,
  recount_verified_by uuid references public.account_profiles(id),
  recount_note text,
  posted_txn_id bigint references public.inventory_transactions(id),
  updated_at timestamptz not null default now(),
  primary key (session_id, product_id)
);

-- Entries of finished counts can never change (defense in depth beyond the functions).
create or replace function app.guard_count_entries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.inventory_count_sessions
              where id = coalesce(new.session_id, old.session_id)
                and status in ('APPROVED', 'POSTED', 'CANCELLED')) then
    raise exception 'LOCKED: this count is % and can no longer change', (
      select lower(status) from public.inventory_count_sessions where id = coalesce(new.session_id, old.session_id))
      using errcode = 'PT409';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: count entries cannot be deleted' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
create trigger count_entries_guard before update or delete on public.inventory_count_entries
  for each row execute function app.guard_count_entries();

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function app.book_qty_as_of(p_location_id uuid, p_product_id uuid, p_as_of timestamptz)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity), 0)
    from public.inventory_transactions
   where location_id = p_location_id and product_id = p_product_id and occurred_at <= p_as_of
$$;

-- Recalculate one product's variance row (book qty stays as of submission).
create or replace function app.refresh_variance(p_session_id uuid, p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_var public.inventory_variances;
  v_phys numeric(16, 4);
  v_vq numeric(16, 4);
  v_pct numeric(12, 2);
  v_val numeric(14, 2);
  v_req boolean;
begin
  select * into v_var from public.inventory_variances where session_id = p_session_id and product_id = p_product_id for update;
  if v_var.session_id is null then
    return;
  end if;
  select coalesce(sum(counted_qty), 0) into v_phys
    from public.inventory_count_entries where session_id = p_session_id and product_id = p_product_id;
  v_vq := v_phys - v_var.book_qty;
  v_pct := case when v_var.book_qty <> 0 then round(v_vq / abs(v_var.book_qty) * 100, 2) end;
  v_val := round(v_vq * v_var.unit_cost, 2);
  v_req := abs(v_val) > app.setting_numeric('counts.recount_variance_value', 50)
        or (v_pct is not null and abs(v_pct) > app.setting_numeric('counts.recount_variance_pct', 10));
  update public.inventory_variances
     set physical_qty = v_phys, variance_qty = v_vq, variance_pct = v_pct,
         physical_value = round(v_phys * unit_cost, 2), variance_value = v_val,
         recount_required = v_req,
         -- a changed physical quantity needs a fresh verification
         recount_verified_at = case when v_phys = v_var.physical_qty then recount_verified_at end,
         recount_verified_by = case when v_phys = v_var.physical_qty then recount_verified_by end,
         updated_at = now()
   where session_id = p_session_id and product_id = p_product_id;
end;
$$;

-- Session status during review + totals.
create or replace function app.refresh_count_review_status(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select case when exists (select 1 from public.inventory_variances
                            where session_id = p_session_id and recount_required and recount_verified_at is null)
              then 'RECOUNT_REQUIRED' else 'AWAITING_REVIEW' end
    into v_status;
  update public.inventory_count_sessions s
     set status = v_status,
         book_value = t.book_value, physical_value = t.physical_value, variance_value = t.variance_value
    from (select coalesce(sum(book_value), 0) as book_value, coalesce(sum(physical_value), 0) as physical_value,
                 coalesce(sum(variance_value), 0) as variance_value
            from public.inventory_variances where session_id = p_session_id) t
   where s.id = p_session_id and s.status in ('AWAITING_REVIEW', 'RECOUNT_REQUIRED');
  return v_status;
end;
$$;

-- -----------------------------------------------------------------------------
-- Start a count. p = { count_type, name, location_id, storage_location_ids[], category_ids[], product_ids[] }
-- -----------------------------------------------------------------------------
create or replace function public.start_count(p jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.perform');
  v_type text := p ->> 'count_type';
  v_loc uuid := coalesce(nullif(p ->> 'location_id', '')::uuid, app.primary_location_id());
  v_id uuid;
  v_no bigint;
  v_storage uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p -> 'storage_location_ids') x), '{}');
  v_cats uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p -> 'category_ids') x), '{}');
  v_prods uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p -> 'product_ids') x), '{}');
  v_name text;
  v_n int;
begin
  if v_type not in ('weekly_full', 'daily_critical', 'cycle', 'location', 'category', 'custom', 'month_end') then
    perform app.fail('VALIDATION', 'Choose a count type.');
  end if;
  if v_type = 'location' and cardinality(v_storage) = 0 then
    perform app.fail('VALIDATION', 'Choose at least one storage area to count.');
  end if;
  if v_type = 'category' and cardinality(v_cats) = 0 then
    perform app.fail('VALIDATION', 'Choose at least one category to count.');
  end if;
  if v_type in ('cycle', 'custom') and cardinality(v_prods) = 0 then
    perform app.fail('VALIDATION', 'Choose the products to count.');
  end if;
  if v_type in ('weekly_full', 'month_end') and exists (
       select 1 from public.inventory_count_sessions
        where location_id = v_loc and count_type in ('weekly_full', 'month_end')
          and status in ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'AWAITING_REVIEW', 'RECOUNT_REQUIRED', 'APPROVED')) then
    perform app.fail('CONFLICT', 'A full inventory is already open. Continue or finish it first.');
  end if;

  v_name := coalesce(nullif(trim(p ->> 'name'), ''),
    case v_type when 'weekly_full' then 'Weekly inventory' when 'month_end' then 'Month-end inventory'
                when 'daily_critical' then 'Daily critical count' when 'cycle' then 'Cycle count'
                when 'location' then 'Storage area count' when 'category' then 'Category count' else 'Custom count' end
    || ' — ' || to_char(now() at time zone app.org_timezone(), 'Mon DD'));

  insert into public.inventory_count_sessions (location_id, count_type, name, status, scope, started_by, started_employee_id)
  values (v_loc, v_type, v_name, 'IN_PROGRESS',
          jsonb_build_object('storage_location_ids', v_storage, 'category_ids', v_cats, 'product_ids', v_prods),
          v_actor.account_id, v_actor.employee_id)
  returning id, count_number into v_id, v_no;

  with scope_products as (
    select pr.id as product_id
      from public.products pr
      join public.location_products lp on lp.product_id = pr.id and lp.location_id = v_loc and lp.is_stocked
     where pr.is_active
       and case v_type
             when 'daily_critical' then lp.count_daily
             when 'category' then pr.category_id = any (v_cats)
             when 'cycle' then pr.id = any (v_prods)
             when 'custom' then pr.id = any (v_prods)
             when 'location' then exists (select 1 from public.product_storage_locations psl
                                           where psl.product_id = pr.id and psl.storage_location_id = any (v_storage))
             else true
           end
  ),
  sheet as (
    select sp.product_id, psl.storage_location_id, psl.shelf_label,
           coalesce(sl.sort_order, 100000) as area_order, coalesce(psl.sort_order, 100000) as item_order
      from scope_products sp
      left join public.product_storage_locations psl
        on psl.product_id = sp.product_id
       and psl.storage_location_id in (select id from public.storage_locations where location_id = v_loc and is_active)
       and (v_type <> 'location' or psl.storage_location_id = any (v_storage))
      left join public.storage_locations sl on sl.id = psl.storage_location_id
  ),
  previous as (
    select distinct on (e.product_id, e.storage_location_id) e.product_id, e.storage_location_id, e.counted_qty
      from public.inventory_count_entries e
      join public.inventory_count_sessions s on s.id = e.session_id
     where s.location_id = v_loc and s.status = 'POSTED' and e.counted_qty is not null
     order by e.product_id, e.storage_location_id, s.posted_at desc
  )
  insert into public.inventory_count_entries (session_id, product_id, storage_location_id, shelf_label, sort_order, previous_qty)
  select v_id, sh.product_id, sh.storage_location_id, sh.shelf_label,
         row_number() over (order by sh.area_order, (select name from public.storage_locations where id = sh.storage_location_id),
                                     sh.item_order, (select name from public.products where id = sh.product_id)),
         pv.counted_qty
    from sheet sh
    left join previous pv on pv.product_id = sh.product_id
                         and pv.storage_location_id is not distinct from sh.storage_location_id;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform app.fail('VALIDATION', 'No stocked products match this count. Check product stocking and storage areas.');
  end if;

  perform app.audit(v_actor, 'counts.started', 'inventory',
    app.actor_label(v_actor) || ' started ' || v_name || ' (#' || v_no || ', ' || v_n || ' lines)',
    'inventory_count_sessions', v_id::text, null, null, v_loc);
  return v_id;
end;
$$;

-- Full sheet for counting (also cached on the device for offline counting).
create or replace function public.get_count_sheet(p_session_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.perform');
  v_s public.inventory_count_sessions;
begin
  select * into v_s from public.inventory_count_sessions where id = p_session_id;
  if v_s.id is null then
    perform app.fail('NOT_FOUND', 'Count not found.');
  end if;
  return jsonb_build_object(
    'session', jsonb_build_object('id', v_s.id, 'count_number', v_s.count_number, 'name', v_s.name,
                 'count_type', v_s.count_type, 'status', v_s.status, 'started_at', v_s.started_at,
                 'as_of', v_s.as_of, 'location_id', v_s.location_id),
    'units', (select jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'kind', u.kind, 'base_factor', u.base_factor)
                               order by u.sort_order) from public.units u),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
         'id', e.id, 'product_id', e.product_id, 'product_name', p.name, 'item_code', p.item_code,
         'inventory_unit', p.inventory_unit, 'purchase_unit', p.purchase_unit,
         'storage_location_id', e.storage_location_id, 'storage_name', coalesce(sl.name, 'No storage area'),
         'shelf_label', e.shelf_label, 'sort_order', e.sort_order, 'previous_qty', e.previous_qty,
         'counted_qty', e.counted_qty, 'components', e.components, 'version', e.version,
         'counted_at', e.counted_at, 'is_added', e.is_added,
         'conversions', (select coalesce(jsonb_object_agg(pc.unit_code, pc.inventory_units_per_unit), '{}'::jsonb)
                           from public.product_unit_conversions pc where pc.product_id = p.id))
         order by e.sort_order), '[]'::jsonb)
       from public.inventory_count_entries e
       join public.products p on p.id = e.product_id
       left join public.storage_locations sl on sl.id = e.storage_location_id
      where e.session_id = v_s.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Save one count line. Never raises for sync conditions; returns a status:
--   saved | duplicate (mutation already applied) | conflict (someone else changed it) | locked
-- p_components: [{ "qty": 1, "unit": "CASE" }, { "qty": 8.5, "unit": "LB" }]  ([] clears)
-- -----------------------------------------------------------------------------
create or replace function public.save_count_entry(
  p_entry_id uuid, p_components jsonb, p_base_version integer, p_device_id text,
  p_client_mutation_id uuid, p_client_recorded_at timestamptz default null, p_source text default 'online')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.perform');
  v_e public.inventory_count_entries;
  v_status text;
  v_comp jsonb;
  v_total numeric := 0;
  v_qty numeric;
  v_new numeric(16, 4);
  v_prod public.products;
  v_session_status text;
begin
  if p_client_mutation_id is null then
    perform app.fail('VALIDATION', 'Missing mutation id.');
  end if;
  if p_source not in ('online', 'offline_sync') then
    perform app.fail('VALIDATION', 'Unknown source.');
  end if;

  select * into v_e from public.inventory_count_entries where id = p_entry_id for update;
  if v_e.id is null then
    perform app.fail('NOT_FOUND', 'Count line not found.');
  end if;
  select status into v_status from public.inventory_count_sessions where id = v_e.session_id for update;

  if exists (select 1 from public.inventory_count_revisions where client_mutation_id = p_client_mutation_id) then
    return jsonb_build_object('status', 'duplicate', 'entry', jsonb_build_object('id', v_e.id, 'version', v_e.version,
             'counted_qty', v_e.counted_qty, 'components', v_e.components));
  end if;

  if v_status not in ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'AWAITING_REVIEW', 'RECOUNT_REQUIRED') then
    return jsonb_build_object('status', 'locked', 'session_status', v_status,
             'entry', jsonb_build_object('id', v_e.id, 'version', v_e.version, 'counted_qty', v_e.counted_qty,
                                         'components', v_e.components));
  end if;

  if p_base_version is distinct from v_e.version and v_e.last_device_id is distinct from p_device_id then
    return jsonb_build_object('status', 'conflict',
             'entry', jsonb_build_object('id', v_e.id, 'version', v_e.version, 'counted_qty', v_e.counted_qty,
                                         'components', v_e.components, 'counted_at', v_e.counted_at,
                                         'counted_by', (select display_name from public.account_profiles where id = v_e.counted_by)));
  end if;

  if coalesce(jsonb_typeof(p_components), '') <> 'array' or jsonb_array_length(p_components) > 6 then
    perform app.fail('VALIDATION', 'Invalid count entry.');
  end if;
  select * into v_prod from public.products where id = v_e.product_id;
  for v_comp in select * from jsonb_array_elements(p_components) loop
    begin
      v_qty := (v_comp ->> 'qty')::numeric;
    exception when others then
      perform app.fail('VALIDATION', v_prod.name || ': quantities must be numbers.');
    end;
    if v_qty is null or v_qty < 0 or v_qty > 100000 then
      perform app.fail('VALIDATION', v_prod.name || ': quantities must be between 0 and 100,000.');
    end if;
    v_total := v_total + v_qty * app.unit_factor_to_inventory(v_prod.id, v_comp ->> 'unit');
  end loop;
  v_new := case when jsonb_array_length(p_components) = 0 then null else round(v_total, 4) end;

  update public.inventory_count_entries
     set counted_qty = v_new, components = p_components, version = version + 1,
         counted_at = case when v_new is null then null else now() end,
         counted_by = v_actor.account_id, counted_employee_id = v_actor.employee_id, last_device_id = p_device_id
   where id = v_e.id;

  insert into public.inventory_count_revisions (entry_id, session_id, old_qty, new_qty, components, account_id, employee_id,
    device_id, client_mutation_id, source, client_recorded_at)
  values (v_e.id, v_e.session_id, v_e.counted_qty, v_new, p_components, v_actor.account_id, v_actor.employee_id,
    p_device_id, p_client_mutation_id, p_source, p_client_recorded_at);

  if v_status in ('NOT_STARTED', 'PAUSED') then
    update public.inventory_count_sessions set status = 'IN_PROGRESS' where id = v_e.session_id;
  elsif v_status in ('AWAITING_REVIEW', 'RECOUNT_REQUIRED') then
    perform app.refresh_variance(v_e.session_id, v_e.product_id);
    v_session_status := app.refresh_count_review_status(v_e.session_id);
    if v_e.counted_qty is distinct from v_new then
      perform app.audit(v_actor, 'counts.recounted', 'inventory',
        app.actor_label(v_actor) || ' changed ' || v_prod.name || ' count from ' ||
          coalesce(trim(to_char(v_e.counted_qty, 'FM999999990.####')), 'blank') || ' to ' ||
          coalesce(trim(to_char(v_new, 'FM999999990.####')), 'blank') || ' ' || v_prod.inventory_unit,
        'inventory_count_entries', v_e.id::text, v_prod.id, null, null,
        jsonb_build_object('counted_qty', v_e.counted_qty), jsonb_build_object('counted_qty', v_new));
    end if;
  end if;

  return jsonb_build_object('status', 'saved', 'session_status', coalesce(v_session_status, case when v_status in ('NOT_STARTED', 'PAUSED') then 'IN_PROGRESS' else v_status end),
           'entry', jsonb_build_object('id', v_e.id, 'version', v_e.version + 1, 'counted_qty', v_new, 'components', p_components));
end;
$$;

-- Add a product found during the count that is not on the sheet.
create or replace function public.add_count_entry(p_session_id uuid, p_product_id uuid, p_storage_location_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.perform');
  v_s public.inventory_count_sessions;
  v_id uuid;
  v_name text;
begin
  select * into v_s from public.inventory_count_sessions where id = p_session_id for update;
  if v_s.id is null then
    perform app.fail('NOT_FOUND', 'Count not found.');
  end if;
  if v_s.status not in ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED') then
    perform app.fail('CONFLICT', 'Items can only be added while counting.');
  end if;
  select name into v_name from public.products where id = p_product_id and is_active;
  if v_name is null then
    perform app.fail('VALIDATION', 'Choose an active product.');
  end if;
  if p_storage_location_id is not null and not exists (
      select 1 from public.storage_locations where id = p_storage_location_id and location_id = v_s.location_id) then
    perform app.fail('VALIDATION', 'Choose a storage area in this location.');
  end if;
  select id into v_id from public.inventory_count_entries
   where session_id = p_session_id and product_id = p_product_id
     and storage_location_id is not distinct from p_storage_location_id;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.inventory_count_entries (session_id, product_id, storage_location_id, sort_order, is_added)
  values (p_session_id, p_product_id, p_storage_location_id,
          (select coalesce(max(sort_order), 0) + 1 from public.inventory_count_entries where session_id = p_session_id), true)
  returning id into v_id;
  insert into public.location_products (location_id, product_id) values (v_s.location_id, p_product_id) on conflict do nothing;
  perform app.audit(v_actor, 'counts.item_added', 'inventory',
    app.actor_label(v_actor) || ' added ' || v_name || ' to count #' || v_s.count_number,
    'inventory_count_entries', v_id::text, p_product_id, null, v_s.location_id);
  return v_id;
end;
$$;

create or replace function public.pause_count(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.perform');
  v_s public.inventory_count_sessions;
begin
  update public.inventory_count_sessions set status = 'PAUSED'
   where id = p_session_id and status in ('IN_PROGRESS', 'NOT_STARTED')
  returning * into v_s;
  if v_s.id is null then
    perform app.fail('CONFLICT', 'Only a count in progress can be paused.');
  end if;
  perform app.audit(v_actor, 'counts.paused', 'inventory', app.actor_label(v_actor) || ' paused ' || v_s.name,
    'inventory_count_sessions', v_s.id::text, null, null, v_s.location_id);
end;
$$;

-- Finish counting -> compute book vs physical and recount flags.
create or replace function public.submit_count(p_session_id uuid, p_uncounted_as_zero boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.perform');
  v_s public.inventory_count_sessions;
  v_uncounted int;
  v_as_of timestamptz := now();
  v_status text;
  v_prod record;
  v_flagged int;
begin
  select * into v_s from public.inventory_count_sessions where id = p_session_id for update;
  if v_s.id is null then
    perform app.fail('NOT_FOUND', 'Count not found.');
  end if;
  if v_s.status not in ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED') then
    perform app.fail('CONFLICT', 'This count was already submitted.');
  end if;
  select count(*) into v_uncounted from public.inventory_count_entries where session_id = v_s.id and counted_qty is null;
  if v_uncounted > 0 and not coalesce(p_uncounted_as_zero, false) then
    return jsonb_build_object('status', 'uncounted', 'uncounted', v_uncounted);
  end if;
  if v_uncounted > 0 then
    -- Explicit manager decision: blank lines are counted as zero. Recorded as revisions.
    insert into public.inventory_count_revisions (entry_id, session_id, old_qty, new_qty, components, account_id,
      employee_id, client_mutation_id, source)
    select e.id, e.session_id, null, 0, '[]'::jsonb, v_actor.account_id, v_actor.employee_id, gen_random_uuid(), 'online'
      from public.inventory_count_entries e where e.session_id = v_s.id and e.counted_qty is null;
    update public.inventory_count_entries
       set counted_qty = 0, counted_at = now(), counted_by = v_actor.account_id,
           counted_employee_id = v_actor.employee_id, version = version + 1
     where session_id = v_s.id and counted_qty is null;
  end if;

  for v_prod in
    select e.product_id, sum(e.counted_qty) as physical,
           app.book_qty_as_of(v_s.location_id, e.product_id, v_as_of) as book,
           coalesce(b.avg_cost, p.current_cost, 0) as unit_cost
      from public.inventory_count_entries e
      join public.products p on p.id = e.product_id
      left join public.inventory_balances b on b.location_id = v_s.location_id and b.product_id = e.product_id
     where e.session_id = v_s.id
     group by e.product_id, b.avg_cost, p.current_cost
  loop
    insert into public.inventory_variances (session_id, product_id, book_qty, physical_qty, variance_qty, unit_cost,
      book_value, physical_value, variance_value)
    values (v_s.id, v_prod.product_id, v_prod.book, v_prod.physical, v_prod.physical - v_prod.book, round(v_prod.unit_cost, 4),
      round(v_prod.book * v_prod.unit_cost, 2), round(v_prod.physical * v_prod.unit_cost, 2),
      round((v_prod.physical - v_prod.book) * v_prod.unit_cost, 2))
    on conflict (session_id, product_id) do nothing;
    perform app.refresh_variance(v_s.id, v_prod.product_id);
  end loop;

  update public.inventory_count_sessions
     set status = 'AWAITING_REVIEW', as_of = v_as_of, submitted_at = now(), submitted_by = v_actor.account_id
   where id = v_s.id;
  v_status := app.refresh_count_review_status(v_s.id);
  select count(*) into v_flagged from public.inventory_variances where session_id = v_s.id and recount_required;

  perform app.audit(v_actor, 'counts.submitted', 'inventory',
    app.actor_label(v_actor) || ' finished counting ' || v_s.name ||
      case when v_flagged > 0 then ' — ' || v_flagged || ' item(s) need a recount' else '' end,
    'inventory_count_sessions', v_s.id::text, null, null, v_s.location_id, null,
    jsonb_build_object('uncounted_set_to_zero', v_uncounted, 'recount_required', v_flagged));

  return jsonb_build_object('status', v_status, 'recount_required', v_flagged);
end;
$$;

create or replace function public.verify_recount(p_session_id uuid, p_product_id uuid, p_note text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.perform');
  v_v public.inventory_variances;
  v_name text;
begin
  if not exists (select 1 from public.inventory_count_sessions where id = p_session_id and status in ('RECOUNT_REQUIRED', 'AWAITING_REVIEW')) then
    perform app.fail('CONFLICT', 'This count is not in review.');
  end if;
  update public.inventory_variances
     set recount_verified_at = now(), recount_verified_by = v_actor.account_id, recount_note = nullif(trim(p_note), '')
   where session_id = p_session_id and product_id = p_product_id and recount_required
  returning * into v_v;
  if v_v.session_id is null then
    perform app.fail('NOT_FOUND', 'That item does not need a recount.');
  end if;
  select name into v_name from public.products where id = p_product_id;
  perform app.audit(v_actor, 'counts.recount_verified', 'inventory',
    app.actor_label(v_actor) || ' verified the recount of ' || v_name || ' (variance ' ||
      trim(to_char(v_v.variance_qty, 'FM999999990.####')) || ', ' || app.fmt_money(v_v.variance_value) || ')',
    'inventory_variances', p_session_id::text, p_product_id, null, null, null, null, p_note);
  return app.refresh_count_review_status(p_session_id);
end;
$$;

create or replace function public.approve_count(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.post');
  v_s public.inventory_count_sessions;
begin
  select * into v_s from public.inventory_count_sessions where id = p_session_id for update;
  if v_s.id is null then
    perform app.fail('NOT_FOUND', 'Count not found.');
  end if;
  if v_s.status = 'RECOUNT_REQUIRED' then
    perform app.fail('CONFLICT', 'Recount or verify every flagged item before approving.');
  end if;
  if v_s.status <> 'AWAITING_REVIEW' then
    perform app.fail('CONFLICT', 'Only a count awaiting review can be approved.');
  end if;
  update public.inventory_count_sessions set status = 'APPROVED', approved_at = now(), approved_by = v_actor.account_id
   where id = v_s.id;
  perform app.audit(v_actor, 'counts.approved', 'inventory', app.actor_label(v_actor) || ' approved ' || v_s.name,
    'inventory_count_sessions', v_s.id::text, null, null, v_s.location_id);
end;
$$;

-- POST INVENTORY: lock the count and write PHYSICAL_VARIANCE ledger rows.
-- If book inventory as of the count time changed since submission (e.g. a
-- back-dated receipt), the variances are refreshed and the count goes back to
-- review instead of posting stale numbers.
create or replace function public.post_count(p_session_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.post');
  v_s public.inventory_count_sessions;
  v_v record;
  v_book numeric;
  v_changed int := 0;
  v_txn public.inventory_transactions;
  v_posted int := 0;
  v_status text;
begin
  select * into v_s from public.inventory_count_sessions where id = p_session_id for update;
  if v_s.id is null then
    perform app.fail('NOT_FOUND', 'Count not found.');
  end if;
  if v_s.status = 'POSTED' then
    return jsonb_build_object('status', 'already_posted');
  end if;
  if v_s.status <> 'APPROVED' then
    perform app.fail('CONFLICT', 'Approve the count before posting.');
  end if;

  for v_v in select * from public.inventory_variances where session_id = v_s.id for update loop
    v_book := app.book_qty_as_of(v_s.location_id, v_v.product_id, v_s.as_of);
    if v_book <> v_v.book_qty then
      update public.inventory_variances
         set book_qty = v_book, book_value = round(v_book * unit_cost, 2)
       where session_id = v_s.id and product_id = v_v.product_id;
      perform app.refresh_variance(v_s.id, v_v.product_id);
      v_changed := v_changed + 1;
    end if;
  end loop;
  if v_changed > 0 then
    update public.inventory_count_sessions set status = 'AWAITING_REVIEW', approved_at = null, approved_by = null
     where id = v_s.id;
    v_status := app.refresh_count_review_status(v_s.id);
    return jsonb_build_object('status', 'book_changed', 'changed', v_changed, 'session_status', v_status);
  end if;

  for v_v in select v.*, p.name from public.inventory_variances v join public.products p on p.id = v.product_id
              where v.session_id = v_s.id loop
    if v_v.variance_qty <> 0 then
      v_txn := app.post_inventory_txn(v_actor, v_s.location_id, v_v.product_id, 'PHYSICAL_VARIANCE', v_v.variance_qty,
        v_v.unit_cost, 'count_variance', v_s.id::text, v_s.as_of, null, 'Count #' || v_s.count_number);
      update public.inventory_variances set posted_txn_id = v_txn.id where session_id = v_s.id and product_id = v_v.product_id;
      v_posted := v_posted + 1;
    end if;
    update public.inventory_balances set last_counted_at = v_s.as_of
     where location_id = v_s.location_id and product_id = v_v.product_id;
  end loop;

  update public.inventory_count_sessions set status = 'POSTED', posted_at = now(), posted_by = v_actor.account_id
   where id = v_s.id;

  perform app.audit(v_actor, 'counts.posted', 'inventory',
    app.actor_label(v_actor) || ' posted ' || v_s.name || ' (' || v_posted || ' adjustment(s), variance ' ||
      app.fmt_money(coalesce(v_s.variance_value, 0)) || ')',
    'inventory_count_sessions', v_s.id::text, null, null, v_s.location_id, null,
    jsonb_build_object('book_value', v_s.book_value, 'physical_value', v_s.physical_value,
                       'variance_value', v_s.variance_value, 'adjustments', v_posted));

  -- Large total variance goes to the attention center.
  if abs(coalesce(v_s.variance_value, 0)) > app.setting_numeric('counts.recount_variance_value', 50) * 4 then
    perform app.raise_alert('HIGH_INVENTORY_VARIANCE', 'warning', 'Inventory variance: ' || v_s.name,
      'Posted inventory variance of ' || app.fmt_money(v_s.variance_value) || '.',
      'inventory_count_sessions', v_s.id::text, '/counts/' || v_s.id, 'count:' || v_s.id, null, null, v_s.location_id);
  end if;
  return jsonb_build_object('status', 'posted', 'adjustments', v_posted);
end;
$$;

create or replace function public.cancel_count(p_session_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('counts.post');
  v_s public.inventory_count_sessions;
begin
  if coalesce(length(trim(p_reason)), 0) < 3 then
    perform app.fail('VALIDATION', 'Give a reason for cancelling the count.');
  end if;
  update public.inventory_count_sessions
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by = v_actor.account_id, cancel_reason = trim(p_reason)
   where id = p_session_id and status not in ('POSTED', 'CANCELLED')
  returning * into v_s;
  if v_s.id is null then
    perform app.fail('CONFLICT', 'Posted or cancelled counts cannot be cancelled.');
  end if;
  perform app.audit(v_actor, 'counts.cancelled', 'inventory', app.actor_label(v_actor) || ' cancelled ' || v_s.name,
    'inventory_count_sessions', v_s.id::text, null, null, v_s.location_id, null, null, p_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants: management reads; writes via functions.
-- -----------------------------------------------------------------------------
alter table public.inventory_count_sessions enable row level security;
alter table public.inventory_count_entries enable row level security;
alter table public.inventory_count_revisions enable row level security;
alter table public.inventory_variances enable row level security;
revoke all on public.inventory_count_sessions, public.inventory_count_entries, public.inventory_count_revisions,
  public.inventory_variances from anon, authenticated;

grant select on public.inventory_count_sessions, public.inventory_count_entries, public.inventory_count_revisions,
  public.inventory_variances to authenticated;
create policy count_sessions_select on public.inventory_count_sessions for select to authenticated
  using ((select app.has_permission('counts.perform')) or (select app.has_permission('counts.post')));
create policy count_entries_select on public.inventory_count_entries for select to authenticated
  using ((select app.has_permission('counts.perform')) or (select app.has_permission('counts.post')));
create policy count_revisions_select on public.inventory_count_revisions for select to authenticated
  using ((select app.has_permission('counts.perform')) or (select app.has_permission('counts.post')));
create policy variances_select on public.inventory_variances for select to authenticated
  using ((select app.has_permission('counts.perform')) or (select app.has_permission('counts.post')));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.start_count(jsonb), public.get_count_sheet(uuid),
  public.save_count_entry(uuid, jsonb, integer, text, uuid, timestamptz, text), public.add_count_entry(uuid, uuid, uuid),
  public.pause_count(uuid), public.submit_count(uuid, boolean), public.verify_recount(uuid, uuid, text),
  public.approve_count(uuid), public.post_count(uuid), public.cancel_count(uuid, text) from public, anon;
grant execute on function public.start_count(jsonb), public.get_count_sheet(uuid),
  public.save_count_entry(uuid, jsonb, integer, text, uuid, timestamptz, text), public.add_count_entry(uuid, uuid, uuid),
  public.pause_count(uuid), public.submit_count(uuid, boolean), public.verify_recount(uuid, uuid, text),
  public.approve_count(uuid), public.post_count(uuid), public.cancel_count(uuid, text) to authenticated;
