import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import fixtures from '../fixtures/conversions.json';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
const n = (v: unknown) => Number(v);

async function balance(code: string, loc = 'MAIN') {
  const r = await db.query(`select quantity, avg_cost from public.inventory_balances where product_id = $1 and location_id = $2`, [I.product(code), I.location(loc)]);
  return { qty: n(r.rows[0]?.quantity ?? 0), avg: n(r.rows[0]?.avg_cost ?? 0) };
}
async function pin(name: string, p: string) {
  return asUser(db, { userId: I.employeeAccount }, async (q) => (await q('select public.start_employee_session($1,$2) r', [I.employee(name), p]))[0].r.token as string);
}
const mgr = () => ({ userId: I.manager });

beforeAll(async () => {
  resetAndSeed();
  db = await connect();
  I = await ids(db);
});
afterAll(async () => db?.end());

describe('database conversion engine matches the shared fixtures', () => {
  it('every fixture vector', async () => {
    await db.query('begin');
    try {
      const pid: Record<string, string> = {};
      for (const [key, p] of Object.entries(fixtures.products)) {
        const r = await db.query(`insert into public.products (item_code, name, inventory_unit) values ($1, $2, $3) returning id`, [`T-${key.toUpperCase()}`, `Test ${key}`, p.inventory_unit]);
        pid[key] = r.rows[0].id;
        for (const [u, f] of Object.entries(p.conversions)) {
          await db.query(`insert into public.product_unit_conversions values ($1, $2, $3)`, [pid[key], u, f]);
        }
      }
      for (const [prod, qty, unit, expected] of fixtures.single) {
        const r = await db.query(`select app.to_inventory_qty($1, $2, $3) v`, [pid[prod], qty, unit]);
        expect(`${prod} ${qty} ${unit} = ${n(r.rows[0].v)}`).toBe(`${prod} ${qty} ${unit} = ${n(expected)}`);
      }
      for (const [prod, comps, expected] of fixtures.components as [string, [string, string][], string][]) {
        const r = await db.query(`select round(sum(c.q::numeric * app.unit_factor_to_inventory($1, c.u)), 4) v from json_to_recordset($2) c(q text, u text)`,
          [pid[prod], JSON.stringify(comps.map(([q, u]) => ({ q, u })))]);
        expect(n(r.rows[0].v)).toBe(n(expected));
      }
      for (const [prod, qty, unit] of fixtures.errors) {
        await db.query('savepoint s');
        await expectFail(db.query(`select app.to_inventory_qty($1, $2, $3)`, [pid[prod], qty, unit]), 'VALIDATION');
        await db.query('rollback to savepoint s');
      }
    } finally {
      await db.query('rollback');
    }
  });
});

