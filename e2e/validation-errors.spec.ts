import { test, expect } from '@playwright/test';

/**
 * Tests for input validation: invalid prices, out-of-range VIX,
 * and edge cases that should produce error messages.
 */
test.describe('Input Validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('negative SPY price shows error', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('-100');

    await expect(page.getByLabel('SPY Price')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('zero SPY price shows error', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('0');

    await expect(page.getByLabel('SPY Price')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('non-numeric SPY price shows error', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('abc');

    await expect(page.getByLabel('SPY Price')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('negative VIX shows error message', async ({ page }) => {
    await page.getByLabel('VIX Value').fill('-5');

    // Negative VIX triggers an IV error via resolveIV, shown as ErrorMsg text
    await expect(page.getByText('VIX must be a positive number')).toBeVisible();
  });

  test('no results table with empty inputs', async ({ page }) => {
    // The results section shows a placeholder prompt instead of the strike table
    const results = page.locator('#results');
    await expect(
      results.getByText('Fill in the inputs above to calculate strike placement'),
    ).toBeVisible();

    // The actual results section (with the styled border) should not be present
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).not.toBeVisible();
  });

  test('results appear only when all required fields are valid', async ({
    page,
  }) => {
    const results = page.locator('#results');

    // Only SPY — no strike results section yet (just placeholder)
    await page.getByLabel('SPY Price').fill('679');
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).not.toBeVisible();

    // Add VIX — now results should appear
    await page.getByLabel('VIX Value').fill('19');
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test('clearing SPY price removes results', async ({ page }) => {
    // First produce results
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel('VIX Value').fill('19');

    const results = page.locator('#results');
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).toBeVisible({ timeout: 5000 });

    // Clear SPY price
    await page.getByLabel('SPY Price').fill('');
    await page.waitForTimeout(400); // debounce

    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).not.toBeVisible();
  });
});
