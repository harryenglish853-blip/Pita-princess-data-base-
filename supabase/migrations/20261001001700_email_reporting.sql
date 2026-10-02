-- =============================================================================
-- 0017 EMAIL REPORTING (Phase 7)
--  * Recipient preferences: daily / weekly / monthly reports, commissary orders,
--    and immediate alert emails by category (owner decides who gets what).
--  * Monthly owner report and immediate alert emails are logged in email_reports
--    like the daily/weekly reports.
--  * alert_email_log: each alert event is emailed to each recipient at most once
--    (claimed before sending, so two dispatchers can never double send).
--  * stock_alert_state: when a product last went LOW / CRITICAL, so a product is
--    announced once per drop, not on every movement.
--  * Food cost figures for scheduled reports (no signed-in user): app.food_cost_data,
--    reachable by the server only through food_cost_report_service.
-- =============================================================================

alter table public.email_recipients
  add column receives_monthly boolean not null default true,
  add column alert_types text[] not null default '{}'
    check (alert_types <@ array['waste', 'variance', 'delivery', 'price', 'critical_stock', 'low_stock',
                                'inventory_due', 'order_reminder', 'sync_failure', 'security']::text[]);

alter table public.email_reports drop constraint email_reports_report_type_check;
alter table public.email_reports add constraint email_reports_report_type_check
  check (report_type in ('daily', 'weekly', 'monthly', 'test', 'commissary_order', 'alert'));
alter table public.email_reports add column alert_refs text[];

insert into public.settings (key, value, description) values
  ('email.monthly_report_day', '1'::jsonb, 'Day of the month (1-28) the monthly owner report for the previous month is emailed.'),
  ('email.alert_min_interval_minutes', '15'::jsonb, 'Minimum minutes between two immediate alert emails to the same person (alerts in between are sent together).'),
  ('alerts.major_price_increase_pct', '10'::jsonb, 'Only price increases above this percent are emailed immediately (smaller ones appear in the daily report).'),
  ('alerts.order_reminder_hours', '3'::jsonb, 'Send vendor order reminders this many hours before the order task is due.')
on conflict (key) do nothing;

create table public.alert_email_log (
  id bigint generated always as identity primary key,
  event_ref text not null check (length(event_ref) between 1 and 300),
  category text not null,
  recipient_email text not null,
  email_report_id uuid references public.email_reports(id),
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed', 'not_configured')),
  created_at timestamptz not null default now(),
  unique (event_ref, recipient_email)
);
create index alert_email_log_recipient_idx on public.alert_email_log (recipient_email, created_at desc);

create table public.stock_alert_state (
  location_id uuid not null references public.locations(id),
  product_id uuid not null references public.products(id),
  status text not null check (status in ('LOW_STOCK', 'CRITICAL', 'OUT_OF_STOCK')),
  since timestamptz not null default now(),
  primary key (location_id, product_id)
);

