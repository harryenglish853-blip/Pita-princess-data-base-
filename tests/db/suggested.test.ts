import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
let vendorId: string;
let dynId: string;
let parId: string;

const suggest = (vendor: string) =>
  asUser(db, { userId: I.manager }, async (q) => (await q('select public.suggested_order($1) r', [vendor]))[0].r);
const line = (s: any, productId: string) => s.items.find((i: any) => i.product_id === productId);

beforeAll(async () => {
  resetAndSeed();
  db = await connect();
  I = await ids(db);
  // A test vendor delivering every day with no cutoff time: the next delivery is
  // tomorrow and the one after is the day after, so an order must last 2 days.
  vendorId = (await db.query(`insert into vendors (code, name, delivery_days, lead_time_days) values ('TESTV', 'Test Vendor', '{0,1,2,3,4,5,6}', 1) returning id`)).rows[0].id;
  const loc = (await db.query(`select id from locations where code = 'MAIN'`)).rows[0].id;
  const mk = async (code: string, parType: string, par: number | null) => {
    const id = (await db.query(`insert into products (item_code, name, inventory_unit, purchase_unit, current_cost, primary_vendor_id)
                                values ($1, $1, 'LB', 'CASE', 2, $2) returning id`, [code, vendorId])).rows[0].id;
    await db.query(`insert into product_unit_conversions (product_id, unit_code, inventory_units_per_unit) values ($1, 'CASE', 40)`, [id]);
    await db.query(`insert into location_products (location_id, product_id, par_level, safety_stock, par_type) values ($1, $2, $3, 15, $4)`, [loc, id, par, parType]);
    await db.query(`insert into vendor_products (vendor_id, product_id, order_unit, current_price) values ($1, $2, 'CASE', 80)`, [vendorId, id]);
    // 28 days of history: received 895 LB, used 868 LB (31 LB/day) -> 27 LB on hand
    const actor = `row($1::uuid, 'manager', 'Management', null, null, null, null, null)::app.actor`;
    await db.query(`select app.post_inventory_txn(${actor}, $2, $3, 'RECEIPT', 895, 2, 'test', null, now() - interval '28 days 1 hour')`, [I.manager, loc, id]);
    await db.query(`select app.post_inventory_txn(${actor}, $2, $3, 'POS_THEORETICAL_CONSUMPTION', -868, null, 'test', null, now() - interval '1 day')`, [I.manager, loc, id]);
    return id;
  };
  dynId = await mk('T-DYN', 'dynamic', 500);
  parId = await mk('T-PAR', 'static', 120);
});
afterAll(async () => db?.end());

describe('suggested orders', () => {
  it('forecast: need 62 + 15 = 77, have 27 + 10 on order = 37, short 40 -> 1 case of 40', async () => {
    // 10 LB already ordered (placed, not yet received)
    await asUser(db, { userId: I.manager }, (q) => q('select public.save_purchase_order($1)', [{
      vendor_id: vendorId, status: 'placed', items: [{ product_id: dynId, quantity: 10, unit_code: 'LB', unit_price: null }] }]));
    const s = await suggest(vendorId);
    expect(s.coverage_days).toBe(2);
    const l = line(s, dynId);
    expect(l.method).toBe('forecast');
    expect(l.observed_days).toBe(28);
    expect(Number(l.daily_usage)).toBe(31);
    expect(Number(l.forecast_usage)).toBe(62);
    expect(Number(l.need)).toBe(77);
    expect(Number(l.on_hand)).toBe(27);
    expect(Number(l.incoming_orders)).toBe(10);
    expect(Number(l.have)).toBe(37);
    expect(Number(l.shortage)).toBe(40);
    expect(Number(l.units_per_order_unit)).toBe(40);
    expect(Number(l.suggested_qty)).toBe(1);
    expect(Number(l.estimated_cost)).toBe(80);
  });

  it('static par: need = par 120, have 27 -> short 93 -> rounded UP to 3 cases', async () => {
    const l = line(await suggest(vendorId), parId);
    expect(l.method).toBe('par');
    expect(Number(l.need)).toBe(120);
    expect(Number(l.shortage)).toBe(93);
    expect(Number(l.suggested_qty)).toBe(3);
  });

  it('demo history: dynamic-par items forecast, static-par items use the par', async () => {
    const s = await suggest(I.vendor('SYSCO'));
    expect(s.items.length).toBeGreaterThan(0);
    for (const i of s.items) expect(['forecast', 'par', 'none']).toContain(i.method);
    // seeded demo history is 28 days, so dynamic-par demo items forecast
    expect(line(s, I.product('P-CHKBR')).method).toBe('forecast');
    expect(line(s, I.product('P-BACON')).method).toBe('par');
  });

  it('saving from the suggestion stores the system number server-side and counts overrides', async () => {
    const r = await asUser(db, { userId: I.manager }, async (q) => (await q('select public.save_purchase_order($1) r', [{
      vendor_id: vendorId, status: 'draft', use_suggestion: true,
      items: [
        { product_id: dynId, quantity: 1, unit_code: 'CASE', unit_price: 80, suggested_qty: 99, suggestion_detail: { forged: true } },
        { product_id: parId, quantity: 4, unit_code: 'CASE', unit_price: 80 },
      ] }]))[0].r);
    const rows = (await db.query(`select product_id, suggested_qty, quantity, suggestion_detail from purchase_order_items where purchase_order_id = $1`, [r.id])).rows;
    const dyn = rows.find((x) => x.product_id === dynId);
    const par = rows.find((x) => x.product_id === parId);
    expect(Number(dyn.suggested_qty)).toBe(1); // browser-sent 99 / forged detail ignored
    expect(dyn.suggestion_detail.forged).toBeUndefined();
    expect(Number(dyn.suggestion_detail.need)).toBe(77);
    expect(Number(par.suggested_qty)).toBe(3);
    expect(Number(par.quantity)).toBe(4);
    const audit = (await db.query(`select summary from audit_logs where action = 'order.drafted' and entity_id = $1`, [r.id])).rows[0];
    expect(audit.summary).toContain('1 quantity changed from the suggestion');

    // editing the draft keeps the original suggestion
    await asUser(db, { userId: I.manager }, (q) => q('select public.save_purchase_order($1)', [{
      id: r.id, vendor_id: vendorId, status: 'placed', items: [{ product_id: dynId, quantity: 2, unit_code: 'CASE', unit_price: 80 }] }]));
    const kept = (await db.query(`select suggested_qty, quantity from purchase_order_items where purchase_order_id = $1`, [r.id])).rows[0];
    expect(Number(kept.suggested_qty)).toBe(1);
    expect(Number(kept.quantity)).toBe(2);
  });

  it('a placed order counts as incoming for the next suggestion', async () => {
    // now 10 LB + 2 cases (80 LB) are on order: have 27 + 90 = 117 > need 77
    const l = line(await suggest(vendorId), dynId);
    expect(Number(l.incoming_orders)).toBe(90);
    expect(Number(l.suggested_qty)).toBe(0);
  });

  it('only order managers can see suggestions', async () => {
    const tok = await asUser(db, { userId: I.employeeAccount }, async (q) => (await q('select public.start_employee_session($1, $2) r', [I.employee('John'), '1357']))[0].r.token);
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select public.suggested_order($1)', [vendorId])), 'FORBIDDEN');
  });
});
