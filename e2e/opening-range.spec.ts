import { test, expect, type Page } from '@playwright/test';

async function fillCalculatorInputs(page: Page) {
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

test.describe('Opening Range Check', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('renders opening range section with inputs', async ({ page }) => {
    await fillCalculatorInputs(page);

    await expect(page.getByText('Opening Range Check')).toBeVisible();
    await expect(page.getByLabel('30-min High')).toBeVisible();
    await expect(page.getByLabel('30-min Low')).toBeVisible();
  });

  test('entering opening range shows range analysis', async ({ page }) => {
    await fillCalculatorInputs(page);

    await page.getByLabel('30-min High').fill('6810');
    await page.getByLabel('30-min Low').fill('6775');

    // Should show range consumption stats
    await expect(page.getByText('Expected Median')).toBeVisible({
      timeout: 3000,
    });
  });

  test('small opening range shows RANGE INTACT signal', async ({ page }) => {
    await fillCalculatorInputs(page);

    // Small range relative to expected daily move
    await page.getByLabel('30-min High').fill('6795');
    await page.getByLabel('30-min Low').fill('6785');

    await expect(page.getByText('RANGE INTACT')).toBeVisible({
      timeout: 3000,
    });
  });

  test('large opening range shows RANGE EXHAUSTED signal', async ({ page }) => {
    await fillCalculatorInputs(page);

    // Large range relative to expected daily move
    await page.getByLabel('30-min High').fill('6850');
    await page.getByLabel('30-min Low').fill('6730');

    await expect(page.getByText('RANGE EXHAUSTED')).toBeVisible({
      timeout: 3000,
    });
  });

  test('displays advice text based on signal', async ({ page }) => {
    await fillCalculatorInputs(page);

    await page.getByLabel('30-min High').fill('6795');
    await page.getByLabel('30-min Low').fill('6785');

    // Green signal advice
    await expect(
      page.getByText(/Good conditions to add positions/),
    ).toBeVisible({ timeout: 3000 });
  });
});
