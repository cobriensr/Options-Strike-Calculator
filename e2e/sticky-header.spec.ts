import { test, expect, type Page } from '@playwright/test';
import { dateTimeSection, openSection } from './helpers/calculator';

/**
 * The sticky stack: AppHeader on top, then the SectionNav strip (below lg)
 * or sidebar (lg and up), stuck right under it. AppHeader publishes its
 * live height as --app-header-h and the nav sticks at that offset, so the
 * header never covers the nav, whatever height the header takes.
 *
 * The dev server runs in owner mode, and a past trading day adds the
 * BACKTEST + NO INTRADAY pills (/api is aborted), so the header carries
 * its fullest controls row: at 1024 it squeezes and the title wraps,
 * making the header 90px tall.
 */

async function openScrolled(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await dateTimeSection(page)
    .getByLabel('Date', { exact: true })
    .fill('2025-01-15');
  await expect(
    page.getByRole('banner').getByText('NO INTRADAY', { exact: false }),
  ).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, 1500));
}

function sectionNav(page: Page) {
  return page
    .getByRole('navigation', { name: 'Page sections' })
    .filter({ visible: true });
}

/** How far the nav's top sits below the header's bottom edge, in px. */
async function navGapBelowHeader(page: Page) {
  const header = await page.getByRole('banner').boundingBox();
  const nav = await sectionNav(page).boundingBox();
  if (!header || !nav) throw new Error('header or section nav not laid out');
  return nav.y - (header.y + header.height);
}

/**
 * How far an anchor sits below the sticky stack: the header plus, below
 * lg, the section strip (from lg the nav is a sidebar beside the content).
 */
async function anchorGapBelowStack(page: Page, id: string, width: number) {
  const header = await page.getByRole('banner').boundingBox();
  const nav = await sectionNav(page).boundingBox();
  const anchor = await page.locator(`#${id}`).boundingBox();
  if (!header || !nav || !anchor)
    throw new Error('stack or anchor not laid out');
  const stackBottom =
    width < 1024 ? nav.y + nav.height : header.y + header.height;
  return anchor.y - stackBottom;
}

test.describe('Sticky header and section nav', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
  });

  for (const width of [375, 640, 768, 1023, 1024, 1280]) {
    test(`the section nav sticks right under the header at ${width}px`, async ({
      page,
    }) => {
      await openScrolled(page, width);
      // Neither covered by the header nor leaving a gap. Polled: the
      // header publishes its height from a ResizeObserver callback.
      await expect.poll(() => navGapBelowHeader(page)).toBeGreaterThan(-0.5);
      expect(await navGapBelowHeader(page)).toBeLessThan(0.5);
      await expect(sectionNav(page).getByRole('link').first()).toBeInViewport({
        ratio: 1,
      });
    });
  }

  // Every section anchor's scroll margin is --anchor-offset: the sticky
  // stack plus 8px. App.tsx renders sec-iv inline; FuturesPanel renders
  // sec-futures-calc inside the lazy Futures panel.
  for (const width of [375, 768, 1024, 1280]) {
    test(`a jump to a section lands just below the sticky stack at ${width}px`, async ({
      page,
    }) => {
      await openScrolled(page, width);

      // Polled until the (possibly smooth) scroll settles 8px below.
      const offTarget = async (id: string) =>
        Math.abs((await anchorGapBelowStack(page, id, width)) - 8);

      await sectionNav(page)
        .getByRole('link', { name: 'Implied Volatility' })
        .click();
      await expect.poll(() => offTarget('sec-iv')).toBeLessThan(1.5);

      // The anchor sits inside the Futures panel, collapsed by default.
      // scrollIntoView honours its scroll margin, as a hash jump does.
      await openSection(page, 'Futures');
      await page
        .locator('#sec-futures-calc')
        .evaluate((el) => el.scrollIntoView());
      await expect.poll(() => offTarget('sec-futures-calc')).toBeLessThan(1.5);
    });
  }
});
