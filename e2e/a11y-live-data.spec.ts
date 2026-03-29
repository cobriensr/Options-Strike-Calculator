import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

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

const MOCK_MOVERS = {
  up: [
    { symbol: 'AAPL', description: 'Apple Inc', change: 2.5, volume: 1000000 },
  ],
  down: [
    { symbol: 'TSLA', description: 'Tesla Inc', change: -3.1, volume: 800000 },
  ],
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
    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('00');
    await page.getByRole('radio', { name: 'AM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    // Wait for live-data components to render (Term Structure appears when
    // VIX is set, which auto-fill handles from mock quotes)
    await expect(page.getByText('Term Structure', { exact: true })).toBeVisible(
      { timeout: 10000 },
    );

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

    // Wait for Chart Analysis section to appear (requires hasData = true)
    const section = page.locator('section[aria-label="Chart Analysis"]');
    await expect(section).toBeVisible({ timeout: 15000 });

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

    // Find the tooltip trigger button (the "?" button for 0DTE adjustment)
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
