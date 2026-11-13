// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../_lib/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

import {
  CACHE_TTL_SEC,
  eventNamesForSnapshot,
  fetchMacroEvents,
  fetchMarketEvents,
  getEventsForDate,
  isEarningsEventName,
  type EventItem,
} from '../_lib/market-events.js';
import { redis } from '../_lib/redis.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

const CPI_DAY = '2026-05-12';
const FOMC_SEP_DAY = '2026-06-17';
const DAY_KEY = `events:day:v3:${CPI_DAY}`;
const RELEASE_KEY = 'fred:release-dates:v1';
const RELEASE_TTL_SEC = 12 * 60 * 60;

/** Redis `set` calls whose key starts with `prefix`, as [key, value, options]. */
function writesTo(prefix: string) {
  return vi
    .mocked(redis.set)
    .mock.calls.filter(([key]) => key.startsWith(prefix));
}

/** The keys passed to Redis `get` that start with `prefix`. */
function keysRead(prefix: string): string[] {
  return vi
    .mocked(redis.get)
    .mock.calls.map(([key]) => key)
    .filter((key) => key.startsWith(prefix));
}

/** The release ID in a FRED `release/dates` request URL. */
function releaseIdOf(url: string): number {
  return Number(new URL(url).searchParams.get('release_id'));
}

/** The release IDs a FRED fetch mock was asked for, ascending. */
function releasesRequested(fetchMock: {
  mock: { calls: ReadonlyArray<readonly [string]> };
}): number[] {
  return fetchMock.mock.calls
    .map(([url]) => releaseIdOf(url))
    .sort((a, b) => a - b);
}

/**
 * Redis answers each release-date key from `cachedByRelease` (a release it
 * does not list is a miss) and every other key with a miss.
 */
function stubCachedReleaseDates(
  cachedByRelease: Partial<Record<number, unknown>>,
) {
  vi.mocked(redis.get).mockImplementation((key: string) => {
    if (!key.startsWith(`${RELEASE_KEY}:`)) return Promise.resolve(null);
    const releaseId = Number(key.slice(RELEASE_KEY.length + 1));
    return Promise.resolve(cachedByRelease[releaseId] ?? null);
  });
}

/**
 * FRED answers every tracked release with its own dates. Finnhub answers
 * with an empty earnings calendar unless a test overrides the stub.
 */
function stubFredFetch(datesByRelease: Record<number, readonly string[]> = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('https://finnhub.io/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ earningsCalendar: [] }),
      });
    }
    const releaseId = Number(new URL(url).searchParams.get('release_id'));
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          release_dates: (datesByRelease[releaseId] ?? []).map((date) => ({
            release_id: releaseId,
            date,
          })),
        }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function urlsCalled(fetchMock: {
  mock: { calls: ReadonlyArray<readonly [string]> };
}): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
}

type Reply = () => Promise<unknown>;

const okJson =
  (body: unknown): Reply =>
  () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

const nonOk: Reply = () => Promise.resolve({ ok: false, status: 500 });

/** A 200 whose body is not JSON, so `res.json()` rejects. */
const unparseable: Reply = () =>
  Promise.resolve({
    ok: true,
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  });

const networkDown: Reply = () => Promise.reject(new Error('Network timeout'));

