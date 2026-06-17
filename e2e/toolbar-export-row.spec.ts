import { test, expect, type Locator, type Page } from '@playwright/test';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * Row-1 toolbar single-line regression guard for the Lottery Finder and
 * Silent Boom panels (Options Alerts view, side-by-side at xl).
 *
 * The owner runs the two panels side-by-side (~660-700px each) and any
 * wrap of the right-aligned EXPORT cluster onto a second line is a
 * regression. The toolbars use compact sizing (CHIP_BASE_COMPACT, 11px
 * text) specifically so the cluster stays on the date-input's line in
 * every state — including the widest one (historical date, where the
 * chip reads "All day" and the "replay" caption appears).
 *
 * Setup mirrors options-alerts-responsive.spec.ts: the dev server runs
 * in owner mode (`import.meta.env.DEV`), and mocking /api/quotes with
 * `marketOpen: true` supplies `market.hasData` so the feed panes mount.
 * /api/history is mocked as a 404 (handled error path) because the
 * helper's default `{}` fallback crashes useHistoryData's candle parse.
 */

const HISTORICAL_DATE = '2026-06-10'; // past weekday → "All day" + replay

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    buildApiFetchMock({
      '/api/quotes': { body: MOCK_QUOTES },
      '/api/history': { body: { error: 'no data' }, status: 404 },
    }),
  );
  // 1440x900 puts the two panes side-by-side at ~660px content width
  // each — the constrained width the compaction was measured against.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#alerts');
});

/**
 * Assert the export cluster shares row-1's line: the "⤓ filtered" link's
 * bounding-box top must match the date input's top within a few px
 * (sub-pixel/border tolerance). A wrapped cluster lands a full row
 * (~28px) lower, so the tolerance cleanly separates the two outcomes.
 */
async function expectExportOnDateLine(region: Locator) {
  const dateInput = region.getByLabel('Select trading day');
  const filteredLink = region.getByRole('link', { name: '⤓ filtered' });
  await expect(dateInput).toBeVisible();
  await expect(filteredLink).toBeVisible();

  const dateBox = await dateInput.boundingBox();
  const exportBox = await filteredLink.boundingBox();
  expect(dateBox).not.toBeNull();
  expect(exportBox).not.toBeNull();
  if (!dateBox || !exportBox) return;

  expect(Math.abs(exportBox.y - dateBox.y)).toBeLessThanOrEqual(4);
}

async function switchToHistorical(region: Locator) {
  await region.getByLabel('Select trading day').fill(HISTORICAL_DATE);
  // The "replay" caption replaces the live "HH:MM CT" stamp — waiting on
  // it guarantees the historical re-render (widest state) is complete.
  await expect(region.getByText('replay', { exact: true })).toBeVisible();
  await expect(
    region.getByRole('button', { name: 'All day', exact: true }),
  ).toBeVisible();
}

/**
 * Pick the first real minute/bucket so the "(1-min)" / "(5-min)" caption
 * renders. Combined with the historical "All day" chip + "replay"
 * caption, this is the widest row-1 state the compaction must survive.
 * Option index 0 is the "pick…" placeholder; index 1 is the first bucket.
 */
async function pickFirstBucket(
  region: Locator,
  selectName: RegExp,
  bucketCaption: string,
) {
  await region.getByLabel(selectName).selectOption({ index: 1 });
  await expect(region.getByText(bucketCaption, { exact: true })).toBeVisible();
}

function getRegions(page: Page) {
  return {
    lottery: page.getByRole('region', { name: 'Lottery Finder alerts' }),
    silentBoom: page.getByRole('region', { name: 'Silent Boom alerts' }),
  };
}

test.describe('Toolbar export row stays on one line', () => {
  test('Lottery Finder: live state keeps export on the date line', async ({
    page,
  }) => {
    const { lottery } = getRegions(page);
    await expect(lottery).toBeVisible();
    await expectExportOnDateLine(lottery);
  });

  test('Lottery Finder: historical date keeps export on the date line', async ({
    page,
  }) => {
    const { lottery } = getRegions(page);
    await expect(lottery).toBeVisible();
    await switchToHistorical(lottery);
    await pickFirstBucket(lottery, /Jump to a specific minute/, '(1-min)');
    await expectExportOnDateLine(lottery);
  });

  test('Silent Boom: live state keeps export on the date line', async ({
    page,
  }) => {
    const { silentBoom } = getRegions(page);
    await expect(silentBoom).toBeVisible();
    await expectExportOnDateLine(silentBoom);
  });

  test('Silent Boom: historical date keeps export on the date line', async ({
    page,
  }) => {
    const { silentBoom } = getRegions(page);
    await expect(silentBoom).toBeVisible();
    await switchToHistorical(silentBoom);
    await pickFirstBucket(
      silentBoom,
      /Jump to a specific 5-min bucket/,
      '(5-min)',
    );
    await expectExportOnDateLine(silentBoom);
  });
});
