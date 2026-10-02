import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
beforeAll(async () => { resetAndSeed(); db = await connect(); I = await ids(db); });
afterAll(async () => db?.end());

const mgr = () => ({ userId: I.manager });
const tomorrow = () => new Date(Date.now() + 36 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
async function balance(code: string, loc = 'MAIN') {
  const r = (await db.query(`select quantity, avg_cost from inventory_balances where product_id = $1 and location_id = $2`, [I.product(code), I.location(loc)])).rows[0];
  return { qty: Number(r?.quantity ?? 0), avg: Number(r?.avg_cost ?? 0) };
}
async function pin(name: string, code: string) {
  return asUser(db, { userId: I.employeeAccount }, async (q) => (await q('select public.start_employee_session($1, $2) r', [I.employee(name), code]))[0].r.token as string);
}

describe('commissary orders', () => {
  let order: { id: string; order_number: number };

  it('the seeded demo order is on its way and the restaurant can see it (without costs)', async () => {
    const tok = await pin('Carlos', '4826');
    const incoming = await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, async (q) => (await q('select public.incoming_commissary_orders() r'))[0].r);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].status).toBe('in_transit');
    expect(JSON.stringify(incoming)).not.toMatch(/cost|price/);
  });

  it('management drafts, then submits an order; a needed date is required to submit', async () => {
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_commissary_order($1)', [{ status: 'submitted', items: [{ product_id: I.product('P-MEATB'), quantity: 100, unit_code: 'EA' }] }])), 'Choose the date');
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_commissary_order($1)', [{ status: 'draft', items: [{ product_id: I.product('P-CHKBR'), quantity: 1, unit_code: 'LB' }] }])), 'not a commissary item');
    const d = await asUser(db, mgr(), async (q) => (await q('select public.save_commissary_order($1) r', [{ status: 'draft', items: [{ product_id: I.product('P-MEATB'), quantity: 50, unit_code: 'EA' }] }]))[0].r);
    order = await asUser(db, mgr(), async (q) => (await q('select public.save_commissary_order($1) r', [{ id: d.id, status: 'submitted', needed_date: tomorrow(), notes: 'For Friday',
      items: [{ product_id: I.product('P-MEATB'), quantity: 100, unit_code: 'EA' }, { product_id: I.product('P-DOUGH'), quantity: 5, unit_code: 'TRAY' }] }]))[0].r);
    expect(order.id).toBe(d.id);
    const row = (await db.query('select status, submitted_by from commissary_orders where id = $1', [order.id])).rows[0];
    expect(row).toEqual({ status: 'submitted', submitted_by: I.manager });
    const items = (await db.query('select quantity_inv from commissary_order_items where order_id = $1 order by quantity_inv', [order.id])).rows.map((r) => Number(r.quantity_inv));
    expect(items).toEqual([100, 120]); // 5 trays x 24 dough
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_commissary_order($1)', [{ id: order.id, status: 'draft', items: [{ product_id: I.product('P-MEATB'), quantity: 1, unit_code: 'EA' }] }])), 'Only draft');
  });

  it('suggested orders count the open commissary order as already ordered', async () => {
    const s = await asUser(db, mgr(), async (q) => (await q('select public.suggested_order($1) r', [I.vendor('COMMISSARY')]))[0].r);
    const meat = s.items.find((i: any) => i.product_id === I.product('P-MEATB'));
    // demo in-transit order: 2 trays (80) + this order: 100
    expect(Number(meat.incoming_orders)).toBe(180);
  });

  it('status moves forward only; employees cannot change it', async () => {
    const tok = await pin('John', '1357');
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q(`select public.set_commissary_order_status($1, 'accepted')`, [order.id])), 'FORBIDDEN');
    await asUser(db, mgr(), (q) => q(`select public.set_commissary_order_status($1, 'accepted')`, [order.id]));
    await asUser(db, mgr(), (q) => q(`select public.set_commissary_order_status($1, 'preparing')`, [order.id]));
    await expectFail(asUser(db, mgr(), (q) => q(`select public.set_commissary_order_status($1, 'accepted')`, [order.id])), 'cannot be marked ACCEPTED');
    await asUser(db, mgr(), (q) => q(`select public.set_commissary_order_status($1, 'ready')`, [order.id]));
    const ev = (await db.query('select to_status, actor_name from commissary_order_events where order_id = $1 order by id', [order.id])).rows;
    expect(ev.map((e) => e.to_status)).toEqual(['draft', 'submitted', 'accepted', 'preparing', 'ready']);
    expect(ev[2].actor_name).toBe('Management');
    await expectFail(db.query(`update commissary_order_events set note = 'x' where order_id = $1`, [order.id]), 'IMMUTABLE');
  });

  it('sending moves no inventory; receiving 95 of 100: commissary out 95, restaurant in 95, difference of 5 flagged', async () => {
    const ckBefore = await balance('P-MEATB', 'CK');
    const mainBefore = await balance('P-MEATB');
    const doughCk = await balance('P-DOUGH', 'CK');
    const items = (await db.query(`select i.id, p.item_code from commissary_order_items i join products p on p.id = i.product_id where order_id = $1`, [order.id])).rows;
    const id = (c: string) => items.find((i) => i.item_code === c).id;
    await asUser(db, mgr(), (q) => q('select public.ship_commissary_order($1, $2)', [order.id, JSON.stringify([{ item_id: id('P-MEATB'), sent_quantity: 100 }, { item_id: id('P-DOUGH'), sent_quantity: 5 }])]));
    expect((await balance('P-MEATB', 'CK')).qty).toBe(ckBefore.qty);

    const tok = await pin('Carlos', '4826');
    const r = await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, async (q) => (await q('select public.receive_commissary_order($1, $2) r',
      [order.id, JSON.stringify([{ item_id: id('P-MEATB'), received_quantity: 95 }, { item_id: id('P-DOUGH'), received_quantity: 5 }])]))[0].r);
    expect(r.differences).toEqual(['Meatballs: ordered 100, sent 100, received 95 EA (short 5)']);
    expect((await balance('P-MEATB', 'CK')).qty).toBe(ckBefore.qty - 95);
    expect((await balance('P-MEATB')).qty).toBe(mainBefore.qty + 95);
    expect((await balance('P-DOUGH', 'CK')).qty).toBe(doughCk.qty - 120);
    // moved at the commissary's average cost
    const t = (await db.query(`select txn_type, quantity, unit_cost, employee_id from inventory_transactions where source_type = 'commissary_order_item' and source_id = $1 order by id`, [id('P-MEATB')])).rows;
    expect(t.map((x) => [x.txn_type, Number(x.quantity)])).toEqual([['COMMISSARY_TRANSFER', -95], ['COMMISSARY_RECEIPT', 95]]);
    expect(t[0].unit_cost).toBe(t[1].unit_cost);
    expect(t[1].employee_id).toBe(I.employee('Carlos'));
    const alert = (await db.query(`select alert_type, message from alerts where dedupe_key = $1`, [`commissary:${order.id}`])).rows[0];
    expect(alert.alert_type).toBe('COMMISSARY_DIFFERENCE');
    const audit = (await db.query(`select summary, employee_name from audit_logs where action = 'commissary.order_received' and entity_id = $1`, [order.id])).rows[0];
    expect(audit.summary).toBe(`Carlos received commissary order #${order.order_number} (95 EA Meatballs, 5 TRAY Pizza Dough) with differences`);
    // cannot be received twice
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select public.receive_commissary_order($1, $2)', [order.id, '[]'])), 'cannot be received');
    expect((await db.query('select * from ledger_integrity_check()')).rows).toEqual([]);
  });

  it('cancelling needs a reason and is impossible after receipt', async () => {
    const o = await asUser(db, mgr(), async (q) => (await q('select public.save_commissary_order($1) r', [{ status: 'submitted', needed_date: tomorrow(), items: [{ product_id: I.product('P-MARI'), quantity: 2, unit_code: 'CONTAINER' }] }]))[0].r);
    await expectFail(asUser(db, mgr(), (q) => q(`select public.cancel_commissary_order($1, '')`, [o.id])), 'reason');
    await asUser(db, mgr(), (q) => q(`select public.cancel_commissary_order($1, 'Made it in house')`, [o.id]));
    expect((await db.query('select status, cancel_reason from commissary_orders where id = $1', [o.id])).rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'Made it in house' });
    await expectFail(asUser(db, mgr(), (q) => q(`select public.cancel_commissary_order($1, 'again')`, [order.id])), 'cannot be cancelled');
  });

  it('employees cannot read commissary order tables directly', async () => {
    const tok = await pin('Maria', '2468');
    const rows = await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select * from commissary_orders'));
    expect(rows).toEqual([]);
  });
});

