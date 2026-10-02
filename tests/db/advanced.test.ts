import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';
import { todayInTz } from '@/lib/format';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
let empToken: string;
const TZ = 'America/New_York';
const iso = (d: number) => todayInTz(TZ, d);
const mgr = () => ({ userId: I.manager });
const emp = () => ({ userId: I.employeeAccount, employeeToken: empToken });
const one = async <T = any>(ctx: { userId: string; employeeToken?: string }, sql: string, params?: unknown[]): Promise<T> =>
  asUser(db, ctx, async (q) => (await q(sql, params))[0]?.r);

/** Service-key calls (the server's cron / invoice reader). */
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

beforeAll(async () => {
  resetAndSeed();
  db = await connect();
  I = await ids(db);
  empToken = (await one({ userId: I.employeeAccount }, 'select public.start_employee_session($1, $2) r', [I.employee('John'), '1357'])).token;
});
afterAll(async () => db?.end());

describe('sales forecast', () => {
  it('= average of the same weekday (open days, last 8 weeks) × recent trend', async () => {
    const day = iso(1);
    const f = await one(mgr(), 'select public.sales_forecast($1, 7) r', [iso(0)]);
    const item = f.items.find((i: any) => i.day === day && i.name === 'Cheeseburger');
    expect(item).toBeTruthy();
    // recompute independently from the raw sales
    const hist = (await db.query(`select s.business_date::text d, sum(s.quantity) q from sales_transactions s join recipes r on r.id = s.recipe_id
       where r.name = 'Cheeseburger' and not s.is_void and s.business_date >= $1::date - 56 and s.business_date < $1::date group by 1`, [iso(0)])).rows;
    const open = (await db.query(`select distinct business_date::text d from sales_transactions where not is_void and recipe_id is not null
       and business_date >= $1::date - 56 and business_date < $1::date`, [iso(0)])).rows.map((r) => r.d as string);
    const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
    const same = open.filter((d) => dow(d) === dow(day));
    const avg = same.reduce((a, d) => a + Number(hist.find((h) => h.d === d)?.q ?? 0), 0) / same.length;
    const since = (n: number) => new Date(new Date(`${iso(0)}T12:00:00Z`).getTime() - n * 86400_000).toISOString().slice(0, 10);
    const recent = hist.filter((h) => h.d >= since(14)).reduce((a, h) => a + Number(h.q), 0);
    const prior = hist.filter((h) => h.d < since(14) && h.d >= since(28)).reduce((a, h) => a + Number(h.q), 0);
    const trend = recent > 0 && prior > 0 ? Math.round(Math.min(Math.max(recent / prior, 0.8), 1.25) * 1000) / 1000 : 1;
    expect(Number(item.basis_days)).toBe(same.length);
    expect(Number(item.qty)).toBeCloseTo(Math.round(avg * trend * 10) / 10, 1);
    expect(f.usage.find((u: any) => u.name === 'Brioche Buns')).toBeTruthy();
  });

  it('adjustments (events, holidays) change the forecast; only ordering managers can add them', async () => {
    const day = iso(2);
    const qty = async () => Number((await one(mgr(), 'select public.sales_forecast($1, 7) r', [iso(0)])).items.find((i: any) => i.day === day && i.name === 'Cheeseburger').qty);
    const before = await qty();
    const id = await one(mgr(), 'select public.save_forecast_adjustment($1) r', [{ starts_on: day, ends_on: day, percent: 50, reason: 'Street fair' }]);
    expect(await qty()).toBeCloseTo(Math.round(before * 1.5 * 10) / 10, 0);
    await expectFail(one(emp(), 'select public.save_forecast_adjustment($1) r', [{ starts_on: day, percent: 10, reason: 'x y' }]), 'FORBIDDEN');
    await expectFail(one(mgr(), 'select public.save_forecast_adjustment($1) r', [{ starts_on: day, percent: 10, reason: '' }]), 'reason');
    await expectFail(one(mgr(), 'select public.save_forecast_adjustment($1) r', [{ starts_on: day, percent: 900, reason: 'Big' }]), 'percent');
    await one(mgr(), 'select public.delete_forecast_adjustment($1) r', [id]);
    expect(await qty()).toBe(before);
    await expectFail(one(emp(), 'select public.sales_forecast($1, 7) r', [iso(0)]), 'FORBIDDEN');
  });

  it('dynamic-par items order from the sales forecast and show the menu items behind it', async () => {
    const s = await one(mgr(), 'select public.suggested_order($1) r', [I.vendor('SYSCO')]);
    const buns = s.items.find((i: any) => i.item_code === 'P-BUNS' || i.name === 'Brioche Buns');
    expect(buns.method).toBe('sales_forecast');
    expect(buns.forecast_breakdown.map((b: any) => b.recipe)).toContain('Cheeseburger');
    const sum = buns.forecast_breakdown.reduce((a: number, b: any) => a + Number(b.usage), 0);
    expect(sum).toBeCloseTo(Number(buns.forecast_usage), 2);
    expect(Number(buns.need)).toBeCloseTo(Number(buns.forecast_usage) + Number(buns.safety_stock), 4);
  });
});

