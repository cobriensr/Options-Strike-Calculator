import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openSection, setEntryTime } from './helpers/calculator';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';
import type { MoversResponse } from '../src/types/api';

const MOCK_YESTERDAY = {
  yesterday: {
    date: '2026-03-27',
    open: 6750,
    high: 6810,
    low: 6720,
    close: 6780,
    rangePct: 1.33,
    rangePts: 90,
  },
  twoDaysAgo: null,
  asOf: '2026-03-28T08:00:00Z',
};

// Typed against the API so the fixture can't drift: the old one had no
// `analysis`, which crashes Pre-Trade Signals once Market Regime is open.
const AAPL = {
  symbol: 'AAPL',
  name: 'Apple Inc',
  change: 2.5,
  price: 200,
  volume: 1000000,
};
const TSLA = {
  symbol: 'TSLA',
  name: 'Tesla Inc',
  change: -3.1,
  price: 250,
  volume: 800000,
};
const MOCK_MOVERS: MoversResponse = {
  up: [AAPL],
  down: [TSLA],
  analysis: {
    concentrated: false,
    megaCapCount: 1,
    megaCapSymbols: ['AAPL'],
    bias: 'mixed',
    topUp: AAPL,
    topDown: TSLA,
  },
  marketOpen: true,
  asOf: new Date().toISOString(),
};

async function scanA11y(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast', 'scrollable-region-focusable'])
    .analyze();
  const critical = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  for (const v of critical) {
    console.log(
      `[a11y] ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} nodes)`,
    );
  }
  return critical;
}

test.describe('Accessibility with Live Data', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

  test('live data page has no critical a11y violations', async ({ page }) => {
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/yesterday': { body: MOCK_YESTERDAY },
        '/api/movers': { body: MOCK_MOVERS },
      }),
    );
    await page.goto('/');

    // Wait for auto-fill to populate inputs from mocked quotes.
    // When VIX1D is present, auto-fill switches to Direct IV mode.
    await expect(page.getByLabel('SPY Price')).toHaveValue('679.00', {
      timeout: 10000,
    });

    // Set explicit entry time so results render regardless of wall-clock
    await setEntryTime(page);

    // Open the sections that start collapsed, so the scan covers their
    // live-data content, not just their headers
    for (const label of [
      'Implied Volatility',
      'Advanced',
      'Risk Calculator',
      'Market Regime',
      'Chart Analysis',
    ]) {
      await openSection(page, label);
    }

    // Wait for live-data components to render: Term Structure (IV section)
    // appears when VIX is set, which auto-fill handles from mock quotes, and
    // Pre-Trade Signals (Market Regime) reads the mocked movers
    await expect(page.getByText('Term Structure', { exact: true })).toBeVisible(
      { timeout: 10000 },
    );
    await expect(page.getByText('Move Breadth')).toBeVisible();

    const violations = await scanA11y(page);
    expect(violations).toEqual([]);
  });

  test('chart analysis section has no a11y violations', async ({ page }) => {
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/yesterday': { body: MOCK_YESTERDAY },
        '/api/movers': { body: MOCK_MOVERS },
      }),
    );
    await page.goto('/');

    // Wait for Chart Analysis section to appear (requires hasData = true),
    // then open it: collapsed, it renders only its header
    const section = page.locator('section[aria-label="Chart Analysis"]');
    await expect(section).toBeVisible({ timeout: 15000 });
    await openSection(page, 'Chart Analysis');
    await expect(section.getByText('Pre-Trade')).toBeVisible();
    await expect(
      section.getByText(/Drop or click to upload|paste/).first(),
    ).toBeVisible();

    // Run axe scan scoped to the chart analysis section
    const results = await new AxeBuilder({ page })
      .include('section[aria-label="Chart Analysis"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast', 'scrollable-region-focusable'])
      .analyze();

    const critical = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    for (const v of critical) {
      console.log(
        `[a11y] ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} nodes)`,
      );
    }
    expect(critical).toEqual([]);
  });

  test('IVTooltip is keyboard dismissible', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');

    // Find the tooltip trigger button (the "?" button for 0DTE adjustment),
    // in the collapsed-by-default IV section
    await openSection(page, 'Implied Volatility');
    const tooltipTrigger = page.getByRole('button', {
      name: 'What is the 0DTE adjustment?',
    });
    await expect(tooltipTrigger).toBeVisible();

    // Click to open the tooltip
    await tooltipTrigger.click();

    // Verify tooltip appears with correct role and id
    const tooltip = page.locator('#adj-tooltip-content[role="tooltip"]');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('0DTE IV Adjustment');

    // Press Escape to dismiss
    await page.keyboard.press('Escape');
    await expect(tooltip).not.toBeVisible();
  });
});
