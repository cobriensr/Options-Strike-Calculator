import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Mirror the repo's a11y scan helper (see a11y-automated.spec.ts): WCAG A/AA,
// drop color-contrast + scrollable-region-focusable (known, intentional), and
// only fail on critical/serious impact.
async function scanA11y(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast', 'scrollable-region-focusable'])
    .analyze();
  const critical = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  for (const v of critical) {
    console.log(
      `[a11y] ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} nodes)`,
    );
  }
  return critical;
}

// E2E runs against the Vite dev server (npm run dev), frontend-only and
// UNAUTHENTICATED — api/** is aborted so the app stays in manual-input mode.
// hasMarketContext = isAuthenticated && hasMarketOrSnapshot, so in this state
// the Options Alerts view renders its GATED message, not the populated panes.
test.describe('Options Alerts view', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
    // Header is shared across views and carries the nav.
    await expect(
      page.getByRole('button', { name: 'Options Alerts', exact: true }),
    ).toBeVisible();
  });

  test('switching to Options Alerts updates hash, landmark, and aria-current', async ({
    page,
  }) => {
    const alertsButton = page.getByRole('button', {
      name: 'Options Alerts',
      exact: true,
    });
    const calculatorButton = page.getByRole('button', {
      name: 'Calculator',
      exact: true,
    });

    // Starts on the calculator view: alerts button is not current.
    await expect(alertsButton).not.toHaveAttribute('aria-current', 'page');

    await alertsButton.click();

    await expect(page).toHaveURL(/#alerts$/);
    await expect(
      page.getByRole('main', { name: /options alerts/i }),
    ).toBeVisible();
    await expect(alertsButton).toHaveAttribute('aria-current', 'page');
    await expect(calculatorButton).not.toHaveAttribute('aria-current', 'page');
  });

  test('unauthenticated alerts view shows the gated message', async ({
    page,
  }) => {
    await page
      .getByRole('button', { name: 'Options Alerts', exact: true })
      .click();

    const alertsMain = page.getByRole('main', { name: /options alerts/i });
    await expect(alertsMain).toBeVisible();

    // Gated copy is the expected e2e state (no auth, no market context).
    await expect(
      alertsMain.getByText(/need live market context/i),
    ).toBeVisible();

    // The populated panes must NOT be present in the gated state.
    await expect(
      page.getByRole('region', { name: 'Lottery Finder alerts' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Silent Boom alerts' }),
    ).toHaveCount(0);
  });

  test('switching back to Calculator clears the hash and restores the calculator', async ({
    page,
  }) => {
    const alertsButton = page.getByRole('button', {
      name: 'Options Alerts',
      exact: true,
    });
    const calculatorButton = page.getByRole('button', {
      name: 'Calculator',
      exact: true,
    });

    await alertsButton.click();
    await expect(page).toHaveURL(/#alerts$/);

    await calculatorButton.click();

    // Hash is cleared (pushState back to pathname + search, no #alerts).
    await expect(page).toHaveURL(/[^#]$/);
    expect(page.url()).not.toContain('#alerts');

    // A calculator-only element is back (the subtitle is not rendered in alerts).
    await expect(
      page.getByText(/Black-Scholes approximation for delta-based strike/i),
    ).toBeVisible();
    await expect(calculatorButton).toHaveAttribute('aria-current', 'page');
    await expect(alertsButton).not.toHaveAttribute('aria-current', 'page');
  });

  test('browser Back returns to the alerts view (popstate)', async ({
    page,
  }) => {
    await page
      .getByRole('button', { name: 'Options Alerts', exact: true })
      .click();
    await expect(page).toHaveURL(/#alerts$/);

    await page.getByRole('button', { name: 'Calculator', exact: true }).click();
    await expect(page.url()).not.toContain('#alerts');

    // Back should land on the alerts view again.
    await page.goBack();
    await expect(page).toHaveURL(/#alerts$/);
    await expect(
      page.getByRole('main', { name: /options alerts/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Options Alerts', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('deep-linking to #alerts loads straight into the alerts view', async ({
    page,
  }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/#alerts');

    await expect(
      page.getByRole('main', { name: /options alerts/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Options Alerts', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(/need live market context/i)).toBeVisible();
  });

  // Axe scans run on Chromium only — Firefox/WebKit report false positives due
  // to rendering differences in how they expose ARIA attributes.
  test('alerts view (gated) has no critical a11y violations', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Chromium only');

    await page
      .getByRole('button', { name: 'Options Alerts', exact: true })
      .click();
    await expect(
      page.getByRole('main', { name: /options alerts/i }),
    ).toBeVisible();

    const violations = await scanA11y(page);
    expect(violations).toEqual([]);
  });
});
