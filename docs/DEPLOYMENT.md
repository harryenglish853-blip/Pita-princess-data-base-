# Deployment, environments, backups

**Flow: LOCAL → STAGING → PRODUCTION.** Never test on the production restaurant database.
Staging and production are two separate Supabase projects and two separate Vercel
environments. Demo data is only ever loaded into local or (explicitly) staging.

## 1. Create the Supabase projects (staging first, then production)

1. Create a Supabase project per environment (same region as Vercel, e.g. `us-east-1`).
2. **Authentication → Sign In / Providers → Email:** disable *Allow new users to sign up*.
   This is critical: accounts are created only by the owner.
3. Authentication settings: minimum password length 12; optionally enable leaked-password
   protection; set session time-box / inactivity timeout to the owner's preference
   (e.g. 12 h for the shared tablet login).
4. **Data API:** exposed schemas = `public` only. Do not expose `app`.
5. Apply migrations with the Supabase CLI from this repository:
   ```bash
   supabase link --project-ref <project-ref>
   supabase db push            # applies supabase/migrations/* in order
   ```
   Migrations are forward-only and additive; each one runs in a transaction. Review
   `supabase db diff` on staging before pushing anything to production.
6. Verify in the SQL editor: `select * from public.ledger_integrity_check();` returns 0 rows,
   and `select count(*) from storage.buckets where id='invoices' and not public;` returns 1.

## 2. Production data setup (no demo data)

Production starts EMPTY. Do **not** run `npm run seed:demo` against it (the script refuses
unless explicitly overridden for staging, and always refuses when `APP_ENV=production`).

1. In the SQL editor, create the organization and the restaurant + commissary locations:
   ```sql
   insert into organizations (name, timezone) values ('<Restaurant name>', 'America/New_York');
   insert into locations (organization_id, code, name, location_type)
   select id, 'MAIN', '<Restaurant name>', 'restaurant' from organizations;
   insert into locations (organization_id, code, name, location_type)
   select id, 'CK', 'Central Kitchen', 'commissary' from organizations;
   ```
2. Create the four logins (password from the environment, never typed on the command line):
   ```bash
   export SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<secret>
   ACCOUNT_PASSWORD='<owner #1 password>' npm run account:create -- --email <owner1 email> --role owner --name "Owner #1"
   ACCOUNT_PASSWORD='<owner #2 password>' npm run account:create -- --email <owner2 email> --role owner --name "Owner #2"
   ACCOUNT_PASSWORD='<manager password>'  npm run account:create -- --email <management email> --role manager --name "Management"
   ACCOUNT_PASSWORD='<shared password>'   npm run account:create -- --email <employees email> --role employee --name "Employee Shared Account"
   ```
   After the first owner exists, further logins/passwords can be managed in
   **Administration → Login accounts**.
3. Sign in as an owner and enter real data: vendors (confirm Sysco/Greco ordering URLs and
   account numbers), storage areas, categories, products (units, case sizes, costs, pars),
   count order, employees and their PINs, settings/thresholds.
4. Take the opening physical count (Counts → Start weekly inventory); posting it creates the
   opening book inventory.

## 3. Vercel

1. Import the repository; framework preset Next.js; Node 22.
2. Environment variables (Production and Preview separately; **none** may start with
   `NEXT_PUBLIC_`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `APP_URL`, `APP_ENV` (`staging` / `production`).
3. Email reports: create a Resend account, verify the restaurant's sending domain, then set
   `RESEND_API_KEY`, `EMAIL_FROM` and `CRON_SECRET` (random, 32+ characters). `vercel.json`
   runs `/api/cron/reports` every hour (daily, weekly on the chosen weekday, monthly on the chosen
   day) and `/api/cron/alerts` every 10 minutes as a safety net for immediate alerts (these crons
   need a Vercel Pro plan; on Hobby, run reports once a day after the report hour — immediate
   alerts are still sent right after each action). The owner enters the company and manager
   email addresses in **Administration → Email reports** and can preview or send a report there.
4. Toast POS: ask Toast for API access for the restaurant (a Standard API machine client) and
   set `TOAST_API_URL`, `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `TOAST_RESTAURANT_GUID`. In Toast,
   add an orders webhook pointing to `https://<domain>/api/pos/toast/webhook` and set its secret as
   `TOAST_WEBHOOK_SECRET` (requests without a valid signature are rejected). `vercel.json` also pulls
   yesterday's and today's orders hourly via `/api/cron/pos`. Then an owner turns on Toast sync in
   **Toast POS** and maps the menu. Verify on staging with a real Toast sandbox before production.
5. Production domain e.g. `inventory.<restaurant>.com`; HTTPS is automatic.
6. Promote to production only a commit that passed the full quality gate on staging.

## 4. Backups and restore

* **Enable Point-in-Time Recovery (PITR)** on the production Supabase project (Pro plan
  add-on). Daily backups are included on paid plans; PITR allows restore to any second.
* Additionally, a weekly logical backup kept outside Supabase:
  ```bash
  pg_dump "$PROD_DB_URL" --format=custom --no-owner --schema=public --schema=app \
    --file=inventory-$(date +%F).dump
  # store encrypted (e.g. in the owner's cloud storage); keep 12 weeks
  ```
  Also back up `storage` objects (invoice photos) via the Supabase dashboard/CLI.
* **Restore drill (do before launch, then quarterly):** restore the latest dump into the
  STAGING project (`pg_restore --clean --if-exists --no-owner -d "$STAGING_DB_URL" file.dump`),
  sign in, check counts of products/ledger rows, and run
  `select * from ledger_integrity_check();` (expect 0 rows).
* Never run destructive SQL on production. Corrections are made through the app (adjustments,
  new ledger rows), never by editing history — the ledger and audit log reject edits.

## 5. Pre-launch

Complete [OWNER_ACCEPTANCE_CHECKLIST.md](OWNER_ACCEPTANCE_CHECKLIST.md) on staging with real
restaurant data, run the full test suite against staging-like data, and update
[LAUNCH_READINESS_REPORT.md](LAUNCH_READINESS_REPORT.md). Launch only when it says
**READY FOR PRODUCTION**.
