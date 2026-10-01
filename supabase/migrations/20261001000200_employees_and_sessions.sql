-- =============================================================================
-- 0002 EMPLOYEES, PINS, EMPLOYEE SESSIONS, ALERTS, ACTOR RESOLUTION
--
-- The ONE shared employee login (account_profiles.role = 'employee') is used by
-- every regular employee. After signing in, a person must pick their name and
-- enter their personal 4-digit PIN. That creates an employee_session whose
-- random token is held in an httpOnly cookie by the web server and forwarded to
-- the database in the `x-employee-session` request header.
--
-- Every operational function calls app.require_actor(), which refuses to act
-- for the shared employee login unless a valid, unexpired, PIN-verified
-- employee session is present. The verified employee_id is then stored on the
-- business record and in the audit log next to the login account.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Employees (people). NOT login accounts.
-- -----------------------------------------------------------------------------
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null unique check (employee_code ~ '^[A-Za-z0-9_-]{1,20}$'),
  display_name text not null check (length(trim(display_name)) between 1 and 60),
  job_title text check (job_title is null or length(job_title) <= 60),
  department text check (department is null or length(department) <= 60),
  photo_path text check (photo_path is null or length(photo_path) <= 300),
  is_active boolean not null default true,
  is_demo boolean not null default false,
  last_activity_at timestamptz,
  deactivated_at timestamptz,
  created_by uuid references public.account_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.employees is 'Individual employees who identify themselves (name + PIN) under the shared employee login.';
comment on column public.employees.is_demo is 'True only for demo/seed records. Production setup must never contain demo employees.';
-- Two active employees cannot share a display name: the WHO ARE YOU? list must be unambiguous.
create unique index employees_active_name_uq on public.employees (lower(trim(display_name))) where is_active;
create trigger employees_touch before update on public.employees
  for each row execute function app.touch_updated_at();

alter table public.audit_logs
  add constraint audit_logs_employee_fk foreign key (employee_id) references public.employees(id);

-- PIN hashes live in their own table with NO grants to API roles at all.
create table public.employee_pins (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  pin_set_at timestamptz not null default now(),
  pin_set_by uuid references public.account_profiles(id)
);
comment on table public.employee_pins is 'bcrypt PIN hashes. Never readable by any API role. PINs can be reset, never retrieved.';

create table public.employee_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  employee_id uuid not null references public.employees(id),
  account_id uuid not null references public.account_profiles(id),
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason in ('switched', 'locked', 'idle_timeout', 'signed_out', 'pin_reset', 'deactivated', 'expired', 'replaced')),
  ip text,
  user_agent text
);
create index employee_sessions_employee_idx on public.employee_sessions (employee_id, started_at desc);
create index employee_sessions_open_idx on public.employee_sessions (account_id) where ended_at is null;

create table public.employee_pin_attempts (
  id bigint generated always as identity primary key,
  attempted_at timestamptz not null default now(),
  account_id uuid references public.account_profiles(id),
  employee_id uuid references public.employees(id),
  result text not null check (result in ('ok', 'invalid', 'locked', 'device_locked', 'unavailable', 'bad_format')),
  ip text,
  user_agent text
);
create index employee_pin_attempts_account_idx on public.employee_pin_attempts (account_id, attempted_at desc);
create index employee_pin_attempts_employee_idx on public.employee_pin_attempts (employee_id, attempted_at desc);

-- -----------------------------------------------------------------------------
-- Alerts (management attention center). Emails are layered on later.
-- -----------------------------------------------------------------------------
create type public.alert_severity as enum ('info', 'warning', 'critical');

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null check (alert_type ~ '^[A-Z_]+$'),
  severity public.alert_severity not null default 'warning',
  title text not null,
  message text not null,
  entity_type text,
  entity_id text,
  link_path text check (link_path is null or link_path ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  location_id uuid references public.locations(id),
  product_id uuid,
  vendor_id uuid,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  dedupe_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.account_profiles(id),
  resolved_at timestamptz,
  resolved_by uuid references public.account_profiles(id),
  emailed_at timestamptz
);
create unique index alerts_open_dedupe_uq on public.alerts (dedupe_key)
  where status <> 'resolved' and dedupe_key is not null;
