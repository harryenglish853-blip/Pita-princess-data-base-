# Restaurant Inventory — private operations website

A private, mobile-first **website** (not an app-store app) for restaurant inventory, receiving, waste,
transfers, physical counts, ordering, the commissary, recipes and food cost, Toast POS sales
and email reports. It is **not** a public site and **not** an app-store
app: staff open a private URL on phones, tablets or computers and can add it to their
home screen (PWA).

> **Status: Phase 1 (foundation) and Phase 2 (core operations) are built and tested.
> The system is NOT READY FOR PRODUCTION yet** — see
> [docs/LAUNCH_READINESS_REPORT.md](docs/LAUNCH_READINESS_REPORT.md) for exactly what is
> done, what is verified, and what is still required.

## Who logs in

| Login | Who | What they see |
|---|---|---|
| Owner #1, Owner #2 | Owners | Everything, including settings, logins, permissions, audit log |
| Management | Managers | Operations: counts, receiving review, waste, ordering, reports, employees (owner can restrict) |
| **One shared Employee login** | All regular employees | `WHO ARE YOU?` → tap your name → 4-digit PIN → Receive, Waste, Transfer, Tasks |

Regular employees **do not** get their own logins. They are *employee profiles* under the
one shared login. Every action stores both the login account **and** the PIN-verified
employee, so the activity report shows "Carlos received Sysco delivery #83923" even though
Carlos and Maria share one login.

## What works today

- Secure login, role-based access, Row Level Security on every table, nothing public except `/login`
- Shared employee login with `WHO ARE YOU?`, hashed PINs, lockout after wrong PINs, device-wide
  throttling, switch employee, lock, automatic inactivity lock
- Products, categories, storage areas, units and a single conversion engine (1 CASE + 8.5 LB = 48.5 LB)
- Immutable inventory ledger with perpetual (book) inventory and weighted-average cost
- Receiving (Sysco / Greco / Commissary / other) with short/over/missing/rejected/invoice-quantity
  /price discrepancies, credit-due estimate, price history, price alerts, invoice photo upload
- Waste logging with automatic cost; transfers between storage areas and locations
- Weekly / daily critical / storage-area / category / month-end counts in shelf-to-sheet order,
  autosave, **offline counting with automatic sync**, multiple counters with conflict detection,
  book-vs-physical variance, recount flags, approve, post
- Owner control center, management dashboard, simple employee home, attention center, tasks, alerts
- Reports (inventory value, variance, waste, deliveries & vendor spending, price history, employee
  activity, audit log) with CSV export
