import { test, expect, type Page } from '@playwright/test';
import { dateTimeSection } from './helpers/calculator';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';
import { priorTradingDay } from '../src/data/marketHours';
import { getETDateStr } from '../src/utils/timezone';

// The browser clock is pinned, as entry-time.spec.ts does. The app opens on
// today's ET date, and the gap preview's prior close comes from the live
// /api/yesterday only while that date is today (a past date gets none). This
// suite used to run on the real clock and went red in the hour after ET
// midnight (05:00Z to 06:00Z in winter), when the default date was still the
// CT one, a day behind.

/** Wednesday 10:00 AM CT (CDT is UTC-5): a session the market is open in. */
const MID_SESSION = '2026-06-17T15:00:00Z';
/** Saturday 00:01 ET = Friday 23:01 CT (EST/CST): when CI went red. */
const ET_MIDNIGHT_HOUR = '2026-11-14T05:01:00Z';
/**
 * Wednesday 00:30 ET = Tuesday 23:30 CT (EST/CST): a Sunday-to-Thursday
 * night, when the owner enters Globex data and the new ET day is a trading
 * day (2026-11-11 is not an NYSE holiday).
 */
const ET_MIDNIGHT_WEEKNIGHT = '2026-11-11T05:30:00Z';
/**
 * Monday 23:58 ET = 22:58 CT (EST/CST), two minutes before Tuesday begins in
 * New York. Tuesday 2026-11-10 is a trading day.
 */
const TWO_MINUTES_BEFORE_ET_MIDNIGHT = '2026-11-10T04:58:00Z';
const NIGHT_DATE = '2026-11-09';
const NEXT_DATE = '2026-11-10';

/** The calendar date `days` after `date` (YYYY-MM-DD). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * /api/yesterday answers per ET date, as the real one does for the date the
 * page asks with (`?d=`): the last trading day before it. The page takes
 * yesterday only when that is the case, so a fixed fixture date would be
 * rejected and the gap preview would lose its prior close. A tab left open
 * across ET midnight asks again with the new date, so the answers cover `now`'s
 * ET date and the days after it.
 */
function yesterdayMocks(now: string) {
  const first = getETDateStr(new Date(now));
  const mocks: Record<string, { body: unknown }> = {};
  for (let days = 0; days < 4; days += 1) {
    const etToday = addDays(first, days);
    mocks[`/api/yesterday?d=${etToday}`] = {
      body: {
        yesterday: {
          date: priorTradingDay(etToday),
          open: 6780,
          high: 6830,
          low: 6750,
          // Not the quote mock's SPX price (6790): the gap preview falls back to
          // the spot when it has no prior close, and the two must differ for a
          // page that rejected this yesterday to show.
          close: 6795,
          rangePct: 1.18,
          rangePts: 80,
        },
        twoDaysAgo: null,
        asOf: new Date(now).toISOString(),
      },
    };
  }
  return mocks;
}

/** Stub the API the pre-market section needs; `now` dates /api/yesterday. */
async function mockPreMarketApi(page: Page, now: string) {
  await page.addInitScript(
    buildApiFetchMock({
      '/api/quotes': { body: MOCK_QUOTES },
      '/api/pre-market': {
        body: { data: null },
        method: 'GET',
      },
      // Provide yesterday data so prevClose is available for gap preview.
      // Without this, gapPreview depends on results?.spot which requires
      // the calculator to run during market hours.
      ...yesterdayMocks(now),
    }),
  );
}

/** Open the app with the browser clock frozen at `now`. */
async function openPreMarket(page: Page, now: string) {
  await page.clock.setFixedTime(new Date(now));
  await mockPreMarketApi(page, now);
  await page.goto('/');
}

/** Globex close vs prevClose from mocked /api/yesterday (6795). */
async function expectGapPreview(page: Page) {
  const section = page.locator('section[aria-label="Pre-Market Futures"]');
  await expect(section).toBeVisible({ timeout: 15000 });

  await section.getByLabel('Globex High').fill('6800');
  await section.getByLabel('Globex Low').fill('6770');
  await section.getByLabel('Globex Close').fill('6780');

  // Gap = 6780 - 6795 = -15.0 (DOWN), the prior close from the mocked
  // /api/yesterday. Without a live yesterday the preview falls back to the
  // quote mock's SPX price, 6790, and shows -10.0 (also DOWN), so the number
  // is what tells the two apart: the direction alone does not.
  await expect(section.getByText('ES vs SPX')).toBeVisible({
    timeout: 5000,
  });
  await expect(section.getByText('-15.0', { exact: true })).toBeVisible();
  await expect(section.getByText('DOWN')).toBeVisible();
}

/**
 * Tests for the Pre-Market input section.
 *
 * The PreMarketInput component only renders when `market.hasData` is true,
 * so we mock the /api/quotes endpoint to supply market data and mock
 * /api/pre-market for load/save operations.
 */
