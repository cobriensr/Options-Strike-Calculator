import { test, expect, type Page } from '@playwright/test';
import { dateTimeSection, fillVix, openSection } from './helpers/calculator';

/**
 * Tests for responsive behavior: mobile viewport, layout shifts,
 * and that the app remains functional at different screen sizes.
 */

/** The page doesn't scroll sideways: its width fits the viewport. */
async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test.describe('Responsive Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
  });

  test('renders correctly on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 }); // iPhone X
    await page.goto('/');

    await expect(page.locator('h1')).toHaveText('Strike Calculator');
    await expect(page.getByLabel('SPY Price')).toBeVisible();
    await openSection(page, 'Implied Volatility');
    await expect(page.getByLabel('VIX Value')).toBeVisible();

    // A past trading day puts the header in backtest mode whatever time
    // the suite runs, and the aborted /api/history adds NO INTRADAY. The
    // header's controls scroll sideways inside their own row with the
    // status pills sorted first, so the pills stay fully on screen.
    await dateTimeSection(page)
      .getByLabel('Date', { exact: true })
      .fill('2025-01-15');
    const header = page.getByRole('banner');
    await expect(header.getByText('BACKTEST')).toBeInViewport({ ratio: 1 });
    await expect(header.getByText('NO INTRADAY')).toBeInViewport({
      ratio: 1,
    });

    // Two rows used to scroll the page sideways: the header's
    // view/status/tool row (949px wide in owner mode) and the lazy Futures
    // panel's picker + Now + Refresh row, so wait for that panel first.
    await expect(
      page.getByRole('region', { name: 'Futures', exact: true }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('calculation works on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');

    const results = page.locator('#results');
    await expect(results.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });
  });

  test('strike table becomes delta cards on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');

    const results = page.locator('#results');
    await expect(results.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });

    // Below md the 14-column table is hidden and each delta row renders
    // as a card instead (839f14ff), so the strikes don't scroll sideways
    await expect(
      page.getByRole('table', { name: /^Strike prices by delta/ }),
    ).toBeHidden();
    const cards = results.locator('div[aria-label="Delta strikes"]');
    await expect(cards).toBeVisible();
    await expect(cards.getByText('5\u0394', { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('renders correctly on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 }); // iPad
    await page.goto('/');

    await expect(page.locator('h1')).toHaveText('Strike Calculator');
    await page.getByLabel('SPY Price').fill('679');
    await fillVix(page, '19');

    const results = page.locator('#results');
    await expect(results.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });

    // From md up the full table shows instead of the cards, inside
    // ScrollHint's horizontal scroller (table > section > overflow div)
    const table = page.getByRole('table', { name: /^Strike prices by delta/ });
    await expect(table).toBeVisible();
    await expect(
      results.locator('div[aria-label="Delta strikes"]'),
    ).toBeHidden();
    await expect(table.locator('xpath=../..')).toHaveCSS('overflow-x', 'auto');
  });

  test('renders correctly on wide desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');

    await expect(page.locator('h1')).toHaveText('Strike Calculator');
    // Content should be constrained to max-w-[660px]
    const container = page.locator('[class*="max-w-"]').first();
    await expect(container).toBeVisible();
    const maxWidth = await container.evaluate(
      (el) => getComputedStyle(el).maxWidth,
    );
    expect(maxWidth).toBe('1152px');
  });
});