- Ordering center: vendors are NOT integrated — each vendor card has OPEN SYSCO / OPEN GRECO
  (opens the vendor's own website), a low-stock list, and LOG AN ORDER: build the list, COPY ORDER
  LIST, place it on the vendor website, then log it here (with the vendor confirmation #).
  Deliveries can be received against a logged order, so short/over shipments are caught.
- **Suggested orders**: VIEW SUGGESTED ORDER on each vendor card prefills the order with
  `need − have`, rounded up to whole cases. Need = par level, or (dynamic par with 7+ days of
  history) average daily usage × days until the following delivery + safety stock. Have = on hand +
  already ordered + transfers on the way. Every line has a WHY? breakdown; the system suggestion
  and the manager's quantity are both stored (computed on the server, never trusted from the browser).
- **Commissary (central kitchen)**: NEW COMMISSARY ORDER (items, quantity, unit, needed date, notes;
  suggested quantities available) → SUBMIT emails the order to the commissary recipients with a
  VIEW ORDER link → statuses SUBMITTED, ACCEPTED, PREPARING, READY, IN TRANSIT, RECEIVED (or
  CANCELLED with a reason), each with who and when. The commissary enters what it sent; the
  restaurant (any employee on the shared login) confirms what arrived. Inventory moves only by what
  was received (commissary out = restaurant in), and any shortage is flagged to management.
- **Production**: record a batch (e.g. 20 QT Marinara from tomatoes, oil, onion). Ingredients leave
  inventory; the finished product comes in at the cost of the ingredients used. The next batch
  pre-fills from the product's prep recipe (scaled to the batch), or else from the last batch.
- Employee profile management (add, rename, reset PIN, deactivate — history kept)

- **Invoice photos are required** for every delivery (by hand or against a logged order); several
  pages per invoice; a delivery saved without one shows as "invoice photo missing" until fixed
- **Email reports** (owner chooses who gets what, per recipient): **daily** (previous day: sales,
  estimated food cost, deliveries with who received them, discrepancies, credit due, **invoice
  photos attached**, orders, waste, low stock, price changes, counts, employee activity, open
  alerts), **weekly** (adds actual vs theoretical food cost, beginning/ending inventory, top loss,
  vendor spending, inventory completion) and the **monthly owner report** (sales, purchases, food
  cost, AvT, waste %, inventory variance, vendor spending and price trends, top loss products,
  best/worst weeks, inventory turnover, month-over-month). Preview / send now / history in
  Administration → Email reports.
- **Immediate alert emails** by category (high waste, inventory variance, delivery discrepancies,
  major price increases, critical / low stock, inventory due, vendor order reminders, failed Toast
  sync, PIN security): sent right after the event (plus a 10-minute safety-net job), only when
  thresholds are met, each event at most once per person, grouped, with a per-person cooldown.
- **Recipes & food cost**: menu items and prep recipes with nested sub-recipes (e.g. House Sauce in
  several sandwiches; loops are rejected). Cost per portion, food cost % and margin are calculated
  live from current ingredient costs, so a price change flows through every recipe that uses it.
- **Daily sales** (entered per menu item until Toast is connected): each sale posts its ingredient
  usage to inventory through the recipes (theoretical usage). Re-saving a day never double counts;
  changes and voids reverse and re-post. Sales without a recipe stay UNMAPPED and post nothing.
- **Actual vs theoretical food cost** (owners): actual = beginning inventory + purchases − ending
  inventory (food items, from the ledger); theoretical = sales × recipe usage; variance in $ and
  points, drill down by category, product (beginning / received / theoretical / waste / expected /
  ending / unexplained), menu item and day; CSV. The owner control center shows the same numbers.

- **Toast POS** (Toast POS screen): menu import, sales import (hourly + a SYNC SALES button) and a
  signed webhook. Toast-specific code is only an adapter (`src/lib/pos/toast`) that turns Toast
  orders into neutral POS orders; the database applies them generically. Each order/line is stored
  once by its Toast id: repeated or older deliveries change nothing, updates replace (never add),
  removed items, voids and quantity changes reverse the usage; refunds lower sales only. Every
  Toast item is mapped to a recipe, marked "not tracked" (gift cards), or shown as **UNMAPPED
  TOAST ITEM** with no usage posted until mapped — then its earlier sales are posted once.
  AUTO-MATCH BY NAME, sync log with errors. Needs Toast API credentials
  (BLOCKED — REQUIRES EXTERNAL CONFIGURATION until set); a local mock Toast API is used for tests.
  A day with Toast sales cannot also be entered by hand.

Not built yet (clearly labeled in the app): forecasting / barcode camera / voice / OCR (Phase 8).

## Technology

Next.js 16 (App Router, React 19, TypeScript, Tailwind CSS 4) · Supabase (Postgres 15, Auth,
Storage, Row Level Security) · Vercel · IndexedDB + service worker for offline counts.
The browser never talks to Supabase directly; all keys are server-side only.

## Local development

Requires Docker and Node 22.

```bash
npm ci
node scripts/local/keys.mjs          # writes .env.local for the LOCAL stack only
./scripts/local/stack-up.sh          # Postgres + Auth + REST + Storage (Supabase images) + gateway
./scripts/local/db-reset.sh          # apply all migrations to the local database
DEMO_PASSWORD=demo-password-123 npm run seed:demo   # demo data (refuses non-local databases)
npm run dev                          # http://localhost:3000
```

Demo logins (local only): `owner1@demo.local`, `owner2@demo.local`, `manager@demo.local`,
`employees@demo.local` with `DEMO_PASSWORD`. Demo employee PINs: John 1357, Maria 2468,
Carlos 4826, Alex 9173. **Demo records are flagged `is_demo` and must never be loaded into
production.**

## Tests

```bash
npm run lint && npm run typecheck
npm test                 # unit tests (conversion engine, CSV, dates, vendor schedule)
npm run test:db          # database tests: RLS, PIN security, attribution, ledger, workflows (resets LOCAL db)
npx next build && npm run test:e2e   # browser tests on phone, tablet and desktop sizes (resets LOCAL db)
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, data model, security model
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — staging → production, accounts, backups, restore
- [docs/OWNER_ACCEPTANCE_CHECKLIST.md](docs/OWNER_ACCEPTANCE_CHECKLIST.md) — what the owner must confirm
- [docs/LAUNCH_READINESS_REPORT.md](docs/LAUNCH_READINESS_REPORT.md) — current verdict and evidence
