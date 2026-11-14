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

// The clock is pinned (Date only) to 2026-03-10 11:00 EDT = 10:00 AM CDT.
const NOW = '2026-03-10T15:00:00Z';
const TODAY = '2026-03-10';
const YESTERDAY = '2026-03-09';
const TOMORROW = '2026-03-11';
/** The slot now sits in (CT), and a quote that printed 30 s ago for it. */
const SLOT = '10:00 AM CT';
const FRESH_QUOTE = Date.parse(NOW) - 30_000;

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
    vi.mocked(metrics.request).mockClear();
    vi.mocked(metrics.increment).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(getEventsForDate)
      .mockReset()
      .mockResolvedValue({ events: [], complete: true, fromCache: false });
  });

  /** Let the real 400 path run: respondIfInvalid answers a failed parse. */
  function validating() {
    vi.mocked(respondIfInvalid).mockImplementation((parsed, res) => {
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message });
        return true;
      }
      return false;
    });
  }

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
        body: { date: '2026-03-10', entryTime: SLOT, quotedAt: FRESH_QUOTE },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: 123, saved: true });
    // quotedAt survives the schema (z.object strips unknown keys).
    expect(saveSnapshot).toHaveBeenCalledWith({
      date: '2026-03-10',
      entryTime: SLOT,
      quotedAt: FRESH_QUOTE,
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

    // Live bodies, so each carries a fresh quote time (and the slot now).
    const LIVE = { date: TODAY, entryTime: SLOT, quotedAt: FRESH_QUOTE };

    it('passes all seven through to saveSnapshot', async () => {
      vi.mocked(saveSnapshot).mockResolvedValue(5);

      const res = mockResponse();
      await handler(
        mockRequest({ method: 'POST', body: { ...LIVE, ...SEVEN } }),
        res,
      );

      expect(res._json).toEqual({ id: 5, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        ...LIVE,
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
        mockRequest({ method: 'POST', body: { ...LIVE, ...nulls } }),
        res,
      );

      expect(res._json).toEqual({ id: 6, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        ...LIVE,
        ...nulls,
        isEventDay: false,
        eventNames: [],
      });
    });

    it('accepts a body that omits all seven', async () => {
      vi.mocked(saveSnapshot).mockResolvedValue(7);

      const res = mockResponse();
      await handler(
        mockRequest({ method: 'POST', body: { ...LIVE, spx: 6800 } }),
        res,
      );

      expect(res._json).toEqual({ id: 7, saved: true });
      expect(saveSnapshot).toHaveBeenCalledWith({
        ...LIVE,
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
        body: { date: '2026-03-10', entryTime: SLOT, quotedAt: FRESH_QUOTE },
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
        body: { date: '2026-03-10', entryTime: SLOT, quotedAt: FRESH_QUOTE },
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

    // A closed day owns no snapshot rows (production held 187 of them on 13
    // non-trading dates). The client guards only its live path, so a stale
    // tab, a direct POST or a backtest save still reaches the server.
    describe('a non-trading day', () => {
      const SATURDAY = '2026-03-07';
      const GOOD_FRIDAY = '2026-04-03';
      const FUTURE_SATURDAY = '2026-04-11';

      beforeEach(() => {
        // Monday 2026-04-06 11:00 EDT: both closed dates are in the past.
        vi.setSystemTime(new Date('2026-04-06T15:00:00Z'));
      });

      it.each([
        ['a Saturday', SATURDAY],
        ['Good Friday', GOOD_FRIDAY],
      ])(
        'skips a backtest save for %s and logs it, with no Sentry warning',
        async (_label, date) => {
          const res = mockResponse();
          await handler(
            mockRequest({
              method: 'POST',
              body: {
                date,
                entryTime: '10:30 AM CT',
                isBacktest: true,
                spx: 6800,
              },
            }),
            res,
          );

          expect(res._status).toBe(200);
          expect(res._json).toEqual({
            id: null,
            saved: false,
            skipped: 'non-trading-day',
          });
          expect(saveSnapshot).not.toHaveBeenCalled();
          // The skip comes before the event lookup, which would call FRED.
          expect(getEventsForDate).not.toHaveBeenCalled();
          // A backtest replay of a closed date is expected noise: the log
          // keeps it, Sentry does not.
          expect(Sentry.captureMessage).not.toHaveBeenCalled();
          expect(logger.warn).toHaveBeenCalledTimes(1);
          expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ date, entryTime: '10:30 AM CT' }),
            expect.stringContaining('non-trading day'),
          );
          expect(logger.error).not.toHaveBeenCalled();
          expect(Sentry.captureException).not.toHaveBeenCalled();
        },
      );

      it('skips a live save when today itself is a closed day, logging it and reporting it to Sentry', async () => {
        // 11:00 EDT on Good Friday: the live-for-other-date guard lets it
        // through (the date is today), the trading-day guard does not. A live
        // save on a closed day is a stale tab or a bad direct POST.
        vi.setSystemTime(new Date('2026-04-03T15:00:00Z'));
        const res = mockResponse();
        await handler(
          mockRequest({
            method: 'POST',
            body: { date: GOOD_FRIDAY, entryTime: '10:30 AM CT' },
          }),
          res,
        );

        expect(res._json).toEqual({
          id: null,
          saved: false,
          skipped: 'non-trading-day',
        });
        expect(saveSnapshot).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          'snapshot.save_for_non_trading_day',
          expect.objectContaining({
            level: 'warning',
            extra: expect.objectContaining({ date: GOOD_FRIDAY }),
          }),
        );
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ date: GOOD_FRIDAY }),
          expect.stringContaining('non-trading day'),
        );
      });

      it('also reports a live save with isBacktest false, which is not a backtest', async () => {
        vi.setSystemTime(new Date('2026-04-03T15:00:00Z'));
        const res = mockResponse();
        await handler(
          mockRequest({
            method: 'POST',
            body: {
              date: GOOD_FRIDAY,
              entryTime: '10:30 AM CT',
              isBacktest: false,
            },
          }),
          res,
        );

        expect((res._json as { skipped?: string }).skipped).toBe(
          'non-trading-day',
        );
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          'snapshot.save_for_non_trading_day',
          expect.objectContaining({ level: 'warning' }),
        );
        expect(logger.warn).toHaveBeenCalledTimes(1);
      });

      it('leaves the two earlier skips ahead of it', async () => {
        // A live save for a past Saturday is a stale client first; a save for
        // a future Saturday is a future date first.
        const live = mockResponse();
        await handler(
          mockRequest({
            method: 'POST',
            body: { date: SATURDAY, entryTime: '10:30 AM CT' },
          }),
          live,
        );
        expect((live._json as { skipped?: string }).skipped).toBe(
          'live-for-other-date',
        );

        const future = mockResponse();
        await handler(
          mockRequest({
            method: 'POST',
            body: {
              date: FUTURE_SATURDAY,
              entryTime: '10:30 AM CT',
              isBacktest: true,
            },
          }),
          future,
        );
        expect((future._json as { skipped?: string }).skipped).toBe(
          'future-date',
        );
        expect(saveSnapshot).not.toHaveBeenCalled();
      });
    });

    it.each([
      ['a live save for today', TODAY, false],
      ['a backtest save for today (scrubbed back)', TODAY, true],
      ['a backtest save for a past date', YESTERDAY, true],
      // A half-day trades, so it is not a closed day.
      ['a backtest save for an early-close day', '2025-12-24', true],
    ])('passes %s through', async (_label, date, isBacktest) => {
      vi.mocked(saveSnapshot).mockResolvedValue(7);
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          body: {
            date,
            entryTime: SLOT,
            isBacktest,
            // Only a live save carries a quote time.
            ...(isBacktest ? {} : { quotedAt: FRESH_QUOTE }),
          },
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
          body: {
            date: TODAY,
            entryTime: '8:00 PM CT',
            quotedAt: Date.parse('2026-03-11T01:00:00Z') - 30_000,
          },
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
          body: {
            date: TODAY,
            entryTime: SLOT,
            quotedAt: FRESH_QUOTE,
            ...body,
          },
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
          entryTime: SLOT,
          quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
        entryTime: SLOT,
        quotedAt: FRESH_QUOTE,
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
          body: { date: TODAY, entryTime: SLOT, quotedAt: FRESH_QUOTE },
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

  // ── The quote's age (P0.6, F11) ─────────────────────────────
  // A live save whose quote printed more than 10 minutes before its slot is
  // refused with a 422: a stalled quote poll, or an old Schwab print, leaves
  // inputs that still match the quote state. The clock is pinned to 10:00 AM
  // CDT, so SLOT is also now.

  describe('the quote’s age', () => {
    const NOW_MS = Date.parse(NOW);
    const MIN = 60_000;

    async function post(body: Record<string, unknown>) {
      const res = mockResponse();
      await handler(mockRequest({ method: 'POST', body }), res);
      return res;
    }

    const live = (quotedAt?: unknown, extra: Record<string, unknown> = {}) => ({
      date: TODAY,
      entryTime: SLOT,
      ...(quotedAt === undefined ? {} : { quotedAt }),
      ...extra,
    });

    /** The `done` the handler took from metrics.request. */
    const done = () =>
      vi.mocked(metrics.request).mock.results.at(-1)!.value as ReturnType<
        typeof vi.fn
      >;

    const notRefused = () => {
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(metrics.increment).not.toHaveBeenCalled();
    };

    /** Every refusal is logged and counted, whether or not it alerts. */
    const expectLogged = (reason: string) => {
      expect(metrics.increment).toHaveBeenCalledWith('snapshot.quote_refused');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason, date: TODAY }),
        expect.stringContaining('quote'),
      );
    };

    /** The alert's title names the reason, so an email says why. */
    const alertTitle = (reason: string) => `snapshot.stale_quote: ${reason}`;

    it('saves a live row whose quote printed 30 s ago', async () => {
      vi.mocked(saveSnapshot).mockResolvedValue(11);

      const res = await post(live(FRESH_QUOTE));

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ id: 11, saved: true });
      expect(done()).toHaveBeenCalledWith({ status: 200 });
      notRefused();
    });

    it('saves a live row whose quote is exactly 10:00 behind its slot', async () => {
      vi.mocked(saveSnapshot).mockResolvedValue(12);

      const res = await post(live(NOW_MS - 10 * MIN));

      expect(res._json).toEqual({ id: 12, saved: true });
      notRefused();
    });

    it('refuses a live row whose quote is 11 min behind: 422, nothing saved, an in-session error', async () => {
      const quotedAt = NOW_MS - 11 * MIN;

      const res = await post(live(quotedAt));

      expect(res._status).toBe(422);
      expect(res._json).toEqual({
        error: 'quote-not-fresh',
        reason: 'stale-quote',
        saved: false,
      });
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(saveSnapshot).not.toHaveBeenCalled();
      expect(done()).toHaveBeenCalledWith({
        status: 422,
        error: 'stale-quote',
      });
      expectLogged('stale-quote');
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        alertTitle('stale-quote'),
        {
          level: 'error',
          tags: { reason: 'stale-quote' },
          // One issue per reason, whatever the title.
          fingerprint: ['snapshot.stale_quote', 'stale-quote'],
          extra: {
            date: TODAY,
            entryTime: SLOT,
            quotedAtIso: new Date(quotedAt).toISOString(),
            slotIso: '2026-03-10T15:00:00.000Z',
            behindMs: 11 * MIN,
          },
        },
      );
    });

    it.each([
      ['absent', undefined],
      ['null', null],
    ])(
      'refuses a live row whose quotedAt is %s as no-quote-time',
      async (_label, quotedAt) => {
        const res = await post(live(quotedAt));

        expect(res._status).toBe(422);
        expect(res._json).toEqual({
          error: 'quote-not-fresh',
          reason: 'no-quote-time',
          saved: false,
        });
        expect(saveSnapshot).not.toHaveBeenCalled();
        expectLogged('no-quote-time');
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          alertTitle('no-quote-time'),
          expect.objectContaining({
            level: 'error',
            tags: { reason: 'no-quote-time' },
            fingerprint: ['snapshot.stale_quote', 'no-quote-time'],
          }),
        );
      },
    );

    it('refuses a quote 5 min ahead of the server clock as quote-from-future', async () => {
      const res = await post(live(NOW_MS + 5 * MIN));

      expect(res._status).toBe(422);
      expect((res._json as { reason: string }).reason).toBe(
        'quote-from-future',
      );
      expect(saveSnapshot).not.toHaveBeenCalled();
      expectLogged('quote-from-future');
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        alertTitle('quote-from-future'),
        expect.objectContaining({ tags: { reason: 'quote-from-future' } }),
      );
    });

    it('refuses a quote time past the Date range without throwing', async () => {
      // 9e15 is a safe integer, so the schema passes it, and no Date holds it.
      const res = await post(live(9_000_000_000_000_000));

      expect(res._status).toBe(422);
      expect((res._json as { reason: string }).reason).toBe(
        'quote-from-future',
      );
      expectLogged('quote-from-future');
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        alertTitle('quote-from-future'),
        expect.objectContaining({
          extra: expect.objectContaining({ quotedAtIso: null }),
        }),
      );
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('refuses a label that is not a clock time as bad-entry-time, and alerts', async () => {
      const res = await post(live(FRESH_QUOTE, { entryTime: '09:35' }));

      expect(res._status).toBe(422);
      expect(res._json).toEqual({
        error: 'quote-not-fresh',
        reason: 'bad-entry-time',
        saved: false,
      });
      expect(saveSnapshot).not.toHaveBeenCalled();
      expectLogged('bad-entry-time');
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        alertTitle('bad-entry-time'),
        expect.objectContaining({ tags: { reason: 'bad-entry-time' } }),
      );
    });

    // A missing quote time or an unreadable label is a wiring bug at any
    // hour, so it alerts even where a stale quote is only logged.
    it.each([
      ['no-quote-time', live(undefined, { entryTime: '6:00 PM CT' })],
      [
        'bad-entry-time',
        live(Date.parse('2026-03-10T22:59:00Z'), { entryTime: '18:00' }),
      ],
    ])(
      'alerts on %s after the close, where a stale quote only logs',
      async (reason, body) => {
        vi.setSystemTime(new Date('2026-03-10T23:00:00Z'));

        const res = await post(body);

        expect(res._status).toBe(422);
        expect((res._json as { reason: string }).reason).toBe(reason);
        expectLogged(reason);
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          alertTitle(reason),
          expect.objectContaining({ level: 'error', tags: { reason } }),
        );
      },
    );

    it.each([
      [
        'after the close',
        '2026-03-10T23:00:00Z',
        '6:00 PM CT',
        // SPX's last index print, 16:37 ET (probed 2026-11-08).
        '2026-03-10T20:37:00Z',
      ],
      [
        'in the 10 min after the open',
        '2026-03-10T13:35:00Z',
        '8:35 AM CT',
        // The prior session's close.
        '2026-03-09T20:00:00Z',
      ],
    ])(
      'refuses a stale quote %s with a log and a metric, not a Sentry error',
      async (_label, clock, entryTime, quotedIso) => {
        vi.setSystemTime(new Date(clock));

        const res = await post(live(Date.parse(quotedIso), { entryTime }));

        expect(res._status).toBe(422);
        expect((res._json as { reason: string }).reason).toBe('stale-quote');
        expect(saveSnapshot).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'stale-quote' }),
          expect.any(String),
        );
        expect(metrics.increment).toHaveBeenCalledWith(
          'snapshot.quote_refused',
        );
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['isBacktest absent', {}],
      ['isBacktest false', { isBacktest: false }],
      ['isBacktest null', { isBacktest: null }],
    ])('checks a live row with %s', async (_label, flag) => {
      const res = await post(live(NOW_MS - 11 * MIN, flag));

      expect(res._status).toBe(422);
      expect(saveSnapshot).not.toHaveBeenCalled();
    });

    it.each([
      ['a past date, no quote time', { date: YESTERDAY }],
      [
        'a past date with a stale quote time',
        { date: YESTERDAY, quotedAt: NOW_MS - 3_600_000 },
      ],
      ['today scrubbed back, no quote time', { entryTime: '9:00 AM CT' }],
      ['today with a stale quote time', { quotedAt: NOW_MS - 60 * MIN }],
    ])('does not check a backtest row: %s', async (_label, patch) => {
      vi.mocked(saveSnapshot).mockResolvedValue(13);

      const res = await post(live(undefined, { isBacktest: true, ...patch }));

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ id: 13, saved: true });
      expect(saveSnapshot).toHaveBeenCalledTimes(1);
      notRefused();
    });

    it('answers a live row for another date with its own skip, ahead of the quote check', async () => {
      const res = await post(live(undefined, { date: YESTERDAY }));

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        id: null,
        saved: false,
        skipped: 'live-for-other-date',
      });
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'snapshot.live_save_for_other_date',
        expect.anything(),
      );
      expect(metrics.increment).not.toHaveBeenCalled();
    });

    it('answers a future date with its own skip, ahead of the quote check', async () => {
      const res = await post(live(undefined, { date: TOMORROW }));

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        id: null,
        saved: false,
        skipped: 'future-date',
      });
      notRefused();
    });

    it('answers a live row for a closed day with its own skip, ahead of the quote check', async () => {
      // 11:00 EDT on Good Friday: today, so the other-date skip lets it by.
      vi.setSystemTime(new Date('2026-04-03T15:00:00Z'));

      const res = await post(live(undefined, { date: '2026-04-03' }));

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        id: null,
        saved: false,
        skipped: 'non-trading-day',
      });
      expect(saveSnapshot).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'snapshot.save_for_non_trading_day',
        expect.anything(),
      );
      expect(metrics.increment).not.toHaveBeenCalled();
    });

    it('makes no event lookup for a refused row', async () => {
      await post(live(NOW_MS - 11 * MIN));

      expect(getEventsForDate).not.toHaveBeenCalled();
    });

    it('rejects a quotedAt that is not a positive integer with a 400', async () => {
      validating();

      const res = await post(live('1794001029801'));

      expect(res._status).toBe(400);
      expect(saveSnapshot).not.toHaveBeenCalled();
      notRefused();
    });

    it('refuses a stale quote before the database is touched, so a failing database does not hide it', async () => {
      vi.mocked(saveSnapshot).mockRejectedValue(new Error('DB error'));

      const res = await post(live(NOW_MS - 11 * MIN));

      expect(res._status).toBe(422);
      expect(saveSnapshot).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(metrics.dbSave).not.toHaveBeenCalled();
    });

    it('still answers 200 saved:false when the database rejects a fresh row', async () => {
      vi.mocked(saveSnapshot).mockRejectedValue(new Error('DB error'));

      const res = await post(live(FRESH_QUOTE));

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ id: null, saved: false });
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(metrics.increment).not.toHaveBeenCalled();
    });
  });
});
