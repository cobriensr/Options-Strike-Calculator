import { test, expect } from '@playwright/test';

test.describe('Theme Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
  });

  test('dark mode persists across page reload', async ({ page }) => {
    // Clear localStorage so default dark mode kicks in
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('darkMode'));
    await page.reload();

    // App defaults to dark mode
    await expect(page.locator('div.dark')).toBeAttached();
    await expect(
      page.getByRole('button', { name: /switch to light mode/i }),
    ).toBeVisible();

    // Reload the page
    await page.reload();

    // Verify dark mode persisted
    await expect(page.locator('div.dark')).toBeAttached();
    await expect(
      page.getByRole('button', { name: /switch to light mode/i }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('button', { name: /switch to light mode/i })
        .locator('span'),
    ).toHaveText('Light');
  });

  test('light mode persists across page reload', async ({ page }) => {
    await page.goto('/');

    // App starts in dark mode — toggle to light
    const toggleToLight = page.getByRole('button', {
      name: /switch to light mode/i,
    });
    await toggleToLight.click();
    await expect(page.locator('div.dark')).not.toBeAttached();

    // Reload the page
    await page.reload();

    // Verify light mode persisted — no dark class
    await expect(page.locator('div.dark')).not.toBeAttached();
    await expect(
      page.getByRole('button', { name: /switch to dark mode/i }),
    ).toBeVisible();
  });

  test('theme toggle applies correct CSS class', async ({ page }) => {
    await page.goto('/');

    // App defaults to dark mode
    await expect(page.locator('div.dark')).toBeAttached();

    // Toggle to light mode
    await page.getByRole('button', { name: /switch to light mode/i }).click();
    await expect(page.locator('div.dark')).not.toBeAttached();

    // Toggle back to dark mode
    await page.getByRole('button', { name: /switch to dark mode/i }).click();
    await expect(page.locator('div.dark')).toBeAttached();
  });
});
