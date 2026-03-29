import { test, expect } from '@playwright/test';

test.describe('Keyboard Navigation & Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  // WebKit on macOS doesn't Tab-focus links by default (system-level setting)
  test('skip to results link is keyboard accessible', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'WebKit/macOS does not Tab-focus links by default',
    );
    const skipLink = page.getByRole('link', { name: 'Skip to results' });

    // The skip link starts off-screen
    await expect(skipLink).toBeAttached();

    // Press Tab to focus the skip link (it should be the first focusable element)
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();

    // On focus, the link moves on-screen (left changes from -9999px)
    const left = await skipLink.evaluate((el) => getComputedStyle(el).left);
    expect(left).toBe('0px');

    // Pressing Enter navigates to #results
    await page.keyboard.press('Enter');
    const url = page.url();
    expect(url).toContain('#results');
  });

  test('tab order flows through all input sections', async ({ page }) => {
    // Tab past the skip link first
    await page.keyboard.press('Tab');
    // Skip link is focused; tab again to move into inputs
    await page.keyboard.press('Tab');

    // Collect ids/labels of focused elements as we tab through
    // Use 40 tabs to cover date picker + radio chips + inputs
    const focusedElements: string[] = [];
    for (let i = 0; i < 40; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return '__none__';
        return (
          el.getAttribute('aria-label') ||
          el.getAttribute('id') ||
          el.tagName.toLowerCase()
        );
      });
      focusedElements.push(info);
      await page.keyboard.press('Tab');
    }

    // Verify key inputs are reachable and SPY comes before SPX
    const spyIndex = focusedElements.indexOf('spot-price');
    const spxIndex = focusedElements.indexOf('spx-direct');

    expect(spyIndex).toBeGreaterThanOrEqual(0);
    expect(spxIndex).toBeGreaterThan(spyIndex);
  });

  test('theme toggle is keyboard accessible', async ({ page }) => {
    // App defaults to dark mode
    await expect(page.locator('html.dark')).toBeAttached();

    // Tab to the theme toggle button (switch to light mode)
    const toggle = page.getByRole('button', {
      name: /switch to light mode/i,
    });
    await toggle.focus();
    await expect(toggle).toBeFocused();

    // Press Enter to activate light mode
    await page.keyboard.press('Enter');
    await expect(page.locator('html.dark')).not.toBeAttached();
  });

  test('radio chips respond to keyboard', async ({ page }) => {
    // The AM/PM radio group in the Entry Time section
    const amRadio = page.getByRole('radio', { name: 'AM' });
    const pmRadio = page.getByRole('radio', { name: 'PM' });

    // Explicitly click AM first (don't assume default)
    await amRadio.click();
    await expect(amRadio).toHaveAttribute('aria-checked', 'true');
    await expect(pmRadio).toHaveAttribute('aria-checked', 'false');

    // Click PM to select it via keyboard simulation
    await pmRadio.focus();
    await page.keyboard.press('Enter');
    await expect(pmRadio).toHaveAttribute('aria-checked', 'true');
    await expect(amRadio).toHaveAttribute('aria-checked', 'false');

    // Click AM back
    await amRadio.focus();
    await page.keyboard.press('Enter');
    await expect(amRadio).toHaveAttribute('aria-checked', 'true');
    await expect(pmRadio).toHaveAttribute('aria-checked', 'false');
  });

  test('input fields have proper labels', async ({ page }) => {
    // All of these should be findable via getByLabel, which verifies
    // that the inputs have proper associated labels
    await expect(page.getByLabel('SPY Price')).toBeVisible();
    await expect(page.getByLabel(/SPX Price/)).toBeVisible();
    await expect(page.getByLabel('VIX Value')).toBeVisible();
    await expect(page.getByLabel('Hour')).toBeAttached();
    await expect(page.getByLabel('Minute')).toBeAttached();
    await expect(page.locator('section[aria-label="Advanced"]').getByLabel('Number of contracts')).toBeVisible();
  });

  test('error states have aria-invalid', async ({ page }) => {
    const spyInput = page.getByLabel('SPY Price');

    // Fill with invalid negative value
    await spyInput.fill('-100');
    await expect(spyInput).toHaveAttribute('aria-invalid', 'true');

    // Fill with valid value — aria-invalid should become "false" after debounce
    await spyInput.fill('679');
    await expect(spyInput).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('results section has proper ARIA landmarks', async ({ page }) => {
    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('00');
    await page.getByRole('radio', { name: 'AM' }).click();
    await page.getByRole('radio', { name: 'ET', exact: true }).click();

    // Fill in valid inputs to produce results
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await page.getByLabel('VIX Value').fill('19');

    // Wait for results
    const resultsSection = page.locator('#results');
    await expect(resultsSection.getByText('All Delta Strikes')).toBeVisible({
      timeout: 5000,
    });

    // Verify the strike table has role="table" and an aria-label
    const strikeTable = resultsSection.locator(
      'table[role="table"][aria-label="Strike prices by delta"]',
    );
    await expect(strikeTable).toBeVisible();
    await expect(strikeTable).toHaveAttribute(
      'aria-label',
      'Strike prices by delta',
    );
  });
});
