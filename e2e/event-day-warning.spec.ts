import { test, expect } from '@playwright/test';
import { buildApiFetchMock, MOCK_QUOTES } from './helpers/mock-fetch';

/**
 * Today's date in YYYY-MM-DD format, matching the app's selectedDate default.
 */
const TODAY = new Date().toLocaleDateString('en-CA', {
  timeZone: 'America/New_York',
});

function makeEventsResponse(
  events: Array<{
    event: string;
    description: string;
    time: string;
    severity: 'high' | 'medium';
    source?: 'fred' | 'static' | 'finnhub';
  }>,
) {
  return {
    events: events.map((e) => ({
      date: TODAY,
      source: 'fred' as const,
      ...e,
    })),
    startDate: TODAY,
    endDate: TODAY,
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
    await expect(
      page.getByRole('radio', { name: 'CT', exact: true }),
    ).toBeChecked({ timeout: 5000 });

    // Set explicit entry time so results render
    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('30');
    await page.getByRole('radio', { name: 'AM' }).click();

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
    await expect(
      page.getByRole('radio', { name: 'CT', exact: true }),
    ).toBeChecked({ timeout: 5000 });

    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('30');
    await page.getByRole('radio', { name: 'AM' }).click();

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
    await expect(
      page.getByRole('radio', { name: 'CT', exact: true }),
    ).toBeChecked({ timeout: 5000 });

    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('30');
    await page.getByRole('radio', { name: 'AM' }).click();

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
    await expect(
      page.getByRole('radio', { name: 'CT', exact: true }),
    ).toBeChecked({ timeout: 5000 });

    await page.getByLabel('Hour').selectOption('10');
    await page.getByLabel('Minute').selectOption('30');
    await page.getByRole('radio', { name: 'AM' }).click();

    // None of the warning banners should appear
    const main = page.locator('main');
    await expect(main.getByText('High-Impact Event Day')).not.toBeVisible();
    await expect(main.getByText('Economic Event Day')).not.toBeVisible();
    await expect(main.getByText('Market Closed')).not.toBeVisible();
  });
});
