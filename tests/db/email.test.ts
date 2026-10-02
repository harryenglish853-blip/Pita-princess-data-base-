import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { asUser, connect, expectFail, ids, resetAndSeed } from './helpers';
import { buildReport } from '@/lib/email/report';
import { runReport } from '@/lib/email/run';
import { createStorageAdmin } from '@/lib/supabase/server';
import { todayInTz } from '@/lib/format';

let db: Client;
let I: Awaited<ReturnType<typeof ids>>;
// calendar dates in the restaurant's time zone (the seed uses New York dates)
const iso = (d: number) => todayInTz('America/New_York', d);
const TZ = 'America/New_York';

beforeAll(async () => { resetAndSeed(); db = await connect(); I = await ids(db); });
afterAll(async () => db?.end());

describe('required invoice photos', () => {
  it('receiving rules say a photo is required; a delivery without one opens an alert', async () => {
    const rules = (await asUser(db, { userId: I.manager }, (q) => q('select public.receiving_rules() r')))[0].r;
    expect(rules).toEqual({ require_invoice_photo: true });
    const r = await asUser(db, { userId: I.manager }, async (q) => (await q('select public.submit_receiving($1) r', [{ idempotency_key: randomUUID(), vendor_id: I.vendor('GRECO'), invoice_number: 'NOPHOTO-1', delivery_date: iso(0), lines: [{ product_id: I.product('P-FLOUR'), unit_code: 'BAG', received_qty: 1 }] }]))[0].r);
    const a = (await db.query(`select status from alerts where dedupe_key = $1`, [`invoice-photo:${r.receiving_event_id}`])).rows[0];
    expect(a.status).toBe('open');
  });
});

describe('report content', () => {
  it('lists deliveries with who received them, attaches their invoice photos and flags missing ones', async () => {
    const rep = await buildReport(createStorageAdmin(), 'weekly', iso(-7), iso(0), TZ, 'https://inventory.example.com');
    expect(rep.subject).toMatch(/^Weekly Restaurant Inventory Report — /);
    expect(rep.html).toContain('Invoice #1001882');
    expect(rep.html).toContain('Invoice #G-55120');
    expect(rep.html).toContain('Invoice #NOPHOTO-1');
    expect(rep.html).toContain('MISSING');
    expect(rep.html).toContain('https://inventory.example.com/dashboard');
    expect(rep.html).toContain('Vendor spending');
    expect(rep.attachments.map((a) => a.filename).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/Sysco-1001882\.png$/), expect.stringMatching(/Greco-G-55120\.png$/)]));
    expect(rep.attachments).toHaveLength(2);
    // purchases match the database exactly
    const total = (await db.query(`select sum(received_total) t from receiving_events where delivery_date between $1 and $2`, [iso(-7), iso(0)])).rows[0].t;
    expect(rep.html).toContain(`$${Number(total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    // escaping: user-entered text cannot inject markup
    expect(rep.html).not.toMatch(/<script/i);
  });

  it('daily report covers only the given day', async () => {
    const rep = await buildReport(createStorageAdmin(), 'daily', iso(-3), iso(-3), TZ, 'https://x');
    expect(rep.subject).toMatch(/^Daily Restaurant Operations — /);
    expect(rep.attachments).toHaveLength(1);
    expect(rep.html).not.toContain('Invoice #G-55120');
  });
});

describe('sending', () => {
  let server: http.Server;
  const received: { auth?: string; body: any }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(data) });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `msg_${received.length}` }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => {
    server.close();
    delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.RESEND_API_URL;
  });

  it('without recipients or provider, the report is saved but not sent', async () => {
    const r = await runReport({ type: 'daily', from: iso(-3), to: iso(-3), tz: TZ, trigger: 'manual' });
    expect(r.status).toBe('no_recipients');
    await db.query(`insert into email_recipients (email, name) values ('office@company.test', 'Company'), ('gm@company.test', 'GM')`);
    const r2 = await runReport({ type: 'daily', from: iso(-3), to: iso(-3), tz: TZ, trigger: 'manual' });
    expect(r2.status).toBe('not_configured');
    const row = (await db.query(`select status, recipients, html from email_reports where id = $1`, [r2.id])).rows[0];
    expect(row.recipients).toEqual(['office@company.test', 'gm@company.test']);
    expect(row.html).toContain('Invoice #1001882');
  });

  it('sends to the company and manager emails with the invoice photos attached, once per scheduled period', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'Reports <reports@company.test>';
    process.env.RESEND_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await db.query(`update email_recipients set receives_weekly = false where email = 'gm@company.test'`);
    const r = await runReport({ type: 'weekly', from: iso(-7), to: iso(0), tz: TZ, trigger: 'schedule' });
    expect(r.status).toBe('sent');
    const mail = received.at(-1)!;
    expect(mail.auth).toBe('Bearer re_test_key');
    expect(mail.body.to).toEqual(['office@company.test']);
    expect(mail.body.from).toBe('Reports <reports@company.test>');
    expect(mail.body.attachments).toHaveLength(2);
    expect(Buffer.from(mail.body.attachments[0].content, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const row = (await db.query(`select status, provider_message_id from email_reports where id = $1`, [r.id])).rows[0];
    expect(row).toEqual({ status: 'sent', provider_message_id: `msg_${received.length}` });
    // the scheduler firing again for the same week does not send a duplicate
    const again = await runReport({ type: 'weekly', from: iso(-7), to: iso(0), tz: TZ, trigger: 'schedule' });
    expect(again.status).toBe('already_sent');
    expect(received).toHaveLength(1);
  });
});

describe('access', () => {
  it('only owners manage recipients and see the report log', async () => {
    expect(await asUser(db, { userId: I.manager }, (q) => q('select * from email_recipients'))).toHaveLength(0);
    expect(await asUser(db, { userId: I.manager }, (q) => q('select * from email_reports'))).toHaveLength(0);
    await expectFail(asUser(db, { userId: I.manager }, (q) => q(`insert into email_recipients (email) values ('x@y.test')`)), 'row-level security');
    expect((await asUser(db, { userId: I.owner1 }, (q) => q('select * from email_recipients'))).length).toBe(2);
    await expectFail(asUser(db, { userId: I.owner1 }, (q) => q(`insert into email_reports (report_type, period_start, period_end, triggered_by, status, subject) values ('daily', current_date, current_date, 'manual', 'sent', 'fake')`)), 'permission denied');
  });
});
