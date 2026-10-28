import { test, expect, type Page } from '@playwright/test';
import { fillVix, openSection, setEntryTime } from './helpers/calculator';

async function fillCalculatorInputs(page: Page) {
  await setEntryTime(page);

  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await fillVix(page, '19');

  await expect(
    page.locator('#results').getByText('All Delta Strikes'),
  ).toBeVisible({ timeout: 5000 });
  // Market Regime starts collapsed
  await openSection(page, 'Market Regime');
}

/**
 * E2E tests for new Market Regime features (manual input mode).
 */
test.describe('Market Regime — Manual Input', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('market regime section renders with VIX input', async ({ page }) => {
    await fillCalculatorInputs(page);
    await expect(
      page.getByRole('region', { name: 'Market Regime' }),
    ).toBeVisible();
    await expect(
      page.getByText(/Historical VIX-to-SPX range correlation/),
    ).toBeVisible();
  });

  test('hide/show analysis toggle works', async ({ page }) => {
    await fillCalculatorInputs(page);

    const hideBtn = page.getByRole('button', { name: 'Hide Analysis' });
    await expect(hideBtn).toBeVisible();
    await hideBtn.click();

    await expect(
      page.getByRole('button', { name: 'Show Analysis' }),
    ).toBeVisible();
  });

  test('volatility clustering section renders with yesterday data', async ({
    page,
  }) => {
    await fillCalculatorInputs(page);

    await expect(
      page.getByText('Volatility Clustering', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Yesterday Open')).toBeVisible();
    await expect(page.getByLabel('Yesterday High')).toBeVisible();
    await expect(page.getByLabel('Yesterday Low')).toBeVisible();
  });

  test('entering yesterday data shows clustering signal and multiplier', async ({
    page,
  }) => {
    await fillCalculatorInputs(page);

    await page.getByLabel('Yesterday Open').fill('6780');
    await page.getByLabel('Yesterday High').fill('6830');
    await page.getByLabel('Yesterday Low').fill('6750');

    await expect(page.getByText(/Today.*Multiplier/i)).toBeVisible({
      timeout: 3000,
    });
  });

  test('VIX term structure section renders with VIX1D input', async ({
    page,
  }) => {
    await fillCalculatorInputs(page);

    await expect(
      page.getByText('Term Structure', { exact: true }),
    ).toBeVisible();

    await page.getByLabel(/VIX1D/).fill('17');
    await page.getByLabel(/VIX9D/).fill('20');

    await expect(page.getByText('VIX1D / VIX')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('VIX9D / VIX')).toBeVisible();
  });
});
