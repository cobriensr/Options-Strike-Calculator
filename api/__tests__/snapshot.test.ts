// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn(),
  respondIfInvalid: vi.fn().mockReturnValue(false),
}));

vi.mock('../_lib/db.js', () => ({
  saveSnapshot: vi.fn(),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    dbSave: vi.fn(),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// The real module loads for `eventNamesForSnapshot` and `isEarningsEventName`,
// so the snapshot save and the backfill keep one definition of the names; only
// the lookup is replaced. Its Redis import is mocked so loading it creates no
// client. The other fetchers can reach FRED or Finnhub, so they throw: a save
// that calls one fails here, without a network call.
vi.mock('../_lib/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../_lib/market-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/market-events.js')>()),
  getEventsForDate: vi.fn(),
  fetchMacroEvents: () => {
    throw new Error('snapshot must use getEventsForDate');
  },
  fetchMarketEvents: () => {
    throw new Error('snapshot must use getEventsForDate');
  },
}));

import handler from '../snapshot.js';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from '../_lib/api-helpers.js';
import { saveSnapshot } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { getEventsForDate, type EventItem } from '../_lib/market-events.js';

// The clock is pinned (Date only) to 2026-03-10 11:00 EDT.
const NOW = '2026-03-10T15:00:00Z';
const TODAY = '2026-03-10';
const YESTERDAY = '2026-03-09';
const TOMORROW = '2026-03-11';

