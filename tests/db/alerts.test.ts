import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { asUser, connect, ids, resetAndSeed } from './helpers';
import { dispatchAlertEmails } from '@/lib/email/alerts';
import { buildMonthlyReport, monthRange, weeksOf } from '@/lib/email/monthly';
import { buildReport } from '@/lib/email/report';
import { runReport } from '@/lib/email/run';
import { createStorageAdmin } from '@/lib/supabase/server';
import { todayInTz } from '@/lib/format';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
let server: http.Server;
const mails: { to: string[]; subject: string; html: string }[] = [];
const TZ = 'America/New_York';
const iso = (d: number) => todayInTz(TZ, d);
const mgr = () => ({ userId: I.manager });
const to = (email: string) => mails.filter((m) => m.to.includes(email));

beforeAll(async () => {
  resetAndSeed();
  db = await connect();
  I = await ids(db);
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      mails.push(JSON.parse(data));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `msg_${mails.length}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'Alerts <alerts@company.test>';
  process.env.RESEND_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.query(`insert into email_recipients (email, name, alert_types) values
    ('owner@company.test', 'Owner', '{waste,critical_stock,price}'), ('gm@company.test', 'GM', '{delivery}')`);
  await db.query(`update settings set value = '0'::jsonb where key = 'email.alert_min_interval_minutes'`);
});
afterAll(async () => {
  server.close();
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.RESEND_API_URL;
  await db?.end();
});

const waste = (qty: number) => asUser(db, mgr(), (q) => q('select public.log_waste($1)', [{ product_id: I.product('P-CHKBR'), quantity: qty, unit_code: 'LB', reason_code: 'SPOILED' }]));
const setStock = (code: string, qty: number) => asUser(db, mgr(), async (q) => {
  const cur = Number((await db.query('select quantity from inventory_balances where product_id = $1 and location_id = $2', [I.product(code), I.location('MAIN')])).rows[0]?.quantity ?? 0);
  return q('select public.adjust_inventory($1, null, $2, $3, $4, $5, $6)', [I.product(code), qty, cur, 'COUNT_CORRECTION', 'test', randomUUID()]);
});
const receive = (price: number, received = 1) => asUser(db, mgr(), (q) => q('select public.submit_receiving($1)', [{ idempotency_key: randomUUID(), vendor_id: I.vendor('SYSCO'),
  invoice_number: `AL-${randomUUID().slice(0, 6)}`, delivery_date: iso(0), lines: [{ product_id: I.product('P-CHKBR'), unit_code: 'CASE', ordered_qty: 1, received_qty: received, invoiced_qty: 1, unit_price: price }] }]));

describe('immediate alert emails', () => {
  it('nothing that happened before a recipient was added is emailed', async () => {
    const before = mails.length;
    await dispatchAlertEmails();
    // only stock drops can be "new" at the first run; this owner did not choose low stock
    expect(mails.slice(before).every((m) => !/High waste|Price increase|Delivery/.test(m.subject))).toBe(true);
  });

  it('high waste goes only to whoever chose waste alerts, once', async () => {
    await waste(20);                                   // 20 LB x $3.20 = $64 > $50 threshold
    await dispatchAlertEmails();
    const owner = to('owner@company.test').filter((m) => /High waste/i.test(m.subject + m.html));
    expect(owner).toHaveLength(1);
    expect(owner[0].html).toContain('Chicken Breast');
    expect(to('gm@company.test').filter((m) => /High waste/i.test(m.subject + m.html))).toHaveLength(0);
    await dispatchAlertEmails();
    expect(to('owner@company.test').filter((m) => /High waste/i.test(m.subject + m.html))).toHaveLength(1);
  });

  it('small waste (under the threshold) is not emailed', async () => {
    const n = mails.length;
    await waste(1);
    await dispatchAlertEmails();
    expect(mails.length).toBe(n);
  });

  it('a product running out is announced once per drop', async () => {
    await setStock('P-SALMON', 0);
    await dispatchAlertEmails();
    const out = () => to('owner@company.test').filter((m) => m.html.includes('OUT OF STOCK: Salmon Fillet'));
    expect(out()).toHaveLength(1);
    await dispatchAlertEmails();
    expect(out()).toHaveLength(1);
    await setStock('P-SALMON', 20);                    // back to healthy
    await dispatchAlertEmails();
    await setStock('P-SALMON', 0);                     // drops again: a new announcement
    await dispatchAlertEmails();
    expect(out()).toHaveLength(2);
  });

  it('delivery discrepancies go to the GM; only MAJOR price increases are emailed immediately', async () => {
    await receive(128, 0.5);                           // short shipment
    await dispatchAlertEmails();
    expect(to('gm@company.test').some((m) => /discrepancy/i.test(m.html))).toBe(true);
    const priceMails = () => to('owner@company.test').filter((m) => /Price increase/i.test(m.html));
    await receive(136);                                // +6.25%: a price alert, but under the 10% email threshold
    await dispatchAlertEmails();
    expect(priceMails()).toHaveLength(0);
    await receive(160);                                // +17.6%: emailed
    await dispatchAlertEmails();
    expect(priceMails()).toHaveLength(1);
  });

  it('two dispatchers at once never send the same alert twice', async () => {
    await waste(25);
    const n = to('owner@company.test').length;
    await Promise.all([dispatchAlertEmails(), dispatchAlertEmails(), dispatchAlertEmails()]);
    expect(to('owner@company.test').length).toBe(n + 1);
    const dup = (await db.query(`select event_ref, recipient_email, count(*) n from alert_email_log group by 1, 2 having count(*) > 1`)).rows;
    expect(dup).toEqual([]);
  });

  it('the cooldown groups alerts instead of sending one email each', async () => {
    await db.query(`update settings set value = '15'::jsonb where key = 'email.alert_min_interval_minutes'`);
    const n = to('owner@company.test').length;
    await waste(30);
    await dispatchAlertEmails();
    expect(to('owner@company.test').length).toBe(n);   // last email was moments ago: wait
    await db.query(`update alert_email_log set created_at = created_at - interval '20 minutes' where recipient_email = 'owner@company.test'`);
    await waste(31);
    await dispatchAlertEmails();
    const last = to('owner@company.test').slice(n);
    expect(last).toHaveLength(1);
    expect(last[0].subject).toMatch(/^URGENT: 2 alerts/);
  });
});

describe('reports', () => {
  it('daily report shows sales and estimated food cost', async () => {
    const r = await buildReport(createStorageAdmin(), 'daily', iso(0), iso(0), TZ, 'https://x');
    expect(r.html).toContain('Estimated food cost');
    expect(r.html).not.toContain('Not connected');
    const sales = (await db.query(`select sum(net_amount) s from sales_transactions where not is_void and business_date = $1`, [iso(0)])).rows[0].s;
    expect(r.html).toContain(`$${Number(sales).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  });

  it('weeks of a month are Sunday-Saturday, clipped to the month', () => {
    expect(weeksOf('2026-10-01', '2026-10-31')).toEqual([
      { from: '2026-10-01', to: '2026-10-03' }, { from: '2026-10-04', to: '2026-10-10' }, { from: '2026-10-11', to: '2026-10-17' },
      { from: '2026-10-18', to: '2026-10-24' }, { from: '2026-10-25', to: '2026-10-31' }]);
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('monthly owner report: sales, food cost, month over month, weeks, turnover, vendors', async () => {
    const [y, m] = iso(0).split('-').map(Number);
    const { from } = monthRange(y, m);
    const r = await buildMonthlyReport(createStorageAdmin(), from, iso(0), TZ, 'https://inventory.example.com');
    expect(r.subject).toMatch(/^Monthly Owner Report — /);
    for (const s of ['Month over month', 'Weeks', 'Top loss products', 'Vendor spending', 'Vendor price trends', 'Inventory turnover', 'AvT variance', 'Total waste'])
      expect(r.html).toContain(s);
    const fc = (await db.query('select public.food_cost_report_service($1, $2) r', [from, iso(0)])).rows[0].r;
    expect(r.html).toContain(`$${Number(fc.sales).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    expect(r.html).toContain('https://inventory.example.com/reports/food-cost');
  });

  it('the monthly report goes to monthly recipients', async () => {
    await db.query(`update email_recipients set receives_monthly = false where email = 'gm@company.test'`);
    const res = await runReport({ type: 'monthly', from: monthRange(2026, 9).from, to: monthRange(2026, 9).to, tz: TZ, trigger: 'manual' });
    expect(res.status).toBe('sent');
    expect(mails.at(-1)!.to).toEqual(['owner@company.test']);
  });

  it('food cost for reports is reachable only by the server', async () => {
    await expect(asUser(db, { userId: I.owner1 }, (q) => q('select public.food_cost_report_service($1, $1)', [iso(0)]))).rejects.toThrow(/permission denied/);
  });
});
