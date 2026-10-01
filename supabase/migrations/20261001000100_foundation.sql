-- =============================================================================
-- 0001 FOUNDATION
-- Schemas, privilege hardening, organization/locations, website login accounts,
-- permissions, settings, audit log and shared helper functions.
--
-- Security model (read this before changing anything):
--   * Nothing is granted to `anon`. Every page except /login requires a session.
--   * `authenticated` receives explicit, minimal grants per object. Supabase's
--     default "grant everything to anon/authenticated" privileges are revoked.
--   * Every table has Row Level Security enabled.
--   * Business workflows (receiving, waste, transfers, counts, PIN checks) run
--     through SECURITY DEFINER functions that re-check permissions and the
--     verified employee identity inside the database.
--   * Internal helpers live in the `app` schema, which is NOT exposed through
--     the Supabase REST API.
-- =============================================================================

create schema if not exists app;
comment on schema app is 'Internal helper functions. Not exposed through the REST API.';

-- -----------------------------------------------------------------------------
-- Privilege hardening: undo Supabase's permissive defaults for objects created
-- by the migration role. Grants are made explicitly per object below.
-- -----------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;
alter default privileges in schema app revoke execute on functions from public;

grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------
create type public.account_role as enum ('owner', 'manager', 'employee');
comment on type public.account_role is
  'owner = owner login accounts; manager = management login; employee = the ONE shared employee login. Individual employees are rows in public.employees, not login accounts.';

create type public.location_type as enum ('restaurant', 'commissary');

-- -----------------------------------------------------------------------------
-- updated_at helper
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Organization & locations
-- -----------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  timezone text not null default 'America/New_York',
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- This deployment serves one restaurant group. Enforce a single organization row.
create unique index organizations_singleton on public.organizations ((true));
create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  code text not null unique check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  location_type public.location_type not null default 'restaurant',
  address text,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger locations_touch before update on public.locations
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Website login accounts (one row per Supabase Auth user).
-- Initially: Owner #1, Owner #2, Management, ONE shared Employee account.
-- -----------------------------------------------------------------------------
create table public.account_profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  role public.account_role not null,
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  is_active boolean not null default true,
  default_location_id uuid references public.locations(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.account_profiles is
  'Website login accounts. The shared employee login is ONE row with role=employee; real people are in public.employees.';
create trigger account_profiles_touch before update on public.account_profiles
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------
create table public.permissions (
  code text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),
  description text not null,
  category text not null
);

create table public.role_permissions (
  role public.account_role not null,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role, permission_code)
);

-- Per-account overrides ("management can ... if authorized").
create table public.account_permission_overrides (
  account_id uuid not null references public.account_profiles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  granted boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.account_profiles(id),
  primary key (account_id, permission_code)
);

