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
 * its fullest controls row. Below xl that row scrolls sideways; at 1280
 * it squeezes, and with the Schwab countdown the header grows to 90px.
 */

/** The owner's Schwab login runs out in 3 hours: the amber countdown shows. */
async function showSchwabCountdown(page: Page) {
  await page.route('**/api/auth/schwab-status', (route) =>
    route.fulfill({
      json: { state: 'expiring', refreshExpiresAt: Date.now() + 3 * 3600_000 },
    }),
  );
}

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

// The owner's fullest header row: backtest pills, the Schwab countdown with
// its Re-auth link, and the admin tools. Below xl the row scrolls sideways;
// it used to squeeze at 1024, wrapping the header to 105px and pushing
// controls off the page (1085px wide) or, in the alerts view, out of reach.
test.describe('Desktop header with the owner row', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort());
    await showSchwabCountdown(page);
  });

  async function openFullRow(
    page: Page,
    width: number,
    view: 'calculator' | 'alerts',
  ) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await dateTimeSection(page)
      .getByLabel('Date', { exact: true })
      .fill('2025-01-15');
    const header = page.getByRole('banner');
    await expect(
      header.getByText('NO INTRADAY', { exact: false }),
    ).toBeAttached();
    await expect(
      header.getByRole('timer', { name: 'Schwab login expiry' }),
    ).toBeAttached();
    if (view === 'alerts') {
      await header.getByRole('button', { name: 'Options Alerts' }).click();
      await expect(
        page.getByRole('main', { name: /options alerts/i }),
      ).toBeVisible();
    }
    return header;
  }

  async function pageWidth(page: Page) {
    return page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
  }

  for (const view of ['calculator', 'alerts'] as const) {
    test(`at 1024 the ${view} view keeps one header row and every control in reach`, async ({
      page,
    }) => {
      const header = await openFullRow(page, 1024, view);
      const { scrollWidth, innerWidth } = await pageWidth(page);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
      const box = await header.boundingBox();
      expect(box?.height).toBeLessThan(75); // one control row: 69px

      // The last tool scrolls into view within the row
      const last = header.getByRole('button', { name: 'Switch to light mode' });
      await last.evaluate((el) =>
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
      );
      await expect(last).toBeInViewport({ ratio: 1 });
    });
  }

  test('at 1280 the header row is a plain row, as before: no scrolling, no fades', async ({
    page,
  }) => {
    const header = await openFullRow(page, 1280, 'calculator');
    const row = header
      .getByRole('navigation', { name: 'Application view' })
      .locator('..');
    await expect(row).toHaveCSS('overflow-x', 'visible');
    await expect(header.getByTestId('controls-fade-right')).toBeHidden();
    const { scrollWidth, innerWidth } = await pageWidth(page);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    await expect(
      header.getByRole('button', { name: 'Switch to light mode' }),
    ).toBeInViewport({ ratio: 1 });
  });
});