describe('DEMO: Carlos receives a Sysco delivery with a short shipment', () => {
  let eventId: string;
  const key = randomUUID();
  let token: string;
  let before: { qty: number; avg: number };

  it('posts only the received quantity and flags the discrepancy', async () => {
    token = await pin('Carlos', '4826');
    before = await balance('P-CHKBR');
    const tomatoBefore = await balance('P-TOMATO');
    const payload = {
      idempotency_key: key, vendor_id: I.vendor('SYSCO'), invoice_number: '83923',
      delivery_date: new Date().toISOString().slice(0, 10), temperature_ok: true,
      lines: [
        { product_id: I.product('P-CHKBR'), unit_code: 'CASE', ordered_qty: 5, received_qty: 4, invoiced_qty: 5, unit_price: 128 },
        { product_id: I.product('P-TOMATO'), unit_code: 'CASE', ordered_qty: 2, received_qty: 2, invoiced_qty: 2, unit_price: 36.25 },
      ],
    };
    const r = await asUser(db, { userId: I.employeeAccount, employeeToken: token }, async (q) => (await q('select public.submit_receiving($1) r', [payload]))[0].r);
    eventId = r.receiving_event_id;
    expect(r.discrepancy_count).toBe(2);
    expect(r.discrepancies.map((d: any) => d.type).sort()).toEqual(['INVOICE_QUANTITY_DIFFERENCE', 'SHORT_SHIPMENT']);
    expect(n(r.credit_due_estimate)).toBe(128); // billed 5 cases, received 4: 1 x $128

    const after = await balance('P-CHKBR');
    expect(after.qty).toBe(before.qty + 160); // 4 cases x 40 LB, not 5
    // weighted average: (60 LB x 3.20 + 160 x 3.20) / 220 = 3.20 (same price)
    expect(after.avg).toBe(3.2);
    const tomato = await balance('P-TOMATO');
    expect(tomato.qty).toBe(tomatoBefore.qty + 50); // 2 cases x 25 LB

    const ev = (await db.query('select * from public.receiving_events where id = $1', [eventId])).rows[0];
    expect(ev.employee_id).toBe(I.employee('Carlos'));
    expect(ev.account_id).toBe(I.employeeAccount);
    expect(n(ev.received_total)).toBe(4 * 128 + 2 * 36.25);
    expect(n(ev.invoiced_total)).toBe(5 * 128 + 2 * 36.25);

    const audit = (await db.query(`select * from public.audit_logs where entity_id = $1 and action = 'receiving.received'`, [eventId])).rows[0];
    expect(audit.employee_name).toBe('Carlos');
    expect(audit.account_name).toBe('Employee Shared Account');
    expect(audit.summary).toBe('Carlos received Sysco delivery #83923 (2 items, 2 discrepancies)');

    const alert = (await db.query(`select * from public.alerts where alert_type = 'DELIVERY_DISCREPANCY' and entity_id = $1`, [eventId])).rows[0];
    expect(alert.status).toBe('open');
    expect(alert.message).toContain('possible credit due $128.00');
    expect(alert.message).toContain('Received by Carlos');
  });

  it('retrying the same submission does not post twice', async () => {
    const qty = (await balance('P-CHKBR')).qty;
    const r = await asUser(db, { userId: I.employeeAccount, employeeToken: token }, async (q) =>
      (await q('select public.submit_receiving($1) r', [{ idempotency_key: key, vendor_id: I.vendor('SYSCO'), invoice_number: '83923', delivery_date: new Date().toISOString().slice(0, 10), lines: [{ product_id: I.product('P-CHKBR'), received_qty: 4 }] }]))[0].r);
    expect(r.receiving_event_id).toBe(eventId);
    expect((await balance('P-CHKBR')).qty).toBe(qty);
  });

  it('the same invoice cannot be received twice', async () => {
    const msg = await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: token }, (q) =>
      q('select public.submit_receiving($1)', [{ idempotency_key: randomUUID(), vendor_id: I.vendor('SYSCO'), invoice_number: '83923', delivery_date: new Date().toISOString().slice(0, 10), lines: [{ product_id: I.product('P-CHKBR'), unit_code: 'CASE', received_qty: 1 }] }])), 'DUPLICATE');
    expect(msg).toContain('already received by Carlos');
  });

  it('rejects invalid input without changing inventory', async () => {
    const qty = (await balance('P-CHKBR')).qty;
    const base = { vendor_id: I.vendor('SYSCO'), delivery_date: new Date().toISOString().slice(0, 10) };
    const u = { userId: I.employeeAccount, employeeToken: token };
    await expectFail(asUser(db, u, (q) => q('select public.submit_receiving($1)', [{ ...base, invoice_number: 'X1', lines: [{ product_id: I.product('P-CHKBR'), unit_code: 'CASE', received_qty: -1 }] }])), 'VALIDATION');
    await expectFail(asUser(db, u, (q) => q('select public.submit_receiving($1)', [{ ...base, invoice_number: 'X2', lines: [{ product_id: I.product('P-CHKBR'), unit_code: 'GAL', received_qty: 1 }] }])), 'No conversion');
    await expectFail(asUser(db, u, (q) => q('select public.submit_receiving($1)', [{ ...base, lines: [{ product_id: I.product('P-CHKBR'), received_qty: 1 }] }])), 'invoice number');
    await expectFail(asUser(db, u, (q) => q('select public.submit_receiving($1)', [{ ...base, invoice_number: 'X3', lines: [] }])), 'at least one item');
    await expectFail(asUser(db, u, (q) => q('select public.submit_receiving($1)', [{ ...base, invoice_number: 'X5' }])), 'at least one item');
    // a failure on line 2 rolls back line 1
    await expectFail(asUser(db, u, (q) => q('select public.submit_receiving($1)', [{ ...base, invoice_number: 'X4', lines: [
      { product_id: I.product('P-CHKBR'), unit_code: 'CASE', received_qty: 1 },
      { product_id: I.product('P-CHKBR'), unit_code: 'CASE', received_qty: 1, rejected_qty: 1 }] }])), 'why product was rejected');
    expect((await balance('P-CHKBR')).qty).toBe(qty);
    expect((await db.query(`select count(*)::int c from public.receiving_events where invoice_number like 'X%'`)).rows[0].c).toBe(0);
  });

  it('management resolves the discrepancy; alert closes when all are handled', async () => {
    const ds = (await db.query('select id from public.delivery_discrepancies where receiving_event_id = $1', [eventId])).rows;
    await expectFail(asUser(db, mgr(), (q) => q(`select public.resolve_discrepancy($1, 'resolved', '')`, [ds[0].id])), 'note');
    for (const d of ds) await asUser(db, mgr(), (q) => q(`select public.resolve_discrepancy($1, 'resolved', 'Credit memo received')`, [d.id]));
    const alert = (await db.query(`select status from public.alerts where alert_type = 'DELIVERY_DISCREPANCY' and entity_id = $1`, [eventId])).rows[0];
    expect(alert.status).toBe('resolved');
    // no photo was attached in this database-level test, so the photo alert stays open
    const photo = (await db.query(`select status from public.alerts where alert_type = 'INVOICE_PHOTO_MISSING' and entity_id = $1`, [eventId])).rows[0];
    expect(photo.status).toBe('open');
  });

  it('a price increase records price history and raises a price alert', async () => {
    await asUser(db, mgr(), (q) => q('select public.submit_receiving($1)', [{ idempotency_key: randomUUID(), vendor_id: I.vendor('SYSCO'), invoice_number: 'PX-1', delivery_date: new Date().toISOString().slice(0, 10),
      lines: [{ product_id: I.product('P-BACON'), unit_code: 'CASE', received_qty: 1, invoiced_qty: 1, unit_price: 84.15 }] }]));
    const ph = (await db.query(`select * from public.price_history where product_id = $1 order by id desc limit 1`, [I.product('P-BACON')])).rows[0];
    expect(n(ph.old_price)).toBe(76.5);
    expect(n(ph.new_price)).toBe(84.15);
    expect(n(ph.change_pct)).toBe(10); // (84.15 - 76.50) / 76.50
    const p = (await db.query('select current_cost, last_cost from public.products where id = $1', [I.product('P-BACON')])).rows[0];
    expect(n(p.current_cost)).toBe(5.61); // 84.15 / 15 LB
    // avg: (14 LB x 5.10 + 15 x 5.61) / 29 = 5.3638
    expect((await balance('P-BACON')).avg).toBe(5.3638);
    const a = (await db.query(`select message from public.alerts where alert_type = 'PRICE_INCREASE' and product_id = $1`, [I.product('P-BACON')])).rows[0];
    expect(a.message).toBe('Bacon $76.50 → $84.15 per CASE (+10.00%)');
  });
});

