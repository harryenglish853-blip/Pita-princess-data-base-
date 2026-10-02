import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
beforeAll(async () => { resetAndSeed(); db = await connect(); I = await ids(db); });
afterAll(async () => db?.end());

const mgr = () => ({ userId: I.manager });
const owner = () => ({ userId: I.owner1 });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const recipeId = async (name: string) => (await db.query('select id from recipes where name = $1', [name])).rows[0].id as string;
const detail = (id: string) => asUser(db, mgr(), async (q) => (await q('select public.recipe_detail($1) r', [id]))[0].r);
const beefUsage = async (saleIds: string[]) => Number((await db.query(
  `select coalesce(sum(-t.quantity), 0) q from inventory_transactions t where t.source_type = 'sales_transaction' and t.source_id = any($1) and t.product_id = $2`,
  [saleIds, I.product('P-GRBEEF')])).rows[0].q);

describe('recipes and recipe cost', () => {
  it('cheeseburger cost from current ingredient costs, line by line', async () => {
    const d = await detail(await recipeId('Cheeseburger'));
    const line = (n: string) => Number(d.lines.find((l: any) => l.name === n).line_cost);
    expect(line('Ground Beef 80/20')).toBe(2.075);       // 8 OZ = 0.5 LB x $4.15
    expect(line('Brioche Buns')).toBe(0.7);              // 1 EA x $33.60 / 48
    expect(line('Cheddar (Sliced)')).toBe(0.3938);       // 2 x 0.046875 LB x $4.20
    expect(line('House Sauce')).toBe(0.1264);            // $8.0875 batch / 64 FL_OZ
    expect(line('Romaine Lettuce')).toBe(0.1188);        // 1 OZ x $1.90/LB
    expect(line('Tomato')).toBe(0.1813);                 // 2 OZ x $1.45/LB
    expect(Number(d.summary.cost_per_unit)).toBe(3.5953);
    expect(Number(d.summary.food_cost_pct)).toBe(27.7);   // 3.5953 / 12.99
    expect(Number(d.summary.margin)).toBe(9.39);
    const sauce = await detail(await recipeId('House Sauce'));
    expect(Number(sauce.summary.batch_cost)).toBe(8.09); // 4.50 + 1.975 + 0.1625 + 1.45
    expect(sauce.used_in.map((u: any) => u.name)).toEqual(['Cheeseburger', 'Chicken Sandwich']);
  });

  it('a price change flows through the sub-recipe into every menu item that uses it', async () => {
    const burger0 = await detail(await recipeId('Cheeseburger'));
    const chick0 = await detail(await recipeId('Chicken Sandwich'));
    const sauce0 = await detail(await recipeId('House Sauce'));
    // heavy cream delivered at a higher price -> its average cost rises
    await asUser(db, mgr(), (q) => q('select public.submit_receiving($1)', [{ idempotency_key: randomUUID(), vendor_id: I.vendor('SYSCO'), invoice_number: 'FC-1',
      delivery_date: today(), lines: [{ product_id: I.product('P-CREAM'), unit_code: 'CASE', ordered_qty: 1, received_qty: 1, invoiced_qty: 1, unit_price: 90 }] }]));
    const sauce1 = await detail(await recipeId('House Sauce'));
    const burger1 = await detail(await recipeId('Cheeseburger'));
    const chick1 = await detail(await recipeId('Chicken Sandwich'));
    const dSauce = Number(sauce1.summary.batch_cost) - Number(sauce0.summary.batch_cost);
    expect(dSauce).toBeGreaterThan(0);
    const perOz = dSauce / 64;
    expect(Number(burger1.summary.cost_per_unit) - Number(burger0.summary.cost_per_unit)).toBeCloseTo(perOz, 3);
    expect(Number(chick1.summary.cost_per_unit) - Number(chick0.summary.cost_per_unit)).toBeCloseTo(perOz, 3);
  });

  it('a recipe cannot contain itself, directly or through a sub-recipe', async () => {
    const sauce = await recipeId('House Sauce');
    const burger = await recipeId('Cheeseburger');
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_recipe($1)', [{ id: sauce, name: 'House Sauce', recipe_type: 'prep', yield_quantity: 64, yield_unit: 'FL_OZ',
      ingredients: [{ product_id: I.product('P-CREAM'), quantity: 1, unit_code: 'QT' }, { sub_recipe_id: burger, quantity: 1, unit_code: 'EA' }] }])), 'contain itself');
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_recipe($1)', [{ id: sauce, name: 'House Sauce', recipe_type: 'prep', yield_quantity: 64, yield_unit: 'FL_OZ',
      ingredients: [{ sub_recipe_id: sauce, quantity: 1, unit_code: 'FL_OZ' }] }])), 'contain itself');
    // unchanged after the rejected saves
    expect((await db.query('select count(*)::int n from recipe_ingredients where recipe_id = $1', [sauce])).rows[0].n).toBe(4);
  });

  it('rejects units that do not convert and duplicate names', async () => {
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_recipe($1)', [{ name: 'Bad', recipe_type: 'menu', yield_quantity: 1, yield_unit: 'EA',
      ingredients: [{ product_id: I.product('P-GRBEEF'), quantity: 1, unit_code: 'GAL' }] }])), 'No conversion');
    await expectFail(asUser(db, mgr(), (q) => q('select public.save_recipe($1)', [{ name: 'cheeseburger', recipe_type: 'menu', yield_quantity: 1, yield_unit: 'EA',
      ingredients: [{ product_id: I.product('P-GRBEEF'), quantity: 8, unit_code: 'OZ' }] }])), 'already exists');
  });

  it('production of Marinara pre-fills from its recipe, scaled to the batch', async () => {
    const t = await asUser(db, mgr(), async (q) => (await q(`select public.recipe_production_template($1, 10, 'QT') r`, [I.product('P-MARI')]))[0].r);
    const q = (code: string) => Number(t.ingredients.find((i: any) => i.product_id === I.product(code)).quantity);
    expect(q('P-TOMATO')).toBe(8);     // 16 LB per 20 QT
    expect(q('P-OIL')).toBe(0.25);     // 0.5 GAL per 20 QT
    expect(q('P-ONION')).toBe(1);      // 2 LB per 20 QT
  });
});

