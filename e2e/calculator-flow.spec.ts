import { test, expect } from '@playwright/test';

test.describe('Calculator Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Block external API calls so the app runs in manual-input mode
    await page.route('**/api/**', (route) => route.abort());

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Strike Calculator');
  });

  test('renders header and core input sections', async ({ page }) => {
    await expect(page.getByText('0DTE Options')).toBeVisible();
    await expect(page.getByLabel('SPY Price')).toBeVisible();
    await expect(page.getByLabel(/SPX Price/)).toBeVisible();
  });

  test('entering SPY price shows derived SPX value', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('672');

    // Wait for debounce and derived SPX display
    await expect(page.getByText('SPX for calculations')).toBeVisible();
    // Default ratio is 10, so SPX ≈ 6720
    await expect(page.getByText('6720')).toBeVisible();
  });

  test('entering SPX directly shows derived ratio', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('672');
    await page.getByLabel(/SPX Price/).fill('6731');

    await expect(page.getByText('Derived ratio')).toBeVisible();
  });

  test('full calculation flow produces strike results', async ({ page }) => {
    // 1. Enter spot price
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');

    // 2. Set VIX (app starts in VIX mode by default)
    await page.getByLabel('VIX Value').fill('19');

    // 3. Entry time defaults are pre-set (10:00 AM CT)
    //    Just verify the time section is visible
    await expect(page.getByText('Entry Time', { exact: true })).toBeVisible();

    // 4. Wait for results to appear (the populated section, not the empty state)
    const resultsSection = page.locator('#results');
    await expect(
      resultsSection.locator(
        'section[aria-label="Strike results for all deltas"]',
      ),
    ).toBeVisible({ timeout: 5000 });

    // 5. Verify parameter summary shows correct inputs
    await expect(resultsSection.getByText('6790')).toBeVisible();

    // 6. Verify strike table has delta rows
    // The table should show deltas: 5, 8, 10, 12, 15, 20
    for (const delta of ['5\u0394', '8\u0394', '10\u0394']) {
      await expect(resultsSection.getByText(delta).first()).toBeVisible();
    }

    // 7. Verify put strikes are below spot and call strikes are above
    //    by checking the results section has both Put and Call headers
    await expect(resultsSection.getByText('Put').first()).toBeVisible();
    await expect(resultsSection.getByText('Call').first()).toBeVisible();
  });

  test('switching to Direct IV mode shows sigma input', async ({ page }) => {
    // Click the "Direct IV" chip
    await page.getByRole('radio', { name: 'Direct IV' }).click();

    await expect(page.getByLabel(/Direct IV/)).toBeVisible();
    await expect(page.getByLabel('VIX (regime only)')).toBeVisible();
  });

  test('direct IV mode calculation produces results', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');

    // Switch to Direct IV mode
    await page.getByRole('radio', { name: 'Direct IV' }).click();
    await page.getByLabel(/Direct IV/).fill('0.2185');
    await page.getByLabel('VIX (regime only)').fill('19');

    // Wait for results
    const resultsSection = page.locator('#results');
    await expect(resultsSection.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });
  });

  test('dark mode toggle works', async ({ page }) => {
    // App defaults to dark mode
    await expect(page.locator('div.dark').first()).toBeVisible();

    // Toggle to light mode
    const toggle = page.getByRole('button', {
      name: 'Switch to light mode',
    });
    await toggle.click();

    // After clicking, the root div should NOT have the "dark" class
    await expect(page.locator('div.dark')).not.toBeAttached();

    // Button label should now say "Dark"
    await expect(
      page.getByRole('button', { name: 'Switch to dark mode' }),
    ).toBeVisible();
  });

  test('iron condor section renders when results are present', async ({
    page,
  }) => {
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('19');

    const resultsSection = page.locator('#results');
    await expect(resultsSection.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });

    // IC section should be visible by default (showIC defaults to true)
    await expect(resultsSection.getByText('Iron Condor').first()).toBeVisible();
  });

  test('VIX regime card appears with valid VIX input', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('19');

    // Regime card should appear within the IV section
    await expect(page.getByText(/regime/i).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('skip to results link is accessible', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: 'Skip to results' });
    await expect(skipLink).toBeAttached();
  });
});