/** FRED and Finnhub answer independently; an omitted source answers empty. */
function stubSources({ fred, finnhub }: { fred?: Reply; finnhub?: Reply }) {
  const fetchMock = vi.fn((url: string) =>
    url.startsWith('https://finnhub.io/')
      ? (finnhub ?? okJson({ earningsCalendar: [] }))()
      : (fred ?? okJson({ release_dates: [] }))(),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Ties `isEarningsEventName` to the names the fetcher really builds: every
 * Finnhub event matches it, and no FRED or static event does. The regex's own
 * table tests would stay green if the `${symbol} Earnings` template changed,
 * and the snapshot's incomplete-path union would then let earnings through.
 */
function expectEarningsRegexMatchesTemplate(events: readonly EventItem[]) {
  const earnings = events.filter((e) => e.source === 'finnhub');
  const others = events.filter((e) => e.source !== 'finnhub');
  expect(earnings.length).toBeGreaterThan(0);
  expect(earnings.map((e) => isEarningsEventName(e.event))).not.toContain(
    false,
  );
  expect(others.map((e) => isEarningsEventName(e.event))).not.toContain(true);
}

/** One Finnhub earnings row, the shape the calendar endpoint returns. */
function earning(symbol: string, date: string) {
  return {
    date,
    epsActual: null,
    epsEstimate: 1,
    hour: 'bmo',
    quarter: 1,
    revenueActual: null,
    revenueEstimate: 1,
    symbol,
    year: 2026,
  };
}

function event(overrides: Partial<EventItem> = {}): EventItem {
  return {
    date: CPI_DAY,
    event: 'CPI',
    description: 'Consumer Price Index',
    time: '8:30 AM',
    severity: 'high',
    source: 'fred',
    ...overrides,
  };
}

describe('market-events', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.FRED_API_KEY = 'fred-key';
    delete process.env.FINNHUB_API_KEY;
    vi.resetAllMocks();
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue('OK');
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe('fetchMarketEvents', () => {
    it('keeps only the single date requested from FRED history', async () => {
      stubFredFetch({
        10: ['2026-04-10', CPI_DAY, '2026-06-10'],
        46: ['2026-05-13'],
      });

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(true);
      expect(events).toEqual([
        {
          date: CPI_DAY,
          event: 'CPI',
          description: 'Consumer Price Index',
          time: '8:30 AM',
          severity: 'high',
          source: 'fred',
        },
      ]);
    });

    it('adds the FOMC + SEP static for its decision day', async () => {
      stubFredFetch();

      const { events } = await fetchMarketEvents(FOMC_SEP_DAY, FOMC_SEP_DAY);

      expect(events).toEqual([
        {
          date: FOMC_SEP_DAY,
          event: 'FOMC + SEP',
          description:
            'Fed rate decision + Summary of Economic Projections (dot plot)',
          time: '2:00 PM',
          severity: 'high',
          source: 'static',
        },
      ]);
    });

    it.each([
      ['2026-11-27', 'EARLY CLOSE'],
      ['2026-04-03', 'CLOSED'],
    ])('adds the half-day static for %s as %s', async (date, name) => {
      stubFredFetch();

      const { events } = await fetchMarketEvents(date, date);

      expect(events.map((e) => [e.date, e.event, e.source])).toEqual([
        [date, name, 'static'],
      ]);
    });

    it('returns no events for an ordinary date', async () => {
      stubFredFetch();

      const result = await fetchMarketEvents('2026-05-14', '2026-05-14');

      expect(result).toEqual({ events: [], complete: true });
    });

    it('sorts by date, then high before medium, then event name', async () => {
      // 2026-06-17: CPI (high) and GDP (medium) from FRED plus the FOMC + SEP
      // static (high). 2026-06-16: PPI. Name order breaks the high-severity tie.
      stubFredFetch({
        10: [FOMC_SEP_DAY],
        53: [FOMC_SEP_DAY],
        46: ['2026-06-16'],
      });

      const { events } = await fetchMarketEvents('2026-06-16', FOMC_SEP_DAY);

      expect(events.map((e) => [e.date, e.event])).toEqual([
        ['2026-06-16', 'PPI'],
        [FOMC_SEP_DAY, 'CPI'],
        [FOMC_SEP_DAY, 'FOMC + SEP'],
        [FOMC_SEP_DAY, 'GDP'],
      ]);
    });

    it('is incomplete when FRED answers non-OK, and still returns the statics', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      );

      const { events, complete } = await fetchMarketEvents(
        FOMC_SEP_DAY,
        FOMC_SEP_DAY,
      );

      expect(complete).toBe(false);
      expect(events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'FRED API non-OK',
        expect.objectContaining({ level: 'warning' }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ status: 503 }),
        'FRED API error',
      );
    });

    it('is incomplete when only one FRED release answers non-OK', async () => {
      const fetchMock = vi.fn((url: string) => {
        const releaseId = new URL(url).searchParams.get('release_id');
        if (releaseId === '54')
          return Promise.resolve({ ok: false, status: 500 });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ release_dates: [] }),
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const { complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(false);
    });

    it('returns static events only, incomplete, when FRED_API_KEY is unset', async () => {
      delete process.env.FRED_API_KEY;
      const fetchMock = stubFredFetch();

      const { events, complete } = await fetchMarketEvents(
        FOMC_SEP_DAY,
        FOMC_SEP_DAY,
      );

      expect(complete).toBe(false);
      expect(events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'FRED_API_KEY not configured; returning static events only',
      );
    });

    it('still adds Finnhub earnings when only FINNHUB_API_KEY is set', async () => {
      delete process.env.FRED_API_KEY;
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            earningsCalendar: [
              {
                date: CPI_DAY,
                epsActual: null,
                epsEstimate: 1,
                hour: 'amc',
                quarter: 1,
                revenueActual: null,
                revenueEstimate: 1,
                symbol: 'NVDA',
                year: 2026,
              },
            ],
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(false);
      expect(events.map((e) => [e.event, e.source])).toEqual([
        ['NVDA Earnings', 'finnhub'],
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toMatch(
        /^https:\/\/finnhub\.io\/api\/v1\/calendar\/earnings\?/,
      );
    });

    it('is incomplete when Finnhub answers non-OK, and keeps the FRED events', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (url.startsWith('https://finnhub.io/')) {
            return Promise.resolve({ ok: false, status: 500 });
          }
          const isCpi = new URL(url).searchParams.get('release_id') === '10';
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                release_dates: isCpi ? [{ release_id: 10, date: CPI_DAY }] : [],
              }),
          });
        }),
      );

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(false);
      expect(events.map((e) => e.event)).toEqual(['CPI']);
      expect(logger.error).toHaveBeenCalledWith(
        { status: 500 },
        'Finnhub earnings API error',
      );
    });

    it('is incomplete when the Finnhub fetch throws', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (url.startsWith('https://finnhub.io/')) {
            return Promise.reject(new Error('Network timeout'));
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ release_dates: [] }),
          });
        }),
      );

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(false);
      expect(events).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Finnhub earnings fetch failed',
      );
    });

    it('is incomplete when the Finnhub body is not JSON', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({ finnhub: unparseable });

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(false);
      expect(events).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(SyntaxError) },
        'Finnhub earnings fetch failed',
      );
    });

    it.each([
      ['an empty object', {}],
      ['a null calendar', { earningsCalendar: null }],
      ['a calendar that is not an array', { earningsCalendar: 'oops' }],
      ['a null body', null],
    ])(
      'is incomplete when Finnhub answers 200 with %s',
      async (_label, body) => {
        process.env.FINNHUB_API_KEY = 'finnhub-key';
        stubSources({ finnhub: okJson(body) });

        const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

        expect(complete).toBe(false);
        expect(events).toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
          'Finnhub earnings malformed payload',
        );
      },
    );

    it('stays complete when Finnhub answers 200 with an empty earnings calendar', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({ finnhub: okJson({ earningsCalendar: [] }) });

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(true);
      expect(events).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('stays complete, with the earnings, when Finnhub answers normally', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({
        finnhub: okJson({
          earningsCalendar: [
            {
              date: CPI_DAY,
              epsActual: null,
              epsEstimate: 1,
              hour: 'bmo',
              quarter: 1,
              revenueActual: null,
              revenueEstimate: 1,
              symbol: 'MSFT',
              year: 2026,
            },
          ],
        }),
      });

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(true);
      expect(events.map((e) => e.event)).toEqual(['MSFT Earnings']);
      expectEarningsRegexMatchesTemplate(events);
    });

    it('keeps only the Finnhub earnings inside the requested range', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({
        finnhub: okJson({
          earningsCalendar: [
            earning('AAPL', '2026-05-11'),
            earning('MSFT', CPI_DAY),
            earning('NVDA', '2026-05-13'),
          ],
        }),
      });

      const { events, complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(true);
      expect(events.map((e) => [e.date, e.event])).toEqual([
        [CPI_DAY, 'MSFT Earnings'],
      ]);
    });

    it('keeps Finnhub earnings on the first and last day of the range', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({
        finnhub: okJson({
          earningsCalendar: [
            earning('AAPL', '2026-05-10'),
            earning('MSFT', '2026-05-11'),
            earning('NVDA', '2026-05-13'),
            earning('TSLA', '2026-05-14'),
          ],
        }),
      });

      const { events } = await fetchMarketEvents('2026-05-11', '2026-05-13');

      expect(events.map((e) => [e.date, e.event])).toEqual([
        ['2026-05-11', 'MSFT Earnings'],
        ['2026-05-13', 'NVDA Earnings'],
      ]);
    });

    it('merges the macro events and the earnings into one sorted list', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      // 06-16: PPI (medium) and AAPL earnings (high). 06-17: CPI, the FOMC +
      // SEP static and NVDA earnings, all high, so the name breaks the tie.
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('https://finnhub.io/')) {
          return okJson({
            earningsCalendar: [
              earning('NVDA', FOMC_SEP_DAY),
              earning('AAPL', '2026-06-16'),
            ],
          })();
        }
        const releaseId = Number(new URL(url).searchParams.get('release_id'));
        const dates: Record<number, string> = {
          10: FOMC_SEP_DAY,
          46: '2026-06-16',
        };
        const date = dates[releaseId];
        return okJson({
          release_dates: date == null ? [] : [{ release_id: releaseId, date }],
        })();
      });
      vi.stubGlobal('fetch', fetchMock);

      const { events, complete } = await fetchMarketEvents(
        '2026-06-16',
        FOMC_SEP_DAY,
      );

      expect(complete).toBe(true);
      expect(events.map((e) => [e.date, e.event])).toEqual([
        ['2026-06-16', 'AAPL Earnings'],
        ['2026-06-16', 'PPI'],
        [FOMC_SEP_DAY, 'CPI'],
        [FOMC_SEP_DAY, 'FOMC + SEP'],
        [FOMC_SEP_DAY, 'NVDA Earnings'],
      ]);
      // FRED and static events sit beside the earnings here, so the rule is
      // checked both ways.
      expectEarningsRegexMatchesTemplate(events);
    });

    it('rejects when a FRED fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      await expect(fetchMarketEvents(CPI_DAY, CPI_DAY)).rejects.toThrow(
        'network down',
      );
    });

    it('rejects when a FRED body is not JSON', async () => {
      stubSources({ fred: unparseable });

      await expect(fetchMarketEvents(CPI_DAY, CPI_DAY)).rejects.toThrow(
        'Unexpected token <',
      );
    });

    it.each([
      ['an empty object', {}],
      ['a null release list', { release_dates: null }],
      ['a release list that is not an array', { release_dates: 'oops' }],
      ['a null body', null],
    ])('is incomplete when FRED answers 200 with %s', async (_label, body) => {
      stubSources({ fred: okJson(body) });

      const { events, complete } = await fetchMarketEvents(
        FOMC_SEP_DAY,
        FOMC_SEP_DAY,
      );

      expect(complete).toBe(false);
      expect(events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ releaseId: expect.any(Number) }),
        'FRED API malformed payload',
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'FRED API malformed payload',
        {
          level: 'warning',
          extra: { releaseId: expect.any(Number) },
        },
      );
    });

    it('treats an empty release list as the normal no-events payload', async () => {
      stubSources({ fred: okJson({ release_dates: [] }) });

      const { complete } = await fetchMarketEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(true);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  // The stored snapshot flag counts macro events only (owner decision
  // 2026-11-12): the tracked FRED releases, FOMC and the half-day statics.
  describe('fetchMacroEvents', () => {
    it('returns the FRED releases and the statics for the date, sorted, complete', async () => {
      stubFredFetch({ 10: [FOMC_SEP_DAY], 53: [FOMC_SEP_DAY] });

      const { events, complete } = await fetchMacroEvents(
        FOMC_SEP_DAY,
        FOMC_SEP_DAY,
      );

      expect(complete).toBe(true);
      expect(events.map((e) => [e.event, e.source])).toEqual([
        ['CPI', 'fred'],
        ['FOMC + SEP', 'static'],
        ['GDP', 'fred'],
      ]);
    });

    // Pins the FRED release-ID map. On 2026-11-12 release 51 (U.S.
    // International Trade) was found mapped to PPI and 110 (Personal Income by
    // State) to JOLTS; the real releases are 46 and 192. Each ID below was
    // checked against FRED's `fred/release?release_id=<id>` on that date. A
    // wrong ID returns 200 with another release's dates, so nothing else in
    // the suite would notice.
    it('asks FRED for exactly the seven tracked releases and names each one right', async () => {
      const releases = [
        [10, 'CPI', '2026-05-01'],
        [50, 'NFP', '2026-05-02'],
        [53, 'GDP', '2026-05-03'],
        [54, 'PCE', '2026-05-04'],
        [46, 'PPI', '2026-05-05'],
        [9, 'Retail Sales', '2026-05-06'],
        [192, 'JOLTS', '2026-05-07'],
      ] as const;
      const fetchMock = stubFredFetch(
        Object.fromEntries(releases.map(([id, , date]) => [id, [date]])),
      );

      const { events } = await fetchMacroEvents('2026-05-01', '2026-05-07');

      const requestedIds = urlsCalled(fetchMock)
        .map((url) => Number(new URL(url).searchParams.get('release_id')))
        .sort((a, b) => a - b);
      expect(requestedIds).toEqual([9, 10, 46, 50, 53, 54, 192]);
      expect(events.map((e) => [e.date, e.event])).toEqual(
        releases.map(([, name, date]) => [date, name]),
      );
    });

    it('makes no Finnhub call, even with a Finnhub key set', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      const fetchMock = stubSources({
        finnhub: okJson({ earningsCalendar: [earning('NVDA', CPI_DAY)] }),
      });

      const { events, complete } = await fetchMacroEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(true);
      expect(events).toEqual([]);
      expect(urlsCalled(fetchMock).length).toBeGreaterThan(0);
      expect(
        urlsCalled(fetchMock).filter((url) => url.includes('finnhub')),
      ).toEqual([]);
    });

    it.each([
      ['answers non-OK', nonOk],
      ['cannot be reached', networkDown],
      ['sends a body that is not JSON', unparseable],
    ])('stays complete when a Finnhub that %s', async (_label, finnhub) => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({ finnhub });

      const { complete } = await fetchMacroEvents(CPI_DAY, CPI_DAY);

      expect(complete).toBe(true);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('is incomplete when a FRED release answers non-OK, and keeps the statics', async () => {
      stubSources({ fred: nonOk });

      const { events, complete } = await fetchMacroEvents(
        FOMC_SEP_DAY,
        FOMC_SEP_DAY,
      );

      expect(complete).toBe(false);
      expect(events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'FRED API non-OK',
        expect.objectContaining({ level: 'warning' }),
      );
    });

    it('is incomplete, with the statics only, when FRED_API_KEY is unset', async () => {
      delete process.env.FRED_API_KEY;
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      const fetchMock = stubFredFetch();

      const { events, complete } = await fetchMacroEvents(
        FOMC_SEP_DAY,
        FOMC_SEP_DAY,
      );

      expect(complete).toBe(false);
      expect(events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when a FRED fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      await expect(fetchMacroEvents(CPI_DAY, CPI_DAY)).rejects.toThrow(
        'network down',
      );
    });
  });

  // FRED's `release/dates` answers a release's whole history, so each release's
  // date list is kept in Redis for 12 hours and a new window costs no FRED
  // calls while the lists are warm.
  describe('FRED release-date cache', () => {
    const START = '2026-05-12';
    const END = '2026-05-14';
    const ALL_RELEASES = [9, 10, 46, 50, 53, 54, 192];

    it('serves a hit with no FRED fetch, keeping only the dates inside the window', async () => {
      stubCachedReleaseDates({
        ...Object.fromEntries(ALL_RELEASES.map((id) => [id, []])),
        10: ['2026-05-11', START, END, '2026-05-15'],
        50: ['2026-05-13'],
      });
      const fetchMock = stubFredFetch({ 10: ['2026-09-09'] });

      const { events, complete } = await fetchMacroEvents(START, END);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(complete).toBe(true);
      expect(events.map((e) => [e.date, e.event, e.source])).toEqual([
        [START, 'CPI', 'fred'],
        ['2026-05-13', 'NFP', 'fred'],
        [END, 'CPI', 'fred'],
      ]);
      expect(redis.get).toHaveBeenCalledWith(`${RELEASE_KEY}:10`);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('on a miss fetches each release once and writes its full sorted date list for 12 hours', async () => {
      const fetchMock = stubFredFetch({
        10: ['2026-06-10', START, '2026-04-10'],
        50: ['2026-05-08'],
      });

      const { events, complete } = await fetchMacroEvents(START, END);

      expect(complete).toBe(true);
      expect(events.map((e) => [e.date, e.event])).toEqual([[START, 'CPI']]);
      expect(releasesRequested(fetchMock)).toEqual(ALL_RELEASES);
      expect(writesTo(RELEASE_KEY)).toHaveLength(7);
      // The whole history, sorted, as date strings only: not the window, and
      // not FRED's entries.
      expect(redis.set).toHaveBeenCalledWith(
        `${RELEASE_KEY}:10`,
        ['2026-04-10', START, '2026-06-10'],
        { ex: RELEASE_TTL_SEC },
      );
      expect(redis.set).toHaveBeenCalledWith(
        `${RELEASE_KEY}:50`,
        ['2026-05-08'],
        { ex: RELEASE_TTL_SEC },
      );
      expect(redis.set).toHaveBeenCalledWith(`${RELEASE_KEY}:9`, [], {
        ex: RELEASE_TTL_SEC,
      });
    });

    it('fetches only the release that is not cached', async () => {
      stubCachedReleaseDates({ 10: [START] });
      const fetchMock = stubFredFetch({ 50: ['2026-05-13'] });

      const { events } = await fetchMacroEvents(START, END);

      expect(releasesRequested(fetchMock)).toEqual([9, 46, 50, 53, 54, 192]);
      expect(events.map((e) => [e.date, e.event])).toEqual([
        [START, 'CPI'],
        ['2026-05-13', 'NFP'],
      ]);
      // A hit is not rewritten, so it does not stretch its own 12 hours.
      expect(writesTo(RELEASE_KEY).map(([key]) => key)).not.toContain(
        `${RELEASE_KEY}:10`,
      );
      expect(writesTo(RELEASE_KEY)).toHaveLength(6);
    });

    it.each([
      ['non-OK', nonOk],
      ['200 with an empty object', okJson({})],
      ['200 with a null release list', okJson({ release_dates: null })],
      [
        '200 with a release list that is not an array',
        okJson({ release_dates: 'oops' }),
      ],
      ['200 with a null body', okJson(null)],
    ])('writes nothing when FRED answers %s', async (_label, fred) => {
      stubSources({ fred });

      const { complete } = await fetchMacroEvents(START, END);

      expect(complete).toBe(false);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('writes nothing, and rejects, when a FRED body is not JSON', async () => {
      stubSources({ fred: unparseable });

      await expect(fetchMacroEvents(START, END)).rejects.toThrow(
        'Unexpected token <',
      );
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('caches the releases that answered well when another answers non-OK', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          const releaseId = releaseIdOf(url);
          return releaseId === 10
            ? nonOk()
            : okJson({
                release_dates: [{ release_id: releaseId, date: START }],
              })();
        }),
      );

      const { complete } = await fetchMacroEvents(START, END);

      expect(complete).toBe(false);
      expect(
        writesTo(RELEASE_KEY)
          .map(([key]) => key)
          .sort(),
      ).toEqual(
        ALL_RELEASES.filter((id) => id !== 10)
          .map((id) => `${RELEASE_KEY}:${id}`)
          .sort(),
      );
    });

    // A cached null would fail the string check on every read, so the release
    // would miss for its whole 12 hours.
    it('writes only the string dates when FRED sends an entry with no date', async () => {
      stubSources({
        fred: okJson({
          release_dates: [{ release_id: 10, date: START }, { release_id: 10 }],
        }),
      });

      await fetchMacroEvents(START, END);

      expect(redis.set).toHaveBeenCalledWith(`${RELEASE_KEY}:10`, [START], {
        ex: RELEASE_TTL_SEC,
      });
    });

    it.each([
      ['a string', START],
      ['an object', { 0: START }],
      ['an array of objects', [{ release_id: 10, date: START }]],
      ['an array holding a non-string', [START, 20260513]],
    ])(
      'treats %s in the cache as a miss and repairs it',
      async (_label, cached) => {
        stubCachedReleaseDates({ 10: cached });
        const fetchMock = stubFredFetch({ 10: [START] });

        const { events } = await fetchMacroEvents(START, END);

        expect(releasesRequested(fetchMock)).toContain(10);
        expect(events.map((e) => [e.date, e.event])).toEqual([[START, 'CPI']]);
        expect(redis.set).toHaveBeenCalledWith(`${RELEASE_KEY}:10`, [START], {
          ex: RELEASE_TTL_SEC,
        });
      },
    );

    it('falls through to FRED, and logs a warning, when the Redis read throws', async () => {
      vi.mocked(redis.get).mockRejectedValue(new Error('redis read failed'));
      const fetchMock = stubFredFetch({ 10: [START] });

      const { events, complete } = await fetchMacroEvents(START, END);

      expect(complete).toBe(true);
      expect(events.map((e) => e.event)).toEqual(['CPI']);
      expect(fetchMock).toHaveBeenCalledTimes(7);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), releaseId: 10 },
        'Failed to read FRED release dates from Redis',
      );
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('still returns the dates, and logs one warning per release, when the Redis write throws', async () => {
      vi.mocked(redis.set).mockRejectedValue(new Error('redis write failed'));
      stubFredFetch({ 10: [START] });

      const { events, complete } = await fetchMacroEvents(START, END);

      expect(complete).toBe(true);
      expect(events.map((e) => e.event)).toEqual(['CPI']);
      expect(logger.warn).toHaveBeenCalledTimes(7);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), releaseId: 10 },
        'Failed to cache FRED release dates in Redis',
      );
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('lets a second date reuse the release lists the first date fetched', async () => {
      const store = new Map<string, unknown>();
      vi.mocked(redis.get).mockImplementation((key) =>
        Promise.resolve(store.get(key) ?? null),
      );
      vi.mocked(redis.set).mockImplementation((key, value) => {
        store.set(key, value);
        return Promise.resolve('OK');
      });
      const fetchMock = stubFredFetch({ 10: [CPI_DAY, '2026-06-10'] });

      const first = await getEventsForDate(CPI_DAY);
      expect(fetchMock).toHaveBeenCalledTimes(7);
      fetchMock.mockClear();
      const second = await getEventsForDate('2026-06-10');

      expect(first.events.map((e) => e.event)).toEqual(['CPI']);
      expect(second.events.map((e) => [e.date, e.event])).toEqual([
        ['2026-06-10', 'CPI'],
      ]);
      expect(second.fromCache).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getEventsForDate', () => {
    it('returns the cached events on a hit and makes no fetch', async () => {
      const cached = [event()];
      vi.mocked(redis.get).mockResolvedValue({
        data: cached,
        cachedAt: 1_700_000_000_000,
      });
      const fetchMock = stubFredFetch();

      const result = await getEventsForDate(CPI_DAY);

      expect(result).toEqual({
        events: cached,
        complete: true,
        fromCache: true,
      });
      expect(redis.get).toHaveBeenCalledWith(DAY_KEY);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('fetches on a miss and caches the complete result for the TTL', async () => {
      const fetchMock = stubFredFetch({ 10: [CPI_DAY] });

      const result = await getEventsForDate(CPI_DAY);

      expect(result.complete).toBe(true);
      expect(result.fromCache).toBe(false);
      expect(result.events.map((e) => e.event)).toEqual(['CPI']);
      expect(urlsCalled(fetchMock).length).toBeGreaterThan(0);
      expect(writesTo('events:day:')).toHaveLength(1);
      expect(redis.set).toHaveBeenCalledWith(
        DAY_KEY,
        { data: result.events, cachedAt: expect.any(Number) },
        { ex: CACHE_TTL_SEC },
      );
    });

    it('caches an empty day, so a quiet date is not refetched', async () => {
      stubFredFetch();

      const result = await getEventsForDate('2026-05-14');

      expect(result).toEqual({ events: [], complete: true, fromCache: false });
      expect(redis.set).toHaveBeenCalledWith(
        'events:day:v3:2026-05-14',
        { data: [], cachedAt: expect.any(Number) },
        { ex: CACHE_TTL_SEC },
      );
    });

    it('caches an incomplete result for five minutes, marked complete: false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      );

      const result = await getEventsForDate(FOMC_SEP_DAY);

      expect(result.complete).toBe(false);
      expect(result.fromCache).toBe(false);
      expect(result.events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        `events:day:v3:${FOMC_SEP_DAY}`,
        { data: result.events, cachedAt: expect.any(Number), complete: false },
        { ex: 300 },
      );
    });

    it('caches the static-only result for five minutes when FRED_API_KEY is unset', async () => {
      delete process.env.FRED_API_KEY;
      stubFredFetch();

      const result = await getEventsForDate(FOMC_SEP_DAY);

      expect(result.complete).toBe(false);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        `events:day:v3:${FOMC_SEP_DAY}`,
        { data: result.events, cachedAt: expect.any(Number), complete: false },
        { ex: 300 },
      );
    });

    it('returns an incomplete cached entry as incomplete and makes no fetch', async () => {
      const partial = [event({ event: 'FOMC + SEP', source: 'static' })];
      vi.mocked(redis.get).mockResolvedValue({
        data: partial,
        cachedAt: 1_700_000_000_000,
        complete: false,
      });
      const fetchMock = stubFredFetch();

      const result = await getEventsForDate(CPI_DAY);

      expect(result).toEqual({
        events: partial,
        complete: false,
        fromCache: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it.each([
      ['has no complete field (written by phase 1)', {}, true],
      ['says complete: true', { complete: true }, true],
      ['says complete: false', { complete: false }, false],
    ])('reads a cached entry that %s', async (_label, flag, expected) => {
      vi.mocked(redis.get).mockResolvedValue({
        data: [event()],
        cachedAt: 1_700_000_000_000,
        ...flag,
      });
      const fetchMock = stubFredFetch();

      const result = await getEventsForDate(CPI_DAY);

      expect(result.complete).toBe(expected);
      expect(result.fromCache).toBe(true);
      expect(result.events.map((e) => e.event)).toEqual(['CPI']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('writes a complete result for seven days with no complete: false, and reads it back as complete', async () => {
      stubFredFetch({ 10: [CPI_DAY] });

      await getEventsForDate(CPI_DAY);

      const dayWrites = writesTo('events:day:');
      expect(dayWrites).toHaveLength(1);
      const [key, entry, options] = dayWrites[0] ?? [];
      expect(key).toBe(DAY_KEY);
      expect(options).toEqual({ ex: 7 * 24 * 60 * 60 });
      expect((entry as { complete?: boolean }).complete).not.toBe(false);

      vi.mocked(redis.get).mockResolvedValue(entry);
      const fetchMock = stubFredFetch();
      const again = await getEventsForDate(CPI_DAY);
      expect(again.complete).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still returns the incomplete result, and logs, when its short cache write throws', async () => {
      vi.mocked(redis.set).mockRejectedValue(new Error('redis write failed'));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      );

      const result = await getEventsForDate(FOMC_SEP_DAY);

      expect(result.complete).toBe(false);
      expect(result.events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Failed to cache day events in Redis',
      );
    });

    it('still fetches, and logs, when the Redis read throws', async () => {
      vi.mocked(redis.get).mockRejectedValue(new Error('redis read failed'));
      const fetchMock = stubFredFetch({ 10: [CPI_DAY] });

      const result = await getEventsForDate(CPI_DAY);

      expect(result.events.map((e) => e.event)).toEqual(['CPI']);
      expect(fetchMock).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Failed to read day events from Redis',
      );
    });

    it('still returns the events, and logs, when the Redis write throws', async () => {
      vi.mocked(redis.set).mockRejectedValue(new Error('redis write failed'));
      stubFredFetch({ 10: [CPI_DAY] });

      const result = await getEventsForDate(CPI_DAY);

      expect(result.complete).toBe(true);
      expect(result.events.map((e) => e.event)).toEqual(['CPI']);
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Failed to cache day events in Redis',
      );
    });

    it.each([
      ['a plain array', [event()]],
      ['a wrapper with no data', { cachedAt: 1 }],
      ['a wrapper whose data is not an array', { data: 'oops', cachedAt: 1 }],
    ])('treats %s in the cache as a miss', async (_label, cached) => {
      vi.mocked(redis.get).mockResolvedValue(cached);
      const fetchMock = stubFredFetch({ 10: [CPI_DAY] });

      const result = await getEventsForDate(CPI_DAY);

      expect(fetchMock).toHaveBeenCalled();
      expect(result.events.map((e) => e.event)).toEqual(['CPI']);
    });

    it('caches an empty incomplete entry for five minutes, then rejects, when a FRED fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      await expect(getEventsForDate(CPI_DAY)).rejects.toThrow('network down');
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        DAY_KEY,
        { data: [], cachedAt: expect.any(Number), complete: false },
        { ex: 300 },
      );
    });

    it('caches an empty incomplete entry for five minutes, then rejects, when a FRED body is not JSON', async () => {
      stubSources({ fred: unparseable });

      await expect(getEventsForDate(CPI_DAY)).rejects.toThrow(
        'Unexpected token <',
      );
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        DAY_KEY,
        { data: [], cachedAt: expect.any(Number), complete: false },
        { ex: 300 },
      );
    });

    it('rethrows the original error, and logs, when the write after a rejected fetch throws', async () => {
      vi.mocked(redis.set).mockRejectedValue(new Error('redis write failed'));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      await expect(getEventsForDate(CPI_DAY)).rejects.toThrow('network down');
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Failed to cache day events in Redis',
      );
    });

    it('answers a repeat call from the failure entry without fetching again', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);
      await expect(getEventsForDate(CPI_DAY)).rejects.toThrow('network down');
      const [, entry] = vi.mocked(redis.set).mock.calls[0] ?? [];
      fetchMock.mockClear();

      vi.mocked(redis.get).mockResolvedValue(entry);
      const again = await getEventsForDate(CPI_DAY);

      expect(again).toEqual({ events: [], complete: false, fromCache: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the statics, and caches them for five minutes, when FRED answers 200 with {}', async () => {
      stubSources({ fred: okJson({}) });

      const result = await getEventsForDate(FOMC_SEP_DAY);

      expect(result.complete).toBe(false);
      expect(result.events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        `events:day:v3:${FOMC_SEP_DAY}`,
        { data: result.events, cachedAt: expect.any(Number), complete: false },
        { ex: 300 },
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'FRED API malformed payload',
        expect.objectContaining({ level: 'warning' }),
      );
    });

    // The stored flag is macro-only (owner decision 2026-11-12): the day lookup
    // never asks Finnhub, so nothing Finnhub does can change what it returns.
    it.each([
      ['answers non-OK', nonOk],
      ['cannot be reached', networkDown],
      ['sends a body that is not JSON', unparseable],
      ['answers 200 with {}', okJson({})],
      [
        'has earnings on the date',
        okJson({ earningsCalendar: [earning('NVDA', CPI_DAY)] }),
      ],
    ])(
      'never calls Finnhub, so a Finnhub that %s changes nothing: complete, no earnings, kept seven days',
      async (_label, finnhub) => {
        process.env.FINNHUB_API_KEY = 'finnhub-key';
        const fetchMock = stubSources({ finnhub });

        const result = await getEventsForDate(CPI_DAY);

        expect(result).toEqual({
          events: [],
          complete: true,
          fromCache: false,
        });
        expect(
          urlsCalled(fetchMock).filter((url) => url.includes('finnhub')),
        ).toEqual([]);
        expect(writesTo('events:day:')).toHaveLength(1);
        expect(redis.set).toHaveBeenCalledWith(
          DAY_KEY,
          { data: [], cachedAt: expect.any(Number) },
          { ex: CACHE_TTL_SEC },
        );
      },
    );

    it('reads and writes the v3 key, and ignores a v2 entry built from the wrong PPI and JOLTS release IDs', async () => {
      const v2Entry = {
        data: [event({ event: 'PPI', severity: 'medium' })],
        cachedAt: 1_700_000_000_000,
      };
      vi.mocked(redis.get).mockImplementation((key: string) =>
        Promise.resolve(key === `events:day:v2:${CPI_DAY}` ? v2Entry : null),
      );
      stubFredFetch({ 10: [CPI_DAY] });

      const result = await getEventsForDate(CPI_DAY);

      expect(keysRead('events:day:')).toEqual([DAY_KEY]);
      expect(result.fromCache).toBe(false);
      expect(result.events.map((e) => e.event)).toEqual(['CPI']);
      expect(redis.set).toHaveBeenCalledWith(DAY_KEY, expect.anything(), {
        ex: CACHE_TTL_SEC,
      });
    });
  });

  describe('CACHE_TTL_SEC', () => {
    it('is seven days', () => {
      expect(CACHE_TTL_SEC).toBe(7 * 24 * 60 * 60);
    });
  });

  describe('eventNamesForSnapshot', () => {
    it('returns the macro names in the given order, duplicates kept, and drops the Finnhub events', () => {
      const events = [
        event({ event: 'FOMC + SEP', source: 'static' }),
        event({ event: 'AAPL Earnings', source: 'finnhub' }),
        event({ event: 'CPI' }),
        event({ event: 'CPI' }),
        event({ event: 'NVDA Earnings', source: 'finnhub' }),
        event({ event: 'EARLY CLOSE', source: 'static' }),
      ];

      expect(eventNamesForSnapshot(events)).toEqual([
        'FOMC + SEP',
        'CPI',
        'CPI',
        'EARLY CLOSE',
      ]);
    });

    it('returns an empty list when only earnings are left', () => {
      expect(
        eventNamesForSnapshot([
          event({ event: 'NVDA Earnings', source: 'finnhub' }),
        ]),
      ).toEqual([]);
    });

    it('returns an empty list for no events', () => {
      expect(eventNamesForSnapshot([])).toEqual([]);
    });
  });

  describe('isEarningsEventName', () => {
    it.each([
      ['NVDA Earnings', true],
      ['AAPL Earnings', true],
      ['CPI', false],
      ['FOMC + SEP', false],
      ['EARLY CLOSE', false],
      // The leading space and the end anchor are both part of the rule.
      ['Earnings Season', false],
      ['Earnings', false],
      ['NVDA Earnings Call', false],
      ['NVDA Earnings ', false],
      ['', false],
    ])('%j -> %s', (name, expected) => {
      expect(isEarningsEventName(name)).toBe(expected);
    });
  });
});
