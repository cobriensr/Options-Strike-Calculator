/**
 * E2E helpers for the Date & Time section's AM/PM and ET/CT toggles.
 *
 * The chips are rendered by `src/components/ui/Chip.tsx` as
 * `<button type="button" aria-pressed aria-label={label}>` toggles — NOT
 * `role="radio"` / `aria-checked` (that markup was replaced on 2026-04-04,
 * commit ae2c1c7a). Every spec must go through these helpers so a future
 * markup change only needs to be fixed in one place.
 *
 * Usage:
 *   await selectMeridiem(page, 'AM');
 *   await selectTimezone(page, 'ET');
 *   await expectTimezone(page, 'CT', { timeout: 5000 }); // auto-fill sets CT
 */
import { expect, type Locator, type Page } from '@playwright/test';

export type Meridiem = 'AM' | 'PM';
export type TimezoneChipLabel = 'ET' | 'CT';

/** Locate the AM or PM toggle chip. */
export function meridiemChip(page: Page, meridiem: Meridiem): Locator {
  return page.getByRole('button', { name: meridiem, exact: true });
}

/** Locate the ET or CT toggle chip. */
export function timezoneChip(page: Page, tz: TimezoneChipLabel): Locator {
  return page.getByRole('button', { name: tz, exact: true });
}

/** Assert the given meridiem chip is the pressed (active) one. */
export async function expectMeridiem(
  page: Page,
  meridiem: Meridiem,
  opts: { timeout?: number } = {},
): Promise<void> {
  await expect(meridiemChip(page, meridiem)).toHaveAttribute(
    'aria-pressed',
    'true',
    opts,
  );
}

/** Assert the given timezone chip is the pressed (active) one. */
export async function expectTimezone(
  page: Page,
  tz: TimezoneChipLabel,
  opts: { timeout?: number } = {},
): Promise<void> {
  await expect(timezoneChip(page, tz)).toHaveAttribute(
    'aria-pressed',
    'true',
    opts,
  );
}

/** Click the AM or PM chip and wait until it reports `aria-pressed="true"`. */
export async function selectMeridiem(
  page: Page,
  meridiem: Meridiem,
): Promise<void> {
  await meridiemChip(page, meridiem).click();
  await expectMeridiem(page, meridiem);
}

/** Click the ET or CT chip and wait until it reports `aria-pressed="true"`. */
export async function selectTimezone(
  page: Page,
  tz: TimezoneChipLabel,
): Promise<void> {
  await timezoneChip(page, tz).click();
  await expectTimezone(page, tz);
}
