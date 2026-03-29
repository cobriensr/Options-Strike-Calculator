import { test, expect, type Page } from '@playwright/test';

async function fillCalculatorInputs(page: Page) {
  // Set explicit entry time to avoid wall-clock dependency
  await page.getByLabel('Hour').selectOption('10');
  await page.getByLabel('Minute').selectOption('00');
  await page.getByRole('radio', { name: 'AM' }).click();
  await page.getByRole('radio', { name: 'ET', exact: true }).click();

  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');

  await expect(
    page.locator('#results').getByText('All Delta Strikes'),
  ).toBeVisible({ timeout: 5000 });
}

/**
 * Tests for error recovery and resilience: verifying the app handles
 * invalid input sequences gracefully and returns to a clean state.
 */
test.describe('Error Recovery', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('app recovers gracefully from invalid input sequences', async ({
    page,
  }) => {
    // 1. Enter valid data and get results
    await fillCalculatorInputs(page);
    const results = page.locator('#results');
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).toBeVisible();

    // 2. Enter invalid VIX (negative) — should show error, not crash
    await page.getByLabel('VIX Value').fill('-5');
    await expect(page.getByText('VIX must be a positive number')).toBeVisible();

    // 3. App should still be interactive — fix the input
    await page.getByLabel('VIX Value').fill('19');
    await expect(
      page.getByText('VIX must be a positive number'),
    ).not.toBeVisible({ timeout: 3000 });

    // 4. Results should reappear with valid input
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).toBeVisible({ timeout: 5000 });
  });

  test('clearing all inputs returns to empty state', async ({ page }) => {
    // 1. Fill in valid data and verify results
    await fillCalculatorInputs(page);
    const results = page.locator('#results');
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).toBeVisible();

    // 2. Clear all inputs
    await page.getByLabel('SPY Price').fill('');
    await page.getByLabel(/SPX Price/).fill('');
    await page.getByLabel('VIX Value').fill('');

    // 3. Wait for debounce
    await page.waitForTimeout(400);

    // 4. Results section should show the empty state prompt
    await expect(page.getByText(/Fill in the inputs above/)).toBeVisible();

    // 5. Strike table should not be visible
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).not.toBeVisible();
  });

  test('rapid input changes do not crash the app', async ({ page }) => {
    // Set entry time first
    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('00');
    await page.getByRole('radio', { name: 'AM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    const spyInput = page.getByLabel('SPY Price');
    const vixInput = page.getByLabel('VIX Value');

    // Rapidly change inputs without waiting for debounce
    for (const spy of ['600', '650', '700', '750', '679']) {
      await spyInput.fill(spy);
    }
    for (const vix of ['10', '25', '40', '15', '19']) {
      await vixInput.fill(vix);
    }

    await page.getByLabel(/SPX Price/).fill('6790');

    // App should settle and produce valid results
    const results = page.locator('#results');
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).toBeVisible({ timeout: 10000 });

    // No crash: header still present
    await expect(page.locator('h1')).toHaveText('Strike Calculator');
  });

  test('switching IV modes preserves app stability', async ({ page }) => {
    await fillCalculatorInputs(page);

    // Switch to Direct IV mode
    await page.getByRole('radio', { name: 'Direct IV' }).click();
    await expect(
      page.getByRole('textbox', { name: /Direct IV/ }),
    ).toBeVisible();

    // Switch back to VIX mode
    await page.getByRole('radio', { name: 'VIX' }).click();
    await expect(page.getByLabel('VIX Value')).toBeVisible();

    // Re-enter VIX and verify results still work
    await page.getByLabel('VIX Value').fill('19');
    const results = page.locator('#results');
    await expect(
      results.locator('section[aria-label="Strike results for all deltas"]'),
    ).toBeVisible({ timeout: 5000 });
  });
});
