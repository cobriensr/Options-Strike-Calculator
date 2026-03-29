import { test, expect, type Page } from '@playwright/test';

async function fillAndWaitForIC(page: Page) {
  await page.getByLabel('Hour').selectOption('10');
  await page.getByLabel('Minute').selectOption('00');
  await page.getByRole('radio', { name: 'AM' }).click();
  await page.getByRole('radio', { name: 'ET', exact: true }).click();

  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');

  // Wait for debounced values to settle and results to reflect filled inputs.
  // The calculator debounces input changes (250 ms), so the first results may
  // still show default values (SPY 572 / SPX 5720). Poll until SPX 6790 appears.
  const results = page.locator('#results');
  await expect(async () => {
    await expect(results.getByText('6790', { exact: false })).toBeVisible();
  }).toPass({ timeout: 10000 });

  // Wait for the P&L profile table to render
  const pnlTable = page.getByRole('table', {
    name: 'Iron condor P&L by delta',
  });
  await expect(pnlTable).toBeVisible({ timeout: 5000 });
  return pnlTable;
}

test.describe('P&L Profile Table', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('P&L table has correct column structure', async ({ page }) => {
    const pnlTable = await fillAndWaitForIC(page);

    const headers = pnlTable.locator('thead th');
    const headerTexts = await headers.allTextContents();

    expect(headerTexts).toEqual([
      'Delta',
      'Side',
      'Credit',
      'Max Loss',
      'Buying Pwr',
      'RoR',
      'PoP',
      'SPX BE',
      'SPY BE',
    ]);
  });

  test('three-row grouping per delta', async ({ page }) => {
    const pnlTable = await fillAndWaitForIC(page);

    // Find all rows in the table body
    const rows = pnlTable.locator('tbody tr');
    const rowCount = await rows.count();

    // Should be a multiple of 3 (each delta has Put Spread, Call Spread, Iron Condor)
    expect(rowCount % 3).toBe(0);
    expect(rowCount).toBeGreaterThanOrEqual(3);

    // Verify the 5-delta group has all three row types
    const allRowTexts = await rows.allTextContents();
    // The delta cell with rowSpan only appears in the first row,
    // so match all 3 rows for the 5-delta group by position.
    // Find the index of the row containing "5Δ"
    const fiveDeltaIndex = allRowTexts.findIndex((text) =>
      text.includes('5\u0394'),
    );
    expect(fiveDeltaIndex).toBeGreaterThanOrEqual(0);

    // The 3 rows for the 5Δ group start at fiveDeltaIndex
    const groupTexts = allRowTexts.slice(fiveDeltaIndex, fiveDeltaIndex + 3);
    expect(groupTexts.some((t) => t.includes('Put Spread'))).toBe(true);
    expect(groupTexts.some((t) => t.includes('Call Spread'))).toBe(true);
    expect(groupTexts.some((t) => t.includes('Iron Condor'))).toBe(true);
  });

  test('RoR values are positive', async ({ page }) => {
    const pnlTable = await fillAndWaitForIC(page);

    // Iron Condor rows contain "Iron Condor" in the Side column
    const icRows = pnlTable.locator('tbody tr').filter({
      hasText: 'Iron Condor',
    });
    const icCount = await icRows.count();
    expect(icCount).toBeGreaterThan(0);

    for (let i = 0; i < icCount; i++) {
      const row = icRows.nth(i);
      // RoR column is the 6th cell (index 5, but Iron Condor rows
      // don't have the Delta cell due to rowSpan, so it's index 4)
      const cells = row.locator('td');
      const cellTexts = await cells.allTextContents();

      // Find the cell containing a percentage that is the RoR value
      // RoR cell has format like "12.3%"
      const rorCell = cellTexts.find(
        (t) => t.match(/^\d+\.\d+%$/) && !t.includes('\n'),
      );
      // If no exact match, look for any cell with a percentage pattern
      const rorText =
        rorCell ?? cellTexts.find((t) => /\d+\.\d+%/.test(t)) ?? '';
      const rorMatch = rorText.match(/(\d+\.\d+)%/);
      expect(rorMatch).not.toBeNull();
      const rorValue = parseFloat(rorMatch![1] ?? '');
      expect(rorValue).toBeGreaterThan(0);
    }
  });

  test('break-even values bracket the spot price', async ({ page }) => {
    const pnlTable = await fillAndWaitForIC(page);
    const spotPrice = 6790;

    // Iron Condor rows show break-even as "low–high" in the SPX BE column.
    // IC rows lack the Delta cell (rowSpan from first row), giving 8 cells:
    // Side, Credit, Max Loss, Buying Pwr, RoR, PoP, SPX BE (idx 6), SPY BE (idx 7)
    const icRows = pnlTable.locator('tbody tr').filter({
      hasText: 'Iron Condor',
    });
    const icCount = await icRows.count();
    expect(icCount).toBeGreaterThan(0);

    for (let i = 0; i < icCount; i++) {
      const row = icRows.nth(i);
      // SPX BE is the second-to-last cell (index 6 of 8)
      const spxBeCell = row.locator('td').nth(6);
      const spxBeText = await spxBeCell.textContent();
      expect(spxBeText).toBeTruthy();

      // SPX BE cell has format "6750–6830" (en-dash separated)
      const beMatch = spxBeText!.match(/(\d+)\u2013(\d+)/);
      expect(beMatch).not.toBeNull();

      const beLow = parseInt(beMatch![1] ?? '', 10);
      const beHigh = parseInt(beMatch![2] ?? '', 10);

      // Low break-even should be below spot, high should be above
      expect(beLow).toBeLessThan(spotPrice);
      expect(beHigh).toBeGreaterThan(spotPrice);
    }
  });

  test('wing width change updates P&L values', async ({ page }) => {
    const pnlTable = await fillAndWaitForIC(page);

    // Capture initial table content
    const initialContent = await pnlTable.textContent();

    // Change wing width from default (20) to 10
    const wingWidthGroup = page.getByRole('radiogroup', {
      name: 'Iron condor wing width',
    });
    await wingWidthGroup.getByText('10', { exact: true }).click();

    // Wait for the table to update
    await page.waitForTimeout(300);

    // Verify the heading now shows 10-pt wings
    const results = page.locator('#results');
    await expect(
      results.getByText('Iron Condor (10-pt wings)'),
    ).toBeVisible();

    // Verify table content changed
    const updatedContent = await pnlTable.textContent();
    expect(updatedContent).not.toBe(initialContent);
  });
});
