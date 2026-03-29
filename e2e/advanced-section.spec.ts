import { test, expect } from '@playwright/test';

/**
 * Tests for the Advanced section: put skew slider, iron condor toggle,
 * wing width selection, and contracts counter.
 */
test.describe('Advanced Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('put skew slider displays current value', async ({ page }) => {
    await expect(page.getByText('Put Skew', { exact: true })).toBeVisible();
    // Default skew is 3%
    await expect(page.getByText('+3% put')).toBeVisible();
  });

  test('hide/show iron condor toggle works', async ({ page }) => {
    const toggleBtn = page.getByRole('button', { name: /Iron Condor/ });
    await expect(toggleBtn).toHaveText('Hide Iron Condor');

    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('Show Iron Condor');

    // Wing width should be hidden when IC is hidden
    await expect(page.locator('section[aria-label="Advanced"]').getByText('Wing Width')).not.toBeVisible();

    await toggleBtn.click();
    await expect(page.locator('section[aria-label="Advanced"]').getByText('Wing Width')).toBeVisible();
  });

  test('wing width chip selection changes value', async ({ page }) => {
    // Default is 20
    const wingGroup = page.getByRole('radiogroup', {
      name: 'Iron condor wing width',
    });
    await expect(wingGroup).toBeVisible();

    // Click 10-pt wing
    await wingGroup.getByRole('radio', { name: '10', exact: true }).click();
    // The 10 chip should now be active
    await expect(
      wingGroup.getByRole('radio', { name: '10', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
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
    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('00');
    await page.getByRole('radio', { name: 'AM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    // Fill inputs to produce results
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('19');

    const results = page.locator('#results');
    await expect(results.getByText('Iron Condor').first()).toBeVisible({
      timeout: 10000,
    });

    // Default: 20-pt wings
    await expect(results.getByText('20-pt wings')).toBeVisible({
      timeout: 5000,
    });

    // Switch to 10-pt wings
    const wingGroup = page.getByRole('radiogroup', {
      name: 'Iron condor wing width',
    });
    await wingGroup.getByRole('radio', { name: '10' }).click();

    await expect(results.getByText('10-pt wings')).toBeVisible();
  });
});
