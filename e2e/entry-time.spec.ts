import { test, expect } from '@playwright/test';
import {
  meridiemChip,
  selectMeridiem,
  selectTimezone,
  timezoneChip,
} from './helpers/time';
import { expandSection } from './helpers/sections';

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
    // The sidebar nav also renders 'Date & Time' links, so target the
    // section heading specifically to avoid a strict-mode violation.
    await expect(
      page.getByRole('heading', { name: 'Date & Time', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Hour', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Minute', { exact: true })).toBeVisible();
  });

  test('hour and minute selects have correct options', async ({ page }) => {
    const hourSelect = page.getByLabel('Hour', { exact: true });
    // Should have options 01-12
    await expect(hourSelect.locator('option')).toHaveCount(12);

    const minuteSelect = page.getByLabel('Minute', { exact: true });
    // Should have options 00, 05, 10, ..., 55 (12 options at 5-min intervals)
    await expect(minuteSelect.locator('option')).toHaveCount(12);
  });

  test('AM/PM toggle switches between AM and PM', async ({ page }) => {
    // selectMeridiem clicks the chip and asserts aria-pressed="true"
    await selectMeridiem(page, 'PM');
    await expect(meridiemChip(page, 'AM')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await selectMeridiem(page, 'AM');
    await expect(meridiemChip(page, 'PM')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('timezone toggle switches between ET and CT', async ({ page }) => {
    // selectTimezone clicks the chip and asserts aria-pressed="true"
    await selectTimezone(page, 'ET');
    await expect(timezoneChip(page, 'CT')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await selectTimezone(page, 'CT');
    await expect(timezoneChip(page, 'ET')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('changing time updates calculation results', async ({ page }) => {
    await expandSection(page, 'Implied Volatility');
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
    await page.getByLabel('Hour', { exact: true }).selectOption('2');
    await selectMeridiem(page, 'PM');

    // Results should update with different T value
    await expect(results.getByText('All Delta Strikes')).toBeVisible();
    // Hours remaining should be different for 2 PM vs 10 AM
    await expect(paramSummary).not.toHaveText(initialText!);
  });
});