describe('DEMO: Maria logs waste after switching employee', () => {
  it('decreases inventory and calculates cost at average cost', async () => {
    const maria = await pin('Maria', '2468');
    const before = await balance('P-AVO');
    const r = await asUser(db, { userId: I.employeeAccount, employeeToken: maria }, async (q) =>
      (await q('select public.log_waste($1) r', [{ idempotency_key: randomUUID(), product_id: I.product('P-AVO'), quantity: 2, unit_code: 'EA', reason_code: 'SPOILED', storage_location_id: I.storage('Walk-In Cooler') }]))[0].r);
    expect(n(r.total_cost)).toBe(2.6); // 2 x $1.30
    expect((await balance('P-AVO')).qty).toBe(before.qty - 2);
    const a = (await db.query(`select employee_name, summary from public.audit_logs where entity_id = $1`, [r.waste_entry_id])).rows[0];
    expect(a).toEqual({ employee_name: 'Maria', summary: 'Maria logged 2 EA Avocado waste (Spoiled, $2.60)' });
  });

  it('chicken: 3 LB dropped at $3.20/LB = $9.60; case units convert', async () => {
    const maria = await pin('Maria', '2468');
    const r = await asUser(db, { userId: I.employeeAccount, employeeToken: maria }, async (q) =>
      (await q('select public.log_waste($1) r', [{ product_id: I.product('P-CHKBR'), quantity: 3, unit_code: 'LB', reason_code: 'DROPPED' }]))[0].r);
    expect(n(r.total_cost)).toBe(9.6);
    const r2 = await asUser(db, { userId: I.employeeAccount, employeeToken: maria }, async (q) =>
      (await q('select public.log_waste($1) r', [{ product_id: I.product('P-CHKBR'), quantity: 8, unit_code: 'OZ', reason_code: 'OVERCOOKED' }]))[0].r);
    expect(n(r2.quantity_inv)).toBe(0.5);
    expect(n(r2.total_cost)).toBe(1.6);
  });

  it('validates input', async () => {
    const maria = await pin('Maria', '2468');
    const u = { userId: I.employeeAccount, employeeToken: maria };
    await expectFail(asUser(db, u, (q) => q('select public.log_waste($1)', [{ product_id: I.product('P-CHKBR'), quantity: 0, reason_code: 'DROPPED' }])), 'greater than 0');
    await expectFail(asUser(db, u, (q) => q('select public.log_waste($1)', [{ product_id: I.product('P-CHKBR'), quantity: 1, reason_code: 'NOPE' }])), 'waste reason');
    await expectFail(asUser(db, u, (q) => q('select public.log_waste($1)', [{ product_id: I.product('P-CHKBR'), quantity: 1, reason_code: 'OTHER' }])), 'note');
  });
});

