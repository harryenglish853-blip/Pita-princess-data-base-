import { test, expect, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, login, pickEmployee, resetDemo, sql, watchConsole } from './helpers';

/**
 * THE DEMO FLOW (phone-sized, the way staff will use it).
 * Runs serially on a fresh demo database.
 */
test.describe.configure({ mode: 'serial' });

const qty = async (code: string) =>
  Number((await sql<{ q: string }>(`select b.quantity q from inventory_balances b join products p on p.id=b.product_id join locations l on l.id=b.location_id where p.item_code=$1 and l.code='MAIN'`, [code]))[0]?.q ?? 0);

let chickenBefore = 0;

test.beforeAll(() => resetDemo());

test('1-4: shared employee login requires WHO ARE YOU? + PIN; wrong PIN is rejected', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'employees@demo.local');
  await expect(page).toHaveURL(/\/who$/);
  // operational pages are not reachable without a person
  await page.goto('/receiving/new');
  await expect(page).toHaveURL(/\/who$/);
  await expectNoHorizontalOverflow(page);

  await pickEmployee(page, 'Carlos', '1111');
  await expect(page.getByText(/Wrong PIN\. 4 attempts left/)).toBeVisible();
  for (const d of '4826') await page.getByRole('button', { name: `Digit ${d}` }).click();
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('employee-name')).toHaveText('Carlos');
  await expect(page.getByRole('link', { name: 'RECEIVE DELIVERY' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

async function asCarlos(page: Page) {
  await login(page, 'employees@demo.local');
  await pickEmployee(page, 'Carlos', '4826');
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('5-10: Carlos receives a Sysco delivery with a short shipment', async ({ page }) => {
  const errors = watchConsole(page);
  chickenBefore = await qty('P-CHKBR');
  await asCarlos(page);
  await page.getByRole('link', { name: 'RECEIVE DELIVERY' }).click();
  await page.getByRole('button', { name: 'SYSCO' }).click();
  await page.getByLabel('Invoice number').fill('83923');
  await page.getByRole('button', { name: 'Yes' }).click();

  await page.getByRole('button', { name: '+ Add item' }).click();
  await page.getByPlaceholder('Search product, item ID or barcode').fill('chicken');
  await page.getByRole('button', { name: /Chicken Breast/ }).click();
  await page.getByLabel('Chicken Breast ordered').fill('5');
  await page.getByLabel('Chicken Breast received').fill('4');
  await page.getByLabel('Chicken Breast invoiced').fill('5');
  await page.getByLabel('Chicken Breast price').fill('128');
  await expect(page.getByText('= 160 LB into inventory')).toBeVisible();
  await expect(page.getByText('SHORT SHIPMENT')).toBeVisible();
  await expect(page.getByText('POSSIBLE BILLING ISSUE')).toBeVisible();

  await page.getByRole('button', { name: '+ Add item' }).click();
  await page.getByPlaceholder('Search product, item ID or barcode').fill('tomato');
  await page.getByRole('button', { name: /^Tomato/ }).click();
  await page.getByLabel('Tomato ordered').fill('2');
  await page.getByLabel('Tomato received').fill('2');
  await page.getByLabel('Tomato invoiced').fill('2');
  await expectNoHorizontalOverflow(page);

  // A photo of the invoice is required before the delivery can be submitted
  await page.getByRole('button', { name: /SUBMIT DELIVERY/ }).click();
  await expect(page.getByText('Take a photo of the invoice (or upload it) before submitting.')).toBeVisible();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  await page.getByTestId('invoice-photo-input').setInputFiles([
    { name: 'invoice-83923-p1.png', mimeType: 'image/png', buffer: png },
    { name: 'invoice-83923-p2.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.getByText('Page 2: invoice-83923-p2.png')).toBeVisible();

  await page.getByRole('button', { name: /SUBMIT DELIVERY/ }).click();
  await expect(page.getByText(/Delivery saved — receipt #/)).toBeVisible();
  await expect(page.getByText(/DELIVERY DISCREPANCY \(2\)/)).toBeVisible();
  await expect(page.getByText('Possible credit due: $128.00')).toBeVisible();
  await expect(page.getByText('Invoice photos: 2 of 2 uploaded')).toBeVisible();

  // Inventory increased only by what was actually received: 4 cases x 40 LB
  expect(await qty('P-CHKBR')).toBe(chickenBefore + 160);
  const ev = (await sql<{ employee: string; account: string; credit: string }>(`
    select e.display_name employee, ap.display_name account, re.credit_due_estimate credit
      from receiving_events re join employees e on e.id = re.employee_id join account_profiles ap on ap.id = re.account_id
     where re.invoice_number = '83923'`))[0];
  expect(ev).toEqual({ employee: 'Carlos', account: 'Employee Shared Account', credit: '128.00' });
  const audit = await sql<{ summary: string; account_name: string; employee_name: string }>(`select summary, account_name, employee_name from audit_logs where action='receiving.received' and employee_name='Carlos'`);
  expect(audit[0]).toEqual({ summary: 'Carlos received Sysco delivery #83923 (2 items, 2 discrepancies)', account_name: 'Employee Shared Account', employee_name: 'Carlos' });
  const alert = await sql<{ status: string }>(`select status from alerts where alert_type='DELIVERY_DISCREPANCY' and title like '%83923%'`);
  expect(alert[0].status).toBe('open');
  const doc = await sql<{ upload_status: string; employee: string }>(`select d.upload_status, e.display_name employee from invoice_documents d join employees e on e.id=d.employee_id join receiving_events re on re.id=d.receiving_event_id where re.invoice_number='83923'`);
  expect(doc).toEqual([{ upload_status: 'uploaded', employee: 'Carlos' }, { upload_status: 'uploaded', employee: 'Carlos' }]);
  const photoAlert = await sql<{ status: string }>(`select a.status from alerts a join receiving_events re on a.dedupe_key = 'invoice-photo:' || re.id where re.invoice_number='83923'`);
  expect(photoAlert[0].status).toBe('resolved');
  expect(errors).toEqual([]);
});

test('employee cannot reach management pages or exports', async ({ page }) => {
  await asCarlos(page);
  for (const path of ['/inventory', '/admin', '/employees', '/reports', '/counts', '/receiving']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/forbidden$/);
  }
  const res = await page.request.get('/api/export/inventory');
  expect(res.status()).toBe(403);
});

test('11-15: switch employee, Maria logs waste under her own name', async ({ page }) => {
  const errors = watchConsole(page);
  await asCarlos(page);
  await page.getByRole('button', { name: 'SWITCH EMPLOYEE' }).first().click();
  await expect(page).toHaveURL(/\/who$/);
  await pickEmployee(page, 'Maria', '2468');
  await expect(page.getByTestId('employee-name')).toHaveText('Maria');
  const before = await qty('P-AVO');
  await page.getByRole('link', { name: 'LOG WASTE' }).click();
  await page.getByPlaceholder('Search product, item ID or barcode').fill('avocado');
  await page.getByRole('button', { name: /Avocado/ }).click();
  await page.getByLabel('Waste quantity').fill('2');
  await page.getByRole('button', { name: 'Spoiled' }).click();
  await expect(page.getByText('Recorded as: Maria')).toBeVisible();
  await page.getByRole('button', { name: 'SAVE WASTE' }).click();
  await expect(page.getByText(/Logged 2 EA Avocado waste \(Spoiled\) by Maria/)).toBeVisible();
  expect(await qty('P-AVO')).toBe(before - 2);
  const a = await sql<{ employee_name: string; account_name: string }>(`select employee_name, account_name from audit_logs where action='waste.logged' order by id desc limit 1`);
  expect(a[0]).toEqual({ employee_name: 'Maria', account_name: 'Employee Shared Account' });
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('inactivity locks the employee session and returns to WHO ARE YOU?', async ({ page }) => {
  await page.clock.install();
  await login(page, 'employees@demo.local');
  await pickEmployee(page, 'Alex', '9173');
  await expect(page.getByTestId('employee-name')).toHaveText('Alex');
  await page.clock.fastForward('04:35');
  await expect(page.getByText(/This device will lock in 30 seconds/)).toBeVisible();
  await page.clock.fastForward('00:40');
  await expect(page).toHaveURL(/\/who\?reason=idle$/);
  await expect(page.getByText(/signed out after a period of inactivity/)).toBeVisible();
  const s = await sql<{ end_reason: string }>(`select end_reason from employee_sessions es join employees e on e.id=es.employee_id where e.display_name='Alex' order by started_at desc limit 1`);
  expect(s[0].end_reason).toBe('idle_timeout');
});

test('16-22: management weekly inventory — offline counting, variance, recount, post', async ({ page, context }) => {
  const errors = watchConsole(page);
  await login(page, 'manager@demo.local');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(/Delivery discrepancy: Sysco invoice #83923/)).toBeVisible();
  await page.goto('/counts');
  await page.getByRole('button', { name: 'START WEEKLY INVENTORY' }).click();
  await expect(page).toHaveURL(/\/counts\/[0-9a-f-]{36}$/);
  const countUrl = page.url();
  await expect(page.getByTestId('area-progress')).toHaveText(/^0 \/ \d+ ITEMS$/);

  // Count every line at its book quantity, except chicken (physical 1 CASE + 4 LB = 44 LB)
  const book = new Map((await sql<{ name: string; q: string }>(`select p.name, coalesce(b.quantity,0) q from products p left join inventory_balances b on b.product_id=p.id and b.location_id=(select id from locations where code='MAIN')`)).map((r) => [r.name, Number(r.q)]));
  const total = Number((await page.getByText(/^Line 1 of (\d+)/).innerText()).match(/of (\d+)/)![1]);
  let wentOffline = false;
  for (let i = 0; i < total; i++) {
    const name = (await page.getByTestId('count-product').innerText()).trim();
    const product = [...book.keys()].find((k) => k.toUpperCase() === name)!;
    if (i === 3 && !wentOffline) {
      // Walk into the freezer: Wi-Fi drops
      await context.setOffline(true);
      wentOffline = true;
    }
    if (product === 'Chicken Breast') {
      await page.getByLabel(`${product} CASE`).fill('1');
      await page.getByLabel(`${product} LB`).fill('4');
      await expect(page.getByTestId('count-total')).toContainText('Total: 44 LB');
    } else {
      const inputs = page.getByLabel(new RegExp(`^${product.replace(/[()]/g, '\\$&')} [A-Z_]+$`));
      await inputs.last().fill(String(book.get(product)));
    }
    if (wentOffline && i === 5) {
      await expect(page.getByTestId('sync-status')).toContainText('OFFLINE — SAVED ON DEVICE');
      // Close/reload the page before the device has synced: nothing may be lost.
      await context.setOffline(false);
      await page.reload();
      await expect(page.getByTestId('sync-status')).toHaveText('SAVED', { timeout: 20_000 });
      const synced = await sql<{ n: string }>(`select count(*) n from inventory_count_revisions where source='offline_sync'`);
      expect(Number(synced[0].n)).toBeGreaterThanOrEqual(3);
      // return to the line we were on
      const prev = page.getByRole('button', { name: 'PREVIOUS', exact: true });
      while (!(await prev.isDisabled())) await prev.click();
      for (let k = 0; k < i; k++) await page.getByRole('button', { name: 'NEXT', exact: true }).click();
    }
    if (i < total - 1) await page.getByRole('button', { name: 'NEXT', exact: true }).click();
  }
  // SAVED must mean saved: check the server immediately after the status says so
  await expect(page.getByTestId('sync-status')).toHaveText('SAVED', { timeout: 20_000 });

  // Every line reached the server exactly once per change, nothing lost
  const counted = await sql<{ n: string; blank: string }>(`select count(*) n, count(*) filter (where counted_qty is null) blank from inventory_count_entries e join inventory_count_sessions s on s.id=e.session_id where s.status='IN_PROGRESS'`);
  expect(Number(counted[0].blank)).toBe(0);
  const offlineSynced = await sql<{ n: string }>(`select count(*) n from inventory_count_revisions where source='offline_sync'`);
  expect(Number(offlineSynced[0].n)).toBeGreaterThan(0);

  // Resume after closing the browser: the count is still there
  await page.goto('/counts');
  await expect(page.getByRole('link', { name: 'CONTINUE INVENTORY' })).toBeVisible();
  await page.goto(countUrl);

  // every line is counted, so no "count blanks as zero?" confirmation appears
  await page.getByRole('button', { name: 'FINISH & REVIEW' }).click();
  await expect(page.getByText(/RECOUNT REQUIRED — 1 item/)).toBeVisible();
  const bookChicken = book.get('Chicken Breast')!;
  await expect(page.getByRole('row', { name: /Chicken Breast/ })).toContainText(`${bookChicken} LB`);
  await expect(page.getByRole('row', { name: /Chicken Breast/ })).toContainText('44 LB');
  // variance value: (44 - book) x $3.20
  const expected = Math.round((44 - bookChicken) * 3.2 * 100) / 100;
  await expect(page.getByRole('row', { name: /Chicken Breast/ })).toContainText(`-$${Math.abs(expected).toFixed(2)}`);

  await page.getByRole('button', { name: 'Recount' }).first().click();
  await page.getByLabel('Verification note').fill('Recounted twice — 44 LB');
  await page.getByRole('button', { name: 'Count is correct' }).click();
  await expect(page.getByText('Ready for review')).toBeVisible();
  await page.getByRole('button', { name: 'Approve count' }).click();
  await expect(page.getByText(/^Approved/)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'POST INVENTORY' }).click();
  await expect(page.getByText(/^Posted/)).toBeVisible();
  expect(await qty('P-CHKBR')).toBe(44);
  const integrity = await sql(`select * from ledger_integrity_check()`);
  expect(integrity).toEqual([]);
  expect(errors).toEqual([]);
});

test('23-25: ordering center vendor buttons open the vendor websites', async ({ page }) => {
  await login(page, 'manager@demo.local');
  await page.goto('/ordering');
  const sysco = page.getByRole('link', { name: 'OPEN SYSCO WEBSITE' });
  await expect(sysco).toHaveAttribute('href', 'https://shop.sysco.com');
  await expect(sysco).toHaveAttribute('target', '_blank');
  await expect(sysco).toHaveAttribute('rel', /noopener/);
  await expect(page.getByRole('link', { name: 'OPEN GRECO WEBSITE' })).toHaveAttribute('href', 'https://www.grecoandsons.com');
  await expect(page.getByRole('link', { name: 'VIEW SUGGESTED ORDER' })).toHaveCount(3); // Sysco, Greco, Commissary
  await expectNoHorizontalOverflow(page);
});

test('28: employee activity report separates Carlos and Maria on the same login', async ({ page }) => {
  await login(page, 'owner1@demo.local');
  await page.goto('/reports/employee-activity?range=today');
  const carlos = page.getByRole('row', { name: /Carlos received Sysco delivery #83923/ });
  await expect(carlos).toContainText('Employee Shared Account');
  await expect(page.getByRole('row', { name: /Maria logged 2 EA Avocado waste/ })).toContainText('Maria');
  const csv = await page.request.get('/api/export/employee-activity?range=today');
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body).toContain('Carlos,Employee Shared Account,receiving.received');
  expect(body).toContain('Maria,Employee Shared Account,waste.logged');
});

test('owner control center shows values derived from data; nothing invented', async ({ page }) => {
  const errors = watchConsole(page);
  await login(page, 'owner1@demo.local');
  await expect(page.getByRole('heading', { name: 'Restaurant control center' })).toBeVisible();
  await expect(page.getByText('Not connected')).toBeVisible();
  const value = (await sql<{ v: string }>(`select round(sum(inventory_value),2) v from inventory_on_hand o join locations l on l.id=o.location_id where l.code='MAIN' and o.is_active`))[0].v;
  await expect(page.getByRole('link', { name: /Inventory value/ })).toContainText(`$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('27: owner sets the company + manager emails; the weekly report includes the invoice photos', async ({ page, request }) => {
  const errors = watchConsole(page);
  await login(page, 'owner1@demo.local');
  await page.goto('/admin/email');
  await expect(page.getByText('Email sending is not set up yet')).toBeVisible();
  for (const [email, name] of [['office@pitaprincess.test', 'Company'], ['manager@pitaprincess.test', 'Manager']]) {
    await page.getByLabel('Recipient email').fill(email);
    await page.getByLabel('Recipient name').fill(name);
    await page.getByRole('button', { name: 'Add recipient' }).click();
    await expect(page.getByText(email)).toBeVisible();
  }
  await page.goto('/admin/email/preview?type=weekly&current=1');
  await expect(page.getByText(/would be attached: .*Sysco-83923-page1\.png/)).toBeVisible();
  await page.goto('/admin/email');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Send this week so far' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved (email sending not set up yet)' })).toBeVisible();
  const row = (await sql<{ recipients: string[]; html: string; attachments: { filename: string }[] }>(`select recipients, html, attachments from email_reports order by created_at desc limit 1`))[0];
  expect(row.recipients).toEqual(['office@pitaprincess.test', 'manager@pitaprincess.test']);
  expect(row.html).toContain('Invoice #83923');
  expect(row.html).toContain('Carlos');
  // the scheduler endpoint rejects callers without the secret
  expect((await request.get('/api/cron/reports')).status()).toBe(401);
  expect((await request.get('/api/cron/reports', { headers: { authorization: 'Bearer wrong-secret-0000000000' } })).status()).toBe(401);
  expect(errors).toEqual([]);
});
