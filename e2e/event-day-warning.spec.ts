import { test, expect, type Page } from '@playwright/test';
import { chip, dateTimeSection, setEntryTime } from './helpers/calculator';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * The calendar date, YYYY-MM-DD, in Central time at `at`. The app's
 * selectedDate defaults to the CT date (src/hooks/useVixData.ts), which
 * differs from the ET date from 23:00 to 24:00 CT.
 */
function centralDate(at: Date = new Date()): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/** Today's date, matching the app's selectedDate default. */
const TODAY = centralDate();

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
   * page made.
   */
  async function failOnceThenAnswerLookup(page: Page, date: string) {
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
    const lookups = await failOnceThenAnswerLookup(page, TODAY);

    await page.goto('/');

    await expectFailureThenRetryLoadsCpi(page, lookups);
  });

  // 23:30 CST on Friday 2026-11-13 is already 00:30 on the 14th in New York.
  // The app's date defaults to the Central date, and from 23:00 to midnight CT
  // that date is before ET today. The forward list starts at ET today
  // (api/events.ts), and so does the hook's range while that list loads
  // (useEventsForDate), so the date is outside both and the page looks up its
  // own events at mount, rightly: the list never covers it. Only a lookup for
  // the 13th is answered, so this fails whenever `centralDate` returns the
  // Eastern date. The lookup count is compared with the forward list's, not
  // pinned to 1: the dev server's StrictMode runs a mount-time fetch twice, the
  // forward list's too (12 ms apart), so the page makes as many lookups as
  // forward requests. A lookup repeated after the list fails would exceed them
  // (the hook tests in useEventsForDate.test.ts pin exactly one).
  test('the date and its lookup are the Central date when the Eastern date has rolled over', async ({
    page,
  }) => {
    const lateEvening = new Date('2026-11-14T05:30:00Z');
    const date = centralDate(lateEvening);
    expect(date).toBe('2026-11-13');
    await page.clock.setFixedTime(lateEvening);
    await page.route('**/api/**', (route) => route.abort());
    let forwardRequests = 0;
    await page.route(
      (url) => url.pathname === '/api/events' && !url.searchParams.has('from'),
      (route) => {
        forwardRequests += 1;
        return route.abort();
      },
    );
    let lookups = 0;
    await page.route(
      (url) =>
        url.pathname === '/api/events' && url.searchParams.get('from') === date,
      (route) => {
        lookups += 1;
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

    await page.goto('/');

    const main = page.getByRole('main');
    await expect(
      dateTimeSection(page).getByLabel('Date', { exact: true }),
    ).toHaveValue(date);
    await expect(main.getByText('High-Impact Event Day')).toBeVisible();
    await expect(main.getByText('CPI', { exact: true })).toBeVisible();
    // The failed forward list changed nothing the date's lookup depends on.
    expect(forwardRequests).toBeGreaterThan(0);
    expect(lookups).toBe(forwardRequests);
  });
});
