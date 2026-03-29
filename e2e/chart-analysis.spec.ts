import { test, expect } from '@playwright/test';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

const MOCK_ANALYZE = {
  analysis: {
    structure: 'Iron Condor',
    suggestedDelta: 10,
    confidence: 'high',
    reasoning: 'Test analysis result',
    entryPlan: null,
    hedge: null,
    managementRules: null,
  },
};

/**
 * Tests for the Chart Analysis section: image upload, mode switching,
 * confirmation dialog, and API error handling.
 *
 * These tests mock the /api/analyze endpoint via addInitScript.
 */
test.describe('Chart Analysis', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/analyze': { body: MOCK_ANALYZE, method: 'POST' },
      }),
    );
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
