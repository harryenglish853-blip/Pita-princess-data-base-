import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;

beforeAll(async () => {
  resetAndSeed();
  db = await connect();
  I = await ids(db);
});
afterAll(async () => db?.end());

describe('save_product', () => {
  it('editing restaurant storage areas keeps the commissary storage assignment', async () => {
    const dough = I.product('P-DOUGH');
    const before = (await db.query(`select count(*)::int n from product_storage_locations where product_id=$1 and storage_location_id=$2`, [dough, I.storage('Commissary Cooler')])).rows[0].n;
    expect(before).toBe(1);
    await asUser(db, { userId: I.manager }, (q) => q('select public.save_product($1)', [{
      id: dough, item_code: 'P-DOUGH', name: 'Pizza Dough', inventory_unit: 'EA', purchase_unit: 'TRAY',
      conversions: [{ unit_code: 'TRAY', inventory_units_per_unit: 24 }],
      storage: [{ storage_location_id: I.storage('Walk-In Cooler'), shelf_label: 'Shelf 4', is_primary: true }],
    }]));
    const rows = (await db.query(`select sl.name from product_storage_locations psl join storage_locations sl on sl.id=psl.storage_location_id where psl.product_id=$1 order by 1`, [dough])).rows.map((r) => r.name);
    expect(rows).toEqual(['Commissary Cooler', 'Walk-In Cooler']);
  });

  it('rejects storage areas from another location and keeps history-bound units', async () => {
    await expectFail(asUser(db, { userId: I.manager }, (q) => q('select public.save_product($1)', [{
      id: I.product('P-ONION'), item_code: 'P-ONION', name: 'Yellow Onion', inventory_unit: 'LB',
      storage: [{ storage_location_id: I.storage('Commissary Cooler'), shelf_label: '', is_primary: true }],
    }])), 'must belong to this location');
    await expectFail(asUser(db, { userId: I.manager }, (q) => q('select public.save_product($1)', [{
      id: I.product('P-ONION'), item_code: 'P-ONION', name: 'Yellow Onion', inventory_unit: 'KG',
    }])), 'cannot change');
  });

  it('vendor price change through the product form records price history and current cost', async () => {
    await asUser(db, { userId: I.manager }, (q) => q('select public.save_product($1)', [{
      id: I.product('P-RICE'), item_code: 'P-RICE', name: 'Rice', inventory_unit: 'LB', purchase_unit: 'BAG',
      conversions: [{ unit_code: 'BAG', inventory_units_per_unit: 25 }],
      vendor: { vendor_id: I.vendor('SYSCO'), vendor_sku: '', vendor_description: '', order_unit: 'BAG', current_price: '30.00' },
    }]));
    const ph = (await db.query(`select old_price, new_price, change_pct, source from price_history where product_id=$1 order by id desc limit 1`, [I.product('P-RICE')])).rows[0];
    expect(Number(ph.old_price)).toBe(27.5);
    expect(Number(ph.new_price)).toBe(30);
    expect(Number(ph.change_pct)).toBe(9.0909);
    expect(ph.source).toBe('manual');
    const cost = (await db.query(`select current_cost from products where id=$1`, [I.product('P-RICE')])).rows[0].current_cost;
    expect(Number(cost)).toBe(1.2); // 30 / 25 LB
  });
});

describe('accounts', () => {
  it('management can read account names but not change them', async () => {
    const rows = await asUser(db, { userId: I.manager }, (q) => q('select display_name from account_profiles order by display_name'));
    expect(rows.map((r) => r.display_name)).toEqual(['Employee Shared Account', 'Management', 'Owner #1', 'Owner #2']);
    const upd = await asUser(db, { userId: I.manager }, (q) => q(`update account_profiles set display_name='X' where id=$1 returning id`, [I.owner1]));
    expect(upd).toHaveLength(0);
  });

  it('the employee login cannot list accounts', async () => {
    const rows = await asUser(db, { userId: I.employeeAccount }, (q) => q('select id from account_profiles'));
    expect(rows.map((r) => r.id)).toEqual([I.employeeAccount]);
  });

  it('admin events are owner-only and attributed', async () => {
    await expectFail(asUser(db, { userId: I.manager }, (q) => q(`select public.log_admin_event('account.created', 'x', null)`)), 'FORBIDDEN');
    await asUser(db, { userId: I.owner2 }, (q) => q(`select public.log_admin_event('account.password_reset', 'reset a login password', $1)`, [I.employeeAccount]));
    const a = (await db.query(`select account_name, category, summary from audit_logs where action='account.password_reset'`)).rows[0];
    expect(a).toEqual({ account_name: 'Owner #2', category: 'security', summary: 'Owner #2 reset a login password' });
  });
});

describe('count order (shelf-to-sheet)', () => {
  it('reorders a storage area and the next count follows it', async () => {
    const walkin = I.storage('Walk-In Cooler');
    const items = (await db.query(`select product_id from product_storage_locations where storage_location_id=$1 order by sort_order`, [walkin])).rows.map((r) => r.product_id).reverse();
    await asUser(db, { userId: I.manager }, (q) => q('select public.set_count_order($1, $2)', [walkin, JSON.stringify(items.map((product_id) => ({ product_id })))]));
    const id = await asUser(db, { userId: I.manager }, async (q) => (await q(`select public.start_count('{"count_type":"location","storage_location_ids":["${walkin}"]}'::jsonb) id`))[0].id);
    const sheet = (await db.query(`select product_id from inventory_count_entries where session_id=$1 order by sort_order`, [id])).rows.map((r) => r.product_id);
    expect(sheet).toEqual(items);
    await expectFail(asUser(db, { userId: I.manager }, (q) => q('select public.set_count_order($1, $2)', [walkin, JSON.stringify([{ product_id: I.product('P-FLOUR') }])])), 'not assigned');
  });
});
