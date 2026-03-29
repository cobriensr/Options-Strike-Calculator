import { test, expect } from '@playwright/test';

test.describe('Parameter Summary', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('displays calculation parameters after valid input', async ({
    page,
  }) => {
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

    // Parameter summary fieldset should be visible
    const params = page.getByRole('group', {
      name: 'Calculation parameters',
    });
    await expect(params).toBeVisible();

    // Should show SPY Spot and SPX values
    await expect(params.getByText('SPY Spot')).toBeVisible();
    await expect(params.getByText('679.00')).toBeVisible();
  });

  test('shows hours left', async ({ page }) => {
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

    const params = page.getByRole('group', {
      name: 'Calculation parameters',
    });
    await expect(params.getByText('Hours Left')).toBeVisible();
  });

  test('shows sigma value', async ({ page }) => {
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

    const params = page.getByRole('group', {
      name: 'Calculation parameters',
    });
    // σ (IV) label
    await expect(params.getByText('\u03C3 (IV)')).toBeVisible();
  });

  test('parameters update when inputs change', async ({ page }) => {
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

    const params = page.getByRole('group', {
      name: 'Calculation parameters',
    });
    await expect(params.getByText('6790')).toBeVisible();

    // Change SPX
    await page.getByLabel(/SPX Price/).fill('6850');
    await expect(params.getByText('6850')).toBeVisible({ timeout: 3000 });
  });
});
