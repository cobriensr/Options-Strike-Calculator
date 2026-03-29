import { test, expect } from '@playwright/test';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

const MOCK_YESTERDAY = {
  yesterday: {
    date: '2026-03-27',
    open: 6780,
    high: 6830,
    low: 6750,
    close: 6800,
    rangePct: 1.18,
    rangePts: 80,
  },
  twoDaysAgo: null,
  asOf: new Date().toISOString(),
};

const MOCK_YESTERDAY_SMALL_RANGE = {
  yesterday: {
    date: '2026-03-27',
    open: 6780,
    high: 6800,
    low: 6766,
    close: 6790,
    rangePct: 0.5,
    rangePts: 34,
  },
  twoDaysAgo: null,
  asOf: new Date().toISOString(),
};

const MOCK_MOVERS = {
  up: [
    {
      symbol: 'NVDA',
      name: 'NVIDIA',
      change: 3.5,
      price: 150,
      volume: 50000000,
    },
    {
      symbol: 'MSFT',
      name: 'Microsoft',
      change: 1.2,
      price: 420,
      volume: 30000000,
    },
  ],
  down: [
    {
      symbol: 'AAPL',
      name: 'Apple',
      change: -2.1,
      price: 200,
      volume: 40000000,
    },
  ],
  analysis: {
    concentrated: true,
    megaCapCount: 2,
    megaCapSymbols: ['NVDA', 'MSFT'],
    bias: 'bullish',
    topUp: {
      symbol: 'NVDA',
      name: 'NVIDIA',
      change: 3.5,
      price: 150,
      volume: 50000000,
    },
    topDown: {
      symbol: 'AAPL',
      name: 'Apple',
      change: -2.1,
      price: 200,
      volume: 40000000,
    },
  },
  marketOpen: true,
  asOf: new Date().toISOString(),
};

/** Empty movers response to prevent computeBreadth crash on fallback `{}`. */
const EMPTY_MOVERS = {
  up: [],
  down: [],
  analysis: {
    concentrated: false,
    megaCapCount: 0,
    megaCapSymbols: [],
    bias: 'mixed' as const,
    topUp: null,
    topDown: null,
  },
  marketOpen: true,
  asOf: new Date().toISOString(),
};

/** Safe empty responses for endpoints we don't need but must not return `{}`. */
const EMPTY_INTRADAY = {
  today: null,
  openingRange: null,
  previousClose: 6780,
  candleCount: 0,
  marketOpen: true,
  asOf: new Date().toISOString(),
};

const EMPTY_EVENTS = {
  events: [],
  startDate: '',
  endDate: '',
  cached: false,
  asOf: new Date().toISOString(),
};

/**
 * Helper: wait for auto-fill from mocked quotes, then set entry time
 * to 10:30 AM so the Market Regime section renders results.
 *
 * Follows the same pattern as market-regime-new.spec.ts.
 */
async function waitForAutoFillAndSetTime(
  page: import('@playwright/test').Page,
) {
  // Wait for auto-fill to populate SPY from mocked quotes
  await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
    timeout: 10000,
  });
  // Auto-fill sets timezone to CT
  await expect(
    page.getByRole('radio', { name: 'CT', exact: true }),
  ).toBeChecked({ timeout: 5000 });

  // Override to a valid market time — auto-fill has finished
  await page.getByLabel('Hour').selectOption('10');
  await page.getByLabel('Minute').selectOption('30');
  await page.getByRole('radio', { name: 'AM' }).click();

  // Wait for calculation results so the Market Regime section expands
  await expect(
    page.locator('#results').getByText('All Delta Strikes'),
  ).toBeVisible({ timeout: 15000 });
}

/**
 * E2E tests for the PreTradeSignals component.
 *
 * PreTradeSignals renders inside MarketRegimeSection when signals
 * can be computed from quotes + yesterday + movers data.
 */
test.describe('Pre-Trade Signals', () => {
  test('RV/IV signal renders with yesterday data — FAIR VALUE', async ({
    page,
  }) => {
    // VIX prevClose=19, yesterdayRangePct=1.18
    // predictedDailyPct = 19 / 15.874 ≈ 1.197
    // ratio = 1.18 / 1.197 ≈ 0.99 → FAIR VALUE (0.8–1.2 range)
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/yesterday': { body: MOCK_YESTERDAY },
        '/api/movers': { body: EMPTY_MOVERS },
        '/api/intraday': { body: EMPTY_INTRADAY },
        '/api/events': { body: EMPTY_EVENTS },
        '/api/chain': { body: { error: 'Unauthorized' }, status: 401 },
      }),
    );
    await page.goto('/');
    await waitForAutoFillAndSetTime(page);

    await expect(page.getByText('Pre-Trade Signals')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Realized vs. Implied Vol')).toBeVisible();
    await expect(page.getByText('FAIR VALUE', { exact: true })).toBeVisible();
  });

  test('PREMIUM RICH signal when yesterday range is small', async ({
    page,
  }) => {
    // VIX prevClose=19, yesterdayRangePct=0.5
    // predictedDailyPct = 19 / 15.874 ≈ 1.197
    // ratio = 0.5 / 1.197 ≈ 0.42 → PREMIUM RICH (< 0.8)
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/yesterday': { body: MOCK_YESTERDAY_SMALL_RANGE },
        '/api/movers': { body: EMPTY_MOVERS },
        '/api/intraday': { body: EMPTY_INTRADAY },
        '/api/events': { body: EMPTY_EVENTS },
        '/api/chain': { body: { error: 'Unauthorized' }, status: 401 },
      }),
    );
    await page.goto('/');
    await waitForAutoFillAndSetTime(page);

    await expect(page.getByText('Pre-Trade Signals')).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByText('PREMIUM RICH', { exact: true }),
    ).toBeVisible();
  });

  test('overnight gap signal renders — FLAT OPEN', async ({ page }) => {
    // MOCK_QUOTES has spx.open=6780 and spx.prevClose=6780
    // gap = 0% → FLAT OPEN (< 0.3%)
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/yesterday': { body: MOCK_YESTERDAY },
        '/api/movers': { body: EMPTY_MOVERS },
        '/api/intraday': { body: EMPTY_INTRADAY },
        '/api/events': { body: EMPTY_EVENTS },
        '/api/chain': { body: { error: 'Unauthorized' }, status: 401 },
      }),
    );
    await page.goto('/');
    await waitForAutoFillAndSetTime(page);

    await expect(page.getByText('Pre-Trade Signals')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Overnight Gap')).toBeVisible();
    await expect(
      page.getByText('FLAT OPEN', { exact: true }),
    ).toBeVisible();
  });

  test('move breadth signal renders with movers data — CONCENTRATED', async ({
    page,
  }) => {
    // MOCK_MOVERS has concentrated=true → CONCENTRATED label
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/yesterday': { body: MOCK_YESTERDAY },
        '/api/movers': { body: MOCK_MOVERS },
        '/api/intraday': { body: EMPTY_INTRADAY },
        '/api/events': { body: EMPTY_EVENTS },
        '/api/chain': { body: { error: 'Unauthorized' }, status: 401 },
      }),
    );
    await page.goto('/');
    await waitForAutoFillAndSetTime(page);

    await expect(page.getByText('Pre-Trade Signals')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText('Move Breadth')).toBeVisible();
    await expect(
      page.getByText('CONCENTRATED', { exact: true }),
    ).toBeVisible();
  });
});
