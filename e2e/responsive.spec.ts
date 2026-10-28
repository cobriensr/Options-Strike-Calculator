import { test, expect } from '@playwright/test';
import { fillVix, openSection } from './helpers/calculator';

/**
 * Tests for responsive behavior: mobile viewport, layout shifts,
 * and that the app remains functional at different screen sizes.
 */
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
    // as a card instead (839f14ff), so nothing has to scroll sideways
    await expect(
      page.getByRole('table', { name: /^Strike prices by delta/ }),
    ).toBeHidden();
    const cards = results.locator('div[aria-label="Delta strikes"]');
    await expect(cards).toBeVisible();
    await expect(cards.getByText('5\u0394', { exact: true })).toBeVisible();
  });

  test('renders correctly on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 }); // iPad
    await page.goto('/');

    await expect(page.locator('h1')).toHaveText('Strike Calculator');
    await page.getByLabel('SPY Price').fill('679');
    await fillVix(page, '19');

    await expect(
      page.locator('#results').getByText('All Delta Strikes'),
    ).toBeVisible({ timeout: 5000 });
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
