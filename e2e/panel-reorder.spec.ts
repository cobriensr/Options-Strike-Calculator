import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * E2E coverage for the panel-prefs modal's drag-to-reorder UI.
 * Spec: docs/superpowers/specs/panel-reordering-2026-05-17.md
 *
 * We block /api/** so the modal opens against a public-mode page
 * (no owner cookie, no panel-prefs GET round-trip stalls the test).
 * In public mode the modal still shows the always-visible panels
 * (Inputs group + Analysis History + Position Monitor + the
 * always-pinned Results), which is enough to exercise the drag UI.
 */
test.describe('Panel reorder modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
  });

  test('opens via gear button and exposes panel + group grip handles', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Show or hide panels' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Show / Hide / Reorder Panels' }),
    ).toBeVisible();

    // Every panel row has a "Drag to reorder <label>" grip button
    await expect(
      page.getByRole('button', { name: 'Drag to reorder Date & Time' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Drag to reorder Spot Price' }),
    ).toBeVisible();

    // Every visible group header has a "Drag to reorder group <group>" grip
    await expect(
      page.getByRole('button', { name: 'Drag to reorder group Inputs' }),
    ).toBeVisible();
  });

  test('three reset buttons render and start in their default state', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Show or hide panels' }).click();

    // All three reset buttons exist as separate controls
    const resetVisibility = page.getByRole('button', {
      name: 'Reset visibility',
    });
    const resetPanelOrder = page.getByRole('button', {
      name: 'Reset panel order',
    });
    const resetGroupOrder = page.getByRole('button', {
      name: 'Reset group order',
    });

    await expect(resetVisibility).toBeVisible();
    await expect(resetPanelOrder).toBeVisible();
    await expect(resetGroupOrder).toBeVisible();

    // No stored state on first visit → all three start disabled
    await expect(resetVisibility).toBeDisabled();
    await expect(resetPanelOrder).toBeDisabled();
    await expect(resetGroupOrder).toBeDisabled();
  });

  test('toggling a panel checkbox enables Reset visibility', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Show or hide panels' }).click();

    const resetVisibility = page.getByRole('button', {
      name: 'Reset visibility',
    });
    await expect(resetVisibility).toBeDisabled();

    await page
      .getByRole('checkbox', { name: 'Hide Date & Time' })
      .click({ force: true });

    // Public mode has no panel-prefs PUT, so optimistic UI state still
    // flips and the reset button becomes enabled.
    await expect(resetVisibility).toBeEnabled();
  });

  test('Done button closes the modal and restores focus to the gear', async ({
    page,
  }) => {
    const gear = page.getByRole('button', { name: 'Show or hide panels' });
    await gear.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // Per WCAG 2.4.3 the gear button regains focus
    await expect(gear).toBeFocused();
  });
});

test.describe('Panel reorder modal — a11y scan', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

  test('open modal has no critical axe violations', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Show or hide panels' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast', 'scrollable-region-focusable'])
      .analyze();

    const critical = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    for (const v of critical) {
      console.log(
        `[a11y] ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length.toString()} nodes)`,
      );
    }
    expect(critical).toEqual([]);
  });
});
