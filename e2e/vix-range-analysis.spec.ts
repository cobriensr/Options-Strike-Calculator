import { test, expect, type Page } from '@playwright/test';

/**
 * Fill core calculator inputs manually to produce results and
 * render the VIXRangeAnalysis component within Market Regime.
 */
async function fillCalculatorInputs(page: Page) {
  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');
  await page.getByLabel('Hour').selectOption('10');
  await page.getByLabel('Minute').selectOption('00');
  await page.getByRole('radio', { name: 'AM' }).click();
  await page.getByRole('radio', { name: 'ET', exact: true }).click();

  // Wait for results to render, proving the calculator ran
  await expect(
    page.locator('#results').getByText('All Delta Strikes'),
  ).toBeVisible({ timeout: 5000 });
}

/**
 * Tests for the VIXRangeAnalysis component rendered inside the
 * Market Regime section. All tests use manual input mode with
 * API calls blocked.
 */
test.describe('VIX Range Analysis', () => {
  test.beforeEach(async ({ page }) => {
    // Block all API calls so the app runs in manual-input mode
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
    await fillCalculatorInputs(page);
  });

  test('renders range table with VIX input', async ({ page }) => {
    // The VIX range table should be visible within Market Regime
    const rangeTable = page.locator(
      'table[aria-label="SPX daily range statistics by VIX level"]',
    );
    await expect(rangeTable).toBeVisible({ timeout: 5000 });

    // Verify the table has expected column headers
    await expect(
      rangeTable.getByRole('columnheader', { name: 'VIX', exact: true }),
    ).toBeVisible();
    await expect(
      rangeTable.getByRole('columnheader', { name: 'Med H-L' }),
    ).toBeVisible();
    await expect(
      rangeTable.getByRole('columnheader', { name: '90th H-L' }),
    ).toBeVisible();
  });

  test('active VIX bucket is highlighted', async ({ page }) => {
    // With VIX=19, the 18-20 bucket should be highlighted.
    // The active row gets border-l-[3px] with a non-transparent border color
    // and shows a "current" badge.
    const rangeTable = page.locator(
      'table[aria-label="SPX daily range statistics by VIX level"]',
    );
    await expect(rangeTable).toBeVisible({ timeout: 5000 });

    // Find the active row by the "current" badge it displays
    const activeRow = rangeTable.locator('tr', { hasText: 'current' });
    await expect(activeRow).toBeVisible();

    // Verify it is the 18-20 bucket
    await expect(activeRow).toContainText('18');

    // Verify the row has a colored left border (non-transparent)
    const borderColor = await activeRow.evaluate(
      (el) => getComputedStyle(el).borderLeftColor,
    );
    // A non-transparent border will NOT be 'rgba(0, 0, 0, 0)' or 'transparent'
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(borderColor).not.toBe('transparent');
  });

  test('survive/settle toggle switches table data', async ({ page }) => {
    // The survival heatmap table should be visible
    const survivalTable = page.locator(
      'table[aria-label*="Iron condor survival rates"]',
    );
    await expect(survivalTable).toBeVisible({ timeout: 5000 });

    // Default mode is "settle" -- verify Settlement chip is active
    const settleChip = page.getByRole('radio', {
      name: /Settlement/,
    });
    await expect(settleChip).toHaveAttribute('aria-checked', 'true');

    // Click Intraday chip to switch
    const intradayChip = page.getByRole('radio', {
      name: /Intraday/,
    });
    await intradayChip.click();

    // The Intraday chip should now be active
    await expect(intradayChip).toHaveAttribute('aria-checked', 'true');
    await expect(settleChip).toHaveAttribute('aria-checked', 'false');

    // The table aria-label should now reflect intraday mode
    await expect(
      page.locator('table[aria-label="Iron condor survival rates (intraday)"]'),
    ).toBeVisible();
  });

  test('fine-grained breakdown toggle shows bars', async ({ page }) => {
    // The fine-grained section should not be visible initially
    const fineSection = page.locator(
      'section[aria-label="Fine-grained VIX bars"]',
    );
    await expect(fineSection).not.toBeVisible();

    // Click the toggle button to show fine-grained breakdown
    const toggleBtn = page.getByRole('button', {
      name: /Point-by-Point VIX Breakdown/,
    });
    await expect(toggleBtn).toBeVisible({ timeout: 5000 });
    await toggleBtn.click();

    // The FineGrainedBars section should now be visible
    await expect(fineSection).toBeVisible({ timeout: 3000 });

    // Verify the fine-grained table has content
    const fineTable = page.locator(
      'table[aria-label="Fine-grained VIX range breakdown"]',
    );
    await expect(fineTable).toBeVisible();

    // Click again to hide
    await toggleBtn.click();
    await expect(fineSection).not.toBeVisible();
  });
});