insert into public.permissions (code, category, description) values
  ('dashboard.owner',          'dashboard', 'Owner control center with financial KPIs'),
  ('dashboard.manager',        'dashboard', 'Management operations dashboard'),
  ('inventory.view',           'inventory', 'View products, quantities, costs and the inventory ledger'),
  ('inventory.adjust',         'inventory', 'Make manual inventory adjustments'),
  ('products.manage',          'inventory', 'Create and edit products, categories, units and conversions'),
  ('counts.perform',           'counts',    'Start and perform inventory counts'),
  ('counts.post',              'counts',    'Review, approve and post inventory counts'),
  ('receiving.perform',        'receiving', 'Receive deliveries'),
  ('receiving.review',         'receiving', 'Review deliveries and resolve discrepancies'),
  ('waste.log',                'waste',     'Log waste'),
  ('waste.review',             'waste',     'Review waste'),
  ('transfers.perform',        'transfers', 'Transfer product between storage areas and locations'),
  ('orders.manage',            'ordering',  'Suggested orders, vendor order lists and purchase orders'),
  ('commissary.manage',        'commissary','Create and manage commissary orders'),
  ('vendors.manage',           'ordering',  'Create and edit vendors and vendor links'),
  ('recipes.manage',           'food_cost', 'Create and edit recipes'),
  ('reports.operational',      'reports',   'Operational reports (inventory, waste, deliveries, activity)'),
  ('reports.financial',        'reports',   'Financial reports (sales, food cost, purchases, vendor spending)'),
  ('tasks.view',               'tasks',     'View and complete tasks'),
  ('tasks.manage',             'tasks',     'Create and assign tasks'),
  ('alerts.view',              'alerts',    'View management alerts'),
  ('employees.manage',         'people',    'Add, edit and deactivate employee profiles'),
  ('employees.reset_pin',      'people',    'Reset employee PINs'),
  ('employees.view_activity',  'people',    'View the employee activity report'),
  ('locations.manage',         'admin',     'Manage locations and storage areas'),
  ('settings.manage',          'admin',     'Change system settings and alert thresholds'),
  ('accounts.manage',          'admin',     'Manage login accounts and permissions'),
  ('email.manage',             'admin',     'Manage email recipients and preferences'),
  ('audit.view',               'admin',     'View the complete audit log');

-- Owner has every permission implicitly (see app.has_permission); rows are kept
-- for completeness so the permission matrix screen is explicit.
insert into public.role_permissions (role, permission_code)
select 'owner', code from public.permissions;

insert into public.role_permissions (role, permission_code) values
  ('manager', 'dashboard.manager'),
  ('manager', 'inventory.view'),
  ('manager', 'inventory.adjust'),
  ('manager', 'products.manage'),
  ('manager', 'counts.perform'),
  ('manager', 'counts.post'),
  ('manager', 'receiving.perform'),
  ('manager', 'receiving.review'),
  ('manager', 'waste.log'),
  ('manager', 'waste.review'),
  ('manager', 'transfers.perform'),
  ('manager', 'orders.manage'),
  ('manager', 'commissary.manage'),
  ('manager', 'recipes.manage'),
  ('manager', 'reports.operational'),
  ('manager', 'tasks.view'),
  ('manager', 'tasks.manage'),
  ('manager', 'alerts.view'),
  ('manager', 'employees.manage'),
  ('manager', 'employees.reset_pin'),
  ('manager', 'employees.view_activity'),
  ('employee', 'receiving.perform'),
  ('employee', 'waste.log'),
  ('employee', 'transfers.perform'),
  ('employee', 'tasks.view');

-- -----------------------------------------------------------------------------
-- Settings (key/value, typed by convention, documented in description)
-- -----------------------------------------------------------------------------
create table public.settings (
  key text primary key check (key ~ '^[a-z_]+(\.[a-z_]+)*$'),
  value jsonb not null,
  description text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.account_profiles(id)
);
create trigger settings_touch before update on public.settings
  for each row execute function app.touch_updated_at();

insert into public.settings (key, value, description) values
  ('employee.idle_timeout_minutes', '5'::jsonb,  'Minutes of inactivity before the shared-device employee session locks and returns to WHO ARE YOU?'),
  ('employee.max_session_hours',    '12'::jsonb, 'Maximum length of one employee PIN session, regardless of activity.'),
  ('employee.pin_max_attempts',     '5'::jsonb,  'Wrong PIN attempts for one employee before that employee is temporarily locked.'),
  ('employee.pin_lock_minutes',     '10'::jsonb, 'Minutes an employee stays locked after too many wrong PINs.'),
  ('employee.device_max_failures',  '15'::jsonb, 'Wrong PIN attempts from the shared account (all employees) within 15 minutes before PIN entry is paused for everyone.'),
  ('counts.recount_variance_pct',   '10'::jsonb, 'Flag RECOUNT REQUIRED when the absolute quantity variance exceeds this percent of book quantity.'),
  ('counts.recount_variance_value', '50'::jsonb, 'Flag RECOUNT REQUIRED when the absolute dollar variance exceeds this amount.'),
  ('alerts.price_increase_pct',     '5'::jsonb,  'Create a PRICE ALERT when a vendor price increases by more than this percent.'),
  ('alerts.high_waste_value',       '50'::jsonb, 'Create a HIGH WASTE alert when a single waste entry exceeds this dollar amount.');

