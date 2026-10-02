import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, login, pickEmployee, resetDemo, sql, watchConsole } from './helpers';

/** Spec step 26 and the commissary lifecycle: order -> email -> statuses -> send -> restaurant receives 95 of 100. */
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => resetDemo());

let orderId = '';

test('management creates and submits a commissary order; it is emailed to the commissary recipients', async ({ page }) => {
  const errors = watchConsole(page);
  await sql(`insert into email_recipients (email, name, receives_daily, receives_weekly, receives_commissary_orders) values ('kitchen@example.com', 'Central kitchen', false, false, true)`);
  await login(page, 'manager@demo.local');
  await page.goto('/commissary');
  await page.getByRole('link', { name: 'NEW COMMISSARY ORDER' }).click();
  await expect(page.getByRole('heading', { name: 'COMMISSARY ORDER' })).toBeVisible();
  await page.getByPlaceholder('Add commissary item').fill('meat');
  await page.getByRole('button', { name: /Meatballs/ }).click();
  await page.getByLabel('Meatballs quantity').fill('100');
  await page.getByLabel('Meatballs unit').selectOption('EA');
  await page.getByRole('button', { name: '+ Add item' }).click();
  await page.getByPlaceholder('Add commissary item').fill('dough');
  await page.getByRole('button', { name: /Pizza Dough/ }).click();
  await page.getByLabel('Pizza Dough quantity').fill('5');
  const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  await page.getByLabel('Needed date').fill(tomorrow);
  await expectNoHorizontalOverflow(page);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'SUBMIT TO COMMISSARY' }).click();
  await expect(page).toHaveURL(/\/commissary\/[0-9a-f-]{36}$/);
  orderId = page.url().split('/').pop()!;
  await expect(page.getByText('SUBMITTED').first()).toBeVisible();
  const mail = (await sql<{ status: string; recipients: string[]; subject: string; html: string }>(`select status, recipients, subject, html from email_reports where commissary_order_id = $1`, [orderId]))[0];
  expect(mail.recipients).toEqual(['kitchen@example.com']);
  expect(['sent', 'not_configured']).toContain(mail.status);
  expect(mail.subject).toMatch(/^COMMISSARY ORDER #\d+ — Pita Princess — Main Street — needed /);
  expect(mail.html).toContain('Meatballs — 100 EA');
  expect(mail.html).toContain('Pizza Dough — 5 TRAY');
  expect(mail.html).toContain(`/commissary/${orderId}`);
  expect(mail.html).toContain('VIEW ORDER');
  await expect(page.getByText(/kitchen@example\.com/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('the commissary accepts, prepares, marks ready and sends it', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto(`/commissary/${orderId}`);
  await page.getByRole('button', { name: 'ACCEPT ORDER' }).click();
  await page.getByRole('button', { name: 'START PREPARING' }).click();
  await page.getByRole('button', { name: 'MARK READY' }).click();
  await page.getByRole('button', { name: 'SEND TO RESTAURANT' }).click();
  await expect(page.getByLabel('Meatballs sent')).toHaveValue('100');
  await page.getByRole('button', { name: 'CONFIRM SENT — IN TRANSIT' }).click();
  await expect(page.getByText('On its way.')).toBeVisible();
  const ev = await sql<{ to_status: string }>(`select to_status from commissary_order_events where order_id = $1 order by id`, [orderId]);
  expect(ev.map((e) => e.to_status)).toEqual(['draft', 'submitted', 'accepted', 'preparing', 'ready', 'in_transit']);
  expect(errors).toEqual([]);
});

test('Carlos receives it on the shared login: 95 of 100 meatballs; out 95 / in 95; difference flagged', async ({ page }) => {
  const errors = watchConsole(page);
  const bal = async (code: string, loc: string) => Number((await sql<{ q: string }>(`select b.quantity q from inventory_balances b join products p on p.id = b.product_id join locations l on l.id = b.location_id where p.item_code = $1 and l.code = $2`, [code, loc]))[0].q);
  const ck = await bal('P-MEATB', 'CK');
  const main = await bal('P-MEATB', 'MAIN');
  const no = (await sql<{ n: string }>(`select order_number::text n from commissary_orders where id = $1`, [orderId]))[0].n;
  await login(page, 'employees@demo.local');
  await pickEmployee(page, 'Carlos', '4826');
  await expect(page.getByText('COMMISSARY ORDERS ARRIVING')).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`Order #${no} `) }).click();
  await expect(page.getByText(`COMMISSARY ORDER #${no}`)).toBeVisible();
  await expect(page.getByText(/cost|\$/)).toHaveCount(0);
  await page.getByLabel('Meatballs received').fill('95');
  await page.getByLabel('Pizza Dough received').fill('5');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'CONFIRM RECEIVED' }).click();
  await expect(page.getByText('Received — with differences')).toBeVisible();
  await expect(page.getByText('Meatballs: ordered 100, sent 100, received 95 EA (short 5)')).toBeVisible();
  expect(await bal('P-MEATB', 'CK')).toBe(ck - 95);
  expect(await bal('P-MEATB', 'MAIN')).toBe(main + 95);
  const a = (await sql<{ employee_name: string; account_name: string }>(`select employee_name, account_name from audit_logs where action = 'commissary.order_received' and entity_id = $1`, [orderId]))[0];
  expect(a).toEqual({ employee_name: 'Carlos', account_name: 'Employee Shared Account' });
  expect(errors).toEqual([]);
});

test('management sees the differences; production batch pre-fills from the last batch and is costed', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto(`/commissary/${orderId}`);
  await expect(page.getByText('Arrived different from the order')).toBeVisible();
  await expect(page.getByText('-5')).toBeVisible();
  await page.goto('/commissary/production/new');
  await page.getByPlaceholder(/Finished product/).fill('marinara');
  await page.getByRole('button', { name: /Marinara/ }).click();
  await expect(page.getByText(/Filled in from the last Marinara batch/)).toBeVisible();
  await expect(page.getByLabel('Amount made')).toHaveValue('20');
  await expect(page.getByLabel('Tomato used', { exact: true })).toHaveValue('16');
  await page.getByLabel('Amount made').fill('10');
  await page.getByLabel('Tomato used', { exact: true }).fill('8');
  await page.getByLabel('Cooking Oil (Fryer) used', { exact: true }).fill('0.25');
  await page.getByLabel('Yellow Onion used', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'RECORD BATCH' }).click();
  // 8 x 1.45 + 0.25 x 9.50 + 1 x 0.65 = 14.625 -> $14.63 for 10 QT
  await expect(page.getByText(/Batch #\d+ recorded/)).toBeVisible();
  await expect(page.getByText(/Ingredients cost \$14\.63 \(\$1\.46 per QT\)/)).toBeVisible();
  expect(errors).toEqual([]);
});
