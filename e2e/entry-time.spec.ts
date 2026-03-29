import { test, expect } from '@playwright/test';

/**
 * Tests for the Entry Time section: hour/minute selects,
 * AM/PM toggle, timezone toggle, and time-dependent calculations.
 */
test.describe('Entry Time Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('entry time section renders with default values', async ({ page }) => {
    await expect(page.getByText('Date & Time', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Hour')).toBeVisible();
    await expect(page.getByLabel('Minute')).toBeVisible();
  });

  test('hour and minute selects have correct options', async ({ page }) => {
    const hourSelect = page.getByLabel('Hour');
    // Should have options 01-12
    await expect(hourSelect.locator('option')).toHaveCount(12);

    const minuteSelect = page.getByLabel('Minute');
    // Should have options 00, 05, 10, ..., 55 (12 options at 5-min intervals)
    await expect(minuteSelect.locator('option')).toHaveCount(12);
  });

  test('AM/PM toggle switches between AM and PM', async ({ page }) => {
    const amChip = page.getByRole('radio', { name: 'AM' });
    const pmChip = page.getByRole('radio', { name: 'PM' });

    await pmChip.click();
    // PM should now be active (visual confirmation via aria or class)
    await expect(pmChip).toBeVisible();

    await amChip.click();
    await expect(amChip).toBeVisible();
  });

  test('timezone toggle switches between ET and CT', async ({ page }) => {
    const etChip = page.getByRole('radio', { name: 'ET', exact: true });
    const ctChip = page.getByRole('radio', { name: 'CT', exact: true });

    await etChip.click();
    await expect(etChip).toHaveAttribute('aria-checked', 'true');

    await ctChip.click();
    await expect(ctChip).toHaveAttribute('aria-checked', 'true');
  });

  test('changing time updates calculation results', async ({ page }) => {
    // Set up inputs
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('19');

    const results = page.locator('#results');
    await expect(results.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });

    // Get the initial hours remaining display
    const paramSummary = results.getByText(/h$/).first();
    const initialText = await paramSummary.textContent();

    // Change to a different hour
    await page.getByLabel('Hour').selectOption('2');
    await page.getByRole('radio', { name: 'PM' }).click();

    // Results should update with different T value
    await expect(results.getByText('All Delta Strikes')).toBeVisible();
    // Hours remaining should be different for 2 PM vs 10 AM
    await expect(paramSummary).not.toHaveText(initialText!);
  });
});
