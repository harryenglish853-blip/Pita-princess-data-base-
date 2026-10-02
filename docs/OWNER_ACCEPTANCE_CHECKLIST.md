# Owner acceptance checklist

Do this on **staging** with the restaurant's real configuration, before anything goes live.
The software working is not the same as the restaurant's setup being correct — check both.
Initial each line, with the date.

## Logins and people
- [ ] Owner #1 can sign in and sees the Restaurant Control Center
- [ ] Owner #2 can sign in and sees the Restaurant Control Center
- [ ] Management can sign in, sees the Operations dashboard, and CANNOT open Administration → Login accounts / Settings
- [ ] The ONE shared Employee login signs in and lands on WHO ARE YOU? (and cannot reach anything else until a PIN is entered)
- [ ] The WHO ARE YOU? list shows exactly the current employees (no demo names: John/Maria/Carlos/Alex are demo only)
- [ ] Each employee has been given their PIN privately; managers know PINs can be reset but never viewed
- [ ] Wrong PIN 5 times locks that employee for 10 minutes; a manager PIN reset unlocks them
- [ ] SWITCH EMPLOYEE returns to WHO ARE YOU? without asking for the shared password
- [ ] Leaving a tablet untouched for the idle timeout (default 5 minutes) returns to WHO ARE YOU?
- [ ] Employee Activity report shows each person's actions under their own name
- [ ] Correct management permissions chosen (Administration → Login accounts → What "Management" may do)

## Restaurant setup
- [ ] Restaurant name and time zone correct (Administration → Settings)
- [ ] Locations correct (restaurant, commissary)
- [ ] Storage areas correct and in walking order
- [ ] Count order matches the real shelves in each storage area (do a test count walk-through)
- [ ] Products complete; each has the right inventory unit, purchase unit and case size
- [ ] Units and conversions correct (spot-check: 1 CASE chicken = __ LB, 1 CASE cream = __ QT)
- [ ] Product costs correct (spot-check 10 items against recent invoices)
- [ ] Par, low-stock and critical levels correct
- [ ] Categories correct; paper/supplies/chemicals marked non-food
- [ ] Vendors correct: Sysco and Greco account numbers, delivery days, cutoffs, lead times
- [ ] OPEN SYSCO opens the correct Sysco ordering site
- [ ] OPEN GRECO opens the correct Greco ordering site
- [ ] Commissary contacts/details correct
- [ ] Alert thresholds acceptable (price increase %, high waste $, recount % and $)

## Workflows (with real items, on staging)
- [ ] Receive a delivery on a phone, including a short shipment → discrepancy + alert appear
- [ ] Attach an invoice photo from the phone camera
- [ ] Log waste on a phone; cost looks right
- [ ] Transfer between storage areas
- [ ] Full weekly count on the tablet, including a stretch with Wi-Fi off in the walk-in
- [ ] Review variances, recount a flagged item, approve, post; on-hand matches the count
- [ ] Reports and CSV exports open correctly in Excel

- [ ] Suggested orders: for each vendor, open VIEW SUGGESTED ORDER, tap WHY? on several lines and
      confirm the math matches what you would order (set dynamic par only on items with steady usage)

## Not yet available (do not plan operations around these)
- [ ] Understood: commissary order forms, recipes/food cost, Toast sales,
      immediate alert emails, monthly report, advanced forecasting, barcode camera and voice counts are later phases

Signed (Owner #1): ____________  Date: ______   Signed (Owner #2): ____________  Date: ______
