import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function scanA11y(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast', 'scrollable-region-focusable'])
    .analyze();
  const critical = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  // Log details for debugging cross-browser differences
  for (const v of critical) {
    console.log(
      `[a11y] ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} nodes)`,
    );
  }
  return critical;
}

// Axe scans run on Chromium only — Firefox/WebKit report false positives
// due to rendering differences in how they expose ARIA attributes.
test.describe('Automated Accessibility Scanning', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');
  test('home page has no critical a11y violations', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');

    const violations = await scanA11y(page);
    expect(violations).toEqual([]);
  });

  test('results section has no a11y violations', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');

    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('00');
    await page.getByRole('radio', { name: 'AM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('19');

    const resultsSection = page.locator('#results');
    await expect(resultsSection.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });

    const violations = await scanA11y(page);
    expect(violations).toEqual([]);
  });

  test('dark mode has no a11y violations', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');

    // App defaults to dark mode — verify it's active
    await expect(page.locator('html.dark')).toBeAttached();

    const violations = await scanA11y(page);
    expect(violations).toEqual([]);
  });
});
