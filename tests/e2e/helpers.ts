import { execSync } from 'node:child_process';
import { expect, type Page, type ConsoleMessage } from '@playwright/test';
import { Client } from 'pg';

export const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';
export const DB = process.env.LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export function resetDemo() {
  if (!/@(127\.0\.0\.1|localhost):/.test(DB)) throw new Error('E2E tests only run against the local database.');
  execSync('./scripts/local/db-reset.sh && npx tsx scripts/seed-demo.ts', { stdio: 'pipe' });
}

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Collects console errors and page errors; assert none at the end of a test. */
export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' && !/Failed to load resource: net::ERR_INTERNET_DISCONNECTED|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

export async function pickEmployee(page: Page, name: string, pin: string) {
  await expect(page.getByRole('heading', { name: 'WHO ARE YOU?' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${name.charAt(0)}\\s*${name}`) }).click();
  for (const d of pin) await page.getByRole('button', { name: `Digit ${d}` }).click();
  await page.getByRole('button', { name: 'CONTINUE' }).click();
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `page ${page.url()} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
}
