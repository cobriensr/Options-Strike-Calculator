import { test, expect, type Page } from '@playwright/test';

async function fillInputs(page: Page) {
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
}

/**
 * Cross-section tests: verify that changing one input cascades correctly
 * through strike table, iron condor, parameter summary, and regime sections.
 */
test.describe('Cross-Section Input Cascades', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('changing SPY price updates strike table, iron condor, and parameter summary', async ({
    page,
  }) => {
    await fillInputs(page);

    const results = page.locator('#results');
    const table = page.getByRole('table', { name: 'Strike prices by delta' });

    // Note a strike value from the table before changing SPY
    const initialPut = await table
      .locator('tbody tr')
      .first()
      .locator('td')
      .nth(1)
      .textContent();

    // Clear direct SPX so derived SPX is used, then change SPY to 690
    await page.getByLabel(/SPX Price/).fill('');
    await page.getByLabel('SPY Price').fill('690');
    await page.waitForTimeout(400); // debounce

    // Parameter summary should show the new derived SPX value (690 × 10 = 6900)
    await expect(
      page
        .locator('fieldset[aria-label="Calculation parameters"]')
        .getByText('6900'),
    ).toBeVisible({ timeout: 3000 });

    // Strike values should have changed
    const updatedPut = await table
      .locator('tbody tr')
      .first()
      .locator('td')
      .nth(1)
      .textContent();
    expect(updatedPut).not.toBe(initialPut);

    // Iron condor section should still be visible with updated values
    await expect(results.getByText('Iron Condor').first()).toBeVisible();
  });

  test('changing VIX affects both strikes and regime section', async ({
    page,
  }) => {
    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('00');
    await page.getByRole('radio', { name: 'AM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    // Fill with VIX=15
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('15');

    const results = page.locator('#results');
    await expect(results.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });

    const table = page.getByRole('table', { name: 'Strike prices by delta' });

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
      // VIX=15 should give a put strike reasonably close to spot
      expect(lowVixPut).toBeGreaterThan(6600);
      expect(lowVixPut).toBeLessThan(6790);
    }).toPass({ timeout: 5000 });

    // Note regime section text
    const regimeText = await page
      .getByText(/regime/i)
      .first()
      .textContent();

    // Change VIX to 30
    await page.getByLabel('VIX Value').fill('30');

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
      // Strikes should widen: 5-delta put should be further from spot (lower value)
      expect(highVixPut).toBeLessThan(lowVixPut);
    }).toPass({ timeout: 5000 });

    // Regime section should update (different zone for VIX 30 vs 15)
    const updatedRegimeText = await page
      .getByText(/regime/i)
      .first()
      .textContent();
    // The regime content or zone should differ between VIX 15 and 30
    expect(updatedRegimeText).not.toBe(regimeText);
  });

  test('skew adjustment affects put/call asymmetry', async ({ page }) => {
    await fillInputs(page);

    const table = page.getByRole('table', { name: 'Strike prices by delta' });

    // Read the 10-delta row (third row, index 2) put and call strikes
    const row10d = table.locator('tbody tr').nth(2);

    // Wait for calculation to settle
    let initialPut = 0;
    let initialPutDist = 0;
    await expect(async () => {
      initialPut = Number.parseFloat(
        (await row10d.locator('td').nth(2).textContent())!,
      );
      initialPutDist = 6790 - initialPut;
      expect(initialPutDist).toBeGreaterThan(50);
      expect(initialPutDist).toBeLessThan(300);
    }).toPass({ timeout: 5000 });

    // Change put skew to 5 via range slider
    const slider = page.locator('#skew-slider');
    await slider.fill('5');

    // Wait for recalculation with polling
    await expect(async () => {
      const updatedPut = Number.parseFloat(
        (await row10d.locator('td').nth(2).textContent())!,
      );
      const updatedPutDist = 6790 - updatedPut;
      // Put distance should increase with higher skew
      expect(updatedPutDist).toBeGreaterThan(initialPutDist);
    }).toPass({ timeout: 5000 });
  });

  test('wing width change updates iron condor section', async ({ page }) => {
    await fillInputs(page);

    const results = page.locator('#results');

    // Default should show 20-pt wings
    await expect(results.getByText('20-pt wings')).toBeVisible();

    // Change wing width to 25
    const wingGroup = page.getByRole('radiogroup', {
      name: 'Iron condor wing width',
    });
    await wingGroup.getByRole('radio', { name: '25' }).click();

    // IC section should now show 25-pt wings
    await expect(results.getByText('25-pt wings')).toBeVisible();
  });

  test('contracts change cascades through IC and hedge dollar values', async ({
    page,
  }) => {
    await fillInputs(page);

    const results = page.locator('#results');
    await expect(results.getByText('Iron Condor').first()).toBeVisible();

    // Read the IC section text with default 20 contracts
    const icSection = results.locator(
      'section[aria-label="Strike results for all deltas"]',
    );
    const initialText = await icSection.textContent();

    // Change contracts from 20 to 10
    await page
      .locator('section[aria-label="Advanced"]')
      .getByLabel('Number of contracts')
      .fill('10');

    // Wait for update with polling
    await expect(async () => {
      const updatedText = await icSection.textContent();
      expect(updatedText).not.toBe(initialText);
    }).toPass({ timeout: 5000 });

    // Verify IC section still renders after contract change
    await expect(results.getByText('Iron Condor').first()).toBeVisible();
  });

  test('ET vs CT timezone produces different hours remaining', async ({
    page,
  }) => {
    // Fill inputs first (sets ET by default)
    await fillInputs(page);

    // Switch to CT
    await page.getByRole('radio', { name: 'CT', exact: true }).click();

    const results = page.locator('#results');
    const params = results.getByRole('group', {
      name: 'Calculation parameters',
    });

    // Get hours remaining in CT
    const hoursText = params.getByText(/h$/).first();
    await expect(hoursText).toBeVisible();
    const ctHoursText = await hoursText.textContent();

    // Switch to ET — hours remaining should change (ET is 1 hour ahead)
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    // Wait for the text to actually change rather than relying on a fixed timeout
    await expect(hoursText).not.toHaveText(ctHoursText!, { timeout: 5000 });
  });
});
