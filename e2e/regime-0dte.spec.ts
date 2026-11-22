/**
 * Regime0dte panel — Phase 4 Playwright coverage for the "0DTE Gamma Regime"
 * section (plan: docs/superpowers/plans/2026-06-07-regime-0dte-panel.md, Task 11).
 *
 * The panel is owner-or-guest (the panel registry leaves it out for a public
 * visitor), but the e2e dev server resolves every visitor as owner
 * (`getAccessMode()` is 'owner' under `import.meta.env.DEV`), so it renders on
 * a plain `/` load with the backend APIs aborted. The browser clock is pinned
 * to a moment the market is CLOSED, so the live hook's window is shut and the
 * panel renders a closed placeholder rather than the four sub-viz, whatever
 * time the suite really runs (the nightly e2e runs after the close). The
 * placeholder says which closed it is: "waiting for the open" on a weekend,
 * "closed for the day" after the close of a trading day. These tests therefore
 * assert the section landmark + the closed-market placeholders — NOT the live
 * visuals — plus an axe-core a11y scan scoped to the section.
 *
 * The panel is wrapped in a SectionBox, which emits
 * `<section aria-label="0DTE Gamma Regime">`. We target that landmark with a
 * role/label selector (semantic, resilient to styling changes) rather than a
 * CSS class. Pattern mirrors e2e/vega-spike-feed.spec.ts and
 * e2e/a11y-automated.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const SECTION_LABEL = '0DTE Gamma Regime';

/** Saturday 12:00 CT (CDT is UTC-5): no session. */
const SATURDAY = '2026-06-06T17:00:00Z';
/** Friday 16:00 CT, an hour after the 15:00 close of a trading day. */
const FRIDAY_AFTER_CLOSE = '2026-06-05T21:00:00Z';

/** Open the app with the browser clock frozen at `now`. */
async function openAt(page: Page, now: string) {
  await page.clock.setFixedTime(new Date(now));
  await page.goto('/');
}

test.describe('0DTE Gamma Regime panel', () => {
  test.beforeEach(async ({ page }) => {
    // Abort every backend call so the page renders the static dashboard
    // shell deterministically and the live regime hook never resolves.
    await page.route('**/api/**', (route) => route.abort());
  });

  test('renders the section landmark', async ({ page }) => {
    await openAt(page, SATURDAY);
    const section = page.getByRole('region', { name: SECTION_LABEL });
    await expect(section).toBeVisible();

    // The collapsible header exposes an accessible toggle for the section.
    await expect(
      section.getByRole('button', { name: `Toggle ${SECTION_LABEL}` }),
    ).toBeVisible();
  });

  test('shows the closed-market "waiting for the open" placeholder on a weekend', async ({
    page,
  }) => {
    await openAt(page, SATURDAY);
    const section = page.getByRole('region', { name: SECTION_LABEL });
    await expect(section).toBeVisible();

    // The clock is pinned to a Saturday → the panel renders the placeholder
    // copy, not the live sub-viz. Match the leading sentence case-insensitively
    // so a copy tweak to the trailing detail doesn't break the assertion.
    await expect(section.getByText(/waiting for the open/i)).toBeVisible();
    await expect(section.getByText(/closed for the day/i)).toHaveCount(0);
  });

  test('says the day is over after the close of a trading day', async ({
    page,
  }) => {
    await openAt(page, FRIDAY_AFTER_CLOSE);
    const section = page.getByRole('region', { name: SECTION_LABEL });
    await expect(section).toBeVisible();

    await expect(section.getByText(/closed for the day/i)).toBeVisible();
    await expect(section.getByText(/waiting for the open/i)).toHaveCount(0);
  });

  test.describe('a11y scan', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

    test('panel has no critical a11y violations', async ({ page }) => {
      await openAt(page, SATURDAY);
      const section = page.getByRole('region', { name: SECTION_LABEL });
      await expect(section).toBeVisible();

      const results = await new AxeBuilder({ page })
        .include('section[aria-label="0DTE Gamma Regime"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['color-contrast'])
        .analyze();

      const critical = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      for (const v of critical) {
        console.log(
          `[a11y] ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} nodes)`,
        );
      }
      expect(critical).toEqual([]);
    });
  });
});
