import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, login, resetDemo, sql, watchConsole } from './helpers';

/** Phase 5: recipes (nested), daily sales -> theoretical usage, actual vs theoretical food cost. */
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => resetDemo());

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const yesterday = () => new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

test('management sees recipe costs and builds a menu item with a sub-recipe', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto('/recipes');
  const burger = page.getByRole('row', { name: /Cheeseburger/ });
  await expect(burger).toContainText('$3.60');   // 3.5953 per portion
  await expect(burger).toContainText('27.7%');
  await burger.getByRole('link').click();
  await expect(page.getByRole('row', { name: /House Sauce/ })).toContainText('Sub-recipe');
  await expect(page.getByRole('row', { name: /Ground Beef/ })).toContainText('$2.08');

  await page.goto('/recipes/new');
  await page.getByLabel('Recipe name').fill('Chicken Wrap');
  await page.getByLabel(/Selling price/).fill('9.99');
  await page.getByPlaceholder('Add ingredient (product)').fill('chicken');
  await page.getByRole('button', { name: /Chicken Breast/ }).click();
  await page.getByLabel('Chicken Breast quantity').fill('5');
  await page.getByLabel('Chicken Breast unit').selectOption('OZ');
  await page.getByRole('button', { name: '+ Add sub-recipe' }).click();
  await page.getByLabel('Add sub-recipe').selectOption({ label: 'House Sauce' });
  await page.getByLabel('House Sauce quantity').fill('1');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'SAVE RECIPE' }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Chicken Wrap' })).toBeVisible();
  // 5 OZ chicken = 0.3125 LB x $3.20 = $1.00 + 1 FL_OZ House Sauce $0.1264 = $1.1264
  await expect(page.getByText('$1.13').first()).toBeVisible();
  await expect(page.getByText('11.3%')).toBeVisible();
  expect(errors).toEqual([]);
});

test('daily sales post the ingredient usage once, and re-saving does not double count', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await page.goto(`/sales?date=${yesterday()}`);
  await page.getByLabel('Chicken Wrap quantity sold').fill('10');
  await expect(page.getByLabel('Chicken Wrap net sales')).toHaveValue('99.90');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'SAVE SALES' }).click();
  await expect(page.getByText(/Saved: 10 items, \$99\.90 in sales/)).toBeVisible();
  const usage = async () => Number((await sql<{ q: string }>(`select coalesce(sum(tu.quantity_inv),0) q from theoretical_usage tu join sales_transactions s on s.id = tu.sales_transaction_id
    join products p on p.id = tu.product_id where s.item_name = 'Chicken Wrap' and p.item_code = 'P-CHKBR'`))[0].q);
  expect(await usage()).toBe(3.125);   // 10 x 5 OZ
  await page.getByRole('button', { name: 'SAVE SALES' }).click();
  await expect(page.getByText(/Saved: 10 items/)).toBeVisible();
  expect(await usage()).toBe(3.125);   // same numbers again: nothing added
  expect(errors).toEqual([]);
});

test('the owner sees actual vs theoretical food cost with drilldowns and CSV', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'owner1@demo.local');
  await expect(page.getByText('Theoretical food cost').first()).toBeVisible();
  await expect(page.locator('a[href="/reports/food-cost"]').first()).toContainText('%');
  await page.goto(`/reports/food-cost?range=custom&from=${yesterday()}&to=${today()}`);
  await expect(page.getByText(/Beginning inventory .* \+ purchases & transfers in .* − ending inventory .* =/)).toBeVisible();
  await page.getByRole('link', { name: 'By menu item' }).click();
  await expect(page.getByRole('row', { name: /Chicken Wrap/ })).toContainText('$99.90');
  await page.getByRole('link', { name: 'By product' }).click();
  await expect(page.getByRole('row', { name: /Ground Beef/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const csv = await page.request.get(`/api/export/food-cost?range=custom&from=${yesterday()}&to=${today()}`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('Theoretical usage qty');
  expect(errors).toEqual([]);
});

test('management cannot open the financial food cost report', async ({ page }) => {
  await login(page, 'manager@demo.local');
  await page.goto('/reports/food-cost');
  await expect(page).toHaveURL(/\/forbidden$/);
  const csv = await page.request.get('/api/export/food-cost');
  expect(csv.status()).toBe(403);
});