describe('production', () => {
  it('ingredients go out, the finished product comes in at the ingredient cost', async () => {
    const tomato = await balance('P-TOMATO', 'CK');
    const mari = await balance('P-MARI', 'CK');
    const oil = await balance('P-OIL', 'CK');
    const r = await asUser(db, mgr(), async (q) => (await q('select public.record_production($1) r', [{
      idempotency_key: randomUUID(), location_id: I.location('CK'), product_id: I.product('P-MARI'), quantity: 20, unit_code: 'QT',
      ingredients: [
        { product_id: I.product('P-TOMATO'), quantity: 16, unit_code: 'LB' },
        { product_id: I.product('P-OIL'), quantity: 0.5, unit_code: 'GAL' },
      ] }]))[0].r);
    // 16 LB x avg tomato + 0.5 GAL x avg oil
    const expected = Math.round((16 * tomato.avg + 0.5 * oil.avg) * 100) / 100;
    expect(Number(r.total_cost)).toBeCloseTo(expected, 2);
    expect(Number(r.unit_cost)).toBeCloseTo(expected / 20, 4);
    expect((await balance('P-TOMATO', 'CK')).qty).toBe(tomato.qty - 16);
    expect((await balance('P-OIL', 'CK')).qty).toBe(oil.qty - 0.5);
    const after = await balance('P-MARI', 'CK');
    expect(after.qty).toBe(mari.qty + 20);
    // weighted average of what was there and the new batch
    expect(after.avg).toBeCloseTo((mari.qty * mari.avg + 20 * Number(r.unit_cost)) / (mari.qty + 20), 3);
    const items = (await db.query('select count(*)::int n from production_items where production_event_id = $1', [r.id])).rows[0].n;
    expect(items).toBe(2);
    await expectFail(db.query('update production_events set quantity = 1 where id = $1', [r.id]), 'IMMUTABLE');
    await expectFail(db.query('delete from production_items where production_event_id = $1', [r.id]), 'IMMUTABLE');
  });

  it('known numbers: 16 LB tomato @ $1.45 + 0.5 GAL oil @ $9.50 + 2 LB onion @ $0.65 = $29.25 for 20 QT = $1.4625/QT', async () => {
    // the seeded demo batch used opening stock at product cost
    const e = (await db.query(`select total_cost, unit_cost from production_events where notes = 'Demo batch'`)).rows[0];
    expect(Number(e.total_cost)).toBe(29.25);
    expect(Number(e.unit_cost)).toBe(1.4625);
  });

  it('rejects bad batches and is idempotent; employees need the permission', async () => {
    const base = { location_id: I.location('CK'), product_id: I.product('P-MARI'), quantity: 4, unit_code: 'QT' };
    await expectFail(asUser(db, mgr(), (q) => q('select public.record_production($1)', [{ ...base, ingredients: [] }])), 'ingredients');
    await expectFail(asUser(db, mgr(), (q) => q('select public.record_production($1)', [{ ...base, ingredients: [{ product_id: I.product('P-MARI'), quantity: 1, unit_code: 'QT' }] }])), 'ingredient of itself');
    await expectFail(asUser(db, mgr(), (q) => q('select public.record_production($1)', [{ ...base, ingredients: [{ product_id: I.product('P-TOMATO'), quantity: 1, unit_code: 'LB' }, { product_id: I.product('P-TOMATO'), quantity: 2, unit_code: 'LB' }] }])), 'listed twice');
    const key = randomUUID();
    const p = { ...base, idempotency_key: key, ingredients: [{ product_id: I.product('P-TOMATO'), quantity: 3, unit_code: 'LB' }] };
    const a = await asUser(db, mgr(), async (q) => (await q('select public.record_production($1) r', [p]))[0].r);
    const b = await asUser(db, mgr(), async (q) => (await q('select public.record_production($1) r', [p]))[0].r);
    expect(b.id).toBe(a.id);
    expect((await db.query('select count(*)::int n from production_events where idempotency_key = $1', [key])).rows[0].n).toBe(1);
    const tok = await pin('Maria', '2468');
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select public.record_production($1)', [{ ...p, idempotency_key: randomUUID() }])), 'FORBIDDEN');
    const tpl = await asUser(db, mgr(), async (q) => (await q('select public.last_production_template($1) r', [I.product('P-MARI')]))[0].r);
    expect(Number(tpl.quantity)).toBe(4);
    expect((await db.query('select * from ledger_integrity_check()')).rows).toEqual([]);
  });
});