describe('sales -> theoretical usage', () => {
  it('120 cheeseburgers x 8 OZ = 960 OZ = 60 LB ground beef', async () => {
    const burger = await recipeId('Cheeseburger');
    const before = Number((await db.query('select quantity from inventory_balances where product_id = $1 and location_id = $2', [I.product('P-GRBEEF'), I.location('MAIN')])).rows[0].quantity);
    await asUser(db, mgr(), (q) => q('select public.save_daily_sales($1)', [{ business_date: daysAgo(1), lines: [{ recipe_id: burger, quantity: 120, net_amount: 1558.8 }] }]));
    const sale = (await db.query(`select id, usage_status from sales_transactions where source = 'manual' and business_date = $1`, [daysAgo(1)])).rows[0];
    expect(sale.usage_status).toBe('posted');
    expect(await beefUsage([sale.id])).toBe(60);
    const after = Number((await db.query('select quantity from inventory_balances where product_id = $1 and location_id = $2', [I.product('P-GRBEEF'), I.location('MAIN')])).rows[0].quantity);
    expect(after).toBe(before - 60);
    // sub-recipe made to order (House Sauce) is exploded into its ingredients: 120 FL_OZ of sauce = 1.875 QT cream
    const cream = Number((await db.query(`select sum(-quantity) q from inventory_transactions where source_type = 'sales_transaction' and source_id = $1 and product_id = $2`, [sale.id, I.product('P-CREAM')])).rows[0].q);
    expect(cream).toBe(1.875);
  });

  it('sending the same sales again changes nothing; a change reverses and re-posts; a void removes it', async () => {
    const burger = await recipeId('Cheeseburger');
    const sale = (await db.query(`select id from sales_transactions where source = 'manual' and business_date = $1`, [daysAgo(1)])).rows[0].id;
    const rows = async () => (await db.query(`select count(*)::int n from inventory_transactions where source_type = 'sales_transaction' and source_id = $1`, [sale])).rows[0].n;
    const n0 = await rows();
    await asUser(db, mgr(), (q) => q('select public.save_daily_sales($1)', [{ business_date: daysAgo(1), lines: [{ recipe_id: burger, quantity: 120, net_amount: 1558.8 }] }]));
    expect(await rows()).toBe(n0);                       // repeated: no double counting
    await asUser(db, mgr(), (q) => q('select public.save_daily_sales($1)', [{ business_date: daysAgo(1), lines: [{ recipe_id: burger, quantity: 100, net_amount: 1299 }] }]));
    expect(await beefUsage([sale])).toBe(50);           // 100 x 8 OZ
    await asUser(db, mgr(), (q) => q('select public.save_daily_sales($1)', [{ business_date: daysAgo(1), lines: [] }]));
    expect(await beefUsage([sale])).toBe(0);
    expect((await db.query('select usage_status, quantity from sales_transactions where id = $1', [sale])).rows[0]).toEqual({ usage_status: 'none', quantity: '0.000' });
    expect((await db.query('select * from ledger_integrity_check()')).rows).toEqual([]);
  });

  it('an unmapped item posts nothing until a recipe is assigned', async () => {
    const actor = `row($1::uuid, 'manager', 'Management', null, null, null, null, null)::app.actor`;
    const ext = `toast-test-${randomUUID()}`;
    await db.query(`select app.apply_sale(${actor}, 'toast', $2, $3::date, 'Double Burger', null, 10, 150, false)`, [I.manager, ext, today()]);
    let s = (await db.query(`select id, usage_status from sales_transactions where external_id = $1`, [ext])).rows[0];
    expect(s.usage_status).toBe('unmapped');
    expect(await beefUsage([s.id])).toBe(0);
    await db.query(`select app.apply_sale(${actor}, 'toast', $2, $3::date, 'Double Burger', $4, 10, 150, false)`, [I.manager, ext, today(), await recipeId('Cheeseburger')]);
    s = (await db.query(`select id, usage_status from sales_transactions where external_id = $1`, [ext])).rows[0];
    expect(s.usage_status).toBe('posted');
    expect(await beefUsage([s.id])).toBe(5);             // 10 x 8 OZ
    await db.query(`select app.apply_sale(${actor}, 'toast', $2, $3::date, 'Double Burger', $4, 10, 150, true)`, [I.manager, ext, today(), await recipeId('Cheeseburger')]);
    expect(await beefUsage([s.id])).toBe(0);             // voided
  });
});

