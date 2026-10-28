/**
 * Shared calculator helpers for the e2e specs.
 *
 * `Chip` (src/components/ui/Chip.tsx) is a toggle button with
 * `aria-pressed`, not a radio, so find it by button role. Several input
 * sections (Advanced, Implied Volatility, Market Regime, ...) render
 * collapsed by default, so open them before reaching for their inputs.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * A `Chip` toggle by its exact label. `exact` matters: a substring match on
 * 'AM' or 'ET' would hit every button whose name contains those letters.
 * Assert its state with `toHaveAttribute('aria-pressed', 'true')`.
 */
export function chip(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/**
 * Expand a collapsible `SectionBox` by its label (its toggle is named
 * "Toggle <label>"). A no-op when the section is already open.
 */
export async function openSection(page: Page, label: string): Promise<void> {
  const toggle = page.getByRole('button', {
    name: `Toggle ${label}`,
    exact: true,
  });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

export interface EntryTime {
  hour?: string;
  minute?: string;
  ampm?: 'AM' | 'PM';
  tz?: 'ET' | 'CT';
}

/**
 * The Date & Time section. Scope entry-time lookups to it: with live data
 * the owner panels add more "Minute" controls (scrubbers) to the page.
 */
export function dateTimeSection(page: Page): Locator {
  return page.getByRole('region', { name: 'Date & Time' });
}

/** Set the Date & Time section's entry time. Defaults to 10:00 AM ET. */
export async function setEntryTime(
  page: Page,
  { hour = '10', minute = '00', ampm = 'AM', tz = 'ET' }: EntryTime = {},
): Promise<void> {
  const section = dateTimeSection(page);
  await section.getByLabel('Hour').selectOption(hour);
  await section.getByLabel('Minute').selectOption(minute);
  await chip(section, ampm).click();
  await chip(section, tz).click();
}

/**
 * Fill the VIX input, opening the (collapsed by default) Implied
 * Volatility section first.
 */
export async function fillVix(page: Page, value: string): Promise<void> {
  await openSection(page, 'Implied Volatility');
  await page.getByLabel('VIX Value').fill(value);
}
