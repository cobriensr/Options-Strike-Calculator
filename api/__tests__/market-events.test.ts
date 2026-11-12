// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../_lib/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureMessage: vi.fn() },
}));

import {
  CACHE_TTL_SEC,
  eventNamesForSnapshot,
  fetchMarketEvents,
  getEventsForDate,
  type EventItem,
} from '../_lib/market-events.js';
import { redis } from '../_lib/redis.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

const CPI_DAY = '2026-05-12';
const FOMC_SEP_DAY = '2026-06-17';
const DAY_KEY = `events:day:v1:${CPI_DAY}`;

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
            release_name: `release ${releaseId}`,
            date,
          })),
        }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function urlsCalled(fetchMock: ReturnType<typeof stubFredFetch>): string[] {
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
        51: ['2026-05-13'],
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
        51: ['2026-06-16'],
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
                release_dates: isCpi
                  ? [{ release_id: 10, release_name: 'CPI', date: CPI_DAY }]
                  : [],
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
      expect(redis.set).toHaveBeenCalledTimes(1);
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
        'events:day:v1:2026-05-14',
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
        `events:day:v1:${FOMC_SEP_DAY}`,
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
        `events:day:v1:${FOMC_SEP_DAY}`,
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

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, entry, options] = vi.mocked(redis.set).mock.calls[0] ?? [];
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
        `events:day:v1:${FOMC_SEP_DAY}`,
        { data: result.events, cachedAt: expect.any(Number), complete: false },
        { ex: 300 },
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'FRED API malformed payload',
        expect.objectContaining({ level: 'warning' }),
      );
    });

    it('caches the day for five minutes when the Finnhub body is not JSON', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({
        finnhub: unparseable,
        fred: okJson({ release_dates: [] }),
      });

      const result = await getEventsForDate(CPI_DAY);

      expect(result.complete).toBe(false);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        DAY_KEY,
        { data: [], cachedAt: expect.any(Number), complete: false },
        { ex: 300 },
      );
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(SyntaxError) },
        'Finnhub earnings fetch failed',
      );
    });

    it.each([
      ['answers non-OK', nonOk],
      ['cannot be reached', networkDown],
      ['answers 200 with {}', okJson({})],
    ])(
      'caches the day for five minutes when Finnhub %s',
      async (_label, finnhub) => {
        process.env.FINNHUB_API_KEY = 'finnhub-key';
        stubSources({ finnhub });

        const result = await getEventsForDate(CPI_DAY);

        expect(result.complete).toBe(false);
        expect(redis.set).toHaveBeenCalledTimes(1);
        expect(redis.set).toHaveBeenCalledWith(
          DAY_KEY,
          { data: [], cachedAt: expect.any(Number), complete: false },
          { ex: 300 },
        );
      },
    );

    it('caches a day Finnhub reports no earnings for', async () => {
      process.env.FINNHUB_API_KEY = 'finnhub-key';
      stubSources({ finnhub: okJson({ earningsCalendar: [] }) });

      const result = await getEventsForDate(CPI_DAY);

      expect(result).toEqual({ events: [], complete: true, fromCache: false });
      expect(redis.set).toHaveBeenCalledWith(
        DAY_KEY,
        { data: [], cachedAt: expect.any(Number) },
        { ex: CACHE_TTL_SEC },
      );
    });

    it('returns, and caches, only the Finnhub earnings on the asked date', async () => {
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

      const result = await getEventsForDate(CPI_DAY);

      expect(result.complete).toBe(true);
      expect(result.events.map((e) => [e.date, e.event])).toEqual([
        [CPI_DAY, 'MSFT Earnings'],
      ]);
      expect(redis.set).toHaveBeenCalledWith(
        DAY_KEY,
        { data: result.events, cachedAt: expect.any(Number) },
        { ex: CACHE_TTL_SEC },
      );
    });
  });

  describe('CACHE_TTL_SEC', () => {
    it('is seven days', () => {
      expect(CACHE_TTL_SEC).toBe(7 * 24 * 60 * 60);
    });
  });

  describe('eventNamesForSnapshot', () => {
    it('returns the names in the given order, duplicates kept', () => {
      const events = [
        event({ event: 'FOMC + SEP', source: 'static' }),
        event({ event: 'CPI' }),
        event({ event: 'CPI' }),
        event({ event: 'NVDA Earnings', source: 'finnhub' }),
      ];

      expect(eventNamesForSnapshot(events)).toEqual([
        'FOMC + SEP',
        'CPI',
        'CPI',
        'NVDA Earnings',
      ]);
    });

    it('returns an empty list for no events', () => {
      expect(eventNamesForSnapshot([])).toEqual([]);
    });
  });
});