describe('POST /api/snapshot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.restoreAllMocks();
    vi.mocked(saveSnapshot).mockReset();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    vi.mocked(respondIfInvalid).mockReturnValue(false);
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(metrics.dbSave).mockClear();
    vi.mocked(metrics.increment).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(getEventsForDate)
      .mockReset()
      .mockResolvedValue({ events: [], complete: true, fromCache: false });
  });

  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(401);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(429);
  });

  it('returns 400 when date is missing', async () => {
    vi.mocked(respondIfInvalid).mockImplementation((parsed, res) => {
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message });
        return true;
      }
      return false;
    });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { entryTime: '09:35' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toBeDefined();
  });

  it('returns 400 when entryTime is missing', async () => {
    vi.mocked(respondIfInvalid).mockImplementation((parsed, res) => {
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message });
        return true;
      }
      return false;
    });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { date: '2026-03-10' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toBeDefined();
  });

  it('saves snapshot and returns id', async () => {
    vi.mocked(saveSnapshot).mockResolvedValue(123);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-03-10', entryTime: '09:35' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: 123, saved: true });
    expect(saveSnapshot).toHaveBeenCalledWith({
      date: '2026-03-10',
      entryTime: '09:35',
      isEventDay: false,
      eventNames: [],
    });
  });

  // The client posts seven regime columns (useSnapshotSave). The body schema
  // is a plain z.object, which strips unknown keys, so a field missing from
  // it never reaches saveSnapshot.
  describe('the seven regime columns', () => {
    const SEVEN = {
      vixTermShape: 'contango',
      clusterPutMult: 1.3125,
      clusterCallMult: 1.1,
      rvIvRatio: 0.85,
      rvIvLabel: 'Fair Value',
      rvAnnualized: 0.1234,
      ivAccelMult: 1.21,
    };

    it('passes all seven through to saveSnapshot', async () => {
      vi.mocked(saveSnapshot).mockResolvedValue(5);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: TODAY, entryTime: '10:30 AM CT', ...SEVEN },
        }),
        res,
      );

      expect(res._json).toEqual({ id: 5, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        ...SEVEN,
        isEventDay: false,
        eventNames: [],
      });
    });

    it('keeps null values (the client sends null for an unavailable signal)', async () => {
      vi.mocked(saveSnapshot).mockResolvedValue(6);
      const nulls = {
        vixTermShape: null,
        clusterPutMult: null,
        clusterCallMult: null,
        rvIvRatio: null,
        rvIvLabel: null,
        rvAnnualized: null,
        ivAccelMult: null,
      };

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: TODAY, entryTime: '10:30 AM CT', ...nulls },
        }),
        res,
      );

      expect(res._json).toEqual({ id: 6, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        ...nulls,
        isEventDay: false,
        eventNames: [],
      });
    });

    it('accepts a body that omits all seven', async () => {
      vi.mocked(saveSnapshot).mockResolvedValue(7);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: TODAY, entryTime: '10:30 AM CT', spx: 6800 },
        }),
        res,
      );

      expect(res._json).toEqual({ id: 7, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        spx: 6800,
        isEventDay: false,
        eventNames: [],
      });
    });
  });

  it('marks a null id as a kept live row (skipped: live-row)', async () => {
    vi.mocked(saveSnapshot).mockResolvedValue(null);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-03-10', entryTime: '09:35' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: null, saved: false, skipped: 'live-row' });
  });

  it('answers a backtest save that kept the live row as a non-error 200', async () => {
    // saveSnapshot returns null when a backtest save meets a live row: the
    // upsert's conflict update is skipped and RETURNING yields no row.
    vi.mocked(saveSnapshot).mockResolvedValue(null);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: {
          date: '2026-03-09',
          entryTime: '10:30 AM CT',
          isBacktest: true,
        },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: null, saved: false, skipped: 'live-row' });
    expect(metrics.dbSave).toHaveBeenCalledWith('market_snapshots', true);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns 200 with saved:false on database error', async () => {
    vi.mocked(saveSnapshot).mockRejectedValue(new Error('DB error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-03-10', entryTime: '09:35' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // No skipped marker: unlike a kept live row, this save failed.
    expect(res._json).toEqual({ id: null, saved: false });
    // Unlike a kept live row, a DB error is surfaced.
    expect(metrics.dbSave).toHaveBeenCalledWith('market_snapshots', false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });

  // ── The row's date (B2) ─────────────────────────────────────
  // The clock is pinned to 2026-03-10 11:00 EDT (TODAY). A live save is
  // today's only: a tab on an old bundle (PWA registerType 'prompt') still
  // posts live rows under past dates, which the upsert guard would then
  // protect from the replay that should own them.

  describe('the row’s date', () => {
    function validating() {
      vi.mocked(respondIfInvalid).mockImplementation((parsed, res) => {
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message });
          return true;
        }
        return false;
      });
    }

    it('skips a live save for a past date and reports the stale client', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: YESTERDAY, entryTime: '10:30 AM CT', spx: 6800 },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        id: null,
        saved: false,
        skipped: 'live-for-other-date',
      });
      expect(saveSnapshot).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'snapshot.live_save_for_other_date',
        expect.objectContaining({ level: 'warning' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ date: YESTERDAY, today: TODAY }),
        expect.stringContaining('live snapshot save for another date'),
      );
    });

    it.each([
      ['isBacktest false', false],
      ['isBacktest null', null],
    ])('skips a past-date save with %s as live', async (_label, isBacktest) => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: YESTERDAY, entryTime: '10:30 AM CT', isBacktest },
        }),
        res,
      );

      expect(saveSnapshot).not.toHaveBeenCalled();
      expect((res._json as { skipped?: string }).skipped).toBe(
        'live-for-other-date',
      );
    });

    it.each([
      ['a live save', undefined],
      ['a backtest save', true],
    ])('skips %s for a future date', async (_label, isBacktest) => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: TOMORROW, entryTime: '10:30 AM CT', isBacktest },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        id: null,
        saved: false,
        skipped: 'future-date',
      });
      expect(saveSnapshot).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it.each([
      ['a live save for today', TODAY, false],
      ['a backtest save for today (scrubbed back)', TODAY, true],
      ['a backtest save for a past date', YESTERDAY, true],
    ])('passes %s through', async (_label, date, isBacktest) => {
      vi.mocked(saveSnapshot).mockResolvedValue(7);
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date, entryTime: '10:30 AM CT', isBacktest },
        }),
        res,
      );

      expect(saveSnapshot).toHaveBeenCalledTimes(1);
      expect(res._json).toEqual({ id: 7, saved: true });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('keys "today" on the ET date, not the UTC date, in the evening', async () => {
      // 21:00 EDT on 03-10 is 01:00Z on 03-11.
      vi.setSystemTime(new Date('2026-03-11T01:00:00Z'));
      vi.mocked(saveSnapshot).mockResolvedValue(8);
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: TODAY, entryTime: '8:00 PM CT' },
        }),
        res,
      );

      expect(saveSnapshot).toHaveBeenCalledTimes(1);
      expect(res._json).toEqual({ id: 8, saved: true });
    });

    it.each([
      ['a single-digit month', '2026-3-10'],
      ['a timestamp', '2026-03-10T10:30:00Z'],
      ['no separators', '20260310'],
      ['text', 'today'],
    ])('rejects %s as the date with a 400', async (_label, date) => {
      validating();
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date, entryTime: '10:30 AM CT' },
        }),
        res,
      );

      expect(res._status).toBe(400);
      expect(saveSnapshot).not.toHaveBeenCalled();
    });
  });

  // ── The event flag and names ────────────────────────────────
  // The server decides both from getEventsForDate. A complete lookup replaces
  // whatever the client sent; an incomplete or failed one keeps the client's
  // names beside the server's, so a FRED outage never loses a flag the
  // client already had.

  describe('the event flag and names', () => {
    const LOOKUP_MSG = 'snapshot: event lookup incomplete';

    function eventItem(
      name: string,
      source: EventItem['source'] = 'fred',
    ): EventItem {
      return {
        date: TODAY,
        event: name,
        description: name,
        time: '8:30 AM',
        severity: 'high',
        source,
      };
    }

    function lookup(names: string[], complete: boolean, fromCache = false) {
      vi.mocked(getEventsForDate).mockResolvedValue({
        events: names.map((name) => eventItem(name)),
        complete,
        fromCache,
      });
    }

    async function save(body: Record<string, unknown>) {
      vi.mocked(saveSnapshot).mockResolvedValue(11);
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: TODAY, entryTime: '10:30 AM CT', ...body },
        }),
        res,
      );
      return res;
    }

    function expectCounted(times = 1) {
      expect(metrics.increment).toHaveBeenCalledTimes(times);
      expect(metrics.increment).toHaveBeenCalledWith(
        'snapshot.event_lookup_incomplete',
      );
    }

    // The metric fires on every incomplete save; the warning and the Sentry
    // message only once per fetch (or failure), not for each cached repeat.
    function expectCountedOnly() {
      expectCounted();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    }

    function expectLookupReported(err: unknown) {
      expectCounted();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { date: TODAY, err },
        LOOKUP_MSG,
      );
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(LOOKUP_MSG, {
        level: 'warning',
        extra: { date: TODAY },
      });
    }

    function expectNothingReported() {
      expect(metrics.increment).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    }

    it('saves a CPI date as an event day although the client sent none', async () => {
      lookup(['CPI'], true);

      const res = await save({ isEventDay: false, eventNames: [] });

      expect(res._json).toEqual({ id: 11, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: true,
        eventNames: ['CPI'],
      });
      expectNothingReported();
    });

    it('replaces the client names with the server names on a complete lookup', async () => {
      lookup(['CPI', 'NVDA Earnings'], true);

      await save({ isEventDay: true, eventNames: ['FOMC'] });

      expect(saveSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          isEventDay: true,
          eventNames: ['CPI', 'NVDA Earnings'],
        }),
      );
    });

    it('saves a complete empty day as not an event day, whatever the client sent', async () => {
      lookup([], true);

      const res = await save({ isEventDay: true, eventNames: ['FOMC'] });

      expect(res._json).toEqual({ id: 11, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: false,
        eventNames: [],
      });
      expectNothingReported();
    });

    // The stored flag is macro-only (owner decision 2026-11-12). A live
    // client's names come from /api/events, which includes earnings.
    it('stores no earnings name on a complete lookup, even when the events hold one and the client sent one', async () => {
      vi.mocked(getEventsForDate).mockResolvedValue({
        events: [
          eventItem('CPI'),
          eventItem('NVDA Earnings', 'finnhub'),
          eventItem('AAPL Earnings', 'finnhub'),
        ],
        complete: true,
        fromCache: false,
      });

      await save({ isEventDay: true, eventNames: ['CPI', 'TSLA Earnings'] });

      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: true,
        eventNames: ['CPI'],
      });
    });

    it('stores a not-event day when the only event is earnings', async () => {
      vi.mocked(getEventsForDate).mockResolvedValue({
        events: [eventItem('NVDA Earnings', 'finnhub')],
        complete: true,
        fromCache: false,
      });

      await save({ isEventDay: true, eventNames: ['NVDA Earnings'] });

      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: false,
        eventNames: [],
      });
    });

    it('drops the client’s earnings names when the lookup is incomplete, keeping its macro names', async () => {
      lookup([], false);

      const res = await save({
        isEventDay: true,
        eventNames: ['CPI', 'NVDA Earnings', 'AAPL Earnings'],
      });

      expect(res._json).toEqual({ id: 11, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: true,
        eventNames: ['CPI'],
      });
      expectLookupReported(undefined);
    });

    it('stores a not-event day when the lookup is incomplete and the client sent only earnings', async () => {
      lookup([], false);

      await save({ isEventDay: true, eventNames: ['NVDA Earnings'] });

      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: false,
        eventNames: [],
      });
    });

    it('drops the client’s earnings names when the lookup rejects', async () => {
      vi.mocked(getEventsForDate).mockRejectedValue(new Error('FRED down'));

      await save({ eventNames: ['FOMC', 'MSFT Earnings'] });

      expect(saveSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ isEventDay: true, eventNames: ['FOMC'] }),
      );
    });

    it('adds the client-only names after the server names on an incomplete lookup, and reports it', async () => {
      lookup(['CPI'], false);

      const res = await save({ isEventDay: true, eventNames: ['FOMC', 'CPI'] });

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ id: 11, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: true,
        eventNames: ['CPI', 'FOMC'],
      });
      expectLookupReported(undefined);
    });

    it('keeps the server duplicates, and appends none already present, on an incomplete lookup', async () => {
      lookup(['CPI', 'CPI'], false);

      await save({ eventNames: ['CPI'] });

      expect(saveSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          isEventDay: true,
          eventNames: ['CPI', 'CPI'],
        }),
      );
    });

    it.each([
      ['null', { eventNames: null }],
      ['omitted', {}],
    ])(
      'saves a not-event day when the lookup is incomplete and the client names are %s',
      async (_label, clientNames) => {
        lookup([], false);

        const res = await save(clientNames);

        expect(res._json).toEqual({ id: 11, saved: true });
        expect(saveSnapshot).toHaveBeenCalledWith({
          date: TODAY,
          entryTime: '10:30 AM CT',
          isEventDay: false,
          eventNames: [],
        });
        expectLookupReported(undefined);
      },
    );

    it('uses the client names, reports the error, and still saves when the lookup rejects', async () => {
      const failure = new Error('FRED unreachable');
      vi.mocked(getEventsForDate).mockRejectedValue(failure);

      const res = await save({ isEventDay: true, eventNames: ['FOMC', 'CPI'] });

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ id: 11, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: true,
        eventNames: ['FOMC', 'CPI'],
      });
      expectLookupReported(failure);
      // The lookup's failure is not the save's: the outer catch stays unused.
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(metrics.dbSave).toHaveBeenCalledWith('market_snapshots', true);
    });

    it.each([
      ['fetched', false],
      ['read from the cache', true],
    ])(
      'treats an unusable lookup result, %s, as a failed lookup, not a failed save',
      async (_label, fromCache) => {
        // A cache entry whose events hold a null makes eventNamesForSnapshot
        // throw; the save must still go on with the client's names, and the
        // failure is reported even when the entry came from the cache.
        vi.mocked(getEventsForDate).mockResolvedValue({
          events: [null as unknown as EventItem],
          complete: true,
          fromCache,
        });

        const res = await save({ isEventDay: true, eventNames: ['FOMC'] });

        expect(res._json).toEqual({ id: 11, saved: true });
        expect(saveSnapshot).toHaveBeenCalledWith(
          expect.objectContaining({ isEventDay: true, eventNames: ['FOMC'] }),
        );
        expectLookupReported(expect.any(TypeError));
        expect(Sentry.captureException).not.toHaveBeenCalled();
      },
    );

    it('warns, captures and counts an incomplete lookup that was just fetched', async () => {
      lookup(['CPI'], false, false);

      await save({ eventNames: ['FOMC'] });

      expectLookupReported(undefined);
    });

    it('counts, but neither warns nor captures, an incomplete lookup served from the cache', async () => {
      lookup(['CPI'], false, true);

      const res = await save({ isEventDay: true, eventNames: ['FOMC'] });

      expect(res._json).toEqual({ id: 11, saved: true });
      // The union is still stored: only the reporting is once per fetch.
      expect(saveSnapshot).toHaveBeenCalledWith({
        date: TODAY,
        entryTime: '10:30 AM CT',
        isEventDay: true,
        eventNames: ['CPI', 'FOMC'],
      });
      expectCountedOnly();
    });

    it('counts every save in a cached incomplete window but reports none of them', async () => {
      lookup(['CPI'], false, true);

      await save({});
      await save({});
      await save({});

      expectCounted(3);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('reports a cached complete lookup as nothing at all', async () => {
      lookup(['CPI'], true, true);

      await save({});

      expectNothingReported();
    });

    it.each([
      ['a live save for today', TODAY, undefined],
      ['a backtest save for today', TODAY, true],
      ['a backtest save for a past date', YESTERDAY, true],
    ])(
      'looks the day up once, with the body’s date, for %s',
      async (_label, date, isBacktest) => {
        lookup(['CPI'], true);

        await save({ date, isBacktest });

        expect(getEventsForDate).toHaveBeenCalledTimes(1);
        expect(getEventsForDate).toHaveBeenCalledWith(date);
      },
    );

    it.each([
      ['a live save for a future date', TOMORROW, undefined],
      ['a backtest save for a future date', TOMORROW, true],
      ['a live save for a past date', YESTERDAY, undefined],
    ])('makes no lookup for %s', async (_label, date, isBacktest) => {
      const res = await save({ date, isBacktest });

      expect(res._json).toMatchObject({ saved: false });
      expect(saveSnapshot).not.toHaveBeenCalled();
      expect(getEventsForDate).not.toHaveBeenCalled();
    });

    it('still takes the error path when the database rejects after a complete lookup', async () => {
      lookup(['CPI'], true);
      vi.mocked(saveSnapshot).mockRejectedValue(new Error('DB error'));

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: { date: TODAY, entryTime: '10:30 AM CT' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ id: null, saved: false });
      expect(metrics.dbSave).toHaveBeenCalledWith('market_snapshots', false);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expectNothingReported();
    });
  });
});
