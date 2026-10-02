import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

/** Calls made by the server's sync / webhook with the service key. */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('set local role service_role');
    const r = await fn();
    await db.query('commit');
    return r;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
const apply = (order: unknown) => asService(async () => (await db.query(`select public.pos_apply_order('toast', $1) r`, [order])).rows[0].r);

const order = (lines: { id: string; item: string; name: string; qty: number; net: number; voided?: boolean }[], modified: string, voided = false) => ({
  external_id: 'order-1', business_date: today(), modified_at: modified, voided,
  lines: lines.map((l) => ({ external_id: l.id, item_id: l.item, item_name: l.name, quantity: l.qty, net_amount: l.net, voided: l.voided ?? false, is_modifier: false })),
});
const usage = async (lineId: string, code: string) => Number((await db.query(
  `select coalesce(sum(tu.quantity_inv), 0) q from theoretical_usage tu join sales_transactions s on s.id = tu.sales_transaction_id
    where s.source = 'toast' and s.external_id = $1 and tu.product_id = $2`, [lineId, I.product(code)])).rows[0].q);
const ledgerRows = async () => Number((await db.query(`select count(*) n from inventory_transactions where source_type = 'sales_transaction'`)).rows[0].n);
let burgerItem: string;

beforeAll(async () => {
  resetAndSeed();
  db = await connect();
  I = await ids(db);
  // the owner turns the sync on; a burger is mapped, fries are mapped, the bacon burger is not
  await asUser(db, { userId: I.owner1 }, (q) => q(`select public.set_pos_enabled('toast', true)`));
  await asService(() => db.query(`select public.pos_upsert_menu('toast', $1)`, [JSON.stringify([
    { external_id: 'tm-burger', name: 'Cheeseburger', price: 12.99 }, { external_id: 'tm-fries', name: 'French Fries', price: 4.99 },
  ])]));
  const items = (await db.query(`select id, external_id from pos_menu_items where source = 'toast'`)).rows;
  burgerItem = items.find((i) => i.external_id === 'tm-burger').id;
  const recipe = async (n: string) => (await db.query('select id from recipes where name = $1', [n])).rows[0].id;
  await asUser(db, { userId: I.manager }, async (q) => {
    await q(`select public.map_pos_item($1, 'recipe', $2)`, [burgerItem, await recipe('Cheeseburger')]);
    await q(`select public.map_pos_item($1, 'recipe', $2)`, [items.find((i) => i.external_id === 'tm-fries').id, await recipe('French Fries')]);
  });
});
afterAll(async () => db?.end());