describe('transfers', () => {
  it('storage transfer moves product without changing the location total', async () => {
    const john = await pin('John', '1357');
    const before = await balance('P-GRBEEF');
    const r = await asUser(db, { userId: I.employeeAccount, employeeToken: john }, async (q) =>
      (await q('select public.create_transfer($1) r', [{ transfer_type: 'storage', from_storage_location_id: I.storage('Walk-In Cooler'), to_storage_location_id: I.storage('Line Cooler'),
        items: [{ product_id: I.product('P-GRBEEF'), quantity: 10, unit_code: 'LB' }] }]))[0].r);
    expect(r.status).toBe('received');
    expect((await balance('P-GRBEEF')).qty).toBe(before.qty);
    const txns = (await db.query(`select txn_type, quantity, employee_id from public.inventory_transactions where reference = $1 order by id`, [`Transfer #${r.transfer_number}`])).rows;
    expect(txns.map((t) => [t.txn_type, n(t.quantity)])).toEqual([['TRANSFER_OUT', -10], ['TRANSFER_IN', 10]]);
    expect(txns.every((t) => t.employee_id === I.employee('John'))).toBe(true);
    const a = (await db.query(`select summary from public.audit_logs where entity_id = $1`, [r.transfer_id])).rows[0];
    expect(a.summary).toBe('John transferred 10 LB Ground Beef 80/20 from Walk-In Cooler to Line Cooler');
  });

  it('employees cannot send product to another location', async () => {
    const john = await pin('John', '1357');
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: john }, (q) => q('select public.create_transfer($1)', [{ transfer_type: 'location', from_location_id: I.location('CK'), to_location_id: I.location('MAIN'), items: [{ product_id: I.product('P-DOUGH'), quantity: 1 }] }])), 'FORBIDDEN');
  });

  it('commissary -> restaurant transfer: out at send, in at receipt, difference flagged', async () => {
    const ckBefore = await balance('P-MEATB', 'CK');
    const mainBefore = await balance('P-MEATB');
    const r = await asUser(db, mgr(), async (q) => (await q('select public.create_transfer($1) r', [{ transfer_type: 'location', from_location_id: I.location('CK'), to_location_id: I.location('MAIN'),
      items: [{ product_id: I.product('P-MEATB'), quantity: 100, unit_code: 'EA' }] }]))[0].r);
    expect((await balance('P-MEATB', 'CK')).qty).toBe(ckBefore.qty - 100);
    expect((await balance('P-MEATB')).qty).toBe(mainBefore.qty);
    const item = (await db.query('select id from public.transfer_items where transfer_id = $1', [r.transfer_id])).rows[0];
    const maria = await pin('Maria', '2468');
    const rr = await asUser(db, { userId: I.employeeAccount, employeeToken: maria }, async (q) => (await q('select public.receive_transfer($1, $2) r', [r.transfer_id, JSON.stringify([{ transfer_item_id: item.id, received_quantity: 95 }])]))[0].r);
    expect(rr.has_differences).toBe(true);
    expect((await balance('P-MEATB')).qty).toBe(mainBefore.qty + 95);
    const t = (await db.query('select received_employee_id from public.inventory_transfers where id = $1', [r.transfer_id])).rows[0];
    expect(t.received_employee_id).toBe(I.employee('Maria'));
    expect((await db.query(`select count(*)::int c from public.alerts where alert_type = 'TRANSFER_DIFFERENCE'`)).rows[0].c).toBe(1);
  });
});