-- -----------------------------------------------------------------------------
-- Audit log: append-only. Records the website account AND the verified
-- employee identity (when the shared employee login is used).
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  account_id uuid references public.account_profiles(id),
  account_role public.account_role,
  account_name text,
  employee_id uuid,               -- FK added in employees migration
  employee_name text,
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  category text not null check (category in ('operations', 'inventory', 'security', 'admin', 'system')),
  entity_type text,
  entity_id text,
  summary text not null,
  product_id uuid,
  vendor_id uuid,
  location_id uuid,
  old_values jsonb,
  new_values jsonb,
  reason text,
  ip text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb
);
create index audit_logs_occurred_idx on public.audit_logs (occurred_at desc);
create index audit_logs_employee_idx on public.audit_logs (employee_id, occurred_at desc) where employee_id is not null;
create index audit_logs_account_idx on public.audit_logs (account_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_action_idx on public.audit_logs (action, occurred_at desc);

create or replace function app.prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'IMMUTABLE: % rows cannot be % (append-only table)', tg_table_name, lower(tg_op)
    using errcode = 'PT409';
end;
$$;

create trigger audit_logs_immutable
  before update or delete on public.audit_logs
  for each row execute function app.prevent_mutation();
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function app.prevent_mutation();

-- -----------------------------------------------------------------------------
-- Request helpers
-- -----------------------------------------------------------------------------
-- Reads an HTTP request header forwarded by PostgREST. Returns NULL outside of
-- an API request (e.g. migrations, psql).
create or replace function app.request_header(p_name text)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(nullif(current_setting('request.headers', true), ''), 'null')::json ->> lower(p_name)
$$;

create or replace function app.current_account()
returns public.account_profiles
language sql
stable
security definer
set search_path = ''
as $$
  select ap.*
  from public.account_profiles ap
  where ap.id = auth.uid() and ap.is_active
$$;

create or replace function app.current_account_role()
returns public.account_role
language sql
stable
security definer
set search_path = ''
as $$
  select ap.role from public.account_profiles ap where ap.id = auth.uid() and ap.is_active
$$;

create or replace function app.has_permission(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when ap.role = 'owner' then true
      else coalesce(
        (select o.granted from public.account_permission_overrides o
          where o.account_id = ap.id and o.permission_code = p_code),
        exists (select 1 from public.role_permissions rp
                 where rp.role = ap.role and rp.permission_code = p_code))
    end
    from public.account_profiles ap
    where ap.id = auth.uid() and ap.is_active
  ), false)
$$;

create or replace function app.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.account_profiles where id = auth.uid() and is_active and role = 'owner')
$$;

-- True for owner/manager accounts (management-side users). Employees are never staff here.
create or replace function app.is_management()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.account_profiles
                  where id = auth.uid() and is_active and role in ('owner', 'manager'))
$$;

create or replace function app.setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (value #>> '{}')::numeric from public.settings where key = p_key), p_default)
$$;

create or replace function app.org_timezone()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select timezone from public.organizations limit 1), 'America/New_York')
$$;

-- Primary restaurant location (first active restaurant), used as default context.
create or replace function app.primary_location_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.locations
   where is_active and location_type = 'restaurant'
   order by created_at, code
   limit 1
$$;

