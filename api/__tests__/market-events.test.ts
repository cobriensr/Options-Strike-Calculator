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

    it('keeps complete true when Finnhub answers non-OK', async () => {
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

      expect(complete).toBe(true);
      expect(events.map((e) => e.event)).toEqual(['CPI']);
      expect(logger.error).toHaveBeenCalledWith(
        { status: 500 },
        'Finnhub earnings API error',
      );
    });

    it('keeps complete true when the Finnhub fetch throws', async () => {
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

      expect(complete).toBe(true);
      expect(events).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Finnhub earnings fetch failed',
      );
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

      expect(result).toEqual({ events: cached, complete: true });
      expect(redis.get).toHaveBeenCalledWith(DAY_KEY);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('fetches on a miss and caches the complete result for the TTL', async () => {
      const fetchMock = stubFredFetch({ 10: [CPI_DAY] });

      const result = await getEventsForDate(CPI_DAY);

      expect(result.complete).toBe(true);
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

      expect(result).toEqual({ events: [], complete: true });
      expect(redis.set).toHaveBeenCalledWith(
        'events:day:v1:2026-05-14',
        { data: [], cachedAt: expect.any(Number) },
        { ex: CACHE_TTL_SEC },
      );
    });

    it('does not cache an incomplete result', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      );

      const result = await getEventsForDate(FOMC_SEP_DAY);

      expect(result.complete).toBe(false);
      expect(result.events.map((e) => e.event)).toEqual(['FOMC + SEP']);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('does not cache the static-only result when FRED_API_KEY is unset', async () => {
      delete process.env.FRED_API_KEY;
      stubFredFetch();

      const result = await getEventsForDate(FOMC_SEP_DAY);

      expect(result.complete).toBe(false);
      expect(redis.set).not.toHaveBeenCalled();
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

    it('rejects, and caches nothing, when a FRED fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      await expect(getEventsForDate(CPI_DAY)).rejects.toThrow('network down');
      expect(redis.set).not.toHaveBeenCalled();
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