describe('barcodes', () => {
  it('unknown -> null; only management can map; then everyone finds it', async () => {
    expect(await one(emp(), 'select public.lookup_barcode($1) r', ['0123456789012'])).toBeNull();
    await expectFail(one(emp(), 'select public.map_barcode($1, $2, $3) r', ['0123456789012', I.product('P-CHKBR'), 'CASE']), 'FORBIDDEN');
    await one(mgr(), 'select public.map_barcode($1, $2, $3) r', ['0123456789012', I.product('P-CHKBR'), 'CASE']);
    const hit = await one(emp(), 'select public.lookup_barcode($1) r', [' 0123456789012 ']);
    expect(hit).toMatchObject({ name: 'Chicken Breast', unit_code: 'CASE', inventory_unit: 'LB' });
    expect((await one(emp(), 'select public.lookup_barcode($1) r', ['p-chkbr'])).name).toBe('Chicken Breast');   // item ID works too
    await expectFail(one({ userId: I.owner1 }, 'select public.map_barcode($1, $2, $3) r', ['x!', I.product('P-CHKBR'), null]), 'barcode');
    await expectFail(one({ userId: I.owner1 }, 'select public.map_barcode($1, $2, $3) r', ['99999999', I.product('P-CHKBR'), 'GAL']), 'No conversion');
    const audit = (await db.query(`select summary from audit_logs where action = 'products.barcode_mapped'`)).rows;
    expect(audit[0].summary).toMatch(/mapped barcode 0123456789012 to Chicken Breast \(CASE\)/);
  });
});