create index alerts_status_idx on public.alerts (status, created_at desc);

create or replace function app.raise_alert(
  p_type text, p_severity public.alert_severity, p_title text, p_message text,
  p_entity_type text default null, p_entity_id text default null, p_link text default null,
  p_dedupe_key text default null, p_product_id uuid default null, p_vendor_id uuid default null,
  p_location_id uuid default null, p_metadata jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.alerts (alert_type, severity, title, message, entity_type, entity_id, link_path,
                             dedupe_key, product_id, vendor_id, location_id, metadata)
  values (p_type, p_severity, p_title, p_message, p_entity_type, p_entity_id, p_link,
          p_dedupe_key, p_product_id, p_vendor_id, p_location_id, coalesce(p_metadata, '{}'::jsonb))
  on conflict (dedupe_key) where status <> 'resolved' and dedupe_key is not null
  do update set message = excluded.message, severity = greatest(public.alerts.severity, excluded.severity),
                metadata = public.alerts.metadata || excluded.metadata
  returning id into v_id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Employee session resolution
-- -----------------------------------------------------------------------------
create or replace function app.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_token is null or length(p_token) < 32 then null
              else encode(extensions.digest(p_token, 'sha256'), 'hex') end
$$;

-- Returns the valid employee session for the current request, or NULL.
create or replace function app.current_employee_session()
returns public.employee_sessions
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
    from public.employee_sessions s
    join public.employees e on e.id = s.employee_id and e.is_active
    join public.account_profiles ap on ap.id = s.account_id and ap.is_active and ap.role = 'employee'
   where s.token_hash = app.hash_token(app.request_header('x-employee-session'))
     and s.account_id = auth.uid()
     and s.ended_at is null
     and s.last_activity_at > now() - make_interval(mins => app.setting_numeric('employee.idle_timeout_minutes', 5)::int)
     and s.started_at > now() - make_interval(hours => app.setting_numeric('employee.max_session_hours', 12)::int)
$$;

create or replace function app.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select (app.current_employee_session()).employee_id
$$;

-- Read access gate used by RLS: management accounts, or the shared employee
-- login WITH a verified employee session.
create or replace function app.can_read_operational()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case app.current_account_role()
           when 'owner' then true
           when 'manager' then true
           when 'employee' then app.current_employee_id() is not null
           else false
         end
$$;

-- The acting identity for a write: login account + verified employee (if any).
create type app.actor as (
  account_id uuid,
  account_role public.account_role,
  account_name text,
  employee_id uuid,
  employee_name text,
  session_id uuid,
  ip text,
  user_agent text
);

-- Display label used in audit summaries: the person, not the shared login.
create or replace function app.actor_label(p_actor app.actor)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_actor.employee_name, p_actor.account_name, 'System')
$$;

-- Must be called first by every operational function.
--  * refuses anonymous / inactive accounts
--  * checks the permission (owner has all)
--  * for the shared employee login, REQUIRES a valid PIN-verified employee session
--    and records activity on it (inactivity timeout is measured from here)
create or replace function app.require_actor(p_permission text)
returns app.actor
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc public.account_profiles;
  v_sess public.employee_sessions;
  v_actor app.actor;
begin
  select * into v_acc from public.account_profiles where id = auth.uid() and is_active;
  if v_acc.id is null then
    perform app.fail('NOT_AUTHENTICATED', 'Please sign in.');
  end if;

  if v_acc.role = 'employee' then
    v_sess := app.current_employee_session();
    if v_sess.id is null then
      perform app.fail('EMPLOYEE_SESSION_REQUIRED', 'Select your name and enter your PIN to continue.');
    end if;
  end if;

  if p_permission is not null and not app.has_permission(p_permission) then
    perform app.fail('FORBIDDEN', 'Your account is not allowed to do this.');
  end if;

  v_actor.account_id := v_acc.id;
  v_actor.account_role := v_acc.role;
  v_actor.account_name := v_acc.display_name;
  v_actor.ip := left(app.request_header('x-client-ip'), 100);
  v_actor.user_agent := left(app.request_header('x-client-ua'), 300);

  if v_sess.id is not null then
    update public.employee_sessions set last_activity_at = now() where id = v_sess.id;
    update public.employees set last_activity_at = now() where id = v_sess.employee_id;
    v_actor.session_id := v_sess.id;
    v_actor.employee_id := v_sess.employee_id;
    select display_name into v_actor.employee_name from public.employees where id = v_sess.employee_id;
  end if;
  return v_actor;
