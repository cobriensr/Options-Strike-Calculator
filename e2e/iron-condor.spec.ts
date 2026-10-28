import { test, expect, type Page } from '@playwright/test';
import { fillVix, openSection, setEntryTime } from './helpers/calculator';

async function fillAndGetResults(page: Page) {
  await setEntryTime(page);

  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await fillVix(page, '19');

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
    // One IC Δ chip per delta row (the strike table's rows) plus the
    // four Hedge Δ chips (HEDGE_DELTA_OPTIONS = 1, 2, 3, 5)
    const deltaRows = await results
      .getByRole('table', { name: /^Strike prices by delta/ })
      .locator('tbody tr')
      .count();
    expect(deltaRows).toBeGreaterThan(1);
    await expect(
      results.getByRole('button', { name: /^\d+\u0394$/ }),
    ).toHaveCount(deltaRows + 4);
  });

  test('contracts change updates P&L dollar values', async ({ page }) => {
    const results = await fillAndGetResults(page);

    // Get initial total values
    const initialText = await results.textContent();

    // Change contracts from 20 to 1 (Advanced starts collapsed)
    await openSection(page, 'Advanced');
    const contractsInput = page
      .locator('section[aria-label="Advanced"]')
      .getByLabel('Number of contracts');
    await contractsInput.fill('1');

    // P&L values should change (total dollar amounts will be 1/20th) — poll
    // auto-retries through the debounce until the recalculation lands
    await expect.poll(() => results.textContent()).not.toBe(initialText);
  });

  test('hiding IC removes iron condor from results', async ({ page }) => {
    const results = await fillAndGetResults(page);
    await expect(results.getByText('Iron Condor').first()).toBeVisible();

    // Click "Hide Iron Condor" by its exact name: the results header also
    // has a "Toggle Iron Condor (…)" button
    await page
      .getByRole('button', { name: 'Hide Iron Condor', exact: true })
      .click();

    // IC section should disappear from results
    await expect(
      results.getByText('Iron Condor (20-pt wings)'),
    ).not.toBeVisible();
  });
});