describe('POS orders -> sales and theoretical usage', () => {
  it('a new order posts usage for mapped items; an unknown item is recorded as UNMAPPED and posts nothing', async () => {
    const r = await apply(order([
      { id: 'l-burger', item: 'tm-burger', name: 'Cheeseburger', qty: 2, net: 25.98 },
      { id: 'l-fries', item: 'tm-fries', name: 'French Fries', qty: 2, net: 9.98 },
      { id: 'l-bacon', item: 'tm-bacon', name: 'Bacon Cheeseburger', qty: 1, net: 14.49 },
    ], at(0)));
    expect(r).toMatchObject({ status: 'created', lines: 3, unmapped_lines: 1 });
    expect(await usage('l-burger', 'P-GRBEEF')).toBe(1);     // 2 x 8 OZ
    expect(await usage('l-fries', 'P-FRIES')).toBe(0.75);    // 2 x 6 OZ
    const bacon = (await db.query(`select s.usage_status, m.tracking from sales_transactions s join pos_menu_items m on m.external_id = s.source_item_id where s.external_id = 'l-bacon'`)).rows[0];
    expect(bacon).toEqual({ usage_status: 'unmapped', tracking: 'unmapped' });
  });

  it('a day with Toast sales cannot also be entered by hand (no double counting)', async () => {
    await expectFail(asUser(db, { userId: I.manager }, (q) => q('select public.save_daily_sales($1)', [{ business_date: today(), lines: [] }])), 'already imported');
  });

  it('the same order again (same modified time) is a duplicate and changes nothing', async () => {
    const n = await ledgerRows();
    const r = await apply(order([
      { id: 'l-burger', item: 'tm-burger', name: 'Cheeseburger', qty: 2, net: 25.98 },
      { id: 'l-fries', item: 'tm-fries', name: 'French Fries', qty: 2, net: 9.98 },
      { id: 'l-bacon', item: 'tm-bacon', name: 'Bacon Cheeseburger', qty: 1, net: 14.49 },
    ], at(0)));
    expect(r.status).toBe('duplicate');
    expect(await ledgerRows()).toBe(n);
  });

  it('an update changes quantities and removes items; an older version arriving late is ignored', async () => {
    const r = await apply(order([
      { id: 'l-burger', item: 'tm-burger', name: 'Cheeseburger', qty: 3, net: 38.97 },
      { id: 'l-bacon', item: 'tm-bacon', name: 'Bacon Cheeseburger', qty: 1, net: 14.49 },
    ], at(5)));
    expect(r.status).toBe('updated');
    expect(await usage('l-burger', 'P-GRBEEF')).toBe(1.5);   // 3 x 8 OZ, not 2 + 3
    expect(await usage('l-fries', 'P-FRIES')).toBe(0);       // removed from the order
    const n = await ledgerRows();
    expect((await apply(order([{ id: 'l-burger', item: 'tm-burger', name: 'Cheeseburger', qty: 9, net: 1 }], at(1)))).status).toBe('stale');
    expect(await ledgerRows()).toBe(n);
    expect(await usage('l-burger', 'P-GRBEEF')).toBe(1.5);
  });

  it('a refund lowers sales but the food was made; a voided line removes its usage', async () => {
    await apply(order([
      { id: 'l-burger', item: 'tm-burger', name: 'Cheeseburger', qty: 3, net: 25.98 },             // one refunded
      { id: 'l-bacon', item: 'tm-bacon', name: 'Bacon Cheeseburger', qty: 1, net: 14.49, voided: true },
    ], at(10)));
    expect(await usage('l-burger', 'P-GRBEEF')).toBe(1.5);
    const s = (await db.query(`select net_amount, is_void from sales_transactions where external_id in ('l-burger', 'l-bacon') order by external_id`)).rows;
    expect(s).toEqual([{ net_amount: '14.49', is_void: true }, { net_amount: '25.98', is_void: false }]);
  });

  it('mapping an item later posts the usage of its earlier sales exactly once; "not tracked" removes it from food sales', async () => {
    await apply(order([
      { id: 'l-burger', item: 'tm-burger', name: 'Cheeseburger', qty: 3, net: 25.98 },
      { id: 'l-bacon', item: 'tm-bacon', name: 'Bacon Cheeseburger', qty: 1, net: 14.49 },
    ], at(15)));
    expect(await usage('l-bacon', 'P-GRBEEF')).toBe(0);
    const bacon = (await db.query(`select id from pos_menu_items where external_id = 'tm-bacon'`)).rows[0].id;
    const burgerRecipe = (await db.query(`select id from recipes where name = 'Cheeseburger'`)).rows[0].id;
    const r = await asUser(db, { userId: I.manager }, async (q) => (await q(`select public.map_pos_item($1, 'recipe', $2) r`, [bacon, burgerRecipe]))[0].r);
    expect(r.reapplied).toBe(1);
    expect(await usage('l-bacon', 'P-GRBEEF')).toBe(0.5);
    await asUser(db, { userId: I.manager }, (q) => q(`select public.map_pos_item($1, 'recipe', $2)`, [bacon, burgerRecipe]));
    expect(await usage('l-bacon', 'P-GRBEEF')).toBe(0.5);   // mapping again: still once
    await asUser(db, { userId: I.manager }, (q) => q(`select public.map_pos_item($1, 'not_tracked', null)`, [bacon]));
    expect(await usage('l-bacon', 'P-GRBEEF')).toBe(0);
    expect((await db.query(`select is_void, usage_status from sales_transactions where external_id = 'l-bacon'`)).rows[0]).toEqual({ is_void: true, usage_status: 'none' });
    const audit = (await db.query(`select summary from audit_logs where action = 'pos.item_mapped' order by id desc limit 1`)).rows[0].summary;
    expect(audit).toBe('Management mapped Toast item "Bacon Cheeseburger" to NOT TRACKED (1 earlier sale line updated)');
  });

  it('a voided order removes all of its usage and its sales', async () => {
    await apply(order([{ id: 'l-burger', item: 'tm-burger', name: 'Cheeseburger', qty: 3, net: 25.98 }], at(20), true));
    expect(await usage('l-burger', 'P-GRBEEF')).toBe(0);
    expect((await db.query(`select is_void from sales_transactions where external_id = 'l-burger'`)).rows[0].is_void).toBe(true);
    expect((await db.query('select * from ledger_integrity_check()')).rows).toEqual([]);
  });

  it('POS payloads are accepted only from the server; a turned-off sync rejects them', async () => {
    await expectFail(asUser(db, { userId: I.owner1 }, (q) => q(`select public.pos_apply_order('toast', $1)`, [order([], at(30))])), 'permission denied');
    await expectFail(asUser(db, { userId: I.manager }, (q) => q(`select public.set_pos_enabled('toast', false)`)), 'FORBIDDEN');
    await asUser(db, { userId: I.owner1 }, (q) => q(`select public.set_pos_enabled('toast', false)`));
    await expectFail(apply({ ...order([], at(40)), external_id: 'order-2' }), 'not turned on');
    const tok = await asUser(db, { userId: I.employeeAccount }, async (q) => (await q('select public.start_employee_session($1, $2) r', [I.employee('John'), '1357']))[0].r.token);
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q(`select public.pos_overview('toast')`)), 'FORBIDDEN');
    expect(await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select * from pos_menu_items'))).toEqual([]);
  });
});
