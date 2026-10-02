import { test, expect } from '@playwright/test';
import { login, pickEmployee, resetDemo, sql, watchConsole, expectNoHorizontalOverflow } from './helpers';

/** Place on the vendor website, log it here, receive against it. */
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => resetDemo());

test('management logs a Sysco order next to the OPEN SYSCO WEBSITE link', async ({ page, context }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto('/ordering');
  const syscoId = (await sql<{ id: string }>(`select id from vendors where code='SYSCO'`))[0].id;
  await page.locator(`a[href="/ordering/new?vendor=${syscoId}"]`).click();
  await expect(page.getByRole('heading', { name: 'SYSCO' })).toBeVisible();
  await expect(page.getByRole('link', { name: /OPEN SYSCO WEBSITE/ })).toHaveAttribute('href', 'https://shop.sysco.com');

  await page.getByPlaceholder(/Add item/).fill('chicken');
  await page.getByRole('button', { name: /Chicken Breast/ }).click();
  await page.getByLabel('Chicken Breast order quantity').fill('5');
  await expect(page.getByLabel('Chicken Breast order unit')).toHaveValue('CASE');
  await expect(page.getByLabel('Chicken Breast order price')).toHaveValue('128');
  await page.getByRole('button', { name: '+ Add item' }).click();
  await page.getByPlaceholder(/Add item/).fill('fries');
  await page.getByRole('button', { name: /French Fries/ }).click();
  await page.getByLabel('French Fries order quantity').fill('4');
  await expect(page.getByText('Estimated total: $808.00')).toBeVisible(); // 5×128 + 4×42
  await expectNoHorizontalOverflow(page);

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'COPY ORDER LIST' }).click();
  await expect(page.getByRole('button', { name: 'COPIED ✓' })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('SYSCO ORDER');
  expect(clip).toContain('Chicken Breast — 5 CASE');
  expect(clip).toContain('French Fries — 4 CASE');

  await page.getByLabel(/Sysco confirmation/).fill('SY-445566');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'LOG AS PLACED' }).click();
  await expect(page).toHaveURL(/\/ordering\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Placed — waiting for delivery')).toBeVisible();
  const po = (await sql<{ status: string; estimated_total: string }>(`select status, estimated_total from purchase_orders`))[0];
  expect(po).toEqual({ status: 'placed', estimated_total: '808.00' });
  expect(errors).toEqual([]);
});

test('Carlos receives the delivery against the logged order (no prices shown to him)', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'employees@demo.local');
  await pickEmployee(page, 'Carlos', '4826');
  await page.getByRole('link', { name: 'RECEIVE DELIVERY' }).click();
  await page.getByRole('button', { name: 'SYSCO' }).click();
  await page.getByRole('button', { name: /Order #\d+ \(SY-445566\)/ }).click();
  await expect(page.getByText(/Receiving against order #/)).toBeVisible();
  await page.getByLabel('Invoice number').fill('77001');
  // open each line and enter what arrived
  await page.getByRole('button', { name: /^Chicken Breast/ }).click();
  await expect(page.getByLabel('Chicken Breast ordered')).toHaveValue('5');
  await expect(page.getByLabel('Chicken Breast price')).toHaveValue('');
  await page.getByLabel('Chicken Breast received').fill('4');
  await page.getByRole('button', { name: /^French Fries/ }).click();
  await page.getByRole('button', { name: 'All arrived (4 CASE)' }).click();
  await page.getByTestId('invoice-photo-input').setInputFiles({ name: 'invoice-77001.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex') });
  await page.getByRole('button', { name: /SUBMIT DELIVERY/ }).click();
  await expect(page.getByText('Invoice photo: 1 of 1 uploaded')).toBeVisible();
  await expect(page.getByText(/DELIVERY DISCREPANCY \(1\)/)).toBeVisible();
  await expect(page.getByText(/Chicken Breast: ordered 5 CASE, delivered 4/)).toBeVisible();
  const po = (await sql<{ status: string }>(`select status from purchase_orders`))[0];
  expect(po.status).toBe('received');
  const ev = (await sql<{ employee: string }>(`select e.display_name employee from receiving_events re join employees e on e.id=re.employee_id where re.invoice_number='77001'`))[0];
  expect(ev.employee).toBe('Carlos');
  expect(errors).toEqual([]);
});
