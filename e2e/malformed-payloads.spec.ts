import { test, expect } from '@playwright/test';
import { buildApiFetchMock } from './helpers/mock-fetch';
import { dateTimeSection, fillVix, setEntryTime } from './helpers/calculator';

/**
 * A 200 with a malformed body must degrade one panel, not blank the page.
 *
 * /api/history, /api/opening-flow-signal and /api/pin-setup-status answer
 * 200 with `{}`, the body that used to crash the page into the root error
 * screen (`history.spx.candles`, `tickers[ticker]`, `state.replace`). Each
 * hook now rejects it at the fetch boundary like a failed fetch. Every
 * other /api/ call fails as an unreachable backend (buildApiFetchMock).
 *
 * Spec: docs/superpowers/specs/panel-payload-guards-2026-10-28.md (phase 1)
 */
const MALFORMED = { body: {} };

test.describe('Malformed 200 payloads', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildApiFetchMock({
        '/api/history': MALFORMED,
        '/api/opening-flow-signal': MALFORMED,
        '/api/pin-setup-status': MALFORMED,
      }),
    );
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Strike Calculator');
  });

  test('the pre-market panels show an error instead of crashing', async ({
    page,
  }) => {
    const section = page.getByRole('region', { name: 'Pre-Market Signals' });
    await expect(
      section.getByRole('heading', { name: 'Opening Flow Signal' }),
    ).toBeVisible();
    await expect(section.getByText('0DTE Pin Setup')).toBeVisible();
    // One error alert per panel, from the hooks' schema check.
    await expect(
      section.getByRole('alert').filter({ hasText: 'invalid response shape' }),
    ).toHaveCount(2);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('a malformed history leaves the calculator computing', async ({
    page,
  }) => {
    // A past trading day, so useHistoryData fetches /api/history whatever
    // the date the suite runs on.
    await dateTimeSection(page)
      .getByLabel('Date', { exact: true })
      .fill('2025-01-15');
    // The header's NO INTRADAY badge carries the hook's error as its title.
    await expect(
      page.getByRole('banner').getByTitle('invalid response shape'),
    ).toContainText('NO INTRADAY');

    await setEntryTime(page);
    await page.getByLabel('SPY Price').fill('679');
    await page.getByLabel(/SPX Price/).fill('6790');
    await fillVix(page, '19');

    const strikeTable = page
      .locator('#results')
      .getByRole('table', { name: /^Strike prices by delta/ });
    await expect(
      strikeTable.getByRole('cell', { name: '10Δ', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
});
