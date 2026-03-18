import { test, expect, type Page } from '@playwright/test';

async function fillInputs(page: Page, hour: string, ampm: 'AM' | 'PM') {
  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');
  await page.getByLabel('Hour').selectOption(hour);
  await page.getByRole('radio', { name: ampm }).click();
  // Use ET so the time is exactly what we set
  await page.getByRole('radio', { name: 'ET', exact: true }).click();

  await expect(
    page.locator('#results').getByText('All Delta Strikes'),
  ).toBeVisible({ timeout: 5000 });
}

/**
 * E2E tests for IV acceleration indicator.
 * The acceleration multiplier increases as the session progresses,
 * inflating premiums and Greeks for afternoon entries.
 */
test.describe('IV Acceleration', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('no late session warning at market open (10 AM ET)', async ({
    page,
  }) => {
    await fillInputs(page, '10', 'AM');
    await expect(page.getByText(/Late session/)).not.toBeVisible();
  });

  test('shows acceleration indicator for afternoon entry (2 PM ET)', async ({
    page,
  }) => {
    await fillInputs(page, '2', 'PM');

    // At 2 PM ET (2h remaining), mult ≈ 1.12
    await expect(page.getByText(/IV acceleration/)).toBeVisible({
      timeout: 10000,
    });
    // Should show the sigma multiplier value in the indicator
    await expect(page.locator('.font-mono').getByText(/\u00D7/)).toBeVisible();
  });

  test('shows late session warning for 3:30 PM entry', async ({ page }) => {
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('19');
    await page.getByLabel('Hour').selectOption('3');
    await page.getByLabel('Minute').selectOption('30');
    await page.getByRole('radio', { name: 'PM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    await expect(
      page.locator('#results').getByText('All Delta Strikes'),
    ).toBeVisible({ timeout: 10000 });

    // At 3:30 PM (0.5h remaining), mult ≈ 1.56 → should show late session warning
    await expect(page.getByText(/Late session/)).toBeVisible({
      timeout: 10000,
    });
  });

  test('premiums are higher for afternoon entries than morning entries', async ({
    page,
  }) => {
    // Morning entry: 10 AM
    await fillInputs(page, '10', 'AM');

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    const morningPutPremium = Number.parseFloat(
      (await table
        .locator('tbody tr')
        .first()
        .locator('td')
        .nth(4)
        .textContent())!,
    );

    // Afternoon entry: 3 PM
    await page.getByLabel('Hour').selectOption('3');
    await page.getByRole('radio', { name: 'PM' }).click();
    await page.waitForTimeout(400);

    const afternoonPutPremium = Number.parseFloat(
      (await table
        .locator('tbody tr')
        .first()
        .locator('td')
        .nth(4)
        .textContent())!,
    );

    // Afternoon premium should be higher due to IV acceleration
    expect(afternoonPutPremium).toBeGreaterThan(morningPutPremium);
  });
});
