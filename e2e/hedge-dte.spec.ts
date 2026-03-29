import { test, expect, type Page } from '@playwright/test';

async function fillAndOpenHedge(page: Page) {
  await page.getByLabel('Hour').selectOption('10');
  await page.getByLabel('Minute').selectOption('00');
  await page.getByRole('radio', { name: 'AM' }).click();
  await page.getByRole('radio', { name: 'ET', exact: true }).click();

  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');

  const results = page.locator('#results');
  await expect(results.getByText('All Delta Strikes')).toBeVisible({
    timeout: 5000,
  });

  // Hedge calculator is always visible after results render
  await expect(results.getByText('Hedge Calculator (Reinsurance)')).toBeVisible(
    { timeout: 3000 },
  );

  return results;
}

/**
 * E2E tests for hedge DTE selector and 7-14 DTE extrinsic value display.
 */
test.describe('Hedge DTE', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('hedge section shows DTE selector chips', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    // DTE label
    await expect(results.getByText('DTE', { exact: true })).toBeVisible();
    // Default is 7d
    const chip7d = results.getByRole('radio', { name: '7d' });
    await expect(chip7d).toBeVisible();
    await expect(chip7d).toHaveAttribute('aria-checked', 'true');
  });

  test('DTE options include 1d, 7d, 14d, 21d', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    for (const dte of ['1d', '7d', '14d', '21d']) {
      await expect(
        results.getByRole('radio', { name: dte, exact: true }),
      ).toBeVisible();
    }
  });

  test('selecting 1d DTE hides EOD recovery breakdown', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    // Switch to 1d
    await results.getByRole('radio', { name: '1d', exact: true }).click();

    // 1DTE should not show the recovery breakdown
    await expect(results.getByText(/sell to close at EOD/)).not.toBeVisible();
  });

  test('7d DTE shows EOD recovery breakdown', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    // Default 7d should show recovery
    await expect(results.getByText(/7DTE hedge/)).toBeVisible();
    await expect(
      results.getByText(/sell to close at EOD/).first(),
    ).toBeVisible();
  });

  test('switching to 14d shows 14DTE in recovery text', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    await results.getByRole('radio', { name: '14d' }).click();
    await expect(results.getByText(/14DTE hedge/)).toBeVisible({
      timeout: 2000,
    });
  });

  test('net daily cost label shows for longer-dated hedges', async ({
    page,
  }) => {
    const results = await fillAndOpenHedge(page);

    // With 7d DTE, label should say "Net Daily Cost" (not "Daily Hedge Cost")
    await expect(results.getByText('Net Daily Cost')).toBeVisible();
  });

  test('switching to 1d shows "Daily Hedge Cost" label', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    await results.getByRole('radio', { name: '1d', exact: true }).click();
    await expect(results.getByText('Daily Hedge Cost')).toBeVisible({
      timeout: 2000,
    });
  });

  test('footer mentions DTE and scenario valuation', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    // Footer should mention the hedge DTE
    await expect(
      results.getByText(/7DTE.*Scenario P&L values hedge/i),
    ).toBeVisible();
  });

  test('scenario table toggle works', async ({ page }) => {
    const results = await fillAndOpenHedge(page);

    const toggleBtn = results.getByRole('button', {
      name: /Show.*P&L Scenario Table/,
    });
    await expect(toggleBtn).toBeVisible();

    await toggleBtn.click();
    await expect(results.getByText('Crash Scenarios')).toBeVisible();
    await expect(results.getByText('Rally Scenarios')).toBeVisible();
  });
});