describe('manual adjustment', () => {
  it('requires a reason and the current quantity; records old/new', async () => {
    const b = await balance('P-RICE');
    await expectFail(asUser(db, mgr(), (q) => q(`select public.adjust_inventory($1, null, 30, $2, 'NOPE', null, gen_random_uuid())`, [I.product('P-RICE'), b.qty])), 'reason');
    await expectFail(asUser(db, mgr(), (q) => q(`select public.adjust_inventory($1, null, 30, $2, 'DAMAGE', null, gen_random_uuid())`, [I.product('P-RICE'), b.qty + 1])), 'CONFLICT');
    const r = await asUser(db, mgr(), async (q) => (await q(`select public.adjust_inventory($1, null, 30, $2, 'DAMAGE', 'torn bag', gen_random_uuid()) r`, [I.product('P-RICE'), b.qty]))[0].r);
    expect(n(r.adjustment)).toBe(30 - b.qty);
    expect((await balance('P-RICE')).qty).toBe(30);
    const a = (await db.query(`select old_values, new_values, summary from public.audit_logs where action = 'inventory.adjusted' order by id desc limit 1`)).rows[0];
    expect(n(a.old_values.quantity)).toBe(b.qty);
    expect(n(a.new_values.quantity)).toBe(30);
  });
});

