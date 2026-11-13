import { test, expect } from '@playwright/test';
import { chip, dateTimeSection, setEntryTime } from './helpers/calculator';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * Today's date in YYYY-MM-DD format, matching the app's selectedDate default.
 */
const TODAY = new Date().toLocaleDateString('en-CA', {
  timeZone: 'America/New_York',
});

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

  // A past date is outside the forward list, so the app looks up that date's
  // own events (/api/events?from=<date>&days=1) once the date settles. When
  // that lookup fails, a blank banner would read as a quiet day, so the
  // banner says so and offers Retry.
  test("a failed lookup for a past date says so, and Retry loads the date's events", async ({
    page,
  }) => {
    // Registered first, so the more specific lookup route below wins.
    await page.route('**/api/**', (route) => route.abort());
    let lookups = 0;
    await page.route(
      (url) =>
        url.pathname === '/api/events' &&
        url.searchParams.get('from') === PAST_DATE,
      (route) => {
        lookups += 1;
        // The first lookup fails; the retry is answered with an event.
        if (lookups === 1) {
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
            PAST_DATE,
          ),
        });
      },
    );

    await page.goto('/');
    await dateTimeSection(page)
      .getByLabel('Date', { exact: true })
      .fill(PAST_DATE);

    const main = page.getByRole('main');
    const loadFailed = main.getByText("Events for this date couldn't load.");
    await expect(loadFailed).toBeVisible();
    await expect(main.getByText('High-Impact Event Day')).not.toBeVisible();
    expect(lookups).toBe(1);

    await main.getByRole('button', { name: 'Retry' }).click();

    await expect(main.getByText('High-Impact Event Day')).toBeVisible();
    await expect(main.getByText('CPI', { exact: true })).toBeVisible();
    await expect(loadFailed).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    expect(lookups).toBe(2);
  });
});