-- Money formatting for human-readable audit summaries and alerts: -$1,234.50
create or replace function app.fmt_money(p numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p is null then '—'
              when p < 0 then '-' || to_char(abs(p), 'FM$999,999,990.00')
              else to_char(p, 'FM$999,999,990.00') end
$$;

-- Standard error raising so the web app can map failures to friendly messages.
-- Codes: NOT_AUTHENTICATED, FORBIDDEN, EMPLOYEE_SESSION_REQUIRED, VALIDATION,
--        NOT_FOUND, CONFLICT, DUPLICATE
create or replace function app.fail(p_code text, p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%: %', p_code, p_message using errcode = case p_code
    when 'NOT_AUTHENTICATED' then 'PT401'
    when 'EMPLOYEE_SESSION_REQUIRED' then 'PT401'
    when 'FORBIDDEN' then 'PT403'
    when 'NOT_FOUND' then 'PT404'
    when 'CONFLICT' then 'PT409'
    when 'DUPLICATE' then 'PT409'
    else 'PT400' end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Generic audit trigger for master-data tables edited by owner/management.
-- Captures old/new row values and the acting login account.
-- -----------------------------------------------------------------------------
create or replace function app.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acc public.account_profiles;
  v_old jsonb;
  v_new jsonb;
  v_id text;
  v_label text;
  v_action text;
begin
  select * into v_acc from public.account_profiles where id = auth.uid();
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;

  -- Only keep changed keys for updates (plus id) to keep the log readable.
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, n.value), jsonb_object_agg(n.key, v_old -> n.key)
      into v_new, v_old
      from jsonb_each(to_jsonb(new)) n
     where n.value is distinct from (to_jsonb(old) -> n.key)
       and n.key not in ('updated_at');
    if v_new is null then
      return new; -- nothing meaningful changed
    end if;
  end if;

  v_id := coalesce(v_new ->> 'id', v_old ->> 'id', to_jsonb(coalesce(new, old)) ->> 'id');
  v_label := coalesce(to_jsonb(coalesce(new, old)) ->> 'name',
                      to_jsonb(coalesce(new, old)) ->> 'display_name',
                      to_jsonb(coalesce(new, old)) ->> 'key',
                      v_id);
  v_action := tg_table_name || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  -- action must match ^[a-z_]+\.[a-z_]+$
  insert into public.audit_logs (account_id, account_role, account_name, action, category,
                                 entity_type, entity_id, summary, old_values, new_values)
  values (v_acc.id, v_acc.role, v_acc.display_name, v_action, 'admin',
          tg_table_name, v_id,
          coalesce(v_acc.display_name, 'System') || ' ' ||
            case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end ||
            ' ' || replace(tg_table_name, '_', ' ') || ' "' || coalesce(v_label, '?') || '"',
          v_old, v_new);
  return coalesce(new, old);
end;
$$;

create trigger organizations_audit after insert or update on public.organizations
  for each row execute function app.audit_row_change();
create trigger locations_audit after insert or update or delete on public.locations
  for each row execute function app.audit_row_change();
create trigger account_profiles_audit after insert or update or delete on public.account_profiles
  for each row execute function app.audit_row_change();
create trigger settings_audit after update on public.settings
  for each row execute function app.audit_row_change();
create trigger account_permission_overrides_audit after insert or update or delete on public.account_permission_overrides
  for each row execute function app.audit_row_change();

-- -----------------------------------------------------------------------------
-- Guard rails on account changes
-- -----------------------------------------------------------------------------
create or replace function app.guard_account_profiles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Never allow the last active owner to be demoted or deactivated.
  if tg_op = 'UPDATE' and old.role = 'owner' and old.is_active
     and (new.role <> 'owner' or not new.is_active) then
    if (select count(*) from public.account_profiles
         where role = 'owner' and is_active and id <> old.id) = 0 then
      perform app.fail('VALIDATION', 'At least one active owner account must remain.');
    end if;
  end if;
  -- Nobody may change their own role or deactivate themselves.
  if tg_op = 'UPDATE' and auth.uid() = old.id
     and (new.role <> old.role or new.is_active <> old.is_active) then
    perform app.fail('FORBIDDEN', 'You cannot change your own role or deactivate your own account.');
  end if;
  return new;
end;
$$;
create trigger account_profiles_guard before update on public.account_profiles
  for each row execute function app.guard_account_profiles();

-- -----------------------------------------------------------------------------
-- Row Level Security & grants
-- -----------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.locations enable row level security;
alter table public.account_profiles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.account_permission_overrides enable row level security;
alter table public.settings enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.organizations, public.locations, public.account_profiles, public.permissions,
  public.role_permissions, public.account_permission_overrides, public.settings, public.audit_logs
  from anon, authenticated;

-- organizations: every signed-in account may read (restaurant name/branding); owner edits.
grant select, update on public.organizations to authenticated;
create policy organizations_select on public.organizations for select to authenticated
  using ((select app.current_account_role()) is not null);
create policy organizations_update on public.organizations for update to authenticated
  using ((select app.has_permission('settings.manage')))
  with check ((select app.has_permission('settings.manage')));

-- locations: everyone signed-in reads; owner manages.
grant select, insert, update on public.locations to authenticated;
create policy locations_select on public.locations for select to authenticated
  using ((select app.current_account_role()) is not null);
create policy locations_insert on public.locations for insert to authenticated
  with check ((select app.has_permission('locations.manage')));
create policy locations_update on public.locations for update to authenticated
  using ((select app.has_permission('locations.manage')))
  with check ((select app.has_permission('locations.manage')));

-- account_profiles: everyone reads their own row; account managers read/update all.
-- Inserts happen only through the server-side setup script (service role).
grant select on public.account_profiles to authenticated;
grant update (display_name, is_active, role, default_location_id) on public.account_profiles to authenticated;
-- Login accounts and permission overrides are owner-only, even if accounts.manage
-- were ever granted to another account (prevents privilege escalation).
create policy account_profiles_select on public.account_profiles for select to authenticated
  using (id = (select auth.uid()) or (select app.is_owner()));
create policy account_profiles_update on public.account_profiles for update to authenticated
  using ((select app.is_owner()))
  with check ((select app.is_owner()));

-- permission catalog: readable by management; overrides managed by owner.
grant select on public.permissions, public.role_permissions to authenticated;
create policy permissions_select on public.permissions for select to authenticated
  using ((select app.is_management()));
create policy role_permissions_select on public.role_permissions for select to authenticated
  using ((select app.is_management()));

grant select, insert, update, delete on public.account_permission_overrides to authenticated;
create policy apo_select on public.account_permission_overrides for select to authenticated
  using (account_id = (select auth.uid()) or (select app.is_owner()));
create policy apo_write on public.account_permission_overrides for all to authenticated
  using ((select app.is_owner()))
  with check ((select app.is_owner()));

-- settings: management reads; owner (settings.manage) updates. No inserts/deletes from the app.
grant select on public.settings to authenticated;
grant update (value) on public.settings to authenticated;
create policy settings_select on public.settings for select to authenticated
  using ((select app.is_management()));
create policy settings_update on public.settings for update to authenticated
  using ((select app.has_permission('settings.manage')))
  with check ((select app.has_permission('settings.manage')));

-- audit_logs: read-only. Owner sees everything; employee activity readers see
-- operational entries. Writes happen only inside SECURITY DEFINER functions.
grant select on public.audit_logs to authenticated;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    (select app.has_permission('audit.view'))
    or ((select app.has_permission('employees.view_activity')) and category in ('operations', 'inventory'))
  );

-- Helper functions used inside RLS policies must be executable by authenticated.
revoke execute on all functions in schema app from public, anon;
grant execute on function app.current_account(), app.current_account_role(), app.has_permission(text),
  app.is_owner(), app.is_management(), app.request_header(text), app.setting_numeric(text, numeric),
  app.org_timezone(), app.primary_location_id()
  to authenticated, service_role;
