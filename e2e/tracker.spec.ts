/**
 * E2E spec for the Contract Tracker section.
 *
 * Mocks all /api/tracker/* routes inline so the spec is hermetic. The
 * 5-min cron tick is simulated by adjusting the mocked /api/tracker/
 * alerts/unread response between polls; the 30s poll interval is the
 * real wall-clock interval (Playwright's default test timeout is 30s
 * so we use `test.setTimeout` for the polling test).
 *
 * Auth: the section is gated behind `isAuthenticated`. Access mode is
 * derived synchronously from `document.cookie` + `import.meta.env.DEV`
 * in `src/utils/auth.ts` — there is no `/api/whoami` fetch to stub.
 * Playwright runs against the Vite dev server, where `getAccessMode()`
 * short-circuits to `'owner'`. The `sc-hint` cookie is set as
 * belt-and-suspenders in case a future change runs e2e against a
 * production build.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

interface TrackerContractFixture {
  id: number;
  occ_symbol: string;
  ticker: string;
  expiry: string;
  strike: string;
  side: 'C' | 'P';
  direction: 'long' | 'short';
  entry_price: string;
  quantity: number;
  notes: string | null;
  status: 'active' | 'closed' | 'expired';
  closed_at: string | null;
  closed_price: string | null;
  up_thresholds: string[] | null;
  down_thresholds: string[] | null;
  spot_alerts: { op: string; level: number }[] | null;
  created_at: string;
  updated_at: string;
  latest_last: string | null;
  latest_bid: string | null;
  latest_ask: string | null;
  latest_underlying: string | null;
  latest_fetched_at: string | null;
}

function makeContract(
  over: Partial<TrackerContractFixture> = {},
): TrackerContractFixture {
  return {
    id: 42,
    occ_symbol: 'NVDA  260522P00225000',
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: '225',
    side: 'P',
    direction: 'long',
    entry_price: '4.30',
    quantity: 5,
    notes: 'whale flow',
    status: 'active',
    closed_at: null,
    closed_price: null,
    up_thresholds: null,
    down_thresholds: null,
    spot_alerts: null,
    created_at: '2026-05-17T15:00:00Z',
    updated_at: '2026-05-17T15:00:00Z',
    latest_last: '4.30',
    latest_bid: '4.25',
    latest_ask: '4.35',
    latest_underlying: '225.10',
    latest_fetched_at: '2026-05-17T15:05:00Z',
    ...over,
  };
}

interface MockState {
  contracts: TrackerContractFixture[];
  alerts: Array<{
    id: number;
    contract_id: number;
    fired_at: string;
    alert_type: 'up_pct' | 'down_pct' | 'spot_level' | 'dte_7';
    threshold: string;
    price_at_fire: string | null;
    underlying_at_fire: string | null;
    acknowledged: boolean;
    occ_symbol: string;
    ticker: string;
    expiry: string;
    strike: string;
    side: 'C' | 'P';
    direction: 'long' | 'short';
    entry_price: string;
    quantity: number;
    contract_status: 'active' | 'closed' | 'expired';
  }>;
}

async function installTrackerMocks(page: Page, state: MockState) {
  await page.route('**/api/tracker/contracts**', async (route: Route) => {
    const url = new URL(route.request().url());
    const status = url.searchParams.get('status') ?? 'active';
    const method = route.request().method();
    if (method === 'GET') {
      const filtered = state.contracts.filter((c) =>
        status === 'active' ? c.status === 'active' : c.status !== 'active',
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ contracts: filtered, count: filtered.length }),
      });
      return;
    }
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<
        string,
        unknown
      >;
      const created = makeContract({
        id: state.contracts.length + 100,
        ticker: String(body.ticker ?? 'NVDA').toUpperCase(),
        strike: String(body.strike ?? '225'),
        expiry: String(body.expiry ?? '2026-05-22'),
        side: (body.side ?? 'C') as 'C' | 'P',
        direction: (body.direction ?? 'long') as 'long' | 'short',
        entry_price: String(body.entry_price ?? '4.30'),
        quantity: Number(body.quantity ?? 1),
      });
      state.contracts.push(created);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ contract: created }),
      });
      return;
    }
    await route.fulfill({ status: 405 });
  });

  await page.route('**/api/tracker/contracts/*', async (route: Route) => {
    const url = new URL(route.request().url());
    const idStr = url.pathname.split('/').at(-1);
    const id = Number(idStr);
    const method = route.request().method();
    if (method === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<
        string,
        unknown
      >;
      const idx = state.contracts.findIndex((c) => c.id === id);
      if (idx === -1) {
        await route.fulfill({ status: 404 });
        return;
      }
      const updated = {
        ...state.contracts[idx]!,
        ...(body.status === 'closed'
          ? {
              status: 'closed' as const,
              closed_at: new Date().toISOString(),
              closed_price: String(body.closed_price),
            }
          : {}),
      };
      state.contracts[idx] = updated;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ contract: updated }),
      });
      return;
    }
    await route.fulfill({ status: 405 });
  });

  await page.route('**/api/tracker/alerts/unread', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        alerts: state.alerts.filter((a) => !a.acknowledged),
        count: state.alerts.filter((a) => !a.acknowledged).length,
      }),
    });
  });

  await page.route('**/api/tracker/alerts/*/ack', async (route: Route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
  });
}

