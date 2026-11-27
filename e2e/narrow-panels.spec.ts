import { test, expect, type Locator, type Page } from '@playwright/test';
import { FULL_SESSION_NOW, fillVix, setEntryTime } from './helpers/calculator';

/**
 * Rows that don't wrap run past their card on a phone. These two now wrap:
 *
 *   - a SectionBox header whose controls don't fit beside the title, e.g.
 *     the Futures panel once its data loads and a time badge joins the
 *     title (the controls drop to their own right-aligned line);
 *   - the hedge calculator's IC Δ chips in the strike results card.
 *
 * Tables that sit behind a disclosure are the other trap: their visually
 * hidden text (the "(gain)/(loss)" spans, a SrHint) is position: absolute,
 * and a horizontal scroller that is not positioned does not contain it, so
 * opening the table can widen the page. The last describe opens each one.
 */

/** The card's content edge: its right side minus border and padding. */
async function contentRight(card: Locator) {
  return card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      box.right -
      Number.parseFloat(style.borderRightWidth) -
      Number.parseFloat(style.paddingRight)
    );
  });
}

async function expectInsideCard(card: Locator, controls: Locator[]) {
  const edge = await contentRight(card);
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box, 'control laid out').not.toBeNull();
    if (box) expect(box.x + box.width).toBeLessThanOrEqual(edge + 0.5);
  }
}

async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test.describe('Panels on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
  });

  test('the Futures header keeps its controls in the card once data loads', async ({
    page,
  }) => {
    // Registered after the abort-everything route, so matched first
    await page.route('**/api/futures/snapshot**', (route) =>
      route.fulfill({
        json: {
          snapshots: [],
          vixTermStructure: null,
          esSpxBasis: null,
          updatedAt: new Date().toISOString(),
          oldestTs: '2026-10-01T14:30:00Z',
          requestedAt: null,
        },
      }),
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const futures = page.getByRole('region', { name: 'Futures', exact: true });
    // The update time joins the title as a badge
    await expect(
      futures.getByRole('button', { name: 'Toggle Futures' }),
    ).toContainText(/\d{1,2}:\d{2}\s?[AP]M/);
    await expectInsideCard(futures, [
      futures.getByLabel('Historical futures timestamp'),
      // Exact: a substring would pass on the old "Reset to live data" name
      futures.getByRole('button', {
        name: 'Now: reset to live data',
        exact: true,
      }),
      // A poll puts the button in its loading state, which renames it
      futures.getByRole('button', {
        name: /^(Refresh|Loading\.\.\. refreshing) futures data$/,
      }),
    ]);
    await expectNoSidewaysScroll(page);
  });

  test('the hedge calculator chips stay in the strike results card at 320px', async ({
    page,
  }) => {
    // The entry time seeds from the wall clock, so after a half day's 1 PM ET
    // close no results render (see the constant).
    await page.clock.setFixedTime(new Date(FULL_SESSION_NOW));
    await page.setViewportSize({ width: 320, height: 640 }); // iPhone SE
    await page.goto('/');
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');

    const results = page.getByRole('region', {
      name: 'Strike results for all deltas',
    });
    // IC Δ, Hedge Δ and DTE chips are toggles (aria-pressed)
    const chips = results.locator('button[aria-pressed]');
    await expect(chips.first()).toBeVisible();
    await expectInsideCard(results, await chips.all());
    await expectNoSidewaysScroll(page);
  });
});

test.describe('Tables behind a disclosure on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await page.setViewportSize({ width: 375, height: 812 }); // iPhone X
    await page.goto('/');
    await setEntryTime(page);
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');
    await expect(
      page.locator('#results').getByText('All Delta Strikes'),
    ).toBeVisible({ timeout: 5000 });
    // Baseline: the results alone fit, so a failure below is the table
    await expectNoSidewaysScroll(page);
  });

  test('the hedge scenario tables fit once "Show P&L Scenario Table" opens them', async ({
    page,
  }) => {
    const results = page.locator('#results');
    await results
      .getByRole('button', { name: /Show.*P&L Scenario Table/ })
      .click();

    await expect(
      results.getByRole('table', { name: 'Hedge P&L crash scenarios' }),
    ).toBeVisible();
    await expect(
      results.getByRole('table', { name: 'Hedge P&L rally scenarios' }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('the iron condor legs and P&L tables fit', async ({ page }) => {
    const results = page.locator('#results');
    await expect(
      results.getByRole('table', { name: 'Iron condor legs by delta' }),
    ).toBeVisible();
    await expect(
      results.getByRole('table', { name: 'Iron condor P&L by delta' }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('the BWB legs and P&L tables fit once "Show BWB" opens them', async ({
    page,
  }) => {
    // Advanced starts collapsed and its Show BWB chip is the only switch
    await page.getByRole('button', { name: 'Show BWB' }).click();

    const results = page.locator('#results');
    await expect(
      results.getByRole('table', { name: 'BWB legs by delta' }),
    ).toBeVisible();
    await expect(
      results.getByRole('table', { name: 'BWB P&L by delta' }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});
