import { test, expect, type Page } from '@playwright/test';

async function fillCalculatorInputs(page: Page) {
  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');

  await expect(
    page.locator('#results').getByText('All Delta Strikes'),
  ).toBeVisible({ timeout: 5000 });
}

test.describe('Delta Regime Guide', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('renders range thresholds table with VIX input', async ({ page }) => {
    await fillCalculatorInputs(page);

    // The range thresholds table has an aria-label (inside an aria-labelled section)
    const table = page.getByRole('table', {
      name: 'VIX regime range thresholds mapped to delta',
    });
    await expect(table).toBeVisible({ timeout: 10000 });

    // Should show the "To Clear" column header and threshold rows
    await expect(table.getByText('To Clear')).toBeVisible();
    await expect(table.getByText('Median H-L')).toBeVisible();
    await expect(table.getByText('90th H-L')).toBeVisible();
  });

  test('renders delta thresholds table', async ({ page }) => {
    await fillCalculatorInputs(page);

    // The deltas vs thresholds table
    await expect(
      page.getByText('Your Deltas vs. Regime Thresholds'),
    ).toBeVisible();

    const table = page.getByRole('table', {
      name: 'Standard deltas vs VIX regime thresholds',
    });
    await expect(table).toBeVisible();
  });

  test('shows recommendation banner with ceiling deltas', async ({ page }) => {
    await fillCalculatorInputs(page);

    // Recommendation banner mentions "ceilings, not targets"
    await expect(page.getByText(/ceilings, not targets/)).toBeVisible();
  });

  test('range thresholds update when VIX changes', async ({ page }) => {
    await fillCalculatorInputs(page);

    const table = page.getByRole('table', {
      name: 'VIX regime range thresholds mapped to delta',
    });

    // Capture initial "Points" value from the 90th H-L row
    const initialText = await table
      .getByText('90th H-L')
      .locator('..')
      .textContent();

    // Change VIX significantly
    await page.getByLabel('VIX Value').fill('30');
    await page.waitForTimeout(400); // debounce

    // Range should be wider with higher VIX
    const updatedText = await table
      .getByText('90th H-L')
      .locator('..')
      .textContent();
    expect(updatedText).not.toBe(initialText);
  });
});
