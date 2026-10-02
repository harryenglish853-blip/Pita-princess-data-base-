import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { expectNoHorizontalOverflow, login, resetDemo, sql, watchConsole } from './helpers';
import { TOAST_WEBHOOK_SECRET } from './constants';

/** Spec step 16 + Phase 6: Toast menu import, mapping, sales import, webhook, no double counting. Runs against the local mock Toast API. */
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  resetDemo();
  await fetch('http://127.0.0.1:3999/__mock/reset');
});

const beef = async (lineId: string) => Number((await sql<{ q: string }>(`select coalesce(sum(tu.quantity_inv), 0) q from theoretical_usage tu join sales_transactions s on s.id = tu.sales_transaction_id
  join products p on p.id = tu.product_id where s.source = 'toast' and s.external_id = $1 and p.item_code = 'P-GRBEEF'`, [lineId]))[0].q);
const bd = () => Number(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', ''));

test('owner turns on Toast sync; management imports the menu and maps items', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'owner1@demo.local');
  await page.goto('/pos');
  await expect(page.getByText('Toast API configured')).toBeVisible();
  await page.getByRole('button', { name: 'TURN ON TOAST SYNC' }).click();
  await expect(page.getByText(/^Since /)).toBeVisible();

  await page.context().clearCookies();
  await login(page, 'manager@demo.local');
  await page.goto('/pos');
  await expect(page.getByRole('button', { name: 'TURN ON TOAST SYNC' })).toHaveCount(0);   // owners only
  await page.getByRole('button', { name: 'SYNC MENU' }).click();
  await expect(page.getByText(/Menu sync: OK — items 9 · new items 9/)).toBeVisible();
  await expect(page.getByText('UNMAPPED TOAST ITEMS (9)')).toBeVisible();
  await page.getByRole('button', { name: 'AUTO-MATCH BY NAME' }).click();
  await expect(page.getByText('Matched 6 items to recipes with the same name.')).toBeVisible();
  await page.getByLabel('Gift Card recipe').selectOption({ label: 'Not tracked (no inventory)' });
  await expect(page.getByLabel('Gift Card recipe')).toHaveValue('__none');
  await page.getByLabel('Extra Cheese recipe').selectOption({ label: 'Not tracked (no inventory)' });
  await expect(page.getByText('UNMAPPED TOAST ITEMS (1)')).toBeVisible();   // Bacon Cheeseburger has no recipe yet
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('16: Toast sales generate theoretical usage; the unmapped item waits until it is mapped', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto('/pos');
  await page.getByRole('button', { name: 'SYNC SALES' }).click();
  await expect(page.getByText(/Sales sync: OK — orders 3 · created 3 · unmapped lines 1/)).toBeVisible();
  expect(await beef('ts-1001-1')).toBe(1);          // 2 cheeseburgers x 8 OZ
  expect(await beef('ts-1002-1')).toBe(0);          // Bacon Cheeseburger: UNMAPPED, nothing posted
  await expect(page.getByText(/1 sale line waiting/)).toBeVisible();

  await page.getByLabel('Bacon Cheeseburger recipe').selectOption({ label: 'Cheeseburger' });
  await expect(page.getByText('All items mapped')).toBeVisible();
  expect(await beef('ts-1002-1')).toBe(0.5);        // posted once mapped

  // sync again: nothing is counted twice
  const rows = async () => Number((await sql<{ n: string }>(`select count(*) n from inventory_transactions where source_type = 'sales_transaction'`))[0].n);
  const before = await rows();
  await page.getByRole('button', { name: 'SYNC SALES' }).click();
  await expect(page.getByText(/Sales sync: OK — orders 3 · duplicate 3/)).toBeVisible();
  expect(await rows()).toBe(before);
  // gift cards are not food sales
  const gift = (await sql<{ is_void: boolean }>(`select is_void from sales_transactions where external_id = 'ts-1003-1'`))[0];
  expect(gift.is_void).toBe(true);
  expect(errors).toEqual([]);
});

test('signed webhook updates an order once; bad signatures and repeats are rejected or skipped', async ({ request }) => {
  const order = {
    guid: 'to-1001', businessDate: bd(), modifiedDate: new Date().toISOString(), voided: false, deleted: false,
    checks: [{ guid: 'tc-1001', selections: [
      { guid: 'ts-1001-1', item: { guid: 'tm-cheeseburger' }, displayName: 'Cheeseburger', quantity: 3, price: 38.97 },
      { guid: 'ts-1001-2', item: { guid: 'tm-fries' }, displayName: 'French Fries', quantity: 2, price: 9.98 },
    ] }],
  };
  const body = JSON.stringify({ guid: 'evt-1', eventCategory: 'orders', eventType: 'order_updated', details: { order } });
  const sign = (b: string) => createHmac('sha256', TOAST_WEBHOOK_SECRET).update(b).digest('base64');

  const bad = await request.post('/api/pos/toast/webhook', { data: body, headers: { 'content-type': 'application/json', 'toast-signature': 'nope' } });
  expect(bad.status()).toBe(401);
  const ok = await request.post('/api/pos/toast/webhook', { data: body, headers: { 'content-type': 'application/json', 'toast-signature': sign(body) } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).stats.updated).toBe(1);
  expect(await beef('ts-1001-1')).toBe(1.5);        // 3 x 8 OZ — replaced, not added
  const again = await request.post('/api/pos/toast/webhook', { data: body, headers: { 'content-type': 'application/json', 'toast-signature': sign(body) } });
  expect((await again.json()).status).toBe('duplicate_event');
  expect(await beef('ts-1001-1')).toBe(1.5);
});

test('the older version from the scheduled pull is ignored and logged', async ({ page }) => {
  await login(page, 'manager@demo.local');
  await page.goto('/pos');
  await page.getByRole('button', { name: 'SYNC SALES' }).click();
  await expect(page.getByText(/Sales sync: OK — orders 3 · duplicate 2 · stale 1/)).toBeVisible();
  expect(await beef('ts-1001-1')).toBe(1.5);
  await expect(page.getByRole('row', { name: /Webhook/ }).first()).toContainText('OK');
});
