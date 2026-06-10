import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * Responsive layout for the Options Alerts view (OptionsAlertsView).
 *
 * The two feed panes (Lottery Finder + Silent Boom) stack vertically below the
 * `xl` breakpoint (1280px) and sit side-by-side at `xl` and wider.
 *
 * The populated panes only mount when `hasMarketContext` is true, i.e.
 * `isAuthenticated && market.hasData`. The Vite dev server reports `import.meta
 * .env.DEV`, so `getAccessMode()` returns 'owner' (authenticated); mocking
 * `/api/quotes` with `marketOpen: true` supplies `market.hasData`. This mirrors
 * the a11y-live-data spec's setup. Without it the view renders its gated
 * message (see options-alerts.spec.ts) and the panes never appear.
 */

// Mirror the repo's a11y scan helper: WCAG A/AA, drop color-contrast +
// scrollable-region-focusable (known, intentional), fail only on
// critical/serious impact.
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

test.describe('Options Alerts responsive layout', () => {
  test.beforeEach(async ({ page }) => {
    // marketOpen: true on the quotes mock gives `market.hasData`, which with
    // the dev-server's owner mode satisfies `hasMarketContext` and mounts the
    // two feed panes instead of the gated message.
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
      }),
    );
  });

  async function gotoAlerts(page: import('@playwright/test').Page) {
    await page.goto('/#alerts');
    await expect(
      page.getByRole('main', { name: /options alerts/i }),
    ).toBeVisible();
    const lottery = page.getByRole('region', { name: 'Lottery Finder alerts' });
    const silentBoom = page.getByRole('region', { name: 'Silent Boom alerts' });
    await expect(lottery).toBeVisible();
    await expect(silentBoom).toBeVisible();
    return { lottery, silentBoom };
  }

  test('panes stack vertically below the xl breakpoint (1024px)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    const { lottery, silentBoom } = await gotoAlerts(page);

    const first = await lottery.boundingBox();
    const second = await silentBoom.boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) return;

    // Both panes must actually have height — guards against a regression
    // where the top pane collapses to ~0px (which would still satisfy the
    // "second below first" check below and pass vacuously).
    expect(first.height).toBeGreaterThan(0);
    expect(second.height).toBeGreaterThan(0);
    // Stacked: Silent Boom begins at (or below) the bottom of Lottery. Allow a
    // small tolerance for sub-pixel border rounding.
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 2);
    // And they share the same x / left edge in the column layout.
    expect(Math.abs(second.x - first.x)).toBeLessThan(2);
    // Each pane is flex-1 of the same column → roughly a 50/50 height split.
    // Within ~15% of each other catches a lopsided collapse the bottom-edge
    // check alone would miss.
    const maxHeight = Math.max(first.height, second.height);
    expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(
      maxHeight * 0.15,
    );
  });

  test('panes sit side-by-side at the xl breakpoint (1440px)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { lottery, silentBoom } = await gotoAlerts(page);

    const first = await lottery.boundingBox();
    const second = await silentBoom.boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) return;

    // Both panes must actually have width — guards against a regression
    // where one pane collapses to ~0px (which would still satisfy the
    // shared-top + "second to the right" checks vacuously).
    expect(first.width).toBeGreaterThan(0);
    expect(second.width).toBeGreaterThan(0);
    // Side-by-side: both panes share the same top edge, and Silent Boom is to
    // the right of Lottery.
    expect(Math.abs(second.y - first.y)).toBeLessThan(2);
    expect(second.x).toBeGreaterThan(first.x);
    // The two columns split the row ~50/50 → widths within ~15% of each
    // other. Catches a collapsed/over-wide pane the x-ordering check misses.
    const maxWidth = Math.max(first.width, second.width);
    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(
      maxWidth * 0.15,
    );
  });

  // Axe scans run on Chromium only — Firefox/WebKit report false positives due
  // to rendering differences in how they expose ARIA attributes.
  test('side-by-side layout has no critical a11y violations', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Chromium only');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAlerts(page);

    const violations = await scanA11y(page);
    expect(violations).toEqual([]);
  });
});