test.describe('Contract Tracker', () => {
  test.beforeEach(async ({ context, page }) => {
    // Seed `sc-hint` so a non-DEV build would still resolve owner mode.
    // Under `vite dev` this is redundant (DEV short-circuits) but keeps
    // the spec robust to future build-target changes.
    await context.addCookies([
      {
        name: 'sc-hint',
        value: '1',
        url: 'http://localhost:5173',
        sameSite: 'Strict',
      },
    ]);
    // Explicit routes table. Auth probe → owner. Tracker → tracker
    // mocks (installed per-test). Everything else → abort so the rest
    // of the app doesn't 500 during the section gate render.
    await page.route('**/api/auth/whoami', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'owner' }),
      }),
    );
    await page.route('**/api/**', (route) => {
      const url = route.request().url();
      if (url.includes('/api/tracker/')) return route.fallback();
      if (url.includes('/api/auth/whoami')) return route.fallback();
      return route.abort();
    });
  });

  test('renders the Active tab with a fetched contract row', async ({
    page,
  }) => {
    const state: MockState = {
      contracts: [makeContract()],
      alerts: [],
    };
    await installTrackerMocks(page, state);
    await page.goto('/');

    // Vite dev server short-circuits `getAccessMode()` to `'owner'`
    // (src/utils/auth.ts), and the beforeEach seeds `sc-hint` for prod
    // builds. The section must render — no conditional skip.
    const section = page.getByRole('region', { name: 'Contract Tracker' });
    await expect(section).toBeVisible({ timeout: 10000 });
    await section
      .getByRole('button', { name: /Toggle Contract Tracker/i })
      .click();
    await expect(section.getByText('NVDA')).toBeVisible({ timeout: 5000 });
    await expect(section.getByText('225P 05/22')).toBeVisible();
  });

  test('opens add-contract modal and submits a structured form', async ({
    page,
  }) => {
    const state: MockState = { contracts: [], alerts: [] };
    await installTrackerMocks(page, state);
    await page.goto('/');

    const section = page.getByRole('region', { name: 'Contract Tracker' });
    await expect(section).toBeVisible({ timeout: 10000 });
    await section
      .getByRole('button', { name: /Toggle Contract Tracker/i })
      .click();
    await section.getByRole('button', { name: /Add new contract/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/Ticker/i).fill('AMD');
    await dialog.getByLabel(/Expiry/i).fill('2026-06-20');
    await dialog.getByLabel(/Strike/i).fill('200');
    await dialog.getByLabel(/Entry price/i).fill('2.50');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(section.getByText('AMD')).toBeVisible({ timeout: 5000 });
  });
});
