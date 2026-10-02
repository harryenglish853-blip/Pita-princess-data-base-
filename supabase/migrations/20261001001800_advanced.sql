-- =============================================================================
-- 0018 ADVANCED FEATURES (Phase 8)
--  * Sales forecast per menu item per day: average of the same weekday over the
--    last 8 weeks (days without any sales are skipped), times the recent trend
--    (last 14 vs previous 14 days, kept within 0.8-1.25), times any manager
--    adjustments (events, holidays, promotions, weather). Needs 2+ weeks of sales.
--  * Dynamic par: expected ingredient usage = forecast portions x recipe, day by
--    day until the following delivery, + safety stock (falls back to 28-day usage).
--  * Barcodes: several per product (unit or case); unknown codes can be mapped.
--  * Invoice reading (OCR): results are stored for a person to review and
--    confirm — nothing is ever posted from them automatically.
--  * Anomaly detection: statistical checks that raise ANOMALY alerts.
-- =============================================================================

create table public.forecast_adjustments (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  starts_on date not null,
  ends_on date not null,
  factor numeric(5, 2) not null check (factor between 0.1 and 5),
  recipe_id uuid references public.recipes(id),
  reason text not null check (length(trim(reason)) between 2 and 120),
  created_by uuid references public.account_profiles(id),
  created_at timestamptz not null default now(),
  constraint forecast_adjustments_range check (ends_on >= starts_on and ends_on - starts_on <= 60)
);
create trigger forecast_adjustments_audit after insert or update or delete on public.forecast_adjustments
  for each row execute function app.audit_row_change();

