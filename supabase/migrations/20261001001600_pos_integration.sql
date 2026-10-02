-- =============================================================================
-- 0016 POS INTEGRATION (Phase 6 — Toast)
-- Generic POS layer. Toast-specific code lives only in the server adapter
-- (src/lib/pos/toast/*), which turns Toast menus and orders into the neutral
-- shapes below. Inventory logic never sees Toast's data model.
--
--   pos_menu_items   every POS menu item / modifier seen, and its mapping:
--                    recipe | not_tracked | unmapped (UNMAPPED = no usage posted)
--   pos_orders       one row per POS order (source, external id) with its
--                    last-modified time: older or repeated deliveries are ignored
--   sales lines      sales_transactions (source 'toast', external id = the
--                    selection/modifier id) -> theoretical usage via app.apply_sale,
--                    which never double counts (changes reverse and re-post)
--   pos_webhook_events  delivered event ids (a redelivered webhook is skipped)
--   pos_sync_runs    sync log with counts and errors
--
-- Writes come from the server (scheduled sync, webhook) with the service key, or
-- from management actions; they run as the account that enabled the integration
-- and are labelled "Toast sync" in the audit log.
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('pos.manage', 'food_cost', 'Toast POS: map menu items to recipes, run a sync, view sync logs')
on conflict (code) do nothing;
insert into public.role_permissions (role, permission_code) values ('owner', 'pos.manage'), ('manager', 'pos.manage')
on conflict do nothing;

alter table public.sales_transactions
  add column source_item_id text,
  add column source_void boolean not null default false,
  add column pos_order_id uuid;
create index sales_transactions_source_item_idx on public.sales_transactions (source, source_item_id) where source_item_id is not null;

create table public.pos_integrations (
  source text primary key check (source ~ '^[a-z_]{2,20}$'),
  is_enabled boolean not null default false,
  actor_account_id uuid references public.account_profiles(id),
  enabled_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger pos_integrations_audit after insert or update or delete on public.pos_integrations
  for each row execute function app.audit_row_change();

create table public.pos_menu_items (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null check (length(external_id) between 1 and 200),
  name text not null check (length(name) between 1 and 200),
  menu_group text,
  price numeric(10, 2),
  is_modifier boolean not null default false,
  tracking text not null default 'unmapped' check (tracking in ('unmapped', 'recipe', 'not_tracked')),
  recipe_id uuid references public.recipes(id),
  mapped_by uuid references public.account_profiles(id),
  mapped_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint pos_menu_items_mapping check ((tracking = 'recipe') = (recipe_id is not null)),
  unique (source, external_id)
);

create table public.pos_orders (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null check (length(external_id) between 1 and 200),
  business_date date not null,
  modified_at timestamptz not null,
  is_void boolean not null default false,
  line_ids text[] not null default '{}',
  net_amount numeric(12, 2) not null default 0,
  version integer not null default 1,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  unique (source, external_id)
);
create index pos_orders_date_idx on public.pos_orders (source, business_date);

create table public.pos_webhook_events (
  source text not null,
  event_id text not null check (length(event_id) between 1 and 200),
  received_at timestamptz not null default now(),
  result jsonb,
  primary key (source, event_id)
);

create table public.pos_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  kind text not null check (kind in ('menu', 'orders', 'webhook')),
  trigger text not null check (trigger in ('schedule', 'manual', 'webhook')),
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed', 'not_configured')),
  business_date date,
  stats jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  account_id uuid references public.account_profiles(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index pos_sync_runs_started_idx on public.pos_sync_runs (source, started_at desc);

-- The actor POS writes run as: the account that enabled the integration, labelled "<Source> sync".
create or replace function app.pos_actor(p_source text)
returns app.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i public.pos_integrations;
  a public.account_profiles;
begin
  select * into i from public.pos_integrations where source = p_source;
  if i.source is null or not i.is_enabled then
    perform app.fail('CONFLICT', initcap(p_source) || ' sync is not turned on.');
  end if;
  select * into a from public.account_profiles where id = i.actor_account_id;
  return row(a.id, a.role, initcap(p_source) || ' sync', null, null, null, null, null)::app.actor;
end;
$$;

-- Applies one sale line from a POS with its current mapping.
create or replace function app.pos_apply_line(p_actor app.actor, p_source text, p_order_id uuid, p_business_date date,
  p_line_id text, p_item_id text, p_item_name text, p_quantity numeric, p_net_amount numeric, p_source_void boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m public.pos_menu_items;
  s public.sales_transactions;
begin
  select * into m from public.pos_menu_items where source = p_source and external_id = p_item_id;
  s := app.apply_sale(p_actor, p_source, p_line_id, p_business_date, coalesce(p_item_name, m.name, 'Unknown item'),
    case when m.tracking = 'recipe' then m.recipe_id end, p_quantity, p_net_amount,
    coalesce(p_source_void, false) or m.tracking = 'not_tracked');
  update public.sales_transactions set source_item_id = p_item_id, source_void = coalesce(p_source_void, false), pos_order_id = p_order_id
   where id = s.id and (source_item_id is distinct from p_item_id or source_void <> coalesce(p_source_void, false) or pos_order_id is distinct from p_order_id);
end;
$$;

-- p_order = { external_id, business_date (YYYY-MM-DD), modified_at, voided,
--             lines: [{ external_id, item_id, item_name, quantity, net_amount, voided }] }
-- Handles created / updated orders, voids, refunds (lower net amount), removed items
-- (lines missing from an update are voided) and quantity changes. Repeated or older
-- versions of an order change nothing.
create or replace function public.pos_apply_order(p_source text, p_order jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.pos_actor(p_source);
  o public.pos_orders;
  v_ext text := nullif(p_order ->> 'external_id', '');
  v_date date := nullif(p_order ->> 'business_date', '')::date;
  v_mod timestamptz := nullif(p_order ->> 'modified_at', '')::timestamptz;
  v_void boolean := coalesce((p_order ->> 'voided')::boolean, false);
  l jsonb;
  v_ids text[] := '{}';
  v_net numeric := 0;
  v_old text;
  v_unmapped int := 0;
  v_status text;
  s public.sales_transactions;
begin
  if v_ext is null or v_date is null or v_mod is null then
    perform app.fail('VALIDATION', 'Order is missing its id, business date or modified time.');
  end if;
  if coalesce(jsonb_typeof(p_order -> 'lines'), '') <> 'array' or jsonb_array_length(p_order -> 'lines') > 500 then
    perform app.fail('VALIDATION', 'Order ' || v_ext || ' has no valid lines.');
  end if;

  select * into o from public.pos_orders where source = p_source and external_id = v_ext for update;
  if o.id is not null and v_mod < o.modified_at then
    return jsonb_build_object('order', v_ext, 'status', 'stale');
  end if;
  if o.id is not null and v_mod = o.modified_at then
    update public.pos_orders set last_received_at = now() where id = o.id;
    return jsonb_build_object('order', v_ext, 'status', 'duplicate');
  end if;

  if o.id is null then
    insert into public.pos_orders (source, external_id, business_date, modified_at, is_void)
    values (p_source, v_ext, v_date, v_mod, v_void) returning * into o;
    v_status := 'created';
  else
    v_status := 'updated';
  end if;

  for l in select * from jsonb_array_elements(p_order -> 'lines') loop
    if nullif(l ->> 'external_id', '') is null or nullif(l ->> 'item_id', '') is null then
      perform app.fail('VALIDATION', 'Order ' || v_ext || ' has a line without an id.');
    end if;
    if l ->> 'external_id' = any (v_ids) then
      continue;  -- the same line twice in one payload
    end if;
    -- a menu item seen for the first time is recorded as UNMAPPED
    insert into public.pos_menu_items (source, external_id, name, is_modifier)
    values (p_source, l ->> 'item_id', coalesce(nullif(l ->> 'item_name', ''), 'Unknown item'), coalesce((l ->> 'is_modifier')::boolean, false))
    on conflict (source, external_id) do update set last_seen_at = now();
    perform app.pos_apply_line(v_actor, p_source, o.id, v_date, l ->> 'external_id', l ->> 'item_id', nullif(l ->> 'item_name', ''),
      coalesce(nullif(l ->> 'quantity', '')::numeric, 0), coalesce(nullif(l ->> 'net_amount', '')::numeric, 0),
      v_void or coalesce((l ->> 'voided')::boolean, false));
    v_ids := v_ids || (l ->> 'external_id');
    if not (v_void or coalesce((l ->> 'voided')::boolean, false)) then
      v_net := v_net + coalesce(nullif(l ->> 'net_amount', '')::numeric, 0);
    end if;
  end loop;

  -- lines that were on the previous version but are gone now (removed items)
  foreach v_old in array o.line_ids loop
    if not (v_old = any (v_ids)) then
      select * into s from public.sales_transactions where source = p_source and external_id = v_old;
      if s.id is not null then
        perform app.pos_apply_line(v_actor, p_source, o.id, s.business_date, v_old, s.source_item_id, s.item_name, s.quantity, s.net_amount, true);
      end if;
    end if;
  end loop;

  update public.pos_orders
     set business_date = v_date, modified_at = v_mod, is_void = v_void, line_ids = v_ids, net_amount = round(v_net, 2),
         version = case when v_status = 'updated' then version + 1 else version end, last_received_at = now()
   where id = o.id;

  select count(*) into v_unmapped from public.sales_transactions
   where pos_order_id = o.id and usage_status = 'unmapped';
  return jsonb_build_object('order', v_ext, 'status', v_status, 'lines', cardinality(v_ids), 'unmapped_lines', v_unmapped);
end;
$$;

-- p_items = [{ external_id, name, menu_group, price, is_modifier }]. Never changes a mapping.
create or replace function public.pos_upsert_menu(p_source text, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_new int := 0;
  v_total int := 0;
  v_inserted boolean;
  i jsonb;
begin
  if coalesce(jsonb_typeof(p_items), '') <> 'array' or jsonb_array_length(p_items) > 5000 then
    perform app.fail('VALIDATION', 'Menu payload is not valid.');
  end if;
  for i in select * from jsonb_array_elements(p_items) loop
    continue when nullif(i ->> 'external_id', '') is null or nullif(trim(i ->> 'name'), '') is null;
    insert into public.pos_menu_items (source, external_id, name, menu_group, price, is_modifier)
    values (p_source, i ->> 'external_id', left(trim(i ->> 'name'), 200), left(nullif(i ->> 'menu_group', ''), 200),
            nullif(i ->> 'price', '')::numeric, coalesce((i ->> 'is_modifier')::boolean, false))
    on conflict (source, external_id) do update
      set name = excluded.name, menu_group = coalesce(excluded.menu_group, public.pos_menu_items.menu_group),
          price = coalesce(excluded.price, public.pos_menu_items.price), last_seen_at = now()
    returning (xmax = 0) into v_inserted;
    v_total := v_total + 1;
    v_new := v_new + case when v_inserted then 1 else 0 end;
  end loop;
  return jsonb_build_object('items', v_total, 'new_items', v_new);
end;
$$;

-- Management maps a POS item to a recipe (or marks it not tracked). Every earlier sale of
-- that item is re-applied, so its usage is posted (or removed) exactly once.
create or replace function public.map_pos_item(p_id uuid, p_tracking text, p_recipe_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('pos.manage');
  m public.pos_menu_items;
  r public.recipes;
  s public.sales_transactions;
  v_n int := 0;
  v_pos app.actor;
begin
  if p_tracking not in ('recipe', 'not_tracked', 'unmapped') then
    perform app.fail('VALIDATION', 'Choose a recipe, "not tracked" or "unmapped".');
  end if;
  select * into m from public.pos_menu_items where id = p_id for update;
  if m.id is null then
    perform app.fail('NOT_FOUND', 'Menu item not found.');
  end if;
  if p_tracking = 'recipe' then
    select * into r from public.recipes where id = p_recipe_id and recipe_type = 'menu';
    if r.id is null then
      perform app.fail('VALIDATION', 'Choose a menu recipe.');
    end if;
  end if;
  update public.pos_menu_items
     set tracking = p_tracking, recipe_id = case when p_tracking = 'recipe' then r.id end, mapped_by = v_actor.account_id, mapped_at = now()
   where id = m.id;

  -- re-apply earlier sales of this item as the person who changed the mapping
  for s in select * from public.sales_transactions where source = m.source and source_item_id = m.external_id for update loop
    perform app.pos_apply_line(v_actor, m.source, s.pos_order_id, s.business_date, s.external_id, s.source_item_id, s.item_name,
      s.quantity, s.net_amount, s.source_void);
    v_n := v_n + 1;
  end loop;

  perform app.audit(v_actor, 'pos.item_mapped', 'operations',
    app.actor_label(v_actor) || ' mapped ' || initcap(m.source) || ' item "' || m.name || '" to ' ||
      case p_tracking when 'recipe' then 'recipe ' || r.name when 'not_tracked' then 'NOT TRACKED' else 'UNMAPPED' end ||
      case when v_n > 0 then ' (' || v_n || ' earlier sale line' || case when v_n = 1 then '' else 's' end || ' updated)' else '' end,
    'pos_menu_items', m.id::text, null, null, null,
    jsonb_build_object('tracking', m.tracking, 'recipe_id', m.recipe_id), jsonb_build_object('tracking', p_tracking, 'recipe_id', r.id));
  return jsonb_build_object('id', m.id, 'tracking', p_tracking, 'reapplied', v_n);
end;
$$;

-- Owner turns a POS sync on/off; the owner's account becomes the sync's acting account.
create or replace function public.set_pos_enabled(p_source text, p_enabled boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('settings.manage');
begin
  if p_source not in ('toast') then
    perform app.fail('VALIDATION', 'Unknown POS.');
  end if;
  insert into public.pos_integrations (source, is_enabled, actor_account_id, enabled_at, updated_at)
  values (p_source, p_enabled, v_actor.account_id, case when p_enabled then now() end, now())
  on conflict (source) do update
    set is_enabled = excluded.is_enabled, actor_account_id = case when excluded.is_enabled then excluded.actor_account_id else public.pos_integrations.actor_account_id end,
        enabled_at = case when excluded.is_enabled then now() else public.pos_integrations.enabled_at end, updated_at = now();
end;
$$;

-- For the management screen (whoever may manage the POS mapping).
create or replace function public.pos_overview(p_source text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('pos.manage');
begin
  return jsonb_build_object(
    'enabled', coalesce((select is_enabled from public.pos_integrations where source = p_source), false),
    'enabled_at', (select enabled_at from public.pos_integrations where source = p_source),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'external_id', m.external_id, 'name', m.name, 'menu_group', m.menu_group,
                'price', m.price, 'is_modifier', m.is_modifier, 'tracking', m.tracking, 'recipe_id', m.recipe_id, 'recipe_name', r.name,
                'last_seen_at', m.last_seen_at,
                'sold_qty_28d', (select coalesce(sum(s.quantity), 0) from public.sales_transactions s
                                  where s.source = m.source and s.source_item_id = m.external_id and not s.is_void and s.business_date > current_date - 28),
                'unmapped_lines', (select count(*) from public.sales_transactions s
                                    where s.source = m.source and s.source_item_id = m.external_id and s.usage_status = 'unmapped'))
                order by (m.tracking = 'unmapped') desc, m.is_modifier, m.menu_group nulls last, m.name), '[]'::jsonb)
                from public.pos_menu_items m left join public.recipes r on r.id = m.recipe_id where m.source = p_source),
    'unmapped_sales', (select coalesce(sum(net_amount), 0) from public.sales_transactions where source = p_source and usage_status = 'unmapped'),
    'orders_28d', (select count(*) from public.pos_orders where source = p_source and business_date > current_date - 28),
    'runs', (select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc), '[]'::jsonb)
               from (select id, kind, trigger, status, business_date, stats, errors, started_at, finished_at
                       from public.pos_sync_runs where source = p_source order by started_at desc limit 20) x));
end;
$$;

-- Manual entry must not double count a day that Toast already supplies.
create or replace function public.save_daily_sales(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('sales.enter');
  v_date date := nullif(p ->> 'business_date', '')::date;
  v_today date := (now() at time zone app.org_timezone())::date;
  l jsonb;
  r public.recipes;
  v_qty numeric;
  v_amt numeric;
  v_seen uuid[] := '{}';
  v_s public.sales_transactions;
  v_total numeric := 0;
  v_items numeric := 0;
begin
  if v_date is null or v_date > v_today or v_date < v_today - 120 then
    perform app.fail('VALIDATION', 'Choose a business date in the last 120 days.');
  end if;
  -- never count a day twice: once Toast sales are imported for a day, that day comes from Toast only
  if exists (select 1 from public.sales_transactions where source <> 'manual' and source <> 'demo' and business_date = v_date and not is_void) then
    perform app.fail('CONFLICT', 'Toast sales are already imported for ' || to_char(v_date, 'Dy Mon DD') || '. Entering them by hand would count them twice.');
  end if;
  if coalesce(jsonb_typeof(p -> 'lines'), '') <> 'array' or jsonb_array_length(p -> 'lines') > 300 then
    perform app.fail('VALIDATION', 'Enter the sales lines.');
  end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into r from public.recipes where id = nullif(l ->> 'recipe_id', '')::uuid and recipe_type = 'menu';
    if r.id is null then
      perform app.fail('VALIDATION', 'Every line must be a menu item.');
    end if;
    if r.id = any (v_seen) then
      perform app.fail('VALIDATION', r.name || ' is listed twice.');
    end if;
    v_qty := coalesce(nullif(l ->> 'quantity', '')::numeric, 0);
    v_amt := coalesce(nullif(l ->> 'net_amount', '')::numeric, 0);
    if v_qty < 0 or v_qty > 100000 or v_amt < 0 or v_amt > 1000000 then
      perform app.fail('VALIDATION', r.name || ': quantity and sales must be 0 or more.');
    end if;
    v_seen := v_seen || r.id;
    v_s := app.apply_sale(v_actor, 'manual', 'manual:' || v_date || ':' || r.id, v_date, r.name, r.id, v_qty, v_amt, false);
    v_total := v_total + v_amt;
    v_items := v_items + v_qty;
  end loop;
  -- menu items entered earlier for this day but left out now
  for v_s in select * from public.sales_transactions
              where source = 'manual' and business_date = v_date and not (recipe_id = any (v_seen)) and quantity > 0 loop
    perform app.apply_sale(v_actor, 'manual', v_s.external_id, v_date, v_s.item_name, v_s.recipe_id, 0, 0, false);
  end loop;
  perform app.audit(v_actor, 'sales.entered', 'operations',
    app.actor_label(v_actor) || ' entered sales for ' || to_char(v_date, 'Dy Mon DD') || ': ' ||
      trim(to_char(v_items, 'FM999999990.###')) || ' items, ' || app.fmt_money(v_total),
    'sales_transactions', v_date::text, null, null, app.primary_location_id(), null,
    jsonb_build_object('business_date', v_date, 'items', v_items, 'net_sales', v_total));
  return jsonb_build_object('business_date', v_date, 'items', v_items, 'net_sales', v_total);
end;
$$;


-- Dashboard wording now that Toast can supply sales.
create or replace function public.dashboard_metrics(p_from date, p_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor(null);
  v_loc uuid := app.primary_location_id();
  v_start timestamptz;
  v_end timestamptz;
  v_fin boolean := app.has_permission('reports.financial');
  v_today date := (now() at time zone app.org_timezone())::date;
  v_fc jsonb;
  v_has_sales boolean;
begin
  if not (app.has_permission('dashboard.owner') or app.has_permission('dashboard.manager')) then
    perform app.fail('FORBIDDEN', 'Not allowed.');
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    perform app.fail('VALIDATION', 'Choose a valid date range (max 400 days).');
  end if;
  v_start := app.range_start(p_from);
  v_end := app.range_start(p_to + 1);
  v_has_sales := exists (select 1 from public.sales_transactions where location_id = v_loc and business_date between p_from and p_to and not is_void and quantity > 0);
  if v_fin and v_has_sales then
    v_fc := public.food_cost_report(p_from, p_to);
  end if;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'financial_access', v_fin,
    'sales', jsonb_build_object('connected', v_has_sales, 'amount', case when v_fin and v_has_sales then v_fc -> 'sales' end,
                                'note', case when v_has_sales then 'From Toast and entered sales.' else 'No sales for this period yet.' end),
    'food_cost', jsonb_build_object('actual_pct', case when v_fin then v_fc -> 'actual_pct' end,
                                    'theoretical_pct', case when v_fin then v_fc -> 'theoretical_pct' end,
                                    'variance_pts', case when v_fin then v_fc -> 'variance_pts' end,
                                    'note', case when not v_has_sales then 'Needs sales for this period.'
                                                 else 'Actual uses book inventory; exact between two posted full counts.' end),
    'inventory_value', (select round(coalesce(sum(inventory_value), 0), 2) from public.inventory_on_hand
                          where location_id = v_loc and is_active),
    'purchases', case when v_fin then (select coalesce(sum(received_total), 0) from public.receiving_events re
                          join public.vendors v on v.id = re.vendor_id
                         where re.location_id = v_loc and re.delivery_date between p_from and p_to) end,
    'purchases_by_vendor', case when v_fin then (select coalesce(jsonb_agg(jsonb_build_object('vendor', x.name, 'amount', x.amount)
                          order by x.amount desc), '[]'::jsonb)
                          from (select v.name, sum(re.received_total) as amount from public.receiving_events re
                                  join public.vendors v on v.id = re.vendor_id
                                 where re.location_id = v_loc and re.delivery_date between p_from and p_to
                                 group by v.name) x) end,
    'waste', (select jsonb_build_object('amount', coalesce(sum(total_cost), 0), 'entries', count(*))
                from public.waste_entries where location_id = v_loc and occurred_at >= v_start and occurred_at < v_end),
    'waste_today', (select coalesce(sum(total_cost), 0) from public.waste_entries
                     where location_id = v_loc and occurred_at >= app.range_start(v_today) and occurred_at < app.range_start(v_today + 1)),
    'inventory_variance', (select coalesce(sum(variance_value), 0) from public.inventory_count_sessions
                            where location_id = v_loc and status = 'POSTED' and posted_at >= v_start and posted_at < v_end),
    'deliveries', (select count(*) from public.receiving_events where location_id = v_loc and delivery_date between p_from and p_to),
    'open_delivery_issues', (select count(distinct receiving_event_id) from public.delivery_discrepancies where status in ('open', 'credit_requested')),
    'stock', (select jsonb_build_object(
                'low', count(*) filter (where stock_status = 'LOW_STOCK'),
                'critical', count(*) filter (where stock_status = 'CRITICAL'),
                'out', count(*) filter (where stock_status = 'OUT_OF_STOCK'))
                from public.inventory_on_hand where location_id = v_loc and is_active),
    'price_alerts', (select count(*) from public.alerts where alert_type = 'PRICE_INCREASE' and status = 'open'),
    'open_alerts', (select count(*) from public.alerts where status = 'open'),
    'open_counts', (select count(*) from public.inventory_count_sessions
                     where location_id = v_loc and status in ('IN_PROGRESS', 'PAUSED', 'AWAITING_REVIEW', 'RECOUNT_REQUIRED', 'APPROVED')),
    'tasks_due', (select count(*) from public.tasks where status = 'open' and due_at < app.range_start(v_today + 1))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants: management reads; writes only through the functions above.
-- -----------------------------------------------------------------------------
alter table public.pos_integrations enable row level security;
alter table public.pos_menu_items enable row level security;
alter table public.pos_orders enable row level security;
alter table public.pos_webhook_events enable row level security;
alter table public.pos_sync_runs enable row level security;
revoke all on public.pos_integrations, public.pos_menu_items, public.pos_orders, public.pos_webhook_events, public.pos_sync_runs from anon, authenticated;
grant select on public.pos_integrations, public.pos_menu_items, public.pos_orders, public.pos_sync_runs to authenticated;
create policy pos_integrations_select on public.pos_integrations for select to authenticated using ((select app.has_permission('pos.manage')));
create policy pos_menu_items_select on public.pos_menu_items for select to authenticated using ((select app.has_permission('pos.manage')));
create policy pos_orders_select on public.pos_orders for select to authenticated using ((select app.has_permission('pos.manage')));
create policy pos_sync_runs_select on public.pos_sync_runs for select to authenticated using ((select app.has_permission('pos.manage')));

revoke execute on all functions in schema app from public, anon;
-- POS payloads arrive only through the server (scheduled sync / signed webhook) with the service key.
revoke execute on function public.pos_apply_order(text, jsonb), public.pos_upsert_menu(text, jsonb) from public, anon, authenticated;
grant execute on function public.pos_apply_order(text, jsonb), public.pos_upsert_menu(text, jsonb) to service_role;
revoke execute on function public.map_pos_item(uuid, text, uuid), public.set_pos_enabled(text, boolean), public.pos_overview(text) from public, anon;
grant execute on function public.map_pos_item(uuid, text, uuid), public.set_pos_enabled(text, boolean), public.pos_overview(text) to authenticated;