describe('DEMO: weekly inventory — book vs physical, recount, post', () => {
  let sid: string;
  let sheet: any;

  it('only one full inventory can be open', async () => {
    sid = await asUser(db, mgr(), async (q) => (await q(`select public.start_count('{"count_type":"weekly_full"}'::jsonb) id`))[0].id);
    await expectFail(asUser(db, mgr(), (q) => q(`select public.start_count('{"count_type":"weekly_full"}'::jsonb)`)), 'already open');
    sheet = await asUser(db, mgr(), async (q) => (await q('select public.get_count_sheet($1) s', [sid]))[0].s);
    // follows shelf-to-sheet order: Walk-In Cooler Shelf 1 items first
    expect(sheet.entries[0].storage_name).toBe('Walk-In Cooler');
    expect(sheet.entries.length).toBe(27);
  });

  it('saves counts with versioning, idempotency and conflict detection', async () => {
    const chicken = sheet.entries.find((e: any) => e.item_code === 'P-CHKBR');
    const mut = randomUUID();
    const save = (comps: any, version: number, device: string, m = randomUUID()) =>
      asUser(db, mgr(), async (q) => (await q('select public.save_count_entry($1,$2,$3,$4,$5) r', [chicken.id, JSON.stringify(comps), version, device, m]))[0].r);
    // 1 CASE + 8.5 LB = 48.5 LB
    let r = await save([{ qty: 1, unit: 'CASE' }, { qty: 8.5, unit: 'LB' }], 0, 'tablet-1', mut);
    expect(r.status).toBe('saved');
    expect(n(r.entry.counted_qty)).toBe(48.5);
    // same mutation replayed (offline sync retry) -> duplicate, no change
    r = await save([{ qty: 99, unit: 'LB' }], 0, 'tablet-1', mut);
    expect(r.status).toBe('duplicate');
    expect(n(r.entry.counted_qty)).toBe(48.5);
    // another device with a stale version -> conflict, nothing overwritten
    r = await save([{ qty: 10, unit: 'LB' }], 0, 'phone-2');
    expect(r.status).toBe('conflict');
    expect(n(r.entry.counted_qty)).toBe(48.5);
    // Physical count lower than book -> large variance
    r = await save([{ qty: 1, unit: 'CASE' }, { qty: 4, unit: 'LB' }], 1, 'tablet-1');
    expect(r.status).toBe('saved');
    expect(n(r.entry.counted_qty)).toBe(44);
    // malformed / missing components never save as zero
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_count_entry($1,null,2,$2,$3)', [chicken.id, 'tablet-1', randomUUID()])), 'Invalid count entry');
    await expectFail(save([{ qty: 'abc', unit: 'LB' }], 2, 'tablet-1'), 'numbers');
    await expectFail(save([{ qty: 5, unit: 'GAL' }], 2, 'tablet-1'), 'No conversion');
    const revs = (await db.query('select count(*)::int c from public.inventory_count_revisions where entry_id = $1', [chicken.id])).rows[0].c;
    expect(revs).toBe(2);
  });

  it('refuses to submit with blank lines unless explicitly counted as zero', async () => {
    const r = await asUser(db, mgr(), async (q) => (await q('select public.submit_count($1, false) r', [sid]))[0].r);
    expect(r.status).toBe('uncounted');
    expect(r.uncounted).toBe(26);
  });

  it('computes book vs physical and flags a recount', async () => {
    // Count every other line at its current book quantity, so only chicken is off.
    for (const e of sheet.entries) {
      if (e.item_code === 'P-CHKBR') continue;
      const b = await balance(e.item_code);
      await asUser(db, mgr(), (q) => q('select public.save_count_entry($1,$2,$3,$4,$5)', [e.id, JSON.stringify([{ qty: b.qty, unit: e.inventory_unit }]), 0, 'tablet-1', randomUUID()]));
    }
    const book = await balance('P-CHKBR');
    const r = await asUser(db, mgr(), async (q) => (await q('select public.submit_count($1, false) r', [sid]))[0].r);
    expect(r).toEqual({ status: 'RECOUNT_REQUIRED', recount_required: 1 });
    const v = (await db.query('select * from public.inventory_variances where session_id = $1 and product_id = $2', [sid, I.product('P-CHKBR')])).rows[0];
    expect(n(v.book_qty)).toBe(book.qty);
    expect(n(v.physical_qty)).toBe(44);
    expect(n(v.variance_qty)).toBe(44 - book.qty);
    expect(n(v.variance_value)).toBe(Math.round((44 - book.qty) * n(v.unit_cost) * 100) / 100);
    expect(n(v.variance_pct)).toBe(Math.round(((44 - book.qty) / book.qty) * 10000) / 100);
    expect(v.recount_required).toBe(true);
    await expectFail(asUser(db, mgr(), (q) => q('select public.approve_count($1)', [sid])), 'Recount');
  });

  it('a recount that confirms the number is verified, then approved and posted', async () => {
    await asUser(db, mgr(), (q) => q(`select public.verify_recount($1, $2, 'Recounted twice, 44 LB is correct')`, [sid, I.product('P-CHKBR')]));
    await asUser(db, mgr(), (q) => q('select public.approve_count($1)', [sid]));
    // employees cannot edit an approved count
    const chicken = sheet.entries.find((e: any) => e.item_code === 'P-CHKBR');
    const locked = await asUser(db, mgr(), async (q) => (await q('select public.save_count_entry($1,$2,$3,$4,$5) r', [chicken.id, '[{"qty":1,"unit":"LB"}]', 2, 'tablet-1', randomUUID()]))[0].r);
    expect(locked.status).toBe('locked');
    const r = await asUser(db, mgr(), async (q) => (await q('select public.post_count($1) r', [sid]))[0].r);
    expect(r.status).toBe('posted');
    expect((await balance('P-CHKBR')).qty).toBe(44);
    const integrity = (await asUser(db, { userId: I.owner1 }, (q) => q('select * from public.ledger_integrity_check()')));
    expect(integrity).toHaveLength(0);
    await expectFail(db.query('update public.inventory_count_entries set counted_qty = 1 where id = $1', [chicken.id]), 'LOCKED');
    const audit = (await db.query(`select summary from public.audit_logs where action = 'counts.posted' order by id desc limit 1`)).rows[0];
    expect(audit.summary).toMatch(/^Management posted Weekly inventory/);
  });

  it('dashboard reflects the posted variance and derives numbers from data', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const owner = (await asUser(db, { userId: I.owner1 }, (q) => q(`select public.dashboard_metrics(current_date - 7, current_date) m`)))[0].m;
    // demo sales were entered for today: sales come from them, not from nothing
    const sales = (await db.query(`select coalesce(sum(net_amount),0) v from public.sales_transactions where not is_void and business_date between current_date - 7 and current_date`)).rows[0].v;
    expect(owner.sales.connected).toBe(true);
    expect(n(owner.sales.amount)).toBe(n(sales));
    expect(owner.purchases).not.toBeNull();
    const posted = (await db.query(`select coalesce(sum(variance_value),0) v from public.inventory_count_sessions where status='POSTED' and posted_at > now() - interval '8 days'`)).rows[0].v;
    expect(n(owner.inventory_variance)).toBe(n(posted));
    const inv = (await db.query(`select round(sum(inventory_value),2) v from public.inventory_on_hand o join public.locations l on l.id=o.location_id where l.code='MAIN' and o.is_active`)).rows[0].v;
    expect(n(owner.inventory_value)).toBe(n(inv));
    const manager = (await asUser(db, mgr(), (q) => q(`select public.dashboard_metrics($1::date, $1::date) m`, [today])))[0].m;
    expect(manager.purchases).toBeNull(); // financial figures hidden from management by default
    expect(manager.sales.amount).toBeNull();
    expect(manager.food_cost.actual_pct).toBeNull();
  });

  it('book changes after submission send the count back to review instead of posting stale numbers', async () => {
    const s2 = await asUser(db, mgr(), async (q) => (await q(`select public.start_count($1) id`, [{ count_type: 'cycle', product_ids: [I.product('P-ONION')] }]))[0].id);
    const sh = await asUser(db, mgr(), async (q) => (await q('select public.get_count_sheet($1) s', [s2]))[0].s);
    const b = await balance('P-ONION');
    await asUser(db, mgr(), (q) => q('select public.save_count_entry($1,$2,0,$3,$4)', [sh.entries[0].id, JSON.stringify([{ qty: b.qty, unit: 'LB' }]), 'd', randomUUID()]));
    await asUser(db, mgr(), (q) => q('select public.submit_count($1)', [s2]));
    await asUser(db, mgr(), (q) => q('select public.approve_count($1)', [s2]));
    // a back-dated movement before the count time
    await db.query(`select app.post_inventory_txn((select row($1::uuid,'manager'::public.account_role,'Management',null,null,null,null,null)::app.actor), $2, $3, 'WASTE', -1, null, 'test', null, now() - interval '1 hour')`, [I.manager, I.location('MAIN'), I.product('P-ONION')]);
    const r = await asUser(db, mgr(), async (q) => (await q('select public.post_count($1) r', [s2]))[0].r);
    expect(r.status).toBe('book_changed');
    const s = (await db.query('select status from public.inventory_count_sessions where id = $1', [s2])).rows[0];
    expect(s.status).toBe('AWAITING_REVIEW');
  });
});

