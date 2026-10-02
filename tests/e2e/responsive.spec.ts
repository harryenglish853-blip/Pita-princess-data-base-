import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, login, pickEmployee, resetDemo, sql, watchConsole } from './helpers';

/** Every page, every role, on phone / tablet / desktop: renders, no horizontal scroll, no console errors. */
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => resetDemo());

const MANAGEMENT_PAGES = ['/dashboard', '/inventory', '/counts', '/receiving', '/receiving/new', '/ordering', '/vendors', '/waste', '/transfers',
  '/tasks', '/alerts', '/employees', '/reports', '/reports/waste', '/reports/deliveries', '/reports/price-history', '/reports/inventory-value',
  '/reports/variance', '/reports/employee-activity', '/more', '/search?q=chick',
  '/commissary', '/commissary/new', '/commissary/new?suggested=1', '/commissary/production', '/commissary/production/new',
  '/recipes', '/recipes/new', '/sales'];
const OWNER_ONLY = ['/reports/food-cost', '/reports/food-cost?view=product', '/reports/food-cost?view=recipe', '/reports/food-cost?view=day', '/admin', '/admin/settings', '/admin/accounts', '/admin/storage', '/admin/count-order', '/admin/catalog', '/admin/audit'];

async function visitAll(page: import('@playwright/test').Page, paths: string[], shotPrefix: string, project: string) {
  for (const path of paths) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(400);
    await expect(page.locator('main')).toBeVisible();
    // wait for streamed content: no loading skeleton left
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('This page could not load')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `test-results/screens/${project}/${shotPrefix}${path.replace(/\//g, '_') || '_root'}.png`, fullPage: true });
  }
}

test('owner: every page', async ({ page }, info) => {
  const errors = watchConsole(page);
  await login(page, 'owner1@demo.local');
  const product = (await sql<{ id: string }>(`select id from products where item_code='P-CHKBR'`))[0].id;
  const receipt = (await sql<{ id: string }>(`select id from receiving_events limit 1`))[0].id;
  const vendor = (await sql<{ id: string }>(`select id from vendors where code='SYSCO'`))[0].id;
  const employee = (await sql<{ id: string }>(`select id from employees where display_name='Carlos'`))[0].id;
  const count = (await sql<{ id: string }>(`select id from inventory_count_sessions limit 1`))[0].id;
  const co = (await sql<{ id: string }>(`select id from commissary_orders limit 1`))[0].id;
  const recipe = (await sql<{ id: string }>(`select id from recipes where name = 'Cheeseburger'`))[0].id;
  await visitAll(page, [...MANAGEMENT_PAGES, ...OWNER_ONLY, `/inventory/products/${product}`, `/inventory/products/${product}/edit`, '/inventory/products/new',
    `/receiving/${receipt}`, `/vendors/${vendor}`, '/vendors/new', `/employees/${employee}`, `/counts/${count}`, `/commissary/${co}`, `/commissary/${co}/receive`, `/recipes/${recipe}`, `/recipes/${recipe}/edit`], 'owner', info.project.name);
  expect(errors).toEqual([]);
});

test('management: every page; owner-only pages are refused', async ({ page }, info) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await visitAll(page, MANAGEMENT_PAGES, 'manager', info.project.name);
  for (const p of ['/admin/accounts', '/admin/settings', '/admin/audit', '/reports/food-cost']) {
    await page.goto(p);
    await expect(page, p).toHaveURL(/\/forbidden$/);
  }
  expect(errors).toEqual([]);
});

test('employee (shared login + PIN): simple pages only', async ({ page }, info) => {
  const errors = watchConsole(page);
  await login(page, 'employees@demo.local');
  await page.screenshot({ path: `test-results/screens/${info.project.name}/employee_who.png`, fullPage: true });
  await pickEmployee(page, 'John', '1357');
  await expect(page.getByTestId('employee-name')).toHaveText('John');
  const co = (await sql<{ id: string }>(`select id from commissary_orders limit 1`))[0].id;
  await visitAll(page, ['/dashboard', '/receiving/new', '/waste', '/transfers', '/tasks', `/commissary/${co}/receive`], 'employee', info.project.name);
  for (const p of [...MANAGEMENT_PAGES.filter((x) => !['/dashboard', '/receiving/new', '/waste', '/transfers', '/tasks'].includes(x)), '/admin']) {
    await page.goto(p);
    await expect(page, p).toHaveURL(/\/(forbidden|dashboard)$/);
  }
  expect(errors).toEqual([]);
});
