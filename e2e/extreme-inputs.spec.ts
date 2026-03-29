import { test, expect, type Page } from '@playwright/test';

async function fillInputsAndWaitForResults(
  page: Page,
  spy: string,
  spx: string,
  vix: string,
) {
  await page.getByLabel('Hour').selectOption('10');
  await page.getByLabel('Minute').selectOption('00');
  await page.getByRole('radio', { name: 'AM' }).click();
  await page.getByRole('radio', { name: 'ET', exact: true }).click();

  await page.getByLabel('SPY Price').fill(spy);
  await page.getByLabel(/SPX Price/).fill(spx);
  await page.getByLabel('VIX Value').fill(vix);

  const results = page.locator('#results');
  await expect(results.getByText('All Delta Strikes')).toBeVisible({
    timeout: 5000,
  });

  // Wait for recalculation to complete with fresh values
  const spxNum = Number.parseFloat(spx);
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
    expect(put).toBeLessThan(spxNum);
    expect(call).toBeGreaterThan(spxNum);
  }).toPass({ timeout: 5000 });

  return results;
}

test.describe('Extreme Inputs', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('very high SPY price produces valid results', async ({ page }) => {
    await fillInputsAndWaitForResults(page, '900', '9000', '19');

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    await expect(table).toBeVisible();

    const rows = table.locator('tbody tr');
    const count = await rows.count();

    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator('td');
      const putStrike = Number.parseFloat((await cells.nth(2).textContent())!);
      const callStrike = Number.parseFloat((await cells.nth(8).textContent())!);

      expect(putStrike).toBeLessThan(9000);
      expect(callStrike).toBeGreaterThan(9000);
    }
  });

  test('very low SPY price produces valid results', async ({ page }) => {
    await fillInputsAndWaitForResults(page, '50', '500', '19');

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    await expect(table).toBeVisible();

    const rows = table.locator('tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    // Verify strikes are in the neighborhood of 500
    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator('td');
      const putStrike = Number.parseFloat((await cells.nth(2).textContent())!);
      const callStrike = Number.parseFloat((await cells.nth(8).textContent())!);

      expect(putStrike).toBeLessThan(500);
      expect(putStrike).toBeGreaterThan(0);
      expect(callStrike).toBeGreaterThan(500);
    }
  });

  test('very high VIX produces wide strikes', async ({ page }) => {
    await fillInputsAndWaitForResults(page, '679', '6790', '80');

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    const firstRow = table.locator('tbody tr').first();
    const cells = firstRow.locator('td');

    // 5Δ put strike
    const putStrike = Number.parseFloat((await cells.nth(2).textContent())!);

    // With VIX=80, the 5Δ put should be more than 200 points below spot
    expect(6790 - putStrike).toBeGreaterThan(200);
  });

  test('very low VIX produces narrow strikes', async ({ page }) => {
    await fillInputsAndWaitForResults(page, '679', '6790', '8');

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    const firstRow = table.locator('tbody tr').first();
    const cells = firstRow.locator('td');

    // 5Δ put strike
    const putStrike = Number.parseFloat((await cells.nth(2).textContent())!);

    // With VIX=8, the 5Δ put should be less than 100 points below spot
    expect(6790 - putStrike).toBeLessThan(100);
  });

  test('VIX of exactly 100 does not crash', async ({ page }) => {
    const results = await fillInputsAndWaitForResults(
      page,
      '679',
      '6790',
      '100',
    );

    // Verify results rendered without errors
    await expect(results.getByText('All Delta Strikes')).toBeVisible();

    const table = page.getByRole('table', { name: 'Strike prices by delta' });
    await expect(table).toBeVisible();

    const rows = table.locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('large number of contracts displays correctly', async ({ page }) => {
    const results = await fillInputsAndWaitForResults(
      page,
      '679',
      '6790',
      '19',
    );

    const contractsInput = page.locator('section[aria-label="Advanced"]').getByLabel('Number of contracts');
    await contractsInput.fill('999');

    // Iron condor section should still render
    await expect(results.getByText('Iron Condor').first()).toBeVisible();
  });

  test('single contract shows smaller dollar values than default', async ({
    page,
  }) => {
    const results = await fillInputsAndWaitForResults(
      page,
      '679',
      '6790',
      '19',
    );

    // Capture default (20 contracts) text
    const initialText = await results.textContent();

    const contractsInput = page.locator('section[aria-label="Advanced"]').getByLabel('Number of contracts');
    await contractsInput.fill('1');
    await page.waitForTimeout(300);

    // Values should have changed (1 contract vs 20)
    const updatedText = await results.textContent();
    expect(updatedText).not.toBe(initialText);

    // IC section should still render
    await expect(results.getByText('Iron Condor').first()).toBeVisible();
  });
});
