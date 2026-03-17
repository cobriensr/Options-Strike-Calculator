import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';

async function fillAndGetResults(page: Page) {
  await page.getByLabel('SPY Price').fill('679');
  await page.getByLabel(/SPX Price/).fill('6790');
  await page.getByLabel('VIX Value').fill('19');
  const results = page.locator('#results');
  await expect(results.getByText('All Delta Strikes')).toBeVisible({
    timeout: 5000,
  });
  return results;
}

test.describe('Export Download', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Strike Calculator');
  });

  test('export button triggers file download with .xlsx extension', async ({
    page,
  }) => {
    await fillAndGetResults(page);

    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export P&L comparison to Excel' })
      .click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test('downloaded file has non-zero size', async ({ page }) => {
    await fillAndGetResults(page);

    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export P&L comparison to Excel' })
      .click();
    const download = await downloadPromise;

    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const stats = fs.statSync(filePath!);
    expect(stats.size).toBeGreaterThan(0);
  });

  test('export filename contains date', async ({ page }) => {
    await fillAndGetResults(page);

    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export P&L comparison to Excel' })
      .click();
    const download = await downloadPromise;

    // Expect a date-like pattern (e.g. 2026-03-17 or 20260317)
    expect(download.suggestedFilename()).toMatch(/\d{4}[-_]?\d{2}[-_]?\d{2}/);
  });
});
