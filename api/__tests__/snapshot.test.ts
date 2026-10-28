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
  metrics: { request: vi.fn(() => vi.fn()), dbSave: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
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
    vi.mocked(logger.error).mockClear();
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
});
