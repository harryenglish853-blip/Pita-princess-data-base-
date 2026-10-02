# Launch readiness report

**Date:** 2026-10-01 · **Scope reviewed:** Phase 1 (foundation) + Phase 2 (core restaurant operations)

## Final recommendation: **NOT READY FOR PRODUCTION**

Phases 1 and 2 are built and pass every automated test listed below. The system must still
**not** be used for real restaurant operations, because:

1. It has only ever run against a **local** Supabase-equivalent stack (same Docker images
   Supabase uses). No staging or production Supabase/Vercel project exists yet —
   **BLOCKED — REQUIRES EXTERNAL CONFIGURATION** (Supabase + Vercel accounts, domain).
2. The owner acceptance checklist (real products, units, case sizes, costs, pars, vendors,
   URLs, employees, count order) has not been done.
3. Phases 3–8 from the specification (suggested ordering, commissary orders/production,
   recipes and food cost, Toast, automated email, forecasting/barcode/voice/OCR) are not built.
   Several of these are part of the required demo flow (steps 16, 22, 23, 26, 27).
4. Backups/PITR and a restore drill can only be done on a real Supabase project.

## Features completed (Phase 1 + 2)

| Area | Status |
|---|---|
| Next.js 16 app, Tailwind, PWA manifest + service worker | Done |
| Supabase schema: 10 migrations, RLS on every table, no `anon` access | Done |
| 4 login roles; ONE shared employee login; employee profiles; hashed PINs; lockout; session switching; inactivity lock | Done |
| Employee attribution on every operational record + audit log (login account AND employee) | Done |
| Products, categories, storage areas, units, central conversion engine, vendors, vendor links | Done |
| Immutable inventory ledger, book inventory, weighted average cost, integrity check | Done |
| Dashboards (owner / management / employee), attention center, alerts, tasks (recurring) | Done |
| Receiving with discrepancies, credit-due estimate, price history, price alerts, invoice photos | Done |
| Waste, transfers (storage areas, restaurant ↔ commissary), manual adjustments | Done |
| Counts: 6 count types, shelf-to-sheet order (drag/arrows), autosave, offline + sync, multiple counters/conflicts, variance, recount flags, approve, post | Done |
| Reports + CSV export: inventory value, variance/count history, waste, deliveries/vendor spending, price history, employee activity, audit log | Done |
| Ordering center: next delivery/cutoff, low-stock list, OPEN SYSCO / OPEN GRECO, **log orders placed on vendor websites** (draft/placed/cancelled, copy order list, confirmation #), receive deliveries against a logged order | Done (suggested quantities = Phase 3) |
| Employee management, login-account & permission admin (owner), settings, global search | Done |
| Required invoice photo on every delivery (multi-page, direct upload to private storage, retry, "photo missing" alert until attached) | Done |
| Daily + weekly email reports with invoice photos attached; owner-managed recipients; preview, send now, history; hourly scheduler sends each period once | Done (delivery via Resend: BLOCKED — REQUIRES EXTERNAL CONFIGURATION) |

## Features intentionally deferred (clearly labeled in the app; no fake buttons)

Phase 3 suggested orders & purchase-order workflow · Phase 4 commissary order form, email,
statuses, production · Phase 5 recipes, nested recipes, recipe cost, actual vs theoretical food
cost · Phase 6 Toast integration · Phase 7 immediate alert emails and monthly owner report · Phase 8
forecasting, dynamic pars, OCR, camera barcode scanning, voice counts. Sales and food-cost %
tiles say "Not connected" / "—" rather than showing invented numbers. PDF export uses the
browser's Print → Save as PDF.

## Tests performed

| Suite | Result |
|---|---|
| Lint (ESLint, Next rules) + TypeScript strict typecheck | Pass, 0 warnings |
| Production build (`next build`) | Pass (44 routes) |
| Unit tests (conversion engine vs shared fixtures, CSV escaping/formula injection, time-zone ranges incl. DST, vendor delivery/cutoff, order list text) | 37 / 37 pass |
| Database / integration tests against real Postgres 15 + Supabase roles (RLS, PIN security, attribution, ledger immutability, receiving/waste/transfer/count math, conversions in SQL, admin, vendor order log, invoice-photo alerts, email report content/attachments/recipients/duplicate-send, mock email provider) | 60 / 60 pass |
| Browser E2E — full demo flow, phone size (steps 1–25 and 28 below) | 9 / 9 pass |
| Browser E2E — log a Sysco order (copy list, open website link, log as placed) then employee receives against it with an invoice photo | 2 / 2 pass |
| Browser E2E — photo required before submit, 2-page invoice upload, owner adds company + manager emails, report preview lists the photos, send-now, scheduler rejects callers without the secret | included in demo flow (10 tests) |
| Browser E2E — every page × owner / management / employee × phone 412px, tablet 820px, desktop 1440px: renders, no horizontal page scroll, no console errors, forbidden pages refused | 9 / 9 pass |

Demo-flow coverage (spec numbering): 1–4 ✔ · 5–10 ✔ (short shipment, discrepancy, +160 LB only,
audit "Employee Shared Account / Carlos", alert) · 11–15 ✔ (switch to Maria, waste, attribution)
· 16 ✘ Toast (Phase 6) · 17–21 ✔ (weekly count incl. Wi-Fi loss and page reload while offline,
book vs physical, recount flag, verify, approve, post) · 22 partial (variance/value update; food
cost needs Phase 5) · 23 partial: order lists can be built, copied and logged by hand; automatic suggested quantities are Phase 3 · 24–25 ✔ ·
26 ✘ commissary order form (Phase 4; commissary transfers work) · 27 ✔ weekly report generated with invoice photos (actual delivery needs Resend keys) · 28 ✔.

Also tested: wrong PIN, repeated wrong PIN (lock + alert), device-wide PIN throttling, PIN reset,
deactivated employee, expired/idle employee session, forged session token, token used with
another login, duplicate invoice, duplicate submission (idempotency), invalid quantities,
missing conversion, malformed input, failure mid-transaction (rollback), concurrent count edit
(conflict), back-dated movement after count submission, ledger/audit tampering attempts,
last-owner removal, self-demotion, privilege escalation attempts by management.

## Bugs found during testing and fixed

| Severity | Bug | Fix |
|---|---|---|
| HIGH (security) | Employee could complete a management-only task (`NOT (NULL OR …)` evaluated NULL) | NULL-safe check + test |
| HIGH (data) | Missing `lines`/`items`/`components` or NULL flag could pass validation (count could be saved as 0) | NULL-safe validation + tests |
| HIGH (data loss) | Count screen showed SAVED while the last typed value was still in a 600 ms debounce, not yet on the device | Every keystroke written to IndexedDB immediately (serialized); SAVED only when nothing pending; E2E reload-while-offline test |
| MEDIUM (data) | Saving a product deleted its storage assignments at other locations | Scoped to edited location + test |
| MEDIUM | Invalid money format in SQL audit text; receiving price-change used a stale factor | Fixed + tests |
| MEDIUM (accessibility) | Most form labels were not linked to their inputs (screen readers) | Shared Field component now always associates label and control |

## Known issues (open)

| Severity | Issue |
|---|---|
| MEDIUM | On phones, the inventory and report tables scroll sideways inside their box (no page overflow, but the status column needs a swipe). A card layout for phones is recommended. |
| LOW | Server log shows "destination stream closed early" when a user is redirected away from a page they may not see (the shell streams, then the client redirects). No data is fetched before the permission check; no user impact. |
| LOW | Local test setup: the stand-in API gateway needed CORS added for direct photo uploads; hosted Supabase provides this, but direct uploads must be re-verified on staging. |
| LOW | Demo seed records the opening count as a large "inventory variance" for this week on the owner dashboard (demo data only). |
| — | Remote vendor URLs (shop.sysco.com, grecoandsons.com) are placeholders to be confirmed by the owner. |

Critical bugs: **0** · High bugs: **0 open** (3 found and fixed).

## Status by area

* **Security:** Database-enforced permissions verified by tests for every role; nothing granted
  to `anon`; secrets server-only (no `NEXT_PUBLIC_` variables; browser never contacts
  Supabase). **NOT YET VERIFIED** on hosted Supabase (forwarding of the `x-employee-session`
  header through Supabase's API gateway must be re-verified on staging — the design fails
  closed if it is not forwarded). No external penetration test performed.
* **Shared employee account / PIN system / attribution:** Implemented and verified (DB + E2E).
* **Database:** Migrations apply cleanly from empty; ledger integrity verified after every
  workflow test. Hosted application **NOT YET VERIFIED**.
* **Backups:** Procedure documented (PITR + weekly `pg_dump`, restore drill).
  **BLOCKED — REQUIRES EXTERNAL CONFIGURATION.**
* **Mobile / tablet / desktop:** Verified at 412×915, 820×1180, 1440×900 in Chromium. Real
  iPhone Safari / iPad Safari / Android Chrome devices: **NOT YET VERIFIED.**
* **Offline counting:** Verified in Chromium (offline entry, reload, automatic sync, no
  duplicates). iOS Safari IndexedDB / PWA behavior: **NOT YET VERIFIED.**
* **Email:** Daily/weekly reports built and verified against a mock email provider (recipients, subject, HTML, base64 invoice-photo attachments, no duplicate sends). Real delivery through Resend: **BLOCKED — REQUIRES EXTERNAL CONFIGURATION** (API key, verified sending domain, recipient addresses). Immediate alert emails and the monthly report: not built.
* **Toast:** Not built (Phase 6). **BLOCKED — REQUIRES TOAST API ACCESS.**
* **Vendor workflow:** Manual (open website, copy list) works; vendor APIs/EDI not built by design.

## Manual calculation verification (performed by hand, matched system output)

| Case | Hand calculation | System |
|---|---|---|
| Count entry 1 CASE + 8.5 LB, case = 40 LB | 40 + 8.5 = 48.5 LB | 48.5 |
| 2 cheddar slices at 0.75 oz | 2 × 0.046875 = 0.09375 → 0.0938 LB | 0.0938 |
| Receive 4 of 5 cases chicken, invoiced 5 @ $128 | +160 LB; credit due (5−4)×128 = $128.00 | +160, $128.00 |
| Mozzarella avg cost: 28 LB @ $3.90 + 20 LB @ $84.55/20 | (109.20 + 84.55)/48 = $4.0365/LB; value 48 × 4.0365 = $193.75 | 4.0365, $193.75 |
| Bacon price $76.50 → $84.15 per 15-LB case | +10.00%; cost 84.15/15 = $5.61/LB; avg (14×5.10+15×5.61)/29 = $5.3638 | 10.00%, 5.61, 5.3638 |
| Waste 3 LB chicken @ $3.20 | $9.60 | $9.60 |
| Waste 8 OZ chicken | 0.5 LB × $3.20 = $1.60 | $1.60 |
| Physical 44 LB vs book B LB chicken @ $3.20 | variance (44 − B) × 3.20; % = (44 − B)/B | matches (E2E + DB test) |
| Rice $27.50 → $30.00 per 25-LB bag | +9.0909%; $1.20/LB | 9.0909, 1.20 |
| Day boundaries, America/New_York | Oct 1 = 04:00Z–04:00Z; Nov 1 (DST end) 25 h | matches |

## Required before production (in order)

1. Create staging Supabase + Vercel projects; apply migrations; re-run DB and E2E suites against staging; verify header forwarding and storage.
2. Build and verify Phases 3–7 (at minimum those the restaurant needs on day one), each through the same test gate.
3. Test on real devices (iPhone, iPad, Android) including offline counting in the walk-in.
4. Enable PITR, run a restore drill, document results.
5. Complete the owner acceptance checklist with real data on staging.
6. Update this report; launch only when it reads READY FOR PRODUCTION.
