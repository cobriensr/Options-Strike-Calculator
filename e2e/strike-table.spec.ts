import { test, expect, type Page } from '@playwright/test';

async function fillCalculatorInputs(page: Page) {
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

  // Wait for recalculation to complete with fresh values
  await expect(async () => {
    const putText = await page
      .getByRole('table', { name: 'Strike prices by delta' })
      .locator('tbody tr')
      .last()
      .locator('td')
      .nth(2)
      .textContent();
    const callText = await page
      .getByRole('table', { name: 'Strike prices by delta' })
      .locator('tbody tr')
      .last()
      .locator('td')
      .nth(8)
      .textContent();
    const put = Number.parseFloat(putText!);
    const call = Number.parseFloat(callText!);
    expect(put).toBeLessThan(6790);
    expect(call).toBeGreaterThan(6790);
  }).toPass({ timeout: 5000 });
}

/**
 * Tests for the Delta Strikes Table: verifies correct rendering of all
 * delta rows, structural invariants (put < spot < call), and that
 * changing inputs produces expected directional changes in strikes.
 */
test.describe('Delta Strikes Table', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('all six delta rows are rendered', async ({ page }) => {
    await fillCalculatorInputs(page);

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    await expect(table).toBeVisible();

    // All 6 delta targets should appear (use exact match to avoid ambiguity)
    for (const delta of [5, 8, 10, 12, 15, 20]) {
      await expect(
        table.getByText(`${delta}\u0394`, { exact: true }).first(),
      ).toBeVisible();
    }
  });

  test('table has correct column headers', async ({ page }) => {
    await fillCalculatorInputs(page);

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    await expect(table.getByText('Put (SPX)')).toBeVisible();
    await expect(table.getByText('Call (SPX)')).toBeVisible();
    await expect(table.getByText('Width')).toBeVisible();
    await expect(table.getByText('Put $')).toBeVisible();
    await expect(table.getByText('Call $')).toBeVisible();
  });

  test('put strikes are below spot and call strikes are above', async ({
    page,
  }) => {
    await fillCalculatorInputs(page);

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    const rows = table.locator('tbody tr');
    const count = await rows.count();

    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator('td');
      // Column 2 = put strike (snapped), column 8 = call strike (snapped)
      const putText = await cells.nth(2).textContent();
      const callText = await cells.nth(8).textContent();

      const putStrike = Number.parseFloat(putText!);
      const callStrike = Number.parseFloat(callText!);

      expect(putStrike).toBeLessThan(6790);
      expect(callStrike).toBeGreaterThan(6790);
    }
  });

  test('higher delta produces narrower strikes', async ({ page }) => {
    await fillCalculatorInputs(page);

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    const rows = table.locator('tbody tr');

    // First row = 5Δ (widest), last row = 20Δ (narrowest)
    const firstCells = rows.first().locator('td');
    const lastCells = rows.last().locator('td');

    const widePut = Number.parseFloat((await firstCells.nth(2).textContent())!);
    const narrowPut = Number.parseFloat(
      (await lastCells.nth(2).textContent())!,
    );

    // 5Δ put should be further from spot than 20Δ put
    expect(widePut).toBeLessThan(narrowPut);
  });

  test('higher VIX produces wider strikes', async ({ page }) => {
    // Set entry time first
    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('00');
    await page.getByRole('radio', { name: 'AM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    // First: calculate with VIX 15
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('15');

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    await expect(table).toBeVisible({ timeout: 5000 });

    // Wait for VIX=15 calculation to settle
    let lowVixPut = 0;
    await expect(async () => {
      lowVixPut = Number.parseFloat(
        (await table
          .locator('tbody tr')
          .first()
          .locator('td')
          .nth(2)
          .textContent())!,
      );
      // VIX=15 should give a 5Δ put reasonably close to spot (within ~200 points)
      expect(lowVixPut).toBeLessThan(6790);
      expect(lowVixPut).toBeGreaterThan(6590);
    }).toPass({ timeout: 5000 });

    // Now increase VIX
    await page.getByLabel('VIX Value').fill('25');

    // Wait for recalculation with polling
    await expect(async () => {
      const highVixPut = Number.parseFloat(
        (await table
          .locator('tbody tr')
          .first()
          .locator('td')
          .nth(2)
          .textContent())!,
      );
      // Higher VIX = put strike further from spot (lower value)
      expect(highVixPut).toBeLessThan(lowVixPut);
    }).toPass({ timeout: 5000 });
  });

  test('export button is present in iron condor section', async ({ page }) => {
    await fillCalculatorInputs(page);

    await expect(
      page.getByRole('button', { name: 'Export P&L comparison to Excel' }),
    ).toBeVisible();
  });
});
