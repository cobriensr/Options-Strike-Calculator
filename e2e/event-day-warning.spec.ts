import { test, expect, type Page } from '@playwright/test';
import { chip, dateTimeSection, setEntryTime } from './helpers/calculator';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * The calendar date, YYYY-MM-DD, in New York at `at`, the date the app opens on
 * (`getETToday`, which `useVixData` seeds `selectedDate` from). It differs from
 * the Central date from 23:00 to 24:00 CT.
 */
function etDate(at: Date = new Date()): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Today's date, matching the app's selectedDate default. */
const TODAY = etDate();

/**
 * 16:00 CST on Friday 2026-11-13, after the close. The count-asserting cases
 * pin the clock here. The hour does not move their counts (the app opens on ET
 * today, which the forward list covers while it loads); what the pin guards is
 * a run that straddles ET midnight between spec load (`TODAY`) and page load,
 * which would leave the date they answer a lookup for a day behind the page's.
 */
const AFTERNOON = new Date('2026-11-13T22:00:00Z');

/** A past trading day: outside the forward list, so it gets its own lookup. */
const PAST_DATE = '2025-01-15';

function makeEventsResponse(
  events: Array<{
    event: string;
    description: string;
    time: string;
    severity: 'high' | 'medium';
    source?: 'fred' | 'static' | 'finnhub';
  }>,
  date: string = TODAY,
) {
  return {
    events: events.map((e) => ({
      date,
      source: 'fred' as const,
      ...e,
    })),
    startDate: date,
    endDate: date,
    cached: false,
    asOf: new Date().toISOString(),
  };
}

/**
 * E2E tests for the EventDayWarning component.
 *
 * The component renders as a full-width banner in <main> when
 * /api/events returns events matching the selected date.
 */
