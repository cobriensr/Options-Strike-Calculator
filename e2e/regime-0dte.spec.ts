/**
 * Regime0dte panel — Phase 4 Playwright coverage for the "0DTE Gamma Regime"
 * section (plan: docs/superpowers/plans/2026-06-07-regime-0dte-panel.md, Task 11).
 *
 * The panel is non-auth-gated, so it renders for a public visitor on a plain
 * `/` load with the backend APIs aborted. During CI / local test runs the
 * market is CLOSED, so the live hook's window is shut and the panel renders
 * its "waiting for the open" placeholder rather than the four sub-viz. These
 * tests therefore assert the section landmark + the closed-market placeholder
 * — NOT the live visuals — plus an axe-core a11y scan scoped to the section.
 *
 * The panel is wrapped in a SectionBox, which emits
 * `<section aria-label="0DTE Gamma Regime">`. We target that landmark with a
 * role/label selector (semantic, resilient to styling changes) rather than a
 * CSS class. Pattern mirrors e2e/vega-spike-feed.spec.ts and
 * e2e/a11y-automated.spec.ts.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const SECTION_LABEL = '0DTE Gamma Regime';

test.describe('0DTE Gamma Regime panel', () => {
  test.beforeEach(async ({ page }) => {
    // Abort every backend call so the page renders the static dashboard
    // shell deterministically and the live regime hook never resolves.
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('renders the section landmark', async ({ page }) => {
    const section = page.getByRole('region', { name: SECTION_LABEL });
    await expect(section).toBeVisible();

    // The collapsible header exposes an accessible toggle for the section.
    await expect(
      section.getByRole('button', { name: `Toggle ${SECTION_LABEL}` }),
    ).toBeVisible();
  });

  test('shows the closed-market "waiting for the open" placeholder', async ({
    page,
  }) => {
    const section = page.getByRole('region', { name: SECTION_LABEL });
    await expect(section).toBeVisible();

    // Market is closed during test runs → the panel renders the placeholder
    // copy, not the live sub-viz. Match the leading sentence case-insensitively
    // so a copy tweak to the trailing detail doesn't break the assertion.
    await expect(
      section.getByText(/waiting for the open/i),
    ).toBeVisible();
  });

  test.describe('a11y scan', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

    test('panel has no critical a11y violations', async ({ page }) => {
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
