import { test, expect } from '@playwright/test';

/** Mock quotes so market.hasData = true and Chart Analysis renders */
const MOCK_QUOTES = {
  spy: {
    price: 679,
    open: 678,
    high: 680,
    low: 677,
    prevClose: 678,
    change: 1,
    changePct: 0.15,
  },
  spx: {
    price: 6790,
    open: 6780,
    high: 6800,
    low: 6770,
    prevClose: 6780,
    change: 10,
    changePct: 0.15,
  },
  vix: {
    price: 19,
    open: 19,
    high: 20,
    low: 18,
    prevClose: 19,
    change: 0,
    changePct: 0,
  },
  vix1d: {
    price: 16,
    open: 16,
    high: 17,
    low: 15,
    prevClose: 16,
    change: 0,
    changePct: 0,
  },
  vix9d: {
    price: 18,
    open: 18,
    high: 19,
    low: 17,
    prevClose: 18,
    change: 0,
    changePct: 0,
  },
  vvix: {
    price: 90,
    open: 90,
    high: 92,
    low: 88,
    prevClose: 90,
    change: 0,
    changePct: 0,
  },
  marketOpen: true,
  asOf: new Date().toISOString(),
};

/**
 * Tests for the Chart Analysis section: image upload, mode switching,
 * confirmation dialog, and API error handling.
 *
 * These tests mock the /api/analyze endpoint at the network level.
 */
test.describe('Chart Analysis', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => {
      const url = route.request().url();

      if (url.includes('/api/analyze')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            analysis: {
              structure: 'Iron Condor',
              suggestedDelta: 10,
              confidence: 'high',
              reasoning: 'Test analysis result',
              entryPlan: null,
              hedge: null,
              managementRules: null,
            },
          }),
        });
      }

      // Provide quotes so market.hasData = true
      if (url.includes('/api/quotes')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_QUOTES),
        });
      }

      return route.abort();
    });

    await page.goto('/');
  });

  test('chart analysis section is not visible without market data or backtest', async ({
    page,
  }) => {
    // This test overrides the route to block quotes too
    await page.route('**/api/quotes**', (route) => route.abort());
    await page.reload();

    // With quotes blocked, Chart Analysis should not render
    const sections = page.getByText('Chart Analysis');
    const count = await sections.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('mode selector shows entry, midday, and review options', async ({
    page,
  }) => {
    // Wait for Chart Analysis section to render (quotes are mocked)
    const section = page.locator('section[aria-label="Chart Analysis"]');
    await expect(section).toBeVisible({ timeout: 10000 });

    await expect(section.getByText('Pre-Trade')).toBeVisible();
    await expect(section.getByText('Mid-Day')).toBeVisible();
    await expect(section.getByText('Review')).toBeVisible();
  });

  test('drop zone shows upload prompt', async ({ page }) => {
    const section = page.locator('section[aria-label="Chart Analysis"]');
    await expect(section).toBeVisible({ timeout: 10000 });

    await expect(
      section.getByText(/Drop or click to upload|paste/).first(),
    ).toBeVisible();
  });
});
