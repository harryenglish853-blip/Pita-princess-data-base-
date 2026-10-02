import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
beforeAll(async () => { resetAndSeed(); db = await connect(); I = await ids(db); });
afterAll(async () => db?.end());

describe('vendor order log', () => {
  let po: { id: string; po_number: number };

  it('management logs a placed order with an estimated total', async () => {
    po = await asUser(db, { userId: I.manager }, async (q) => (await q('select public.save_purchase_order($1) r', [{
      vendor_id: I.vendor('SYSCO'), status: 'placed', expected_delivery_date: '', vendor_confirmation: 'SY-998877', notes: '',
      items: [{ product_id: I.product('P-CHKBR'), quantity: 5, unit_code: 'CASE', unit_price: 128 },
              { product_id: I.product('P-FRIES'), quantity: 2, unit_code: 'CASE', unit_price: 42 }],
    }]))[0].r);
    const row = (await db.query('select status, estimated_total, placed_by from purchase_orders where id=$1', [po.id])).rows[0];
    expect(row.status).toBe('placed');
    expect(Number(row.estimated_total)).toBe(5 * 128 + 2 * 42);
    expect(row.placed_by).toBe(I.manager);
    const a = (await db.query(`select summary from audit_logs where action='order.placed'`)).rows[0];
    expect(a.summary).toBe(`Management logged Sysco order #${po.po_number} (2 items, est. $724.00)`);
  });

  it('placed orders cannot be edited; invalid input is rejected', async () => {
    await expectFail(asUser(db, { userId: I.manager }, (q) => q('select public.save_purchase_order($1)', [{ id: po.id, vendor_id: I.vendor('SYSCO'), status: 'placed', items: [{ product_id: I.product('P-CHKBR'), quantity: 1, unit_code: 'CASE' }] }])), 'Only draft');
    await expectFail(asUser(db, { userId: I.manager }, (q) => q('select public.save_purchase_order($1)', [{ vendor_id: I.vendor('SYSCO'), status: 'placed', items: [] }])), 'at least one item');
    await expectFail(asUser(db, { userId: I.manager }, (q) => q('select public.save_purchase_order($1)', [{ vendor_id: I.vendor('SYSCO'), status: 'placed', items: [{ product_id: I.product('P-CHKBR'), quantity: 1, unit_code: 'GAL' }] }])), 'No conversion');
  });

  it('employees cannot log orders but can see open orders WITHOUT prices', async () => {
    const tok = await asUser(db, { userId: I.employeeAccount }, async (q) => (await q('select public.start_employee_session($1, $2) r', [I.employee('Carlos'), '4826']))[0].r.token);
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select public.save_purchase_order($1)', [{ vendor_id: I.vendor('SYSCO'), status: 'placed', items: [] }])), 'FORBIDDEN');
    const open = await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, async (q) => (await q('select public.open_orders_for_receiving($1) r', [I.vendor('SYSCO')]))[0].r);
    expect(open).toHaveLength(1);
    expect(open[0].items.every((i: any) => i.unit_price === null)).toBe(true);
    const mgr = await asUser(db, { userId: I.manager }, async (q) => (await q('select public.open_orders_for_receiving($1) r', [I.vendor('SYSCO')]))[0].r);
    expect(mgr[0].items.some((i: any) => Number(i.unit_price) === 128)).toBe(true);

    // receiving against the order closes it
    await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select public.submit_receiving($1)', [{
      idempotency_key: randomUUID(), vendor_id: I.vendor('SYSCO'), invoice_number: 'PO-TEST-1', delivery_date: new Date().toISOString().slice(0, 10),
      purchase_order_id: po.id, lines: [{ product_id: I.product('P-CHKBR'), unit_code: 'CASE', ordered_qty: 5, received_qty: 4 }],
    }]));
    expect((await db.query('select status from purchase_orders where id=$1', [po.id])).rows[0].status).toBe('received');
    const again = await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, async (q) => (await q('select public.open_orders_for_receiving($1) r', [I.vendor('SYSCO')]))[0].r);
    expect(again).toHaveLength(0);
  });

  it('drafts can be edited and cancelled with a reason', async () => {
    const d = await asUser(db, { userId: I.manager }, async (q) => (await q('select public.save_purchase_order($1) r', [{ vendor_id: I.vendor('GRECO'), status: 'draft', items: [{ product_id: I.product('P-MOZZ'), quantity: 1, unit_code: 'CASE' }] }]))[0].r);
    await asUser(db, { userId: I.manager }, (q) => q('select public.save_purchase_order($1)', [{ id: d.id, vendor_id: I.vendor('GRECO'), status: 'draft', items: [{ product_id: I.product('P-MOZZ'), quantity: 3, unit_code: 'CASE' }] }]));
    expect(Number((await db.query('select quantity from purchase_order_items where purchase_order_id=$1', [d.id])).rows[0].quantity)).toBe(3);
    await expectFail(asUser(db, { userId: I.manager }, (q) => q(`select public.cancel_purchase_order($1, '')`, [d.id])), 'reason');
    await asUser(db, { userId: I.manager }, (q) => q(`select public.cancel_purchase_order($1, 'Ordered by phone instead')`, [d.id]));
    expect((await db.query('select status from purchase_orders where id=$1', [d.id])).rows[0].status).toBe('cancelled');
  });
});