describe('invoice reading (OCR)', () => {
  let eventId: string;
  it('needs a photo; results are stored by the server only; a person confirms; nothing is posted', async () => {
    const r = await one(mgr(), 'select public.submit_receiving($1) r', [{ idempotency_key: randomUUID(), vendor_id: I.vendor('SYSCO'), invoice_number: 'OCR-1',
      delivery_date: iso(0), lines: [{ product_id: I.product('P-CHKBR'), unit_code: 'CASE', ordered_qty: 1, received_qty: 1, invoiced_qty: 1, unit_price: 128 }] }]);
    eventId = r.receiving_event_id;
    await expectFail(one(mgr(), 'select public.request_invoice_extraction($1, $2, $3) r', [eventId, 'anthropic', 'm']), 'no uploaded invoice photo');
    await db.query(`insert into invoice_documents (receiving_event_id, vendor_id, storage_path, file_name, mime_type, size_bytes, upload_status, account_id)
      values ($1, $2, $3, 'inv.jpg', 'image/jpeg', 1000, 'uploaded', $4)`, [eventId, I.vendor('SYSCO'), `test/${randomUUID()}.jpg`, I.manager]);
    await expectFail(one(emp(), 'select public.request_invoice_extraction($1, $2, $3) r', [eventId, 'anthropic', 'm']), 'FORBIDDEN');
    const id = await one(mgr(), 'select public.request_invoice_extraction($1, $2, $3) r', [eventId, 'anthropic', 'm']);
    await expectFail(one(mgr(), 'select public.request_invoice_extraction($1, $2, $3) r', [eventId, 'anthropic', 'm']), 'already being read');
    await expectFail(one(mgr(), `select public.complete_invoice_extraction($1, 'ready', '{}'::jsonb, null) r`, [id]), 'permission denied');
    await expectFail(one(mgr(), `select public.review_invoice_extraction($1, 'confirmed', null) r`, [id]), 'finished reading');

    const ledger = async () => Number((await db.query('select count(*) n from inventory_transactions')).rows[0].n);
    const n = await ledger();
    await asService(() => db.query(`select public.complete_invoice_extraction($1, 'ready', $2, null)`, [id, { lines: [{ description: 'CHICKEN BREAST', quantity: 2, unit_price: 140 }] }]));
    await one(mgr(), `select public.review_invoice_extraction($1, 'confirmed', 'Called Sysco') r`, [id]);
    expect((await db.query('select status, review_note from invoice_extractions where id = $1', [id])).rows[0]).toEqual({ status: 'confirmed', review_note: 'Called Sysco' });
    expect(await ledger()).toBe(n);   // the reading changed no inventory
    expect((await db.query(`select received_qty, unit_price from receiving_items where receiving_event_id = $1`, [eventId])).rows[0]).toEqual({ received_qty: '1.0000', unit_price: '128.0000' });
    await expectFail(one(mgr(), `select public.review_invoice_extraction($1, 'discarded', null) r`, [id]), 'finished reading');
    expect((await db.query(`select summary from audit_logs where action = 'receiving.invoice_read_confirmed'`)).rows[0].summary).toMatch(/checked the AI invoice reading — Called Sysco/);
  });
});

describe('anomaly detection', () => {
  const anomalies = async () => (await db.query(`select title, dedupe_key from alerts where alert_type = 'ANOMALY' order by created_at`)).rows;
  it('only management can run the checks; the service version is server-only', async () => {
    await expectFail(one(emp(), 'select public.run_anomaly_checks() r'), 'FORBIDDEN');
    await expectFail(one(mgr(), 'select public.run_anomaly_checks_service() r'), 'permission denied');
  });

  it('flags a waste spike, an unusual price and missing sales — once each', async () => {
    // waste: 30 LB chicken yesterday (about $96) where there is normally almost none
    await one(mgr(), 'select public.log_waste($1) r', [{ product_id: I.product('P-CHKBR'), quantity: 30, unit_code: 'LB', reason_code: 'SPOILED' }]);
    await db.query(`set session_replication_role = replica`);
    await db.query(`update waste_entries set occurred_at = occurred_at - interval '1 day' where id = (select id from waste_entries order by created_at desc limit 1)`);
    // sales: yesterday's sales did not come in
    await db.query(`update sales_transactions set is_void = true where business_date = $1`, [iso(-1)]);
    await db.query(`set session_replication_role = origin`);
    // price: two normal deliveries, then one 33% above the usual
    const rcv = (price: number, date: string) => one(mgr(), 'select public.submit_receiving($1) r', [{ idempotency_key: randomUUID(), vendor_id: I.vendor('SYSCO'),
      invoice_number: `AN-${randomUUID().slice(0, 6)}`, delivery_date: date, lines: [{ product_id: I.product('P-SALMON'), unit_code: 'LB', ordered_qty: 10, received_qty: 10, invoiced_qty: 10, unit_price: price }] }]);
    await rcv(12, iso(-20)); await rcv(12, iso(-10)); await rcv(16, iso(0));

    const found = await one(mgr(), 'select public.run_anomaly_checks() r');
    expect(found.map((f: any) => f.kind).sort()).toEqual(['price', 'sales', 'waste']);
    const titles = (await anomalies()).map((a) => a.title);
    expect(titles).toEqual(expect.arrayContaining(['Unusual waste: Chicken Breast', 'Sales much lower than expected yesterday']));
    expect(titles.some((t) => /^Unusual price: Salmon Fillet/.test(t))).toBe(true);
    const n = (await anomalies()).length;
    await asService(() => db.query('select public.run_anomaly_checks_service()'));
    expect((await anomalies()).length).toBe(n);   // deduplicated
  });
});
