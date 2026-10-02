# Architecture

## Overview

```
Phone / tablet / desktop browser
   │  HTTPS, httpOnly cookies only (no Supabase keys in the browser)
   ▼
Next.js 16 on Vercel
   ├─ proxy.ts ............ refreshes the Supabase session; everything except /login requires sign-in
   ├─ Server Components ... read data AS the signed-in user (RLS applies)
   ├─ Server Actions ...... validate input (zod) and call database functions
   └─ Route handlers ...... offline count sync, CSV exports, catalog
   │  forwards: user JWT + x-employee-session (PIN session token) + client IP / user agent
   ▼
Supabase
   ├─ Auth (GoTrue) ....... 4 login accounts; sign-ups disabled
   ├─ PostgREST ........... exposes ONLY the `public` schema
   ├─ Postgres ............ RLS on every table; business logic in SECURITY DEFINER functions
   └─ Storage ............. private `invoices` bucket (server-only access)
```

Every rule that matters — permissions, employee identity, inventory math, immutability — is
enforced **inside Postgres**, so it holds even if someone calls the API directly with a valid
login. The web app enforces the same rules a second time for a good user experience.

## Login accounts vs. employees (the shared employee login)

* `auth.users` + `account_profiles`: website logins. Roles: `owner`, `manager`, `employee`.
  The `employee` role is the ONE shared login for all regular staff.
* `employees`: real people (Carlos, Maria…). Not logins. PINs are bcrypt hashes in
  `employee_pins`, a table with **no grants at all** to API roles.
* `start_employee_session(employee, pin)` (only callable by the shared employee login):
  rate-limited (per employee: 5 wrong → locked 10 min; per device/login: 15 wrong in 15 min →
  paused), logged in `employee_pin_attempts`, alerts on lockout. On success it returns a random
  256-bit token; the server stores it in an **httpOnly** cookie and the database keeps only its
  SHA-256.
* Each request forwards that token in the `x-employee-session` header. `app.require_actor()`
  (called first by every operational function) refuses to act for the shared login unless the
  token matches an open session **for that same login**, not idle longer than the configured
  timeout (default 5 min), not older than 12 h, for an active employee.
* Operational functions have **no employee parameter**. The employee recorded on receiving,
  waste, transfers, tasks, count revisions, ledger rows and audit rows is always the verified
  one, so nobody can attribute an action to someone else.
* Switch employee / lock / inactivity end the session server-side. The client also runs an
  inactivity timer (warning at 30 s) — the server-side timeout is the real enforcement.

## Permissions

`permissions` + `role_permissions` define defaults; `account_permission_overrides` lets an owner
allow/deny items for the management login ("if authorized"). `app.has_permission()` is used by RLS
policies and functions; owners implicitly have everything. Login accounts and overrides can be
changed by owners only (prevents privilege escalation even if `accounts.manage` were granted).

## Inventory ledger

* `inventory_transactions` — immutable (UPDATE/DELETE/TRUNCATE blocked by triggers). Signed
  quantity in the product's **inventory unit**, unit cost, extended cost, running balance,
  source document, login account and employee.
* `inventory_balances` — perpetual (book) inventory and weighted-average cost per
  location/product, written **only** by `app.post_inventory_txn()` in the same transaction and
  under a row lock. `ledger_integrity_check()` proves balance = Σ ledger (owner page + tests).
* Weighted average cost on inbound costed movements:
  `new_avg = (old_qty × old_avg + qty × cost) / (old_qty + qty)` (or `cost` when old qty ≤ 0).
  Outbound movements are valued at the current average.
* A product's inventory unit cannot change once it has ledger history.

## Unit conversion

One rule set, two runtimes: `app.unit_factor_to_inventory()` (authoritative, used on save) and
`src/lib/units/convert.ts` (instant previews and offline counting). Both are tested against the
same fixtures (`tests/fixtures/conversions.json`). Standard units use exact factors (1 LB =
453.59237 g, 1 GAL = 3785.411784 mL); package units (CASE, BAG…) are defined per product.
Quantities are stored to 4 decimals, money as `numeric` — never floating point. The browser uses
`decimal.js` for all arithmetic it displays.