-- Forecast portions per menu recipe per day.
create or replace function app.forecast_items(p_loc uuid, p_from date, p_to date)
returns table (day date, recipe_id uuid, qty numeric, basis_days int, avg_dow numeric, trend numeric, adjustment numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with t as (select (now() at time zone app.org_timezone())::date as d),
  hist as (
    select s.business_date as d, s.recipe_id, sum(s.quantity) as q
      from public.sales_transactions s, t
     where s.location_id = p_loc and not s.is_void and s.recipe_id is not null
       and s.business_date >= t.d - 56 and s.business_date < t.d
     group by 1, 2
  ),
  open_days as (select distinct d from hist),
  recipes as (select distinct recipe_id from hist),
  dw as (
    select r.recipe_id, extract(dow from od.d)::int as w, count(*)::int as n, sum(coalesce(h.q, 0)) as total
      from recipes r cross join open_days od
      left join hist h on h.recipe_id = r.recipe_id and h.d = od.d
     group by 1, 2
  ),
  tr as (
    select r.recipe_id,
           coalesce(sum(h.q) filter (where h.d >= t.d - 14), 0) as recent,
           coalesce(sum(h.q) filter (where h.d < t.d - 14 and h.d >= t.d - 28), 0) as prior
      from recipes r cross join t left join hist h on h.recipe_id = r.recipe_id
     group by 1
  ),
  days as (select g::date as day from generate_series(p_from, p_to, interval '1 day') g)
  select dy.day, dw.recipe_id,
         round(dw.total / dw.n * f.trend * a.f, 1),
         dw.n, round(dw.total / dw.n, 2), f.trend, round(a.f, 3)
    from days dy
    join dw on dw.w = extract(dow from dy.day)::int and dw.n >= 2
    join tr on tr.recipe_id = dw.recipe_id
    cross join lateral (select case when tr.recent > 0 and tr.prior > 0 then round(least(greatest(tr.recent / tr.prior, 0.8), 1.25), 3) else 1 end as trend) f
    cross join lateral (select coalesce(exp(sum(ln(fa.factor))), 1) as f from public.forecast_adjustments fa
                         where fa.location_id = p_loc and dy.day between fa.starts_on and fa.ends_on
                           and (fa.recipe_id is null or fa.recipe_id = dw.recipe_id)) a
$$;

-- Expected ingredient usage (inventory units) from the forecast, with the menu items behind it.
create or replace function app.forecast_product_usage(p_loc uuid, p_from date, p_to date)
returns table (product_id uuid, qty_inv numeric, breakdown jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with pr as (
    select fi.recipe_id, sum(fi.qty) as portions from app.forecast_items(p_loc, p_from, p_to) fi group by 1
  ),
  ex as (
    select pr.recipe_id, r.name, pr.portions, e.product_id, e.quantity_inv * pr.portions as use
      from pr join public.recipes r on r.id = pr.recipe_id
      cross join lateral app.recipe_explode(pr.recipe_id, 1 / r.yield_quantity) e
  ),
  per as (select product_id, recipe_id, name, portions, sum(use) as use from ex group by 1, 2, 3, 4)
  select per.product_id, round(sum(per.use), 4),
         jsonb_agg(jsonb_build_object('recipe', per.name, 'portions', per.portions, 'usage', round(per.use, 4)) order by per.use desc)
    from per group by per.product_id
   having sum(per.use) > 0
$$;

-- Forecast screen: next days by menu item, totals, expected ingredient usage, adjustments.
create or replace function public.sales_forecast(p_from date, p_days int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor(null);
  v_loc uuid := app.primary_location_id();
  v_to date := p_from + least(greatest(coalesce(p_days, 7), 1), 28) - 1;
begin
  if not (app.has_permission('orders.manage') or app.has_permission('sales.enter') or app.has_permission('reports.financial')) then
    perform app.fail('FORBIDDEN', 'Not allowed.');
  end if;
  return jsonb_build_object(
    'from', p_from, 'to', v_to,
    'history_days', (select count(distinct business_date) from public.sales_transactions
                      where location_id = v_loc and not is_void and recipe_id is not null
                        and business_date >= (now() at time zone app.org_timezone())::date - 56),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('day', fi.day, 'recipe_id', fi.recipe_id, 'name', r.name, 'qty', fi.qty,
                'sales', round(fi.qty * coalesce(r.selling_price, 0), 2), 'basis_days', fi.basis_days, 'avg_dow', fi.avg_dow,
                'trend', fi.trend, 'adjustment', fi.adjustment) order by fi.day, r.name), '[]'::jsonb)
                from app.forecast_items(v_loc, p_from, v_to) fi join public.recipes r on r.id = fi.recipe_id),
    'usage', (select coalesce(jsonb_agg(jsonb_build_object('product_id', u.product_id, 'name', p.name, 'inventory_unit', p.inventory_unit,
                'qty', u.qty_inv, 'on_hand', coalesce(b.quantity, 0), 'breakdown', u.breakdown) order by p.name), '[]'::jsonb)
                from app.forecast_product_usage(v_loc, p_from, v_to) u join public.products p on p.id = u.product_id
                left join public.inventory_balances b on b.product_id = u.product_id and b.location_id = v_loc),
    'adjustments', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'starts_on', a.starts_on, 'ends_on', a.ends_on, 'factor', a.factor,
                      'reason', a.reason, 'recipe', r.name) order by a.starts_on), '[]'::jsonb)
                      from public.forecast_adjustments a left join public.recipes r on r.id = a.recipe_id
                     where a.location_id = v_loc and a.ends_on >= p_from - 30));
end;
$$;

