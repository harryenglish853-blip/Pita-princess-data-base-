import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import { TOAST_WEBHOOK_SECRET } from './tests/e2e/constants';

/**
 * End-to-end tests against a PRODUCTION build (next start) and the local
 * Supabase stack (scripts/local/stack-up.sh). Tests reset and reseed the LOCAL
 * database; they refuse to run against anything else.
 */
const chrome = process.env.CHROME_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const launchOptions = chrome ? { executablePath: chrome } : {};

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions },
  webServer: [
    // stand-in for the Toast API (tests only)
    { command: 'node scripts/local/toast-mock.mjs', url: 'http://127.0.0.1:3999/__mock/reset', reuseExistingServer: true, timeout: 30_000 },
    {
      command: 'npx next start -p 3100',
      url: 'http://localhost:3100/login',
      reuseExistingServer: true,
      timeout: 120_000,
      env: { TOAST_API_URL: 'http://127.0.0.1:3999', TOAST_CLIENT_ID: 'test-client', TOAST_CLIENT_SECRET: 'test-secret',
             TOAST_RESTAURANT_GUID: 'test-restaurant', TOAST_WEBHOOK_SECRET: TOAST_WEBHOOK_SECRET },
    },
  ],
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions } },
    { name: 'tablet', testIgnore: /demo-flow|ordering|commissary|foodcost|toast/, use: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, launchOptions } },
    { name: 'desktop', testIgnore: /demo-flow|ordering|commissary|foodcost|toast/, use: { viewport: { width: 1440, height: 900 }, launchOptions } },
  ],
});