-- Food cost figures without a signed-in user (scheduled reports). The public report keeps its permission check.
create or replace function app.food_cost_data(p_from date, p_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loc uuid := app.primary_location_id();
  v_start timestamptz;
  v_end timestamptz;
  v_sales numeric;
  v_products jsonb;
  v_tot jsonb;
  v_theo numeric;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    perform app.fail('VALIDATION', 'Choose a valid date range (max 400 days).');
  end if;
  v_start := app.range_start(p_from);
  v_end := app.range_start(p_to + 1);

  select coalesce(sum(net_amount), 0) into v_sales from public.sales_transactions
   where location_id = v_loc and business_date between p_from and p_to and not is_void;
  select coalesce(sum(tu.extended_cost), 0) into v_theo from public.theoretical_usage tu
    join public.sales_transactions s on s.id = tu.sales_transaction_id
   where s.location_id = v_loc and tu.business_date between p_from and p_to;

  -- Per product (food categories only), from the immutable ledger.
  with t as (
    select t.product_id, t.txn_type, t.source_type, t.quantity, t.extended_cost, t.occurred_at
      from public.inventory_transactions t
      join public.products p on p.id = t.product_id
      left join public.categories c on c.id = p.category_id
     where t.location_id = v_loc and coalesce(c.is_food, true) and t.occurred_at < v_end
  ),
  agg as (
    select product_id,
      sum(quantity) filter (where occurred_at < v_start) as begin_qty,
      sum(extended_cost) filter (where occurred_at < v_start) as begin_value,
      sum(quantity) filter (where occurred_at >= v_start and (txn_type in ('RECEIPT', 'RETURN_TO_VENDOR', 'COMMISSARY_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT')
                              or (txn_type = 'CORRECTION' and source_type = 'transfer_item'))) as purchased_qty,
      sum(extended_cost) filter (where occurred_at >= v_start and (txn_type in ('RECEIPT', 'RETURN_TO_VENDOR', 'COMMISSARY_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT')
                              or (txn_type = 'CORRECTION' and source_type = 'transfer_item'))) as purchased_value,
      -sum(quantity) filter (where occurred_at >= v_start and txn_type = 'POS_THEORETICAL_CONSUMPTION' and source_type = 'sales_transaction') as theoretical_qty,
      -sum(extended_cost) filter (where occurred_at >= v_start and txn_type = 'POS_THEORETICAL_CONSUMPTION' and source_type = 'sales_transaction') as theoretical_value,
      -sum(quantity) filter (where occurred_at >= v_start and txn_type = 'WASTE') as waste_qty,
      -sum(extended_cost) filter (where occurred_at >= v_start and txn_type = 'WASTE') as waste_value,
      sum(quantity) filter (where occurred_at >= v_start and txn_type = 'PHYSICAL_VARIANCE') as count_variance_qty,
      sum(extended_cost) filter (where occurred_at >= v_start and txn_type = 'PHYSICAL_VARIANCE') as count_variance_value,
      sum(quantity) as end_qty,
      sum(extended_cost) as end_value
    from t group by product_id
  ),
  rows as (
    select a.*, p.name, p.inventory_unit, coalesce(c.name, 'Uncategorized') as category,
      coalesce(a.begin_value, 0) + coalesce(a.purchased_value, 0) - coalesce(a.end_value, 0) as actual_value,
      coalesce(a.begin_qty, 0) + coalesce(a.purchased_qty, 0) - coalesce(a.end_qty, 0) as actual_qty
      from agg a join public.products p on p.id = a.product_id left join public.categories c on c.id = p.category_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', product_id, 'name', name, 'category', category, 'inventory_unit', inventory_unit,
      'begin_qty', round(coalesce(begin_qty, 0), 4), 'begin_value', round(coalesce(begin_value, 0), 2),
      'purchased_qty', round(coalesce(purchased_qty, 0), 4), 'purchased_value', round(coalesce(purchased_value, 0), 2),
      'theoretical_qty', round(coalesce(theoretical_qty, 0), 4), 'theoretical_value', round(coalesce(theoretical_value, 0), 2),
      'waste_qty', round(coalesce(waste_qty, 0), 4), 'waste_value', round(coalesce(waste_value, 0), 2),
      'expected_qty', round(coalesce(begin_qty, 0) + coalesce(purchased_qty, 0) - coalesce(theoretical_qty, 0) - coalesce(waste_qty, 0), 4),
      'end_qty', round(coalesce(end_qty, 0), 4), 'end_value', round(coalesce(end_value, 0), 2),
      'count_variance_qty', round(coalesce(count_variance_qty, 0), 4), 'count_variance_value', round(coalesce(count_variance_value, 0), 2),
      'actual_qty', round(actual_qty, 4), 'actual_value', round(actual_value, 2),
      'variance_value', round(actual_value - coalesce(theoretical_value, 0), 2))
      order by abs(actual_value - coalesce(theoretical_value, 0)) desc, name), '[]'::jsonb),
    jsonb_build_object('begin', round(coalesce(sum(begin_value), 0), 2), 'purchases', round(coalesce(sum(purchased_value), 0), 2),
      'end', round(coalesce(sum(end_value), 0), 2),
      -- from the rounded totals, so beginning + purchases - ending adds up to the cent on screen
      'actual', round(coalesce(sum(begin_value), 0), 2) + round(coalesce(sum(purchased_value), 0), 2) - round(coalesce(sum(end_value), 0), 2),
      'waste', round(coalesce(sum(waste_value), 0), 2), 'count_variance', round(coalesce(sum(count_variance_value), 0), 2))
    into v_products, v_tot
    from rows
   where coalesce(begin_qty, 0) <> 0 or coalesce(purchased_qty, 0) <> 0 or coalesce(end_qty, 0) <> 0 or actual_value <> 0;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'sales', round(v_sales, 2),
    'beginning_inventory', (v_tot ->> 'begin')::numeric,
    'purchases', (v_tot ->> 'purchases')::numeric,
    'ending_inventory', (v_tot ->> 'end')::numeric,
    'actual_cost', (v_tot ->> 'actual')::numeric,
    'theoretical_cost', round(v_theo, 2),
    'variance', round((v_tot ->> 'actual')::numeric - v_theo, 2),
    'actual_pct', case when v_sales > 0 then round((v_tot ->> 'actual')::numeric / v_sales * 100, 1) end,
    'theoretical_pct', case when v_sales > 0 then round(v_theo / v_sales * 100, 1) end,
    'variance_pts', case when v_sales > 0 then round(((v_tot ->> 'actual')::numeric - v_theo) / v_sales * 100, 1) end,
    'waste', (v_tot ->> 'waste')::numeric,
    'count_variance', (v_tot ->> 'count_variance')::numeric,
    'counts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'count_type', count_type, 'posted_at', posted_at) order by posted_at), '[]'::jsonb)
                 from public.inventory_count_sessions where location_id = v_loc and status = 'POSTED'
                  and count_type in ('weekly_full', 'month_end') and posted_at >= v_start - interval '1 day' and posted_at < v_end),
    'unmapped_sales', (select coalesce(sum(net_amount), 0) from public.sales_transactions
                        where location_id = v_loc and business_date between p_from and p_to and usage_status = 'unmapped'),
    'products', v_products,
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('category', x.category, 'actual_value', x.a, 'theoretical_value', x.t,
                     'waste_value', x.w, 'variance_value', x.a - x.t) order by x.a - x.t desc), '[]'::jsonb)
                     from (select e ->> 'category' as category, sum((e ->> 'actual_value')::numeric) as a, sum((e ->> 'theoretical_value')::numeric) as t,
                                  sum((e ->> 'waste_value')::numeric) as w
                             from jsonb_array_elements(v_products) e group by 1) x),
    'recipes', (select coalesce(jsonb_agg(jsonb_build_object('recipe_id', x.recipe_id, 'name', x.name, 'quantity', x.q, 'net_sales', x.amt,
                   'theoretical_cost', x.c, 'theoretical_pct', case when x.amt > 0 then round(x.c / x.amt * 100, 1) end) order by x.c desc), '[]'::jsonb)
                  from (select s.recipe_id, coalesce(r.name, s.item_name) as name, sum(s.quantity) as q, sum(s.net_amount) as amt,
                               round(coalesce(sum((select sum(tu.extended_cost) from public.theoretical_usage tu where tu.sales_transaction_id = s.id)), 0), 2) as c
                          from public.sales_transactions s left join public.recipes r on r.id = s.recipe_id
                         where s.location_id = v_loc and s.business_date between p_from and p_to and not s.is_void and s.quantity > 0
                         group by s.recipe_id, coalesce(r.name, s.item_name)) x),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('date', d.d, 'net_sales', d.amt, 'theoretical_cost', d.c,
                 'theoretical_pct', case when d.amt > 0 then round(d.c / d.amt * 100, 1) end) order by d.d), '[]'::jsonb)
               from (select s.business_date as d, sum(s.net_amount) as amt,
                            round(coalesce(sum((select sum(tu.extended_cost) from public.theoretical_usage tu where tu.sales_transaction_id = s.id)), 0), 2) as c
                       from public.sales_transactions s
                      where s.location_id = v_loc and s.business_date between p_from and p_to and not s.is_void
                      group by s.business_date) d)
  );
end;
$$;

create or replace function public.food_cost_report(p_from date, p_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('reports.financial');
begin
  return app.food_cost_data(p_from, p_to);
end;
$$;

create or replace function public.food_cost_report_service(p_from date, p_to date)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select app.food_cost_data(p_from, p_to)
$$;

alter table public.alert_email_log enable row level security;
alter table public.stock_alert_state enable row level security;
revoke all on public.alert_email_log, public.stock_alert_state from anon, authenticated;
grant select on public.alert_email_log to authenticated;
create policy alert_email_log_select on public.alert_email_log for select to authenticated using ((select app.has_permission('email.manage')));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.food_cost_report_service(date, date) from public, anon, authenticated;
grant execute on function public.food_cost_report_service(date, date) to service_role;