test.describe('Pre-Market Input', () => {
  test.beforeEach(async ({ page }) => {
    await openPreMarket(page, MID_SESSION);
  });

  test('pre-market section renders with mocked quotes', async ({ page }) => {
    const section = page.locator('section[aria-label="Pre-Market Futures"]');
    await expect(section).toBeVisible({ timeout: 15000 });

    // Core ES overnight inputs
    await expect(section.getByLabel('Globex High')).toBeVisible();
    await expect(section.getByLabel('Globex Low')).toBeVisible();
    await expect(section.getByLabel('Globex Close')).toBeVisible();
    await expect(section.getByLabel('Globex VWAP')).toBeVisible();

    // Save button
    await expect(section.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  test('entering globex data shows overnight range preview', async ({
    page,
  }) => {
    const section = page.locator('section[aria-label="Pre-Market Futures"]');
    await expect(section).toBeVisible({ timeout: 15000 });

    await section.getByLabel('Globex High').fill('6555.25');
    await section.getByLabel('Globex Low').fill('6520.50');
    await section.getByLabel('Globex Close').fill('6548.00');

    // O/N Range preview should appear: 6555.25 - 6520.50 = 34.75 pts
    await expect(section.getByText('O/N Range')).toBeVisible({ timeout: 3000 });
    await expect(section.getByText('34.8 pts')).toBeVisible();
  });

  test('entering globex close shows ES vs SPX gap preview', async ({
    page,
  }) => {
    await expectGapPreview(page);
  });

  test('validation requires high, low, and close', async ({ page }) => {
    const section = page.locator('section[aria-label="Pre-Market Futures"]');
    await expect(section).toBeVisible({ timeout: 15000 });

    // Only fill High, leave Low and Close empty
    await section.getByLabel('Globex High').fill('6555.25');

    // Click Save
    await section.getByRole('button', { name: 'Save' }).click();

    // Should show validation error
    await expect(
      section.getByText('Globex High, Low, and Close are required'),
    ).toBeVisible({ timeout: 3000 });
  });

  test('validation rejects high less than low', async ({ page }) => {
    const section = page.locator('section[aria-label="Pre-Market Futures"]');
    await expect(section).toBeVisible({ timeout: 15000 });

    // Fill with High < Low (invalid)
    await section.getByLabel('Globex High').fill('6500');
    await section.getByLabel('Globex Low').fill('6550');
    await section.getByLabel('Globex Close').fill('6520');

    await section.getByRole('button', { name: 'Save' }).click();

    await expect(
      section.getByText(/Globex High must be .* Globex Low/),
    ).toBeVisible({ timeout: 3000 });
  });
});

/**
 * The owner enters Globex data at night, so this is the hour that matters:
 * after ET midnight the default date is the new ET day while the CT date is
 * still the old one. The gap preview must still get its prior close.
 */
test.describe('Pre-Market Input in the ET-midnight hour', () => {
  const instants = [
    { label: 'Saturday 00:01 ET (Friday 23:01 CT)', now: ET_MIDNIGHT_HOUR },
    {
      label: 'Wednesday 00:30 ET (Tuesday 23:30 CT)',
      now: ET_MIDNIGHT_WEEKNIGHT,
    },
  ];

  for (const { label, now } of instants) {
    test(`entering globex close still shows the ES vs SPX gap preview at ${label}`, async ({
      page,
    }) => {
      await openPreMarket(page, now);
      await expectGapPreview(page);
    });
  }
});

/**
 * A tab left open across ET midnight (23:00 CT). The clock is installed, not
 * frozen, so the app's own midnight timer is armed; fastForward then jumps
 * past the turn, as a laptop lid closed and reopened would. The date was
 * today's, so it moves to the new ET date with no action, and the gap preview
 * keeps its prior close. Left on the old date, it would turn "past" at
 * 23:00 CT and lose the preview. Picking another date to stay on is covered
 * in src/__tests__/hooks/useVixData.test.ts.
 */
test.describe('Pre-Market Input across ET midnight with the app open', () => {
  const OVER_MIDNIGHT_MS = 3 * 60 * 1000;

  test.beforeEach(async ({ page }) => {
    await page.clock.install({
      time: new Date(TWO_MINUTES_BEFORE_ET_MIDNIGHT),
    });
    await mockPreMarketApi(page, TWO_MINUTES_BEFORE_ET_MIDNIGHT);
    await page.goto('/');
    // The installed clock put the app on Monday, before the turn.
    await expect(
      dateTimeSection(page).getByLabel('Date', { exact: true }),
    ).toHaveValue(NIGHT_DATE);
  });

  test('the date moves to the new ET date and the gap preview stays', async ({
    page,
  }) => {
    await page.clock.fastForward(OVER_MIDNIGHT_MS);

    await expectGapPreview(page);
    await expect(
      dateTimeSection(page).getByLabel('Date', { exact: true }),
    ).toHaveValue(NEXT_DATE);
  });

  test('a manual time edit ends with the date it was made on', async ({
    page,
  }) => {
    await dateTimeSection(page).getByLabel('Hour').selectOption('11');
    const paused = page.getByText('Manual time — live sync paused');
    await expect(paused).toBeVisible();

    await page.clock.fastForward(OVER_MIDNIGHT_MS);

    await expect(
      dateTimeSection(page).getByLabel('Date', { exact: true }),
    ).toHaveValue(NEXT_DATE);
    await expect(paused).toBeHidden();
  });
});
