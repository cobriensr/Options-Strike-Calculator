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
    // No test may reach a real database (owner rule, 2026-11-04; spec
    // docs/superpowers/specs/tests-no-db-2026-11-04.md). Vite proxies /api to
    // VITE_API_TARGET, which defaults to a local `vercel dev` on :3000 that
    // is wired to whatever DATABASE_URL the shell has. Point it at a closed
    // port instead, so a request that no spec stubbed is refused. Always
    // start our own server: a dev server already on :5173 would keep the
    // default proxy target.
    reuseExistingServer: false,
    env: { VITE_API_TARGET: 'http://127.0.0.1:9' },
  },
});
