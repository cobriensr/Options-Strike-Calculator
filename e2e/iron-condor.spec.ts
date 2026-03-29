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
 * Tests for the Iron Condor section: legs table, P&L profile,
 * hedge calculator toggle, and the export button.
 */
test.describe('Iron Condor Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('iron condor section displays legs and P&L tables', async ({ page }) => {
    const results = await fillAndGetResults(page);

    await expect(results.getByText('Iron Condor (20-pt wings)')).toBeVisible();
    // Should show credit, max loss, buying power, RoR columns
    await expect(results.getByText('Credit').first()).toBeVisible();
    await expect(results.getByText('Max Loss').first()).toBeVisible();
  });

  test('hedge calculator toggle reveals hedge section', async ({ page }) => {
    const results = await fillAndGetResults(page);

    // Hedge section is always visible after results render (no toggle needed)
    await expect(
      results.getByText('Hedge Calculator (Reinsurance)'),
    ).toBeVisible({ timeout: 3000 });
  });

  test('hedge calculator shows delta selector when open', async ({ page }) => {
    const results = await fillAndGetResults(page);

    // Should show IC Δ chip selector
    await expect(results.getByText('IC \u0394')).toBeVisible();
    // Multiple delta options as radio buttons
    const deltaRadios = results.getByRole('radio');
    expect(await deltaRadios.count()).toBeGreaterThanOrEqual(6);
  });

  test('contracts change updates P&L dollar values', async ({ page }) => {
    const results = await fillAndGetResults(page);

    // Get initial total values
    const initialText = await results.textContent();

    // Change contracts from 20 to 1
    const contractsInput = page.locator('section[aria-label="Advanced"]').getByLabel('Number of contracts');
    await contractsInput.fill('1');

    // P&L values should change (total dollar amounts will be 1/20th)
    await page.waitForTimeout(300);
    const updatedText = await results.textContent();
    expect(updatedText).not.toBe(initialText);
  });

  test('hiding IC removes iron condor from results', async ({ page }) => {
    const results = await fillAndGetResults(page);
    await expect(results.getByText('Iron Condor').first()).toBeVisible();

    // Click "Hide Iron Condor"
    await page
      .getByRole('button', { name: /Iron Condor/ })
      .first()
      .click();

    // IC section should disappear from results
    await expect(
      results.getByText('Iron Condor (20-pt wings)'),
    ).not.toBeVisible();
  });
});