create or replace function public.save_forecast_adjustment(p jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('orders.manage');
  v_id uuid;
  v_from date := nullif(p ->> 'starts_on', '')::date;
  v_to date := coalesce(nullif(p ->> 'ends_on', '')::date, nullif(p ->> 'starts_on', '')::date);
  v_pct numeric := nullif(p ->> 'percent', '')::numeric;
begin
  if v_from is null or v_to < v_from or v_to - v_from > 60 then
    perform app.fail('VALIDATION', 'Choose the dates (at most 60 days).');
  end if;
  if v_pct is null or v_pct < -90 or v_pct > 400 then
    perform app.fail('VALIDATION', 'Enter the expected change in percent (e.g. 30 for +30%, -20 for -20%).');
  end if;
  if coalesce(length(trim(p ->> 'reason')), 0) < 2 then
    perform app.fail('VALIDATION', 'Give a reason (e.g. Holiday, Street fair, Snowstorm).');
  end if;
  insert into public.forecast_adjustments (location_id, starts_on, ends_on, factor, recipe_id, reason, created_by)
  values (app.primary_location_id(), v_from, v_to, round(1 + v_pct / 100, 2), nullif(p ->> 'recipe_id', '')::uuid, trim(p ->> 'reason'), v_actor.account_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.delete_forecast_adjustment(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('orders.manage');
begin
  delete from public.forecast_adjustments where id = p_id;
end;
$$;

-- Suggested orders: dynamic par uses the sales forecast when there is enough history.
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
  v_fc jsonb;
begin
  select * into v_vendor from public.vendors where id = p_vendor_id and is_active;
  if v_vendor.id is null then
    perform app.fail('NOT_FOUND', 'Vendor not found.');
  end if;
  select * into w from app.vendor_delivery_window(p_vendor_id);
  -- days the order must last: until the delivery AFTER the one we are ordering for (7 if unknown)
  v_cover := coalesce(w.following_delivery - v_today, 7);
  -- expected ingredient usage from the menu-item sales forecast, day by day, until the following delivery
  select coalesce(jsonb_object_agg(f.product_id::text, jsonb_build_object('qty', f.qty_inv, 'breakdown', f.breakdown)), '{}'::jsonb)
    into v_fc from app.forecast_product_usage(v_loc, v_today, v_today + v_cover - 1) f;

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
           v_fc -> i.product_id::text as fc,
           coalesce((select sum(ti.quantity_inv) from public.transfer_items ti join public.inventory_transfers tr on tr.id = ti.transfer_id
                      where ti.product_id = i.product_id and tr.to_location_id = v_loc and tr.status in ('sent', 'in_transit')), 0) as incoming_transfers
      from items i
      cross join lateral app.daily_usage(v_loc, i.product_id, 28) u
  ),
  need as (
    select c.*,
           case when c.par_type = 'dynamic' and c.fc is not null then 'sales_forecast'
                when c.par_type = 'dynamic' and c.observed_days >= 7 then 'forecast'
                when c.par_level is not null then 'par'
                when c.observed_days >= 7 then 'forecast'
                else 'none' end as method,
           case when c.par_type = 'dynamic' and c.fc is not null then round((c.fc ->> 'qty')::numeric, 4)
                else round(c.daily_usage * v_cover, 4) end as forecast_usage
      from calc c
  ),
  final as (
    select n.*,
           case n.method when 'forecast' then n.forecast_usage + coalesce(n.safety_stock, 0)
                         when 'sales_forecast' then n.forecast_usage + coalesce(n.safety_stock, 0)
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
           'coverage_days', v_cover, 'forecast_usage', r.forecast_usage, 'forecast_breakdown', r.fc -> 'breakdown', 'safety_stock', coalesce(r.safety_stock, 0),
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
-- Barcodes
-- -----------------------------------------------------------------------------
create table public.product_barcodes (
  barcode text primary key check (barcode ~ '^[0-9A-Za-z.-]{4,64}$'),
  product_id uuid not null references public.products(id),
  unit_code text references public.units(code),
  created_by uuid references public.account_profiles(id),
  created_at timestamptz not null default now()
);
create index product_barcodes_product_idx on public.product_barcodes (product_id);
create trigger product_barcodes_audit after insert or update or delete on public.product_barcodes
  for each row execute function app.audit_row_change();
insert into public.product_barcodes (barcode, product_id)
select trim(barcode), id from public.products where barcode is not null and trim(barcode) ~ '^[0-9A-Za-z.-]{4,64}$'
on conflict do nothing;

-- Any signed-in person (employees count too): what is this barcode?
create or replace function public.lookup_barcode(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor(null);
  v_code text := trim(coalesce(p_code, ''));
begin
  return (select jsonb_build_object('product_id', p.id, 'name', p.name, 'item_code', p.item_code, 'unit_code', b.unit_code, 'inventory_unit', p.inventory_unit)
            from public.product_barcodes b join public.products p on p.id = b.product_id
           where b.barcode = v_code and p.is_active
          union all
          select jsonb_build_object('product_id', p.id, 'name', p.name, 'item_code', p.item_code, 'unit_code', null, 'inventory_unit', p.inventory_unit)
            from public.products p where p.is_active and (p.barcode = v_code or p.item_code = upper(v_code))
           limit 1);
end;
$$;

create or replace function public.map_barcode(p_code text, p_product_id uuid, p_unit text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('products.manage');
  v_code text := trim(coalesce(p_code, ''));
  v_name text;
begin
  if v_code !~ '^[0-9A-Za-z.-]{4,64}$' then
    perform app.fail('VALIDATION', 'That does not look like a barcode.');
  end if;
  select name into v_name from public.products where id = p_product_id and is_active;
  if v_name is null then
    perform app.fail('VALIDATION', 'Choose an active product.');
  end if;
  if nullif(p_unit, '') is not null then
    perform app.unit_factor_to_inventory(p_product_id, p_unit);
  end if;
  insert into public.product_barcodes (barcode, product_id, unit_code, created_by)
  values (v_code, p_product_id, nullif(p_unit, ''), v_actor.account_id)
  on conflict (barcode) do update set product_id = excluded.product_id, unit_code = excluded.unit_code, created_by = excluded.created_by, created_at = now();
  perform app.audit(v_actor, 'products.barcode_mapped', 'admin',
    app.actor_label(v_actor) || ' mapped barcode ' || v_code || ' to ' || v_name || coalesce(' (' || nullif(p_unit, '') || ')', ''),
    'product_barcodes', v_code, p_product_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Invoice reading (OCR) — extracted data waits for a person
-- -----------------------------------------------------------------------------
create table public.invoice_extractions (
  id uuid primary key default gen_random_uuid(),
  receiving_event_id uuid not null references public.receiving_events(id),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'confirmed', 'discarded')),
  provider text not null,
  model text,
  extracted jsonb,
  error text,
  requested_by uuid not null references public.account_profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  reviewed_by uuid references public.account_profiles(id),
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 500)
);
create index invoice_extractions_event_idx on public.invoice_extractions (receiving_event_id, created_at desc);

create or replace function public.request_invoice_extraction(p_receiving_event_id uuid, p_provider text, p_model text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.review');
  v_id uuid;
begin
  if not exists (select 1 from public.invoice_documents where receiving_event_id = p_receiving_event_id and upload_status = 'uploaded') then
    perform app.fail('VALIDATION', 'This delivery has no uploaded invoice photo to read.');
  end if;
  if exists (select 1 from public.invoice_extractions where receiving_event_id = p_receiving_event_id and status = 'pending' and created_at > now() - interval '5 minutes') then
    perform app.fail('CONFLICT', 'The invoice is already being read. Wait a moment.');
  end if;
  insert into public.invoice_extractions (receiving_event_id, provider, model, requested_by)
  values (p_receiving_event_id, left(coalesce(p_provider, 'unknown'), 40), left(p_model, 80), v_actor.account_id) returning id into v_id;
  return v_id;
end;
$$;

-- A person confirms (checked against the delivery) or discards what was read. Nothing is posted.
create or replace function public.review_invoice_extraction(p_id uuid, p_decision text, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.review');
  x public.invoice_extractions;
begin
  if p_decision not in ('confirmed', 'discarded') then
    perform app.fail('VALIDATION', 'Choose confirm or discard.');
  end if;
  select * into x from public.invoice_extractions where id = p_id for update;
  if x.id is null or x.status <> 'ready' then
    perform app.fail('CONFLICT', 'Only a finished reading can be reviewed.');
  end if;
  update public.invoice_extractions set status = p_decision, reviewed_by = v_actor.account_id, reviewed_at = now(),
         review_note = nullif(trim(p_note), '') where id = x.id;
  perform app.audit(v_actor, 'receiving.invoice_read_' || case when p_decision = 'confirmed' then 'confirmed' else 'discarded' end, 'operations',
    app.actor_label(v_actor) || case when p_decision = 'confirmed' then ' checked the AI invoice reading' else ' discarded the AI invoice reading' end ||
      coalesce(' — ' || nullif(trim(p_note), ''), ''),
    'receiving_events', x.receiving_event_id::text, null, null, null, null, null, nullif(trim(p_note), ''));
end;
$$;

-- -----------------------------------------------------------------------------
-- Anomaly detection
-- -----------------------------------------------------------------------------
alter table public.email_recipients drop constraint email_recipients_alert_types_check;
alter table public.email_recipients add constraint email_recipients_alert_types_check
  check (alert_types <@ array['waste', 'variance', 'delivery', 'price', 'critical_stock', 'low_stock',
                              'inventory_due', 'order_reminder', 'sync_failure', 'security', 'anomaly']::text[]);

insert into public.settings (key, value, description) values
  ('anomaly.price_deviation_pct', '15'::jsonb, 'Flag a delivery price this many percent away from the 90-day median for that item.'),
  ('anomaly.sales_low_pct', '50'::jsonb, 'Flag a day whose sales are below this percent of the forecast (missing Toast data?).'),
  ('anomaly.min_amount', '20'::jsonb, 'Ignore waste / variance anomalies smaller than this many dollars.')
on conflict (key) do nothing;

-- Runs the checks and raises one ANOMALY alert per finding (deduplicated). Returns the findings.
create or replace function app.detect_anomalies()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loc uuid := app.primary_location_id();
  v_today date := (now() at time zone app.org_timezone())::date;
  v_min numeric := app.setting_numeric('anomaly.min_amount', 20);
  v_price_pct numeric := app.setting_numeric('anomaly.price_deviation_pct', 15);
  v_sales_pct numeric := app.setting_numeric('anomaly.sales_low_pct', 50);
  r record;
  v_found jsonb := '[]'::jsonb;
  v_fc numeric;
  v_sales numeric;
begin
  if v_loc is null then
    return v_found;
  end if;
  -- 1. waste spike: yesterday's waste of a product far above its usual daily waste (mean + 3 sd of the prior 28 days)
  for r in
    with daily as (
      select w.product_id, (w.occurred_at at time zone app.org_timezone())::date as d, sum(w.total_cost) as c
        from public.waste_entries w where w.location_id = v_loc and w.occurred_at >= now() - interval '30 days'
       group by 1, 2
    ),
    stats as (
      select product_id, avg(c) as mu, coalesce(stddev_pop(c), 0) as sd, count(*) as n
        from (select p.product_id, g::date as d, coalesce(dl.c, 0) as c
                from (select distinct product_id from daily) p
                cross join generate_series(v_today - 29, v_today - 2, interval '1 day') g
                left join daily dl on dl.product_id = p.product_id and dl.d = g::date) x
       group by 1
    )
    select d.product_id, d.c, s.mu, s.sd, pr.name from daily d join stats s using (product_id) join public.products pr on pr.id = d.product_id
     where d.d = v_today - 1 and d.c >= v_min and d.c > s.mu + 3 * greatest(s.sd, 1)
  loop
    perform app.raise_alert('ANOMALY', 'warning', 'Unusual waste: ' || r.name,
      'Yesterday ' || app.fmt_money(r.c) || ' of ' || r.name || ' was wasted; usually about ' || app.fmt_money(r.mu) || ' a day.',
      'products', r.product_id::text, '/reports/waste', 'anomaly:waste:' || r.product_id || ':' || (v_today - 1), r.product_id, null, v_loc,
      jsonb_build_object('kind', 'waste', 'amount', r.c, 'usual', round(r.mu, 2)));
    v_found := v_found || jsonb_build_object('kind', 'waste', 'product', r.name, 'amount', r.c);
  end loop;

  -- 2. delivery price far from the 90-day median for that product and vendor
  for r in
    with recent as (
      select ri.id, ri.product_id, re.vendor_id, ri.unit_cost_inv as c, re.delivery_date
        from public.receiving_items ri join public.receiving_events re on re.id = ri.receiving_event_id
       where re.location_id = v_loc and re.delivery_date >= v_today - 2 and ri.unit_cost_inv > 0
    ),
    med as (
      select ri.product_id, re.vendor_id, (percentile_cont(0.5) within group (order by ri.unit_cost_inv))::numeric as m, count(*) as n
        from public.receiving_items ri join public.receiving_events re on re.id = ri.receiving_event_id
       where re.location_id = v_loc and re.delivery_date between v_today - 90 and v_today - 3 and ri.unit_cost_inv > 0
       group by 1, 2
    )
    select rc.*, md.m, pr.name, v.name as vendor from recent rc join med md using (product_id, vendor_id)
      join public.products pr on pr.id = rc.product_id join public.vendors v on v.id = rc.vendor_id
     where md.n >= 2 and abs(rc.c - md.m) / md.m * 100 > v_price_pct
  loop
    perform app.raise_alert('ANOMALY', 'warning', 'Unusual price: ' || r.name || ' (' || r.vendor || ')',
      r.name || ' cost ' || app.fmt_money(r.c) || ' per unit on ' || to_char(r.delivery_date, 'Mon DD') || '; the usual price is ' ||
        app.fmt_money(r.m) || ' (' || case when r.c > r.m then '+' else '' end || to_char((r.c - r.m) / r.m * 100, 'FM990.0') || '%).',
      'receiving_items', r.id::text, '/reports/price-history', 'anomaly:price:' || r.id, r.product_id, r.vendor_id, v_loc,
      jsonb_build_object('kind', 'price', 'cost', r.c, 'median', r.m));
    v_found := v_found || jsonb_build_object('kind', 'price', 'product', r.name, 'cost', r.c, 'median', r.m);
  end loop;

  -- 3. count variance far beyond what that product usually shows
  for r in
    with v as (
      select t.product_id, t.extended_cost, t.occurred_at, row_number() over (partition by t.product_id order by t.occurred_at desc) as rn
        from public.inventory_transactions t
       where t.location_id = v_loc and t.txn_type = 'PHYSICAL_VARIANCE' and t.occurred_at >= now() - interval '120 days'
    ),
    last as (select * from v where rn = 1 and occurred_at >= now() - interval '7 days'),
    hist as (select product_id, avg(abs(extended_cost)) as mu, count(*) as n from v where rn > 1 group by 1)
    select l.product_id, l.extended_cost, h.mu, pr.name, l.occurred_at from last l join hist h using (product_id) join public.products pr on pr.id = l.product_id
     where h.n >= 2 and abs(l.extended_cost) >= v_min and abs(l.extended_cost) > 3 * greatest(h.mu, 1)
  loop
    perform app.raise_alert('ANOMALY', 'warning', 'Unusual count difference: ' || r.name,
      'The last count found ' || app.fmt_money(r.extended_cost) || ' for ' || r.name || '; usually the difference is about ±' || app.fmt_money(r.mu) || '.',
      'products', r.product_id::text, '/reports/variance', 'anomaly:variance:' || r.product_id || ':' || r.occurred_at::date, r.product_id, null, v_loc,
      jsonb_build_object('kind', 'variance', 'amount', r.extended_cost, 'usual', round(r.mu, 2)));
    v_found := v_found || jsonb_build_object('kind', 'variance', 'product', r.name, 'amount', r.extended_cost);
  end loop;

  -- 4. yesterday's sales far below the forecast (missing Toast data, or a real problem)
  select sum(fi.qty * coalesce(rc.selling_price, 0)) into v_fc
    from app.forecast_items(v_loc, v_today - 1, v_today - 1) fi join public.recipes rc on rc.id = fi.recipe_id;
  select coalesce(sum(net_amount), 0) into v_sales from public.sales_transactions where location_id = v_loc and business_date = v_today - 1 and not is_void;
  if v_fc is not null and v_fc > 100 and v_sales < v_fc * v_sales_pct / 100 then
    perform app.raise_alert('ANOMALY', 'warning', 'Sales much lower than expected yesterday',
      'Yesterday''s sales were ' || app.fmt_money(v_sales) || ' against a forecast of about ' || app.fmt_money(v_fc) ||
        '. If the restaurant was open, check that Toast sales came in (Toast POS → SYNC SALES).',
      'sales_transactions', (v_today - 1)::text, '/pos', 'anomaly:sales:' || (v_today - 1), null, null, v_loc,
      jsonb_build_object('kind', 'sales', 'sales', v_sales, 'forecast', round(v_fc, 2)));
    v_found := v_found || jsonb_build_object('kind', 'sales', 'sales', v_sales, 'forecast', round(v_fc, 2));
  end if;
  return v_found;
end;
$$;

-- Management can run the checks now; the server runs them on its schedule.
create or replace function public.run_anomaly_checks()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('alerts.view');
begin
  return app.detect_anomalies();
end;
$$;
create or replace function public.run_anomaly_checks_service()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select app.detect_anomalies() $$;

-- -----------------------------------------------------------------------------
-- RLS & grants
-- -----------------------------------------------------------------------------
alter table public.forecast_adjustments enable row level security;
alter table public.product_barcodes enable row level security;
alter table public.invoice_extractions enable row level security;
revoke all on public.forecast_adjustments, public.product_barcodes, public.invoice_extractions from anon, authenticated;
grant select on public.forecast_adjustments, public.product_barcodes, public.invoice_extractions to authenticated;
create policy forecast_adjustments_select on public.forecast_adjustments for select to authenticated using ((select app.is_management()));
create policy product_barcodes_select on public.product_barcodes for select to authenticated using ((select app.has_permission('inventory.view')));
create policy invoice_extractions_select on public.invoice_extractions for select to authenticated using ((select app.has_permission('receiving.review')));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.sales_forecast(date, int), public.save_forecast_adjustment(jsonb), public.delete_forecast_adjustment(uuid),
  public.lookup_barcode(text), public.map_barcode(text, uuid, text), public.request_invoice_extraction(uuid, text, text),
  public.review_invoice_extraction(uuid, text, text), public.run_anomaly_checks() from public, anon;
grant execute on function public.sales_forecast(date, int), public.save_forecast_adjustment(jsonb), public.delete_forecast_adjustment(uuid),
  public.lookup_barcode(text), public.map_barcode(text, uuid, text), public.request_invoice_extraction(uuid, text, text),
  public.review_invoice_extraction(uuid, text, text), public.run_anomaly_checks() to authenticated;
revoke execute on function public.run_anomaly_checks_service() from public, anon, authenticated;
grant execute on function public.run_anomaly_checks_service() to service_role;

-- The server stores what the reader returned (service key only). Only a pending reading can be completed.
create or replace function public.complete_invoice_extraction(p_id uuid, p_status text, p_extracted jsonb, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status not in ('ready', 'failed') then
    perform app.fail('VALIDATION', 'Invalid status.');
  end if;
  update public.invoice_extractions set status = p_status, extracted = p_extracted, error = left(p_error, 500), completed_at = now()
   where id = p_id and status = 'pending';
  if not found then
    perform app.fail('CONFLICT', 'This reading is not waiting for a result.');
  end if;
end;
$$;
revoke execute on function public.complete_invoice_extraction(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_invoice_extraction(uuid, text, jsonb, text) to service_role;
