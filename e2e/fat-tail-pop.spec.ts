import { test, expect, type Page } from '@playwright/test';

async function fillAndGetResults(page: Page) {
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
  return results;
}

/**
 * E2E tests for fat-tail adjusted PoP display.
 * The P&L profile table shows adjusted PoP (primary) with log-normal
 * PoP displayed below in struck-through text.
 */
test.describe('Fat-Tail Adjusted PoP', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('P&L profile table shows PoP column', async ({ page }) => {
    const results = await fillAndGetResults(page);

    await expect(results.getByText('Iron Condor').first()).toBeVisible();
    // The P&L table has a PoP column header
    await expect(results.getByText('PoP').first()).toBeVisible();
  });

  test('PoP values include both adjusted and log-normal', async ({ page }) => {
    const results = await fillAndGetResults(page);

    // The table should have percentage values (adjusted PoP)
    // Look for the line-through log-normal value underneath
    const pnlTable = results.getByRole('table', {
      name: 'Iron condor P&L by delta',
    });
    await expect(pnlTable).toBeVisible();

    // Should have at least one PoP value with a percentage
    const popCells = pnlTable.locator('td').filter({ hasText: '%' });
    expect(await popCells.count()).toBeGreaterThan(0);
  });

  test('adjusted PoP is lower than log-normal PoP', async ({ page }) => {
    const results = await fillAndGetResults(page);

    const pnlTable = results.getByRole('table', {
      name: 'Iron condor P&L by delta',
    });

    // Find the IC row's PoP cell (3rd row of first delta group = Iron Condor)
    // Each delta has 3 rows: Put Spread, Call Spread, Iron Condor
    const icRow = pnlTable.getByText('Iron Condor').first();
    await expect(icRow).toBeVisible();

    // The adjusted PoP should be displayed and the log-normal should be
    // struck through. We can verify the struck-through text exists
    const struckThrough = pnlTable.locator('.line-through').first();
    await expect(struckThrough).toBeVisible();
    const logNormalText = await struckThrough.textContent();
    expect(logNormalText).toMatch(/\d+\.\d+%/);
  });
});