end;
$$;

create or replace function app.audit(
  p_actor app.actor, p_action text, p_category text, p_summary text,
  p_entity_type text default null, p_entity_id text default null,
  p_product_id uuid default null, p_vendor_id uuid default null, p_location_id uuid default null,
  p_old jsonb default null, p_new jsonb default null, p_reason text default null,
  p_metadata jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.audit_logs (account_id, account_role, account_name, employee_id, employee_name,
    action, category, entity_type, entity_id, summary, product_id, vendor_id, location_id,
    old_values, new_values, reason, ip, user_agent, metadata)
  values (p_actor.account_id, p_actor.account_role, p_actor.account_name, p_actor.employee_id, p_actor.employee_name,
    p_action, p_category, p_entity_type, p_entity_id, p_summary, p_product_id, p_vendor_id, p_location_id,
    p_old, p_new, p_reason, p_actor.ip, p_actor.user_agent,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('employee_session_id', p_actor.session_id))
  returning id into v_id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- PIN rules
-- -----------------------------------------------------------------------------
create or replace function app.validate_new_pin(p_pin text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    perform app.fail('VALIDATION', 'PIN must be exactly 4 digits.');
  end if;
  -- Reject trivially guessable PINs: all the same digit, or straight sequences.
  if p_pin ~ '^(\d)\1{3}$' or p_pin in ('0123','1234','2345','3456','4567','5678','6789',
                                         '9876','8765','7654','6543','5432','4321','3210') then
    perform app.fail('VALIDATION', 'That PIN is too easy to guess. Avoid repeated digits and sequences like 1234.');
  end if;
end;
$$;

create or replace function app.hash_pin(p_pin text)
returns text
language sql
volatile
set search_path = ''
as $$
  select extensions.crypt(p_pin, extensions.gen_salt('bf', 8))
$$;

-- -----------------------------------------------------------------------------
-- PUBLIC API: shared-device employee identification
-- -----------------------------------------------------------------------------

-- WHO ARE YOU? list. Only for the shared employee login.
create or replace function public.list_employee_picker()
returns table (id uuid, display_name text, job_title text, photo_path text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_account_role() is distinct from 'employee' then
    perform app.fail('FORBIDDEN', 'Only the shared employee login uses the employee picker.');
  end if;
  return query
    select e.id, e.display_name, e.job_title, e.photo_path
      from public.employees e
     where e.is_active
       and exists (select 1 from public.employee_pins p where p.employee_id = e.id)
     order by lower(e.display_name);
end;
$$;

-- Verify an employee's PIN and open an employee session.
-- Returns JSON (never raises for a wrong PIN, so failure counters are committed):
--   {status:'ok', token, employee:{id,display_name}, idle_timeout_minutes}
--   {status:'invalid_pin', attempts_remaining}
--   {status:'locked', locked_until}
--   {status:'device_locked', retry_after}
--   {status:'unavailable'}
create or replace function public.start_employee_session(p_employee_id uuid, p_pin text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc public.account_profiles;
  v_emp public.employees;
  v_pin public.employee_pins;
  v_ip text := left(app.request_header('x-client-ip'), 100);
  v_ua text := left(app.request_header('x-client-ua'), 300);
  v_max_attempts int := greatest(app.setting_numeric('employee.pin_max_attempts', 5)::int, 1);
  v_lock_minutes int := greatest(app.setting_numeric('employee.pin_lock_minutes', 10)::int, 1);
  v_device_max int := greatest(app.setting_numeric('employee.device_max_failures', 15)::int, 1);
  v_recent_failures int;
  v_token text;
  v_session_id uuid;
  v_actor app.actor;
begin
  select * into v_acc from public.account_profiles where id = auth.uid() and is_active;
  if v_acc.id is null then
    perform app.fail('NOT_AUTHENTICATED', 'Please sign in.');
  end if;
  if v_acc.role <> 'employee' then
    perform app.fail('FORBIDDEN', 'Only the shared employee login uses employee PINs.');
  end if;

  v_actor.account_id := v_acc.id; v_actor.account_role := v_acc.role; v_actor.account_name := v_acc.display_name;
  v_actor.ip := v_ip; v_actor.user_agent := v_ua;

  -- Device/account-wide throttle: stops guessing across many employees.
  select count(*) into v_recent_failures
    from public.employee_pin_attempts
   where account_id = v_acc.id and result = 'invalid' and attempted_at > now() - interval '15 minutes';
  if v_recent_failures >= v_device_max then
    insert into public.employee_pin_attempts (account_id, employee_id, result, ip, user_agent)
    values (v_acc.id, p_employee_id, 'device_locked', v_ip, v_ua);
    perform app.raise_alert('SUSPICIOUS_PIN_ACTIVITY', 'critical', 'Repeated wrong employee PINs',
      'PIN entry on the shared employee login was paused after ' || v_recent_failures ||
      ' wrong PINs in 15 minutes.', 'account_profiles', v_acc.id::text, '/admin/audit',
      'device-pin-lock:' || v_acc.id || ':' || to_char(now(), 'YYYYMMDDHH24'));
    return jsonb_build_object('status', 'device_locked',
      'retry_after', (select max(attempted_at) + interval '15 minutes' from public.employee_pin_attempts
                       where account_id = v_acc.id and result = 'invalid'));
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    insert into public.employee_pin_attempts (account_id, employee_id, result, ip, user_agent)
    values (v_acc.id, p_employee_id, 'bad_format', v_ip, v_ua);
    return jsonb_build_object('status', 'invalid_pin', 'attempts_remaining', null);
  end if;

  select * into v_emp from public.employees where id = p_employee_id and is_active;
  -- Lock the PIN row so parallel guesses are serialized and counted correctly.
  select * into v_pin from public.employee_pins where employee_id = p_employee_id for update;
  if v_emp.id is null or v_pin.employee_id is null then
    insert into public.employee_pin_attempts (account_id, employee_id, result, ip, user_agent)
    values (v_acc.id, case when v_emp.id is null then null else p_employee_id end, 'unavailable', v_ip, v_ua);
    return jsonb_build_object('status', 'unavailable');
  end if;

  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    insert into public.employee_pin_attempts (account_id, employee_id, result, ip, user_agent)
    values (v_acc.id, v_emp.id, 'locked', v_ip, v_ua);
    return jsonb_build_object('status', 'locked', 'locked_until', v_pin.locked_until);
  end if;

  if extensions.crypt(p_pin, v_pin.pin_hash) <> v_pin.pin_hash then
    insert into public.employee_pin_attempts (account_id, employee_id, result, ip, user_agent)
    values (v_acc.id, v_emp.id, 'invalid', v_ip, v_ua);

    if v_pin.failed_attempts + 1 >= v_max_attempts then
      update public.employee_pins
         set failed_attempts = 0, locked_until = now() + make_interval(mins => v_lock_minutes)
       where employee_id = v_emp.id;
      v_actor.employee_id := v_emp.id; v_actor.employee_name := v_emp.display_name;
      perform app.audit(v_actor, 'employee.pin_locked', 'security',
        'PIN entry for ' || v_emp.display_name || ' locked for ' || v_lock_minutes ||
        ' minutes after ' || v_max_attempts || ' wrong attempts',
        'employees', v_emp.id::text, p_metadata => jsonb_build_object('attempts', v_max_attempts));
      perform app.raise_alert('EMPLOYEE_PIN_LOCKED', 'warning', 'Employee PIN locked',
        v_emp.display_name || '''s PIN was locked after ' || v_max_attempts || ' wrong attempts.',
        'employees', v_emp.id::text, '/employees/' || v_emp.id,
        'pin-lock:' || v_emp.id || ':' || to_char(now(), 'YYYYMMDDHH24MI'));
      return jsonb_build_object('status', 'locked', 'locked_until', now() + make_interval(mins => v_lock_minutes));
    end if;

    update public.employee_pins set failed_attempts = failed_attempts + 1 where employee_id = v_emp.id;
    return jsonb_build_object('status', 'invalid_pin', 'attempts_remaining', v_max_attempts - (v_pin.failed_attempts + 1));
  end if;

  -- Success
  update public.employee_pins set failed_attempts = 0, locked_until = null where employee_id = v_emp.id;
  insert into public.employee_pin_attempts (account_id, employee_id, result, ip, user_agent)
  values (v_acc.id, v_emp.id, 'ok', v_ip, v_ua);

  -- If this device still had a session open (sent in the header), close it.
  update public.employee_sessions
     set ended_at = now(), end_reason = 'replaced'
   where token_hash = app.hash_token(app.request_header('x-employee-session'))
     and account_id = v_acc.id and ended_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.employee_sessions (token_hash, employee_id, account_id, ip, user_agent)
  values (app.hash_token(v_token), v_emp.id, v_acc.id, v_ip, v_ua)
  returning id into v_session_id;
  update public.employees set last_activity_at = now() where id = v_emp.id;

  v_actor.employee_id := v_emp.id; v_actor.employee_name := v_emp.display_name; v_actor.session_id := v_session_id;
  perform app.audit(v_actor, 'employee.session_started', 'security',
    v_emp.display_name || ' identified with PIN on ' || v_acc.display_name,
    'employee_sessions', v_session_id::text);

  return jsonb_build_object(
    'status', 'ok',
    'token', v_token,
    'employee', jsonb_build_object('id', v_emp.id, 'display_name', v_emp.display_name),
    'idle_timeout_minutes', app.setting_numeric('employee.idle_timeout_minutes', 5));
end;
$$;

-- Ends the employee session named by the request header (switch / lock / idle).
create or replace function public.end_employee_session(p_reason text default 'switched')
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sess public.employee_sessions;
  v_actor app.actor;
begin
  if p_reason not in ('switched', 'locked', 'idle_timeout', 'signed_out') then
    perform app.fail('VALIDATION', 'Unknown reason.');
  end if;
  update public.employee_sessions
     set ended_at = now(), end_reason = p_reason
   where token_hash = app.hash_token(app.request_header('x-employee-session'))
     and account_id = auth.uid() and ended_at is null
  returning * into v_sess;

  if v_sess.id is not null then
    select ap.id, ap.role, ap.display_name into v_actor.account_id, v_actor.account_role, v_actor.account_name
      from public.account_profiles ap where ap.id = v_sess.account_id;
    v_actor.employee_id := v_sess.employee_id;
    select display_name into v_actor.employee_name from public.employees where id = v_sess.employee_id;
    v_actor.session_id := v_sess.id;
    v_actor.ip := left(app.request_header('x-client-ip'), 100);
    v_actor.user_agent := left(app.request_header('x-client-ua'), 300);
    perform app.audit(v_actor, 'employee.session_ended', 'security',
      v_actor.employee_name || ' session ended (' || replace(p_reason, '_', ' ') || ')',
      'employee_sessions', v_sess.id::text);
  end if;
end;
$$;

-- Everything the web app needs to render the shell for the signed-in account.
-- For the shared employee login this also validates (and refreshes activity on)
-- the employee session; `employee` is null when the person must identify again.
create or replace function public.get_my_context()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc public.account_profiles;
  v_sess public.employee_sessions;
  v_emp jsonb;
  v_loc public.locations;
begin
  select * into v_acc from public.account_profiles where id = auth.uid() and is_active;
  if v_acc.id is null then
    return null;
  end if;

  if v_acc.role = 'employee' then
    v_sess := app.current_employee_session();
    if v_sess.id is not null then
      update public.employee_sessions set last_activity_at = now() where id = v_sess.id;
      select jsonb_build_object('id', e.id, 'display_name', e.display_name, 'session_started_at', v_sess.started_at)
        into v_emp from public.employees e where e.id = v_sess.employee_id;
    end if;
  end if;

  select * into v_loc from public.locations
   where id = coalesce(v_acc.default_location_id, app.primary_location_id());

  return jsonb_build_object(
    'account', jsonb_build_object('id', v_acc.id, 'role', v_acc.role, 'display_name', v_acc.display_name),
    'permissions', (select coalesce(jsonb_agg(p.code order by p.code), '[]'::jsonb)
                      from public.permissions p where app.has_permission(p.code)),
    'organization', (select jsonb_build_object('name', o.name, 'timezone', o.timezone) from public.organizations o limit 1),
    'location', case when v_loc.id is null then null
                     else jsonb_build_object('id', v_loc.id, 'name', v_loc.name, 'code', v_loc.code) end,
    'employee', v_emp,
    'idle_timeout_minutes', app.setting_numeric('employee.idle_timeout_minutes', 5));
end;
$$;

-- -----------------------------------------------------------------------------
-- PUBLIC API: employee profile management (owner / authorized management)
-- -----------------------------------------------------------------------------
create or replace function public.create_employee(
  p_display_name text, p_employee_code text, p_pin text,
  p_job_title text default null, p_department text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('employees.manage');
  v_id uuid;
  v_name text := trim(p_display_name);
begin
  if v_name is null or length(v_name) = 0 or length(v_name) > 60 then
    perform app.fail('VALIDATION', 'Employee name is required (max 60 characters).');
  end if;
  if p_employee_code is null or trim(p_employee_code) !~ '^[A-Za-z0-9_-]{1,20}$' then
    perform app.fail('VALIDATION', 'Employee ID must be 1-20 letters, numbers, dashes or underscores.');
  end if;
  perform app.validate_new_pin(p_pin);
  if exists (select 1 from public.employees where lower(trim(display_name)) = lower(v_name) and is_active) then
    perform app.fail('DUPLICATE', 'An active employee named "' || v_name || '" already exists. Add a last initial to tell them apart.');
  end if;
  if exists (select 1 from public.employees where employee_code = trim(p_employee_code)) then
    perform app.fail('DUPLICATE', 'Employee ID "' || trim(p_employee_code) || '" is already used.');
  end if;

  insert into public.employees (display_name, employee_code, job_title, department, created_by)
  values (v_name, trim(p_employee_code), nullif(trim(p_job_title), ''), nullif(trim(p_department), ''), v_actor.account_id)
  returning id into v_id;
  insert into public.employee_pins (employee_id, pin_hash, pin_set_by)
  values (v_id, app.hash_pin(p_pin), v_actor.account_id);

  perform app.audit(v_actor, 'employee.created', 'admin', app.actor_label(v_actor) || ' added employee ' || v_name,
    'employees', v_id::text,
    p_new => jsonb_build_object('display_name', v_name, 'employee_code', trim(p_employee_code),
                                'job_title', p_job_title, 'department', p_department));
  return v_id;
end;
$$;

create or replace function public.update_employee(
  p_employee_id uuid, p_display_name text, p_employee_code text,
  p_job_title text default null, p_department text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('employees.manage');
  v_old public.employees;
  v_name text := trim(p_display_name);
begin
  select * into v_old from public.employees where id = p_employee_id for update;
  if v_old.id is null then
    perform app.fail('NOT_FOUND', 'Employee not found.');
  end if;
  if v_name is null or length(v_name) = 0 or length(v_name) > 60 then
    perform app.fail('VALIDATION', 'Employee name is required (max 60 characters).');
  end if;
  if p_employee_code is null or trim(p_employee_code) !~ '^[A-Za-z0-9_-]{1,20}$' then
    perform app.fail('VALIDATION', 'Employee ID must be 1-20 letters, numbers, dashes or underscores.');
  end if;
  if v_old.is_active and exists (select 1 from public.employees
              where lower(trim(display_name)) = lower(v_name) and is_active and id <> p_employee_id) then
    perform app.fail('DUPLICATE', 'An active employee named "' || v_name || '" already exists.');
  end if;
  if exists (select 1 from public.employees where employee_code = trim(p_employee_code) and id <> p_employee_id) then
    perform app.fail('DUPLICATE', 'Employee ID "' || trim(p_employee_code) || '" is already used.');
  end if;

  update public.employees
     set display_name = v_name, employee_code = trim(p_employee_code),
         job_title = nullif(trim(p_job_title), ''), department = nullif(trim(p_department), '')
   where id = p_employee_id;

  perform app.audit(v_actor, 'employee.updated', 'admin',
    app.actor_label(v_actor) || ' updated employee ' || v_name ||
      case when v_old.display_name <> v_name then ' (was ' || v_old.display_name || ')' else '' end,
    'employees', p_employee_id::text,
    p_old => jsonb_build_object('display_name', v_old.display_name, 'employee_code', v_old.employee_code,
                                'job_title', v_old.job_title, 'department', v_old.department),
    p_new => jsonb_build_object('display_name', v_name, 'employee_code', trim(p_employee_code),
                                'job_title', nullif(trim(p_job_title), ''), 'department', nullif(trim(p_department), '')));
end;
$$;

-- Deactivation keeps all history; it only removes the person from WHO ARE YOU?
create or replace function public.set_employee_active(p_employee_id uuid, p_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('employees.manage');
  v_emp public.employees;
begin
  select * into v_emp from public.employees where id = p_employee_id for update;
  if v_emp.id is null then
    perform app.fail('NOT_FOUND', 'Employee not found.');
  end if;
  if v_emp.is_active = p_active then
    return;
  end if;
  if p_active and exists (select 1 from public.employees
        where lower(trim(display_name)) = lower(trim(v_emp.display_name)) and is_active and id <> p_employee_id) then
    perform app.fail('DUPLICATE', 'Another active employee is named "' || v_emp.display_name || '". Rename one first.');
  end if;

  update public.employees
     set is_active = p_active, deactivated_at = case when p_active then null else now() end
   where id = p_employee_id;

  if not p_active then
    update public.employee_sessions set ended_at = now(), end_reason = 'deactivated'
     where employee_id = p_employee_id and ended_at is null;
  end if;

  perform app.audit(v_actor, case when p_active then 'employee.reactivated' else 'employee.deactivated' end, 'admin',
    app.actor_label(v_actor) || case when p_active then ' reactivated ' else ' deactivated ' end || v_emp.display_name,
    'employees', p_employee_id::text,
    p_old => jsonb_build_object('is_active', v_emp.is_active), p_new => jsonb_build_object('is_active', p_active));
end;
$$;

-- PIN reset (never retrieval). Ends that employee's open sessions and clears lockout.
create or replace function public.reset_employee_pin(p_employee_id uuid, p_new_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('employees.reset_pin');
  v_emp public.employees;
begin
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    perform app.fail('NOT_FOUND', 'Employee not found.');
  end if;
  perform app.validate_new_pin(p_new_pin);

  insert into public.employee_pins (employee_id, pin_hash, pin_set_by, pin_set_at, failed_attempts, locked_until)
  values (p_employee_id, app.hash_pin(p_new_pin), v_actor.account_id, now(), 0, null)
  on conflict (employee_id) do update
     set pin_hash = excluded.pin_hash, pin_set_by = excluded.pin_set_by, pin_set_at = now(),
         failed_attempts = 0, locked_until = null;

  update public.employee_sessions set ended_at = now(), end_reason = 'pin_reset'
   where employee_id = p_employee_id and ended_at is null;

  perform app.audit(v_actor, 'employee.pin_reset', 'security',
    app.actor_label(v_actor) || ' reset the PIN for ' || v_emp.display_name,
    'employees', p_employee_id::text);
end;
$$;

-- Management view of employees, including PIN lock state (never the PIN or hash).
create or replace function public.list_employees_admin()
returns table (
  id uuid, employee_code text, display_name text, job_title text, department text,
  is_active boolean, is_demo boolean, created_at timestamptz, last_activity_at timestamptz,
  deactivated_at timestamptz, has_pin boolean, pin_locked_until timestamptz, pin_set_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (app.has_permission('employees.manage') or app.has_permission('employees.view_activity')) then
    perform app.fail('FORBIDDEN', 'Your account is not allowed to view employees.');
  end if;
  return query
    select e.id, e.employee_code, e.display_name, e.job_title, e.department, e.is_active, e.is_demo,
           e.created_at, e.last_activity_at, e.deactivated_at,
           p.employee_id is not null,
           case when p.locked_until > now() then p.locked_until else null end,
           p.pin_set_at
      from public.employees e
      left join public.employee_pins p on p.employee_id = e.id
     order by e.is_active desc, lower(e.display_name);
end;
$$;

-- Alerts: acknowledge / resolve.
create or replace function public.set_alert_status(p_alert_id uuid, p_status text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('alerts.view');
  v_alert public.alerts;
begin
  if p_status not in ('acknowledged', 'resolved', 'open') then
    perform app.fail('VALIDATION', 'Unknown alert status.');
  end if;
  update public.alerts
     set status = p_status,
         acknowledged_at = case when p_status = 'acknowledged' then now() else acknowledged_at end,
         acknowledged_by = case when p_status = 'acknowledged' then v_actor.account_id else acknowledged_by end,
         resolved_at = case when p_status = 'resolved' then now() else null end,
         resolved_by = case when p_status = 'resolved' then v_actor.account_id else null end
   where id = p_alert_id
  returning * into v_alert;
  if v_alert.id is null then
    perform app.fail('NOT_FOUND', 'Alert not found.');
  end if;
  perform app.audit(v_actor, 'alert.' || p_status, 'operations',
    app.actor_label(v_actor) || ' marked alert "' || v_alert.title || '" ' || p_status,
    'alerts', p_alert_id::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS & grants
-- -----------------------------------------------------------------------------
alter table public.employees enable row level security;
alter table public.employee_pins enable row level security;
alter table public.employee_sessions enable row level security;
alter table public.employee_pin_attempts enable row level security;
alter table public.alerts enable row level security;

revoke all on public.employees, public.employee_pins, public.employee_sessions,
  public.employee_pin_attempts, public.alerts from anon, authenticated;

-- employees: management reads directly; writes only through the functions above.
-- The shared employee login uses list_employee_picker() instead.
grant select on public.employees to authenticated;
create policy employees_select on public.employees for select to authenticated
  using ((select app.is_management()));

-- employee_pins: no grants, no policies. Unreachable from the API by design.

grant select on public.employee_sessions to authenticated;
create policy employee_sessions_select on public.employee_sessions for select to authenticated
  using ((select app.has_permission('employees.view_activity')));
-- token_hash is never exposed
revoke select on public.employee_sessions from authenticated;
grant select (id, employee_id, account_id, started_at, last_activity_at, ended_at, end_reason, ip, user_agent)
  on public.employee_sessions to authenticated;

grant select on public.employee_pin_attempts to authenticated;
create policy employee_pin_attempts_select on public.employee_pin_attempts for select to authenticated
  using ((select app.has_permission('audit.view')));

grant select on public.alerts to authenticated;
create policy alerts_select on public.alerts for select to authenticated
  using ((select app.has_permission('alerts.view')));

revoke execute on all functions in schema app from public, anon;
grant execute on function app.current_employee_session(), app.current_employee_id(), app.can_read_operational()
  to authenticated, service_role;

revoke execute on function public.list_employee_picker(), public.start_employee_session(uuid, text),
  public.end_employee_session(text), public.get_my_context(),
  public.create_employee(text, text, text, text, text), public.update_employee(uuid, text, text, text, text),
  public.set_employee_active(uuid, boolean), public.reset_employee_pin(uuid, text),
  public.list_employees_admin(), public.set_alert_status(uuid, text)
  from public, anon;
grant execute on function public.list_employee_picker(), public.start_employee_session(uuid, text),
  public.end_employee_session(text), public.get_my_context(),
  public.create_employee(text, text, text, text, text), public.update_employee(uuid, text, text, text, text),
  public.set_employee_active(uuid, boolean), public.reset_employee_pin(uuid, text),
  public.list_employees_admin(), public.set_alert_status(uuid, text)
  to authenticated;
