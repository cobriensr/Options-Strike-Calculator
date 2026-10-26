import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  workers: isCI ? 1 : undefined,
  // CI: stop once 10 tests have failed every retry, so a broken suite goes
  // red in minutes instead of running into the job timeout. `list` prints
  // each test name and error to the job log; `html` is the uploaded report.
  maxFailures: isCI ? 10 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'html',
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !isCI,
  },
});
