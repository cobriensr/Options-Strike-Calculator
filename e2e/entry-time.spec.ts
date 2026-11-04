import { test, expect } from '@playwright/test';
import { chip, fillVix } from './helpers/calculator';

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
    await expect(
      page.getByRole('region', { name: 'Date & Time' }),
    ).toBeVisible();
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
    const amChip = chip(page, 'AM');
    const pmChip = chip(page, 'PM');

    await pmChip.click();
    await expect(pmChip).toHaveAttribute('aria-pressed', 'true');
    await expect(amChip).toHaveAttribute('aria-pressed', 'false');

    await amChip.click();
    await expect(amChip).toHaveAttribute('aria-pressed', 'true');
    await expect(pmChip).toHaveAttribute('aria-pressed', 'false');
  });

  test('timezone toggle switches between ET and CT', async ({ page }) => {
    const etChip = chip(page, 'ET');
    const ctChip = chip(page, 'CT');

    await etChip.click();
    await expect(etChip).toHaveAttribute('aria-pressed', 'true');

    await ctChip.click();
    await expect(ctChip).toHaveAttribute('aria-pressed', 'true');
    await expect(etChip).toHaveAttribute('aria-pressed', 'false');
  });
});

/**
 * The entry time seeds from the CT wall clock during market hours and falls
 * back to 10:00 AM CT outside them (src/hooks/useTimeInputs.ts). A test that
 * assumes a starting time therefore has to pin the browser clock before the
 * page loads. This one used to assume 10 AM, then select 2 PM and expect the
 * hours remaining to change; CI ran it at 2:01 PM CT, the start was already
 * 2 PM, nothing changed and it failed on every market day in the 2 PM hour.
 * Each case picks a target that differs from its seeded start, including the
 * 2 PM hour itself. 2026-06-17 is a Wednesday and CDT is UTC-5.
 */
const SEEDED_STARTS = [
  {
    name: 'before the target hour (10:00 AM CT)',
    now: '2026-06-17T15:00:00Z',
    start: { hour: '10', ampm: 'AM' },
    target: { hour: '2', ampm: 'PM' },
  },
  {
    name: 'inside the 2 PM CT hour (2:10 PM CT, the CI failure)',
    now: '2026-06-17T19:10:00Z',
    start: { hour: '2', ampm: 'PM' },
    target: { hour: '10', ampm: 'AM' },
  },
  {
    name: 'outside market hours (8:00 PM CT, falls back to 10:00 AM CT)',
    now: '2026-06-18T01:00:00Z',
    start: { hour: '10', ampm: 'AM' },
    target: { hour: '2', ampm: 'PM' },
  },
] as const;

test.describe('Entry Time: changing the time updates the results', () => {
  for (const { name, now, start, target } of SEEDED_STARTS) {
    test(`from the seeded start ${name}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(now));
      await page.route('**/api/**', (route) => route.abort());
      await page.goto('/');

      // The pinned clock must have seeded the start this case assumes.
      await expect(page.getByLabel('Hour')).toHaveValue(start.hour);
      await expect(chip(page, start.ampm)).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      await page.getByLabel('SPY Price').fill('679');
      await page.getByLabel(/SPX Price/).fill('6790');
      await fillVix(page, '19');

      const results = page.locator('#results');
      await expect(results.getByText('All Delta Strikes')).toBeVisible({
        timeout: 5000,
      });

      // Get the initial hours remaining display
      const paramSummary = results.getByText(/h$/).first();
      const initialText = await paramSummary.textContent();

      // Change to a different time of day
      await page.getByLabel('Hour').selectOption(target.hour);
      await chip(page, target.ampm).click();

      // Results should update with different T value
      await expect(results.getByText('All Delta Strikes')).toBeVisible();
      await expect(paramSummary).not.toHaveText(initialText!);
    });
  }
});