## Receiving

`submit_receiving()` is one atomic transaction: event, lines, ledger rows (only the **accepted**
quantity), average cost, vendor price + price history, price-increase alert, discrepancies,
discrepancy alert, audit. Duplicate invoices are rejected per vendor; retries are idempotent
(`idempotency_key`). "Credit due" = (invoiced − received) × price + overcharges vs. contract
cost; short/missing/rejected rows carry the value of the affected goods but are not added again.

## Counts (physical inventory)

`start_count()` builds the sheet in shelf-to-sheet order. Each save is `save_count_entry()`:
idempotent per `client_mutation_id`, versioned, returns `conflict` if another device changed the
line. The browser writes every keystroke to IndexedDB first, then syncs in order through
`/api/counts/:id/sync`; a service worker lets an opened count page reload without Wi-Fi.
`submit_count()` snapshots book quantity **as of** submission, computes variance %/$ and flags
`RECOUNT REQUIRED` (defaults: |%| > 10 or |$| > 50). Posting writes `PHYSICAL_VARIANCE` ledger rows
dated at the count time; if back-dated movements changed the book meanwhile, posting refuses and
sends the count back to review. Posted counts are locked by trigger.

## Data protection

* No `anon` grants anywhere; Supabase's default grants are revoked; every table has RLS.
* Employees read a cost-free catalog through `operational_catalog()`; cost tables are
  management-only.
* Audit log (`audit_logs`) is append-only and records login account, role, employee, action,
  old/new values, reason, IP and user agent.
* Invoice files: private bucket, uploaded/served by the server only after a database function
  authorizes the specific delivery; viewing uses 5-minute signed URLs.
* Supabase session cookies and the employee cookie are `httpOnly`, `SameSite=Lax`, `Secure` in
  production. Security headers: frame-deny, nosniff, HSTS, no-index.

## Phase 8: forecasting, invoice reading, barcodes, voice, anomalies

* **Forecast** (`app.forecast_items`): per menu item per day = same-weekday average over the last 56 days (open days
  only, n ≥ 2) × trend (last 14 / prior 14 days, clamped 0.8–1.25) × product of matching `forecast_adjustments`.
  `app.forecast_product_usage` explodes it through the recipes into inventory units. `suggested_order` uses it for
  dynamic-par items (method `sales_forecast`), else 28-day ledger usage, else the par.
* **Invoice reading**: `request_invoice_extraction` (DB authorizes, needs an uploaded photo) → the server downloads the
  files with the service key and calls Claude (`src/lib/ocr/invoice.ts`, structured output validated by Zod) →
  `complete_invoice_extraction` (service role only) stores the suggestion → a person runs `review_invoice_extraction`
  (confirm / discard, audited). No function posts anything from a reading.
* **Barcodes**: `product_barcodes` (one code → product + optional unit); `lookup_barcode` (any signed-in user),
  `map_barcode` (`products.manage`, audited).
* **Voice counts**: speech-to-text is the browser's; `src/lib/voice/parse.ts` turns text into product + quantities and
  marks uncertain results, which the UI requires to be confirmed. Saving goes through the normal count autosave.
* **Anomalies**: `app.detect_anomalies()` raises deduplicated `ANOMALY` alerts; run by the alerts cron
  (`run_anomaly_checks_service`, service role) and on demand (`run_anomaly_checks`, `alerts.view`).

## Integration seams for later phases

`vendors.integration_type` (manual/api/edi), `purchase_orders`, `invoice_documents.ocr_*`
(suggestions only — never posted without confirmation), `inventory_txn_type`
`POS_THEORETICAL_CONSUMPTION` / `PRODUCTION` / `COMMISSARY_*`, `location_products.par_type`
(`dynamic`), `alerts.emailed_at`. Toast will live in its own integration layer writing sales and
theoretical-usage rows through the same ledger function.