describe('tasks', () => {
  it('employees complete their tasks with identity; recurring tasks roll forward', async () => {
    const alex = await pin('Alex', '9173');
    const u = { userId: I.employeeAccount, employeeToken: alex };
    const tasks = (await asUser(db, u, (q) => q('select public.list_tasks(false) t')))[0].t;
    expect(tasks.map((t: any) => t.title)).toEqual(['Check and log walk-in temperatures']);
    const r = (await asUser(db, u, (q) => q('select public.complete_task($1) r', [tasks[0].id])))[0].r;
    expect(r.next_task_id).toBeTruthy();
    const done = (await db.query('select completed_employee_id from public.tasks where id = $1', [tasks[0].id])).rows[0];
    expect(done.completed_employee_id).toBe(I.employee('Alex'));
    const mgrTask = (await db.query(`select id from public.tasks where title = 'Weekly inventory' and status = 'open'`)).rows[0];
    await expectFail(asUser(db, u, (q) => q('select public.complete_task($1)', [mgrTask.id])), 'not assigned to you');
  });
});

describe('employee activity distinguishes people on the shared login', () => {
  it('Carlos and Maria are separate even though they used the same account', async () => {
    const rows = (await asUser(db, mgr(), (q) => q(`select employee_name, action, summary from public.audit_logs where account_id = $1 and category = 'operations' order by id`, [I.employeeAccount])));
    const byEmp = (name: string) => rows.filter((r: any) => r.employee_name === name).map((r: any) => r.action);
    expect(byEmp('Carlos')).toContain('receiving.received');
    expect(byEmp('Maria')).toContain('waste.logged');
    expect(byEmp('Carlos')).not.toContain('transfer.received');
    expect(rows.every((r: any) => r.employee_name)).toBe(true);
  });
});
