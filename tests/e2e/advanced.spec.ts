import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, login, pickEmployee, resetDemo, sql, watchConsole } from './helpers';

/** Phase 8: forecast, forecast-driven suggestions, barcode scanning, voice counts, AI invoice check, anomaly checks. */
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => resetDemo());

test('forecast: next 7 days, ingredients, and an event adjustment', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto('/forecast');
  await expect(page.getByRole('heading', { name: 'Sales forecast' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Cheeseburger', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Brioche Buns', exact: true })).toBeVisible();
  await page.getByLabel('Change (%)').fill('30');
  await page.getByLabel('Reason').fill('Street fair');
  await page.getByRole('button', { name: 'ADD ADJUSTMENT' }).click();
  await expect(page.getByText(/Street fair · .* · \+30% · all menu items/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: /Remove Street fair/ }).click();
  await expect(page.getByText(/Street fair ·/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('suggested order for a dynamic-par item explains the sales forecast behind it', async ({ page }) => {
  await login(page, 'manager@demo.local');
  const sysco = (await sql<{ id: string }>(`select id from vendors where code='SYSCO'`))[0].id;
  await page.goto(`/ordering/new?vendor=${sysco}&suggested=1`);
  const why = page.locator('details', { hasText: 'Based on the menu-item sales forecast' }).first();
  await why.locator('summary').click();
  await expect(why.getByText('Forecast usage (from the sales forecast)')).toBeVisible();
  await expect(why.getByText(/^\s*.+ \([\d.,]+ forecast\)$/).first()).toBeVisible();
});

test('barcode: unknown code for an employee; a manager maps it and the next scan opens the item', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'employees@demo.local');
  await pickEmployee(page, 'Carlos', '4826');
  await expect(page.getByTestId('employee-name')).toHaveText('Carlos');
  await page.getByRole('link', { name: 'Scan' }).first().click();
  await expect(page.getByRole('heading', { name: 'Scan barcode' })).toBeVisible();
  await page.getByLabel('Barcode number').fill('0074865004231');
  await page.getByRole('button', { name: 'LOOK UP' }).click();
  await expect(page.getByText('BARCODE NOT FOUND')).toBeVisible();
  await expect(page.getByText('Ask a manager to add this barcode to the right product.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.context().clearCookies();
  await login(page, 'manager@demo.local');
  await page.goto('/scan');
  await page.getByLabel('Barcode number').fill('0074865004231');
  await page.getByRole('button', { name: 'LOOK UP' }).click();
  await expect(page.getByText('BARCODE NOT FOUND')).toBeVisible();
  await page.getByRole('button', { name: /MAP THIS BARCODE/ }).click();
  await page.getByPlaceholder('Search product, item ID or barcode').fill('chicken breast');
  await page.getByRole('button', { name: /Chicken Breast/ }).click();
  await page.getByLabel('One scan is').selectOption('CASE');
  await page.getByRole('button', { name: 'SAVE BARCODE' }).click();
  await expect(page).toHaveURL(/\/inventory\/products\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Chicken Breast' })).toBeVisible();
  const m = await sql<{ unit_code: string }>(`select unit_code from product_barcodes where barcode = '0074865004231'`);
  expect(m[0].unit_code).toBe('CASE');
  expect(errors).toEqual([]);
});

test('voice count: "chicken breast one case and eight pounds" fills 48 LB after confirmation; scanning jumps to the line', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto('/counts');
  await page.getByRole('button', { name: 'START WEEKLY INVENTORY' }).click();
  await expect(page).toHaveURL(/\/counts\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'VOICE COUNT' }).click();
  await page.getByLabel('Say or type the count').fill('Chicken breast, one case and eight pounds');
  await page.getByRole('button', { name: 'READ', exact: true }).click();
  await expect(page.getByTestId('voice-result')).toContainText('1 CASE + 8 LB = 48 LB');
  await expect(page.getByTestId('count-total')).not.toContainText('48 LB');   // nothing filled before confirming
  await page.getByRole('button', { name: 'USE THIS COUNT' }).click();
  await expect(page.getByTestId('count-product')).toHaveText(/^chicken breast$/i);
  await expect(page.getByTestId('count-total')).toContainText('Total: 48 LB');
  await expect(page.getByTestId('sync-status')).toHaveText('SAVED');
  const e = await sql<{ counted_qty: string }>(`select ce.counted_qty from inventory_count_entries ce join products p on p.id = ce.product_id where p.item_code = 'P-CHKBR' order by ce.counted_at desc nulls last limit 1`);
  expect(Number(e[0].counted_qty)).toBe(48);

  // unsure (a number without a unit) -> must be confirmed explicitly
  await page.getByLabel('Say or type the count').fill('avocado twelve');
  await page.getByRole('button', { name: 'READ', exact: true }).click();
  await expect(page.getByText('Check this before using it')).toBeVisible();
  await expect(page.getByRole('button', { name: 'YES, IT IS CORRECT — USE IT' })).toBeVisible();
  await page.getByRole('button', { name: 'CANCEL' }).click();

  await page.getByRole('button', { name: 'SCAN BARCODE' }).first().click();
  await page.getByLabel('Barcode number').fill('P-AVO');
  await page.getByRole('button', { name: 'LOOK UP' }).click();
  await expect(page.getByTestId('count-product')).toHaveText(/^avocado$/i);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('AI invoice check is clearly marked as not set up without an API key; anomaly checks run on demand', async ({ page }) => {
  await login(page, 'manager@demo.local');
  const ev = (await sql<{ id: string }>(`select id from receiving_events order by received_at desc limit 1`))[0].id;
  await page.goto(`/receiving/${ev}`);
  await expect(page.getByText('AI invoice check')).toBeVisible();
  await expect(page.getByText(/Invoice reading needs an ANTHROPIC_API_KEY/)).toBeVisible();
  await page.goto('/alerts');
  await page.getByRole('button', { name: 'RUN ANOMALY CHECKS' }).click();
  await expect(page.getByText(/^Checks done:/)).toBeVisible();
});