test.describe('Event Day Warning', () => {
  test('high-severity event shows red warning banner', async ({ page }) => {
    const eventsResponse = makeEventsResponse([
      {
        event: 'CPI',
        description: 'Consumer Price Index (MoM)',
        time: '8:30',
        severity: 'high',
      },
    ]);

    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/events': { body: eventsResponse },
      }),
    );
    await page.goto('/');

    // Wait for auto-fill from mocked quotes
    await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
      timeout: 10000,
    });
    await expect(chip(dateTimeSection(page), 'CT')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 5000 },
    );

    // Set explicit entry time so results render
    await setEntryTime(page, { minute: '30', tz: 'CT' });

    // Verify the high-severity banner text and event tag
    const main = page.locator('main');
    await expect(main.getByText('High-Impact Event Day')).toBeVisible({
      timeout: 10000,
    });
    await expect(main.getByText('CPI', { exact: true })).toBeVisible();
  });

  test('medium-severity event shows caution banner', async ({ page }) => {
    const eventsResponse = makeEventsResponse([
      {
        event: 'GDP',
        description: 'Gross Domestic Product (QoQ)',
        time: '8:30',
        severity: 'medium',
      },
    ]);

    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/events': { body: eventsResponse },
      }),
    );
    await page.goto('/');

    await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
      timeout: 10000,
    });
    await expect(chip(dateTimeSection(page), 'CT')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 5000 },
    );

    await setEntryTime(page, { minute: '30', tz: 'CT' });

    const main = page.locator('main');
    await expect(main.getByText('Economic Event Day')).toBeVisible({
      timeout: 10000,
    });
    await expect(main.getByText('GDP', { exact: true })).toBeVisible();
  });

  test('market closed event shows closed banner', async ({ page }) => {
    const eventsResponse = makeEventsResponse([
      {
        event: 'CLOSED',
        description: 'Good Friday',
        time: '',
        severity: 'high',
        source: 'static',
      },
    ]);

    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/events': { body: eventsResponse },
      }),
    );
    await page.goto('/');

    await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
      timeout: 10000,
    });
    await expect(chip(dateTimeSection(page), 'CT')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 5000 },
    );

    await setEntryTime(page, { minute: '30', tz: 'CT' });

    const main = page.locator('main');
    await expect(main.getByText('Market Closed')).toBeVisible({
      timeout: 10000,
    });
    await expect(main.getByText('No 0DTE trading possible')).toBeVisible();
  });

  test('no events renders nothing', async ({ page }) => {
    const eventsResponse = makeEventsResponse([]);

    await page.addInitScript(
      buildApiFetchMock({
        '/api/quotes': { body: MOCK_QUOTES },
        '/api/events': { body: eventsResponse },
      }),
    );
    await page.goto('/');

    await expect(page.getByLabel('SPY Price')).toHaveValue(/\d+/, {
      timeout: 10000,
    });
    await expect(chip(dateTimeSection(page), 'CT')).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 5000 },
    );

    await setEntryTime(page, { minute: '30', tz: 'CT' });

    // None of the warning banners should appear
    const main = page.locator('main');
    await expect(main.getByText('High-Impact Event Day')).not.toBeVisible();
    await expect(main.getByText('Economic Event Day')).not.toBeVisible();
    await expect(main.getByText('Market Closed')).not.toBeVisible();
  });

  /**
   * Abort every /api request (the forward list, `/api/events?days=30`, among
   * them), then answer one date's own lookup (`/api/events?from=<date>`): a 500
   * the first time, a CPI event the second. The count is how many lookups the
   * page made. The clock is pinned to AFTERNOON, so a run that straddles ET
   * midnight between spec load and page load cannot leave the date answered a
   * day behind the page's (see AFTERNOON).
   */
  async function failOnceThenAnswerLookup(page: Page, date: string) {
    await page.clock.setFixedTime(AFTERNOON);
    // Registered first, so the more specific lookup route below wins.
    await page.route('**/api/**', (route) => route.abort());
    const lookups = { count: 0 };
    await page.route(
      (url) =>
        url.pathname === '/api/events' && url.searchParams.get('from') === date,
      (route) => {
        lookups.count += 1;
        if (lookups.count === 1) {
          return route.fulfill({
            status: 500,
            json: { error: 'Events unavailable' },
          });
        }
        return route.fulfill({
          json: makeEventsResponse(
            [
              {
                event: 'CPI',
                description: 'Consumer Price Index (MoM)',
                time: '8:30',
                severity: 'high',
              },
            ],
            date,
          ),
        });
      },
    );
    return lookups;
  }

  /** The failure line, Retry, then the banner with the CPI tag. */
  async function expectFailureThenRetryLoadsCpi(
    page: Page,
    lookups: { count: number },
  ) {
    const main = page.getByRole('main');
    const loadFailed = main.getByText("Events for this date couldn't load.");
    await expect(loadFailed).toBeVisible();
    await expect(main.getByText('High-Impact Event Day')).not.toBeVisible();
    expect(lookups.count).toBe(1);

    await main.getByRole('button', { name: 'Retry', exact: true }).click();

    await expect(main.getByText('High-Impact Event Day')).toBeVisible();
    await expect(main.getByText('CPI', { exact: true })).toBeVisible();
    await expect(loadFailed).toHaveCount(0);
    await expect(
      main.getByRole('button', { name: 'Retry', exact: true }),
    ).toHaveCount(0);
    expect(lookups.count).toBe(2);
  }

  // A past date is outside the forward list, so the app looks up that date's
  // own events (/api/events?from=<date>&days=1) once the date settles. When
  // that lookup fails, a blank banner would read as a quiet day, so the
  // banner says so and offers Retry.
  test("a failed lookup for a past date says so, and Retry loads the date's events", async ({
    page,
  }) => {
    const lookups = await failOnceThenAnswerLookup(page, PAST_DATE);

    await page.goto('/');
    await dateTimeSection(page)
      .getByLabel('Date', { exact: true })
      .fill(PAST_DATE);

    await expectFailureThenRetryLoadsCpi(page, lookups);
  });

  // Today's events come from the forward list. When that list fails to load,
  // a blank banner would read as a quiet day, which matters most on a CPI or
  // jobs-report morning. Today then looks up its own events, as a past date
  // does, and says so when that fails too.
  test('a failed forward list makes today look up its own events, says so on a failure, and Retry loads them', async ({
    page,
  }) => {
    // The helper pins the clock to AFTERNOON, so today is that ET date.
    const lookups = await failOnceThenAnswerLookup(page, etDate(AFTERNOON));

    await page.goto('/');

    await expectFailureThenRetryLoadsCpi(page, lookups);
  });

  // 23:30 CST on Friday 2026-11-13 is already 00:30 on the 14th in New York.
  // The app opens on the ET date (`useVixData` seeds `selectedDate` from
  // `getETToday`), so the date is the 14th: today in ET, which the forward list
  // covers while it loads (the hook assumes ET today .. +30) and once it
  // arrives (`api/events.ts` starts it at `getETToday`). So the page makes no
  // own-date lookup at all, and the 14th's CPI banner comes from the list.
  // Seeded from the CT date, as the app was before 84fea1f3, the date was the
  // 13th, outside the list, and this fails on the date input and the lookup.
  test('at 23:30 CT the date is the ET date, which the forward list covers, so no own-date lookup is made', async ({
    page,
  }) => {
    const lateEvening = new Date('2026-11-14T05:30:00Z');
    const date = etDate(lateEvening);
    expect(date).toBe('2026-11-14');
    await page.clock.setFixedTime(lateEvening);
    await page.route('**/api/**', (route) => route.abort());
    // The forward list: the 14th's CPI, answered under its own date.
    await page.route(
      (url) => url.pathname === '/api/events' && !url.searchParams.has('from'),
      (route) =>
        route.fulfill({
          json: makeEventsResponse(
            [
              {
                event: 'CPI',
                description: 'Consumer Price Index (MoM)',
                time: '8:30',
                severity: 'high',
              },
            ],
            date,
          ),
        }),
    );
    let lookups = 0;
    await page.route(
      (url) => url.pathname === '/api/events' && url.searchParams.has('from'),
      (route) => {
        lookups += 1;
        return route.abort();
      },
    );

    await page.goto('/');

    const main = page.getByRole('main');
    await expect(
      dateTimeSection(page).getByLabel('Date', { exact: true }),
    ).toHaveValue(date);
    await expect(main.getByText('High-Impact Event Day')).toBeVisible();
    await expect(main.getByText('CPI', { exact: true })).toBeVisible();
    // Any lookup for a covered date would have fired at mount, before the
    // banner came from the list.
    expect(lookups).toBe(0);
  });
});
