-- =============================================================================
-- 0008 TASKS, DASHBOARD METRICS, ATTENTION CENTER
-- All dashboard numbers are computed from stored data. Values that depend on
-- integrations that are not connected yet (Toast sales) are returned as NULL
-- with an explicit flag, never invented.
-- =============================================================================

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 120),
  description text check (description is null or length(description) <= 1000),
  task_type text not null default 'custom' check (task_type in ('weekly_inventory', 'place_order', 'review_waste',
    'receive_commissary', 'resolve_discrepancy', 'review_variance', 'custom')),
  assigned_role public.account_role,
  assigned_employee_id uuid references public.employees(id),
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'complete', 'cancelled')),
  link_path text check (link_path is null or link_path ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  recurrence jsonb,
  created_by uuid references public.account_profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.account_profiles(id),
  completed_employee_id uuid references public.employees(id),
  completion_notes text check (completion_notes is null or length(completion_notes) <= 500),
  constraint tasks_recurrence_shape check (recurrence is null or (
    recurrence ->> 'freq' in ('daily', 'weekly')
    and (recurrence ->> 'freq' = 'daily' or (recurrence ->> 'weekday') ~ '^[0-6]$')
    and (recurrence ->> 'time') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
comment on column public.tasks.recurrence is '{"freq":"weekly","weekday":0-6,"time":"HH:MM"} or {"freq":"daily","time":"HH:MM"} in the organization time zone.';
create index tasks_open_idx on public.tasks (status, due_at);

create or replace function app.task_display_status(p_status text, p_due_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_status = 'complete' then 'COMPLETE'
    when p_status = 'cancelled' then 'CANCELLED'
    when p_due_at < now() then 'OVERDUE'
    when (p_due_at at time zone app.org_timezone())::date = (now() at time zone app.org_timezone())::date then 'DUE_TODAY'
    else 'UPCOMING'
  end
$$;

-- Next due time strictly after p_after for a recurrence rule (org time zone).
create or replace function app.next_occurrence(p_rule jsonb, p_after timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := app.org_timezone();
  v_local timestamp := p_after at time zone v_tz;
  v_time time := (p_rule ->> 'time')::time;
  v_candidate timestamp;
  v_i int;
begin
  for v_i in 0..8 loop
    v_candidate := (v_local::date + v_i) + v_time;
    if (p_rule ->> 'freq' = 'daily' or extract(dow from v_candidate)::int = (p_rule ->> 'weekday')::int)
       and (v_candidate at time zone v_tz) > p_after then
      return v_candidate at time zone v_tz;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function public.create_task(p jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('tasks.manage');
  v_id uuid;
  v_due timestamptz := nullif(p ->> 'due_at', '')::timestamptz;
  v_rec jsonb := case when jsonb_typeof(p -> 'recurrence') = 'object' then p -> 'recurrence' end;
begin
  if v_due is null and v_rec is not null then
    v_due := app.next_occurrence(v_rec, now());
  end if;
  if v_due is null then
    perform app.fail('VALIDATION', 'Choose when the task is due.');
  end if;
  if nullif(p ->> 'assigned_employee_id', '') is not null and not exists (
       select 1 from public.employees where id = (p ->> 'assigned_employee_id')::uuid and is_active) then
    perform app.fail('VALIDATION', 'Assign the task to an active employee.');
  end if;
  insert into public.tasks (title, description, task_type, assigned_role, assigned_employee_id, due_at, link_path,
                            recurrence, created_by)
  values (trim(p ->> 'title'), nullif(trim(p ->> 'description'), ''), coalesce(nullif(p ->> 'task_type', ''), 'custom'),
          nullif(p ->> 'assigned_role', '')::public.account_role, nullif(p ->> 'assigned_employee_id', '')::uuid,
          v_due, nullif(p ->> 'link_path', ''), v_rec, v_actor.account_id)
  returning id into v_id;
  perform app.audit(v_actor, 'task.created', 'operations', app.actor_label(v_actor) || ' created task "' || trim(p ->> 'title') || '"',
    'tasks', v_id::text);
  return v_id;
end;
$$;

-- Tasks visible to the caller. Employees: tasks for the employee role or for themselves.
create or replace function public.list_tasks(p_include_done boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('tasks.view');
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'description', t.description, 'task_type', t.task_type,
      'assigned_role', t.assigned_role, 'assigned_employee', e.display_name, 'due_at', t.due_at,
      'status', app.task_display_status(t.status, t.due_at), 'link_path', t.link_path,
      'recurring', t.recurrence is not null, 'completed_at', t.completed_at,
      'completed_by', coalesce(ce.display_name, cap.display_name))
      order by (t.status = 'open') desc, t.due_at), '[]'::jsonb)
    from public.tasks t
    left join public.employees e on e.id = t.assigned_employee_id
    left join public.employees ce on ce.id = t.completed_employee_id
    left join public.account_profiles cap on cap.id = t.completed_by
   where (t.status = 'open' or (p_include_done and t.completed_at > now() - interval '7 days'))
     and (v_actor.account_role in ('owner', 'manager')
          or (v_actor.account_role = 'employee'
              and (t.assigned_employee_id = v_actor.employee_id
                   or (t.assigned_employee_id is null and t.assigned_role = 'employee')))));
end;
$$;

create or replace function public.complete_task(p_task_id uuid, p_notes text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('tasks.view');
  v_t public.tasks;
  v_next uuid;
begin
  select * into v_t from public.tasks where id = p_task_id for update;
  if v_t.id is null then
    perform app.fail('NOT_FOUND', 'Task not found.');
  end if;
  -- coalesce(..., false): a NULL comparison must never pass this permission check.
  if v_actor.account_role = 'employee' and not coalesce(v_t.assigned_employee_id = v_actor.employee_id
       or (v_t.assigned_employee_id is null and v_t.assigned_role = 'employee'), false) then
    perform app.fail('FORBIDDEN', 'This task is not assigned to you.');
  end if;
  if v_t.status <> 'open' then
    return jsonb_build_object('status', 'already_' || v_t.status);
  end if;
  update public.tasks
     set status = 'complete', completed_at = now(), completed_by = v_actor.account_id,
         completed_employee_id = v_actor.employee_id, completion_notes = nullif(trim(p_notes), '')
   where id = v_t.id;
  if v_t.recurrence is not null then
    insert into public.tasks (title, description, task_type, assigned_role, assigned_employee_id, due_at, link_path,
                              recurrence, created_by)
    values (v_t.title, v_t.description, v_t.task_type, v_t.assigned_role, v_t.assigned_employee_id,
            app.next_occurrence(v_t.recurrence, greatest(v_t.due_at, now())), v_t.link_path, v_t.recurrence, v_t.created_by)
    returning id into v_next;
  end if;
  perform app.audit(v_actor, 'task.completed', 'operations', app.actor_label(v_actor) || ' completed task "' || v_t.title || '"',
    'tasks', v_t.id::text, p_metadata => jsonb_build_object('notes', p_notes, 'next_task_id', v_next));
  return jsonb_build_object('status', 'completed', 'next_task_id', v_next);
end;
$$;

create or replace function public.cancel_task(p_task_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('tasks.manage');
  v_t public.tasks;
begin
  update public.tasks set status = 'cancelled' where id = p_task_id and status = 'open' returning * into v_t;
  if v_t.id is null then
    perform app.fail('CONFLICT', 'Only open tasks can be cancelled.');
  end if;
  perform app.audit(v_actor, 'task.cancelled', 'operations', app.actor_label(v_actor) || ' cancelled task "' || v_t.title || '"',
    'tasks', v_t.id::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- Dashboard metrics for a date range (inclusive, organization time zone).
-- -----------------------------------------------------------------------------
create or replace function app.range_start(p_date date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (p_date::timestamp) at time zone app.org_timezone()
$$;

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
begin
  if not (app.has_permission('dashboard.owner') or app.has_permission('dashboard.manager')) then
    perform app.fail('FORBIDDEN', 'Not allowed.');
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    perform app.fail('VALIDATION', 'Choose a valid date range (max 400 days).');
  end if;
  v_start := app.range_start(p_from);
  v_end := app.range_start(p_to + 1);

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'financial_access', v_fin,
    'sales', jsonb_build_object('connected', false, 'amount', null,
                                'note', 'Toast sales are not connected yet.'),
    'food_cost', jsonb_build_object('actual_pct', null, 'theoretical_pct', null, 'variance_pts', null,
                                    'note', 'Food cost % requires Toast sales and recipes (later phase).'),
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

-- NEEDS ATTENTION: open alerts + stock problems + due tasks, most severe first.
create or replace function public.attention_center(p_limit integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('alerts.view');
  v_loc uuid := app.primary_location_id();
begin
  return (select coalesce(jsonb_agg(q.item order by q.rank, q.created_at desc), '[]'::jsonb) from (
    select u.item, u.rank, u.created_at from (
      select jsonb_build_object('kind', 'alert', 'id', a.id, 'type', a.alert_type, 'severity', a.severity,
               'title', a.title, 'message', a.message, 'link', a.link_path, 'created_at', a.created_at) as x,
             case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end as rank, a.created_at
        from public.alerts a where a.status = 'open'
      union all
      select jsonb_build_object('kind', 'stock', 'id', o.product_id, 'type', o.stock_status,
               'severity', case o.stock_status when 'LOW_STOCK' then 'warning' else 'critical' end,
               'title', replace(o.stock_status, '_', ' ') || ': ' || o.product_name,
               'message', trim(to_char(o.quantity, 'FM999999990.##')) || ' ' || o.inventory_unit || ' remaining' ||
                          coalesce(' (par ' || trim(to_char(o.par_level, 'FM999999990.##')) || ')', ''),
               'link', '/inventory/products/' || o.product_id, 'created_at', o.balance_updated_at),
             case o.stock_status when 'OUT_OF_STOCK' then 0 when 'CRITICAL' then 0 else 1 end, o.balance_updated_at
        from public.inventory_on_hand o
       where o.location_id = v_loc and o.is_active and o.stock_status <> 'HEALTHY'
      union all
      select jsonb_build_object('kind', 'task', 'id', t.id, 'type', 'TASK_' || app.task_display_status(t.status, t.due_at),
               'severity', case when t.due_at < now() then 'critical' else 'info' end,
               'title', replace(app.task_display_status(t.status, t.due_at), '_', ' ') || ': ' || t.title,
               'message', 'Due ' || to_char(t.due_at at time zone app.org_timezone(), 'Dy Mon DD HH12:MI AM'),
               'link', coalesce(t.link_path, '/tasks'), 'created_at', t.due_at),
             case when t.due_at < now() then 0 else 2 end, t.due_at
        from public.tasks t
       where t.status = 'open' and t.due_at < app.range_start((now() at time zone app.org_timezone())::date + 1)
    ) u(item, rank, created_at)
    order by u.rank, u.created_at desc
    limit greatest(least(p_limit, 100), 1)
  ) q);
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants
-- -----------------------------------------------------------------------------
alter table public.tasks enable row level security;
revoke all on public.tasks from anon, authenticated;
grant select on public.tasks to authenticated;
create policy tasks_select on public.tasks for select to authenticated using ((select app.is_management()));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.create_task(jsonb), public.list_tasks(boolean), public.complete_task(uuid, text),
  public.cancel_task(uuid), public.dashboard_metrics(date, date), public.attention_center(integer) from public, anon;
grant execute on function public.create_task(jsonb), public.list_tasks(boolean), public.complete_task(uuid, text),
  public.cancel_task(uuid), public.dashboard_metrics(date, date), public.attention_center(integer) to authenticated;
