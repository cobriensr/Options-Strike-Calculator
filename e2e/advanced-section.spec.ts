import { test, expect } from '@playwright/test';
import { chip, fillVix, openSection, setEntryTime } from './helpers/calculator';

/**
 * Tests for the Advanced section: put skew slider, iron condor toggle,
 * wing width selection, and contracts counter.
 */
test.describe('Advanced Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
    // Advanced starts collapsed
    await openSection(page, 'Advanced');
  });

  test('put skew slider displays current value', async ({ page }) => {
    await expect(page.getByText('Put Skew', { exact: true })).toBeVisible();
    // Default skew is 3%
    await expect(page.getByText('+3% put')).toBeVisible();
  });

  test('hide/show iron condor toggle works', async ({ page }) => {
    // Anchored: the results header also has a "Toggle Iron Condor (…)" button
    const toggleBtn = page.getByRole('button', {
      name: /^(Hide|Show) Iron Condor$/,
    });
    await expect(toggleBtn).toHaveText('Hide Iron Condor');

    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('Show Iron Condor');

    // Wing width should be hidden when IC is hidden
    await expect(
      page.locator('section[aria-label="Advanced"]').getByText('Wing Width'),
    ).not.toBeVisible();

    await toggleBtn.click();
    await expect(
      page.locator('section[aria-label="Advanced"]').getByText('Wing Width'),
    ).toBeVisible();
  });

  test('wing width chip selection changes value', async ({ page }) => {
    // Default is 20
    const wingGroup = page.getByRole('group', {
      name: 'Iron condor wing width',
    });
    await expect(wingGroup).toBeVisible();

    // Click 10-pt wing
    await chip(wingGroup, '10').click();
    // The 10 chip should now be active
    await expect(chip(wingGroup, '10')).toHaveAttribute('aria-pressed', 'true');
  });

  test('contracts counter increment and decrement', async ({ page }) => {
    const advanced = page.locator('section[aria-label="Advanced"]');
    const input = advanced.getByLabel('Number of contracts');
    await expect(input).toHaveValue('20'); // default

    await advanced.getByLabel('Increase contracts').click();
    await expect(input).toHaveValue('21');

    await advanced.getByLabel('Decrease contracts').click();
    await advanced.getByLabel('Decrease contracts').click();
    await expect(input).toHaveValue('19');
  });

  test('contracts counter accepts manual input', async ({ page }) => {
    const advanced = page.locator('section[aria-label="Advanced"]');
    const input = advanced.getByLabel('Number of contracts');
    await input.fill('50');
    await expect(input).toHaveValue('50');
  });

  test('changing wing width updates iron condor results', async ({ page }) => {
    await setEntryTime(page);

    // Fill inputs to produce results
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');

    const results = page.locator('#results');
    await expect(results.getByText('Iron Condor').first()).toBeVisible({
      timeout: 10000,
    });

    // Default: 20-pt wings
    await expect(results.getByText('20-pt wings')).toBeVisible({
      timeout: 5000,
    });

    // Switch to 10-pt wings
    const wingGroup = page.getByRole('group', {
      name: 'Iron condor wing width',
    });
    await chip(wingGroup, '10').click();

    await expect(results.getByText('10-pt wings')).toBeVisible();
  });
});
