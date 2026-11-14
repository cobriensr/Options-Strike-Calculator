import { test, expect, type Page } from '@playwright/test';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * The browser clock is pinned, as entry-time.spec.ts does. The app opens on
 * today's ET date, and the gap preview's prior close comes from the live
 * /api/yesterday only while that date is today (a past date gets none). This
 * suite used to run on the real clock and went red in the hour after ET
 * midnight (05:00Z to 06:00Z in winter), when the default date was still the
 * CT one, a day behind.
 */
/** Wednesday 10:00 AM CT (CDT is UTC-5): a session the market is open in. */
const MID_SESSION = '2026-06-17T15:00:00Z';
/** Saturday 00:01 ET = Friday 23:01 CT (EST/CST): when CI went red. */
const ET_MIDNIGHT_HOUR = '2026-11-14T05:01:00Z';

async function openPreMarket(page: Page, now: string) {
  await page.clock.setFixedTime(new Date(now));
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
      '/api/yesterday': {
        body: {
          yesterday: {
            date: '2026-03-27',
            open: 6780,
            high: 6830,
            low: 6750,
            close: 6790,
            rangePct: 1.18,
            rangePts: 80,
          },
          twoDaysAgo: null,
          asOf: new Date(now).toISOString(),
        },
      },
    }),
  );
  await page.goto('/');
}

/** Globex close vs prevClose from mocked /api/yesterday (6790). */
async function expectGapPreview(page: Page) {
  const section = page.locator('section[aria-label="Pre-Market Futures"]');
  await expect(section).toBeVisible({ timeout: 15000 });

  await section.getByLabel('Globex High').fill('6800');
  await section.getByLabel('Globex Low').fill('6770');
  await section.getByLabel('Globex Close').fill('6780');

  // Gap = 6780 - 6790 = -10.0 (DOWN)
  await expect(section.getByText('ES vs SPX')).toBeVisible({
    timeout: 5000,
  });
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

    // Mock the POST response so the save attempt goes through the mock
    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/pre-market': {
          body: { ok: true },
          method: 'POST',
        },
      }),
    );

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
  test('entering globex close still shows the ES vs SPX gap preview', async ({
    page,
  }) => {
    await openPreMarket(page, ET_MIDNIGHT_HOUR);
    await expectGapPreview(page);
  });
});