describe('actual vs theoretical food cost', () => {
  it('sales, theoretical and actual reconcile with the ledger', async () => {
    const r = await asUser(db, owner(), async (q) => (await q('select public.food_cost_report($1, $1) r', [today()]))[0].r);
    // seeded sales: 24x12.99 + 18x11.99 + 12x14.99 + 6x15.99 + 30x4.99 + 20x2.49 (the voided Toast test line does not count)
    expect(Number(r.sales)).toBe(1002.9);
    expect(Math.round(Number(r.actual_cost) * 100)).toBe(Math.round((Number(r.beginning_inventory) + Number(r.purchases) - Number(r.ending_inventory)) * 100));
    const theo = Number((await db.query(`select sum(tu.extended_cost) c from theoretical_usage tu where tu.business_date = $1`, [today()])).rows[0].c);
    expect(Number(r.theoretical_cost)).toBeCloseTo(theo, 2);
    // what is not explained by sales is waste and count differences (no other movements today)
    // (each total is rounded to the cent on its own, so allow one cent)
    expect(Math.abs(Number(r.variance) - (Number(r.waste) + Number(r.count_variance)))).toBeLessThanOrEqual(0.011);
    expect(Number(r.actual_pct)).toBe(Math.round((Number(r.actual_cost) / Number(r.sales)) * 1000) / 10);
    expect(r.recipes.find((x: any) => x.name === 'Cheeseburger').quantity).toBe(24);
  });

  it('only financial users see food cost; employees cannot read recipes or enter sales', async () => {
    await expectFail(asUser(db, mgr(), (q) => q('select public.food_cost_report($1, $1)', [today()])), 'FORBIDDEN');
    const tok = await asUser(db, { userId: I.employeeAccount }, async (q) => (await q('select public.start_employee_session($1, $2) r', [I.employee('John'), '1357']))[0].r.token);
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select public.list_recipes()')), 'FORBIDDEN');
    await expectFail(asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select public.save_daily_sales($1)', [{ business_date: today(), lines: [] }])), 'FORBIDDEN');
    expect(await asUser(db, { userId: I.employeeAccount, employeeToken: tok }, (q) => q('select * from sales_transactions'))).toEqual([]);
    await expectFail(db.query('delete from theoretical_usage'), 'IMMUTABLE');
  });

  it('the owner dashboard shows sales and food cost from the same numbers', async () => {
    const m = await asUser(db, owner(), async (q) => (await q('select public.dashboard_metrics($1, $1) r', [today()]))[0].r);
    const r = await asUser(db, owner(), async (q) => (await q('select public.food_cost_report($1, $1) r', [today()]))[0].r);
    expect(m.sales.connected).toBe(true);
    expect(Number(m.sales.amount)).toBe(Number(r.sales));
    expect(Number(m.food_cost.actual_pct)).toBe(Number(r.actual_pct));
    expect(Number(m.food_cost.theoretical_pct)).toBe(Number(r.theoretical_pct));
  });
});
