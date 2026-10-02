-- =============================================================================
-- 0012 REQUIRED INVOICE PHOTOS + EMAIL REPORTS
--  * Every delivery needs a photo of the invoice. The receiving screen will not
--    submit without one; if an upload still fails, the delivery is saved and an
--    INVOICE_PHOTO_MISSING alert stays open until a photo is attached.
--  * Email recipients (company email, managers) are entered by the owner.
--  * Every report email that is generated or sent is logged in email_reports.
-- =============================================================================

insert into public.settings (key, value, description) values
  ('receiving.require_invoice_photo', '1'::jsonb, '1 = a photo of the invoice is required for every delivery; 0 = optional.'),
  ('email.daily_report_hour', '6'::jsonb, 'Local hour (0-23) when the daily report for the previous day is emailed.'),
  ('email.weekly_report_day', '1'::jsonb, 'Weekday the weekly report (previous Sunday-Saturday) is emailed: 0=Sunday ... 6=Saturday.')
on conflict (key) do nothing;

-- Rules the receiving screen needs (readable by a PIN-verified employee too).
create or replace function public.receiving_rules()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('receiving.perform');
begin
  return jsonb_build_object('require_invoice_photo', app.setting_numeric('receiving.require_invoice_photo', 1) <> 0);
end;
$$;

-- Missing-photo alert: opened when a delivery is recorded, resolved when a photo is uploaded.
create or replace function app.receiving_photo_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendor text;
begin
  if app.setting_numeric('receiving.require_invoice_photo', 1) = 0 then
    return new;
  end if;
  select name into v_vendor from public.vendors where id = new.vendor_id;
  perform app.raise_alert('INVOICE_PHOTO_MISSING', 'warning',
    'Invoice photo missing: ' || v_vendor || coalesce(' #' || new.invoice_number, ' receipt #' || new.receipt_number),
    'No invoice photo has been attached to this delivery yet. Open it and upload a photo of the invoice.',
    'receiving_events', new.id::text, '/receiving/' || new.id, 'invoice-photo:' || new.id,
    null, new.vendor_id, new.location_id);
  return new;
end;
$$;
create trigger receiving_events_photo_alert after insert on public.receiving_events
  for each row execute function app.receiving_photo_alert();

create or replace function app.invoice_uploaded_resolve_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.upload_status = 'uploaded' and old.upload_status is distinct from 'uploaded' and new.receiving_event_id is not null then
    update public.alerts set status = 'resolved', resolved_at = now(), resolved_by = new.account_id
     where dedupe_key = 'invoice-photo:' || new.receiving_event_id and status <> 'resolved';
  end if;
  return new;
end;
$$;
create trigger invoice_documents_resolve_alert after update on public.invoice_documents
  for each row execute function app.invoice_uploaded_resolve_alert();

-- Allow the uploader (any account) to confirm, but only for a document they registered.
-- (mark_invoice_uploaded from 0005 already enforces account_id = caller.)

-- -----------------------------------------------------------------------------
-- Email recipients & report log
-- -----------------------------------------------------------------------------
create table public.email_recipients (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 200),
  name text check (name is null or length(name) <= 80),
  receives_daily boolean not null default true,
  receives_weekly boolean not null default true,
  is_active boolean not null default true,
  created_by uuid references public.account_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index email_recipients_email_uq on public.email_recipients (lower(email));
create trigger email_recipients_touch before update on public.email_recipients for each row execute function app.touch_updated_at();
create trigger email_recipients_audit after insert or update or delete on public.email_recipients
  for each row execute function app.audit_row_change();

create table public.email_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('daily', 'weekly', 'test')),
  period_start date not null,
  period_end date not null,
  triggered_by text not null check (triggered_by in ('schedule', 'manual')),
  status text not null check (status in ('sending', 'sent', 'failed', 'not_configured', 'no_recipients')),
  recipients text[] not null default '{}',
  subject text not null,
  html text,
  attachments jsonb not null default '[]'::jsonb,
  provider_message_id text,
  error text,
  account_id uuid references public.account_profiles(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
-- The scheduler sends each period once, even if it fires twice.
create unique index email_reports_scheduled_once_uq on public.email_reports (report_type, period_start)
  where triggered_by = 'schedule' and status in ('sending', 'sent');
create index email_reports_created_idx on public.email_reports (created_at desc);

alter table public.email_recipients enable row level security;
alter table public.email_reports enable row level security;
revoke all on public.email_recipients, public.email_reports from anon, authenticated;

grant select, insert, update, delete on public.email_recipients to authenticated;
create policy email_recipients_all on public.email_recipients for all to authenticated
  using ((select app.has_permission('email.manage'))) with check ((select app.has_permission('email.manage')));

-- Report log: readable by email managers; written only by the server (service role).
grant select on public.email_reports to authenticated;
create policy email_reports_select on public.email_reports for select to authenticated
  using ((select app.has_permission('email.manage')));

revoke execute on all functions in schema app from public, anon;
revoke execute on function public.receiving_rules() from public, anon;
grant execute on function public.receiving_rules() to authenticated;
