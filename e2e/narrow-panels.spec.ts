import { test, expect, type Locator, type Page } from '@playwright/test';
import { fillVix } from './helpers/calculator';

/**
 * Rows that don't wrap run past their card on a phone. These two now wrap:
 *
 *   - a SectionBox header whose controls don't fit beside the title, e.g.
 *     the Futures panel once its data loads and a time badge joins the
 *     title (the controls drop to their own right-aligned line);
 *   - the hedge calculator's IC Δ chips in the strike results card.
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
      futures.getByRole('button', { name: 'Reset to live data' }),
      futures.getByRole('button', { name: 'Refresh futures data' }),
    ]);
    await expectNoSidewaysScroll(page);
  });

  test('the hedge calculator chips stay in the strike results card at 320px', async ({
    page,
  }) => {
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
