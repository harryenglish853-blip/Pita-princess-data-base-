/**
 * DEMO SEED — local development (and, only with explicit opt-in, a STAGING demo).
 *
 *   npm run seed:demo
 *
 * Creates four demo login accounts through the Supabase Auth admin API and
 * loads supabase/seed/demo_data.sql. Refuses to run against anything that is
 * not localhost unless ALLOW_DEMO_SEED=staging is set, and it NEVER runs when
 * APP_ENV=production. Demo employees/products are flagged is_demo = true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { loadEnv } from './lib/env';
import { demoInvoicePng } from './lib/demoInvoice';

loadEnv();

const url = process.env.SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl = process.env.LOCAL_DB_URL ?? process.env.DATABASE_URL ?? '';
const password = process.env.DEMO_PASSWORD ?? '';

function isLocal(u: string) {
  return /(^|@|\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/.test(u);
}

async function main() {
  if (process.env.APP_ENV === 'production') throw new Error('Refusing: APP_ENV=production. Demo data must never reach production.');
  if (!url || !serviceKey || !dbUrl) throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and LOCAL_DB_URL are required.');
  if ((!isLocal(url) || !isLocal(dbUrl)) && process.env.ALLOW_DEMO_SEED !== 'staging') {
    throw new Error('Refusing to seed a non-local project. Set ALLOW_DEMO_SEED=staging only for a staging demo project.');
  }
  if (password.length < 12) throw new Error('Set DEMO_PASSWORD (12+ characters) for the demo accounts.');

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const accounts = ['owner1@demo.local', 'owner2@demo.local', 'manager@demo.local', 'employees@demo.local'];
  const { data: existing, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listErr) throw listErr;
  for (const email of accounts) {
    if (existing.users.some((u) => u.email === email)) continue;
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    console.log(`created auth user ${email}`);
  }

  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/seed/demo_data.sql'), 'utf8');
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(sql);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');
    throw e;
  } finally {
    await db.end();
  }
  // Demo invoice photos for the seeded deliveries (uploaded like the app does).
  const db2 = new Client({ connectionString: dbUrl });
  await db2.connect();
  try {
    const events = (await db2.query(`select re.id, re.account_id, re.vendor_id, re.delivery_date, coalesce(re.invoice_number, re.receipt_number::text) inv from receiving_events re`)).rows;
    for (const ev of events) {
      const docId = (await db2.query('select gen_random_uuid() id')).rows[0].id;
      const storagePath = `${String(ev.delivery_date.toISOString?.() ?? ev.delivery_date).slice(0, 7).replace('-', '/')}/${ev.id}/${docId}.png`;
      await db2.query(`insert into invoice_documents (id, receiving_event_id, vendor_id, storage_path, file_name, mime_type, size_bytes, account_id)
                       values ($1, $2, $3, $4, $5, 'image/png', $6, $7)`, [docId, ev.id, ev.vendor_id, storagePath, `demo-invoice-${ev.inv}.png`, demoInvoicePng().length, ev.account_id]);
      const { error } = await admin.storage.from('invoices').upload(storagePath, demoInvoicePng(), { contentType: 'image/png', upsert: true });
      await db2.query(`update invoice_documents set upload_status = $2 where id = $1`, [docId, error ? 'failed' : 'uploaded']);
      if (error) console.warn(`demo invoice upload failed (storage not running?): ${error.message}`);
    }
  } finally {
    await db2.end();
  }
  console.log('demo data loaded. Accounts:', accounts.join(', '));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
