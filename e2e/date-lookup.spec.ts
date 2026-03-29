import { test, expect, type Page } from '@playwright/test';

async function fillCalculatorInputs(page: Page) {
  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');

  await expect(
    page.locator('#results').getByText('All Delta Strikes'),
  ).toBeVisible({ timeout: 5000 });
}

test.describe('Date Lookup Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('date picker is visible after VIX data loads', async ({ page }) => {
    // VIX data loads from static JSON on mount; date picker appears after
    await expect(page.locator('#dt-date-picker')).toBeVisible({
      timeout: 8000,
    });
  });

  test('selecting a date shows VIX OHLC values', async ({ page }) => {
    await expect(page.locator('#dt-date-picker')).toBeVisible({
      timeout: 8000,
    });

    // Pick a known historical date (should be in vix-data.json)
    await page.locator('#dt-date-picker').fill('2025-01-15');

    // OHLC fields should appear within the Date Lookup section
    const ohlcGroup = page.getByRole('group', { name: 'VIX OHLC values' });
    await expect(ohlcGroup).toBeVisible({ timeout: 3000 });
  });

  test('selecting a date populates VIX from historical data', async ({
    page,
  }) => {
    await expect(page.locator('#dt-date-picker')).toBeVisible({
      timeout: 8000,
    });

    // Pick a known historical date
    await page.locator('#dt-date-picker').fill('2025-01-15');

    // VIX field should auto-populate from historical data
    const vixInput = page.getByLabel('VIX Value');
    await expect(vixInput).not.toHaveValue('', { timeout: 3000 });
  });

  test('calculator works with historical date', async ({ page }) => {
    await expect(page.locator('#dt-date-picker')).toBeVisible({
      timeout: 8000,
    });

    // Set a date, then fill the rest
    await page.locator('#dt-date-picker').fill('2025-01-15');
    await fillCalculatorInputs(page);

    // Results should render normally
    await expect(page.getByText('Market Regime')).toBeVisible();
  });
});
