// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockQuery } = vi.hoisted(() => {
  const queryFn = vi.fn();
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    query: typeof queryFn;
  };
  fn.query = queryFn;
  return { mockSql: fn, mockQuery: queryFn };
});

// The real withDbRetry, so the rollup's retry of transient errors is
// exercised; only the connection is replaced.
vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: actual.withDbRetry,
  };
});

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

import handler, { config } from '../cron/rollup-ws-gex-strike-expiry.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { SCHEDULE_MAP } from '../_lib/cron-schedules.js';

// Monday 22:30 UTC = 6:30 PM EDT — the scheduled cron firing time.
// cronGuard derives `today` via getETDateStr(new Date()), so on this
// clock the cron's today is 2026-05-18.
const RUN_TIME = new Date('2026-05-18T22:30:00.000Z');
const TODAY = '2026-05-18';
const JOB = 'rollup-ws-gex-strike-expiry';

function authedReq(query: Record<string, unknown> = {}) {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
    query: query as never,
  });
}

function isTickerList(text: string): boolean {
  return text.includes('SELECT DISTINCT ticker');
}

function isInsert(text: string): boolean {
  return text.includes('INSERT INTO strike_exposures');
}

/**
 * Route mockQuery by statement. The ticker list comes back in the order
 * given (deliberately not SPX-first, so the handler's ordering is tested).
 * Each ticker's INSERT returns its server-side count. `onInsert` runs
 * before the count is returned, so a test can move the clock or return an
 * Error to reject that ticker's statement.
 */
function routeQuery(opts: {
  tickers: string[] | Error;
  counts?: Record<string, number>;
  onInsert?: (ticker: string) => Error | undefined;
}) {
  mockQuery.mockImplementation((text: string, params: unknown[] = []) => {
    if (isTickerList(text)) {
      return opts.tickers instanceof Error
        ? Promise.reject(opts.tickers)
        : Promise.resolve(opts.tickers.map((ticker) => ({ ticker })));
    }
    if (isInsert(text)) {
      const ticker = params[1] as string;
      const err = opts.onInsert?.(ticker);
      if (err) return Promise.reject(err);
      return Promise.resolve([{ inserted: opts.counts?.[ticker] ?? 0 }]);
    }
    return Promise.reject(new Error(`unexpected SQL: ${text}`));
  });
}

/** [sql, params] of every per-ticker INSERT, in call order. */
function insertCalls(): [string, unknown[]][] {
  return mockQuery.mock.calls
    .filter((c) => isInsert(c[0] as string))
    .map((c) => [c[0] as string, c[1] as unknown[]]);
}

function insertedTickers(): string[] {
  return insertCalls().map(([, params]) => params[1] as string);
}

describe('rollup-ws-gex-strike-expiry handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.query = mockQuery;
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    delete process.env.SENTRY_DSN;
    vi.setSystemTime(RUN_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  describe('auth guard', () => {
    it('returns 405 on non-GET', async () => {
      const req = mockRequest({ method: 'POST' });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(405);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 401 when CRON_SECRET is missing', async () => {
      delete process.env.CRON_SECRET;
      const res = mockResponse();
      await handler(authedReq(), res);
      expect(res._status).toBe(401);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 401 on wrong bearer', async () => {
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong' },
      });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(401);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('per-ticker rollup', () => {
    it('copies SPX first, then the other tickers, and totals the server-side counts', async () => {
      routeQuery({
        tickers: ['AAPL', 'SPY', 'SPX'],
        counts: { SPX: 146_000, AAPL: 1_200, SPY: 40_000 },
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(insertedTickers()).toEqual(['SPX', 'AAPL', 'SPY']);
      expect(res._json).toMatchObject({
        job: JOB,
        status: 'success',
        rows: 187_200,
        date: TODAY,
        tickerCount: 3,
        failedTickers: [],
        deferredTickers: [],
      });
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', JOB);
    });

    it('lists tickers with a sargable ET-day range on the (ticker, expiry, ts_minute) index', async () => {
      routeQuery({ tickers: [] });
      const res = mockResponse();
      await handler(authedReq(), res);

      const listCall = mockQuery.mock.calls.find((c) =>
        isTickerList(c[0] as string),
      );
      expect(listCall).toBeDefined();
      const [sqlText, params] = listCall!;
      expect(sqlText).toContain('FROM ws_gex_strike_expiry');
      expect(sqlText).toContain('expiry = $1::date');
      expect(sqlText).toContain(
        "ts_minute >= ($1::date::timestamp AT TIME ZONE 'America/New_York')",
      );
      expect(sqlText).toContain(
        "ts_minute < (($1::date + 1)::timestamp AT TIME ZONE 'America/New_York')",
      );
      // The non-sargable cast on the column must be gone.
      expect(sqlText).not.toContain(
        "(ts_minute AT TIME ZONE 'America/New_York')::date =",
      );
      expect(params).toEqual([TODAY]);
    });

    it('issues one counted INSERT...SELECT per ticker with no id payload', async () => {
      routeQuery({ tickers: ['SPX', 'QQQ'], counts: { SPX: 5, QQQ: 7 } });
      const res = mockResponse();
      await handler(authedReq(), res);

      const calls = insertCalls();
      expect(calls).toHaveLength(2);
      for (const [sqlText, params] of calls) {
        expect(sqlText).toContain('WITH ins AS (');
        expect(sqlText).toContain('INSERT INTO strike_exposures');
        expect(sqlText).toContain('FROM ws_gex_strike_expiry');
        expect(sqlText).toContain('ticker = $2');
        expect(sqlText).toContain('expiry = $1::date');
        expect(sqlText).toContain(
          "ts_minute >= ($1::date::timestamp AT TIME ZONE 'America/New_York')",
        );
        expect(sqlText).toContain(
          "ts_minute < (($1::date + 1)::timestamp AT TIME ZONE 'America/New_York')",
        );
        expect(sqlText).toContain(
          'ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING',
        );
        expect(sqlText).toContain('RETURNING 1');
        expect(sqlText).toContain('count(*)::int');
        expect(sqlText).not.toContain('RETURNING id');
        // WS payload doesn't carry delta — rolled-up rows must NULL it.
        expect(sqlText).toContain('NULL::numeric AS call_delta_oi');
        expect(sqlText).toContain('NULL::numeric AS put_delta_oi');
        // SPX → SPXW remap on copy (the heatmap only reads SPXW).
        expect(sqlText).toContain(
          "CASE WHEN ticker = 'SPX' THEN 'SPXW' ELSE ticker END",
        );
        expect(params[0]).toBe(TODAY);
      }
      expect(calls.map(([, p]) => p[1])).toEqual(['SPX', 'QQQ']);
      expect(res._json).toMatchObject({ status: 'success', rows: 12 });
    });

    it('reports error and warns when a trading day has no source rows (capture down or source purged)', async () => {
      routeQuery({ tickers: [] });
      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'error',
        rows: 0,
        date: TODAY,
        tickerCount: 0,
        message:
          `no ws_gex_strike_expiry rows for trading day ${TODAY}: ` +
          'capture was down or the source was already purged',
      });
      expect(insertCalls()).toHaveLength(0);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        `${JOB}: no source rows on a trading day (capture down or source purged)`,
        expect.objectContaining({
          level: 'warning',
          fingerprint: [JOB, 'empty-source'],
          tags: { 'cron.anomaly': 'ws-gex-rollup-empty-source' },
          extra: expect.objectContaining({ date: TODAY }),
        }),
      );
    });

    it.each([
      ['a market holiday', '2025-12-25'],
      ['a weekend day', '2026-05-16'],
    ])(
      'reports success with zero rows when %s has no source rows',
      async (_label, date) => {
        routeQuery({ tickers: [] });
        const res = mockResponse();
        await handler(authedReq({ date }), res);

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'success',
          rows: 0,
          date,
          tickerCount: 0,
        });
        expect(insertCalls()).toHaveLength(0);
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      },
    );
  });

  describe('failure isolation', () => {
    it('keeps copying after a ticker fails and reports partial with the failure surfaced', async () => {
      const overflow = new Error('numeric field overflow');
      routeQuery({
        tickers: ['SPX', 'AAPL', 'SPY'],
        counts: { AAPL: 10, SPY: 20 },
        onInsert: (t) => (t === 'SPX' ? overflow : undefined),
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(insertedTickers()).toEqual(['SPX', 'AAPL', 'SPY']);
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 30,
        failedTickers: ['SPX'],
        deferredTickers: [],
      });
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        overflow,
        expect.objectContaining({
          tags: expect.objectContaining({ 'rollup.ticker': 'SPX' }),
        }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ ticker: 'SPX', err: overflow }),
        expect.any(String),
      );
    });

    it('reports error when every ticker fails', async () => {
      routeQuery({
        tickers: ['SPX', 'SPY'],
        onInsert: () => new Error('connection lost'),
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._json).toMatchObject({
        status: 'error',
        rows: 0,
        failedTickers: ['SPX', 'SPY'],
      });
      expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    });

    it('fails a ticker whose INSERT returns no count row instead of reading it as 0 rows', async () => {
      mockQuery.mockImplementation((text: string, params: unknown[] = []) => {
        if (isTickerList(text)) {
          return Promise.resolve([{ ticker: 'SPX' }, { ticker: 'SPY' }]);
        }
        // SPX's count row is missing; SPY's is fine.
        return Promise.resolve(params[1] === 'SPX' ? [] : [{ inserted: 4 }]);
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(insertedTickers()).toEqual(['SPX', 'SPY']);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 4,
        failedTickers: ['SPX'],
      });
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('no row count'),
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ 'rollup.ticker': 'SPX' }),
        }),
      );
    });

    it('retries a transient error on a ticker and lands it', async () => {
      // withDbRetry backs off 1 s before the retry; fake it.
      vi.useFakeTimers({ now: RUN_TIME });
      let aaplAttempts = 0;
      routeQuery({
        tickers: ['SPX', 'AAPL'],
        counts: { SPX: 3, AAPL: 5 },
        onInsert: (t) => {
          if (t !== 'AAPL') return undefined;
          aaplAttempts += 1;
          return aaplAttempts === 1 ? new Error('fetch failed') : undefined;
        },
      });

      const res = mockResponse();
      const run = handler(authedReq(), res);
      await vi.advanceTimersByTimeAsync(1_000);
      await run;

      expect(insertedTickers()).toEqual(['SPX', 'AAPL', 'AAPL']);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 8,
        failedTickers: [],
      });
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('fails the run with a 500 when the ticker list cannot be read', async () => {
      routeQuery({ tickers: new Error('connection lost') });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ job: JOB, error: 'Internal error' });
      expect(Sentry.captureException).toHaveBeenCalledOnce();
      expect(insertCalls()).toHaveLength(0);
    });
  });

  describe('run budget', () => {
    it('stops starting tickers once 240 s have elapsed and warns once about the deferred ones', async () => {
      routeQuery({
        tickers: ['SPX', 'AAPL', 'SPY'],
        counts: { SPX: 100 },
        onInsert: (t) => {
          // SPX is slow: the clock reaches the budget during it.
          if (t === 'SPX') {
            vi.setSystemTime(new Date(RUN_TIME.getTime() + 240_000));
          }
          return undefined;
        },
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(insertedTickers()).toEqual(['SPX']);
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 100,
        failedTickers: [],
        deferredTickers: ['AAPL', 'SPY'],
      });
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('deferred'),
        expect.objectContaining({
          level: 'warning',
          fingerprint: [JOB, 'deferred'],
          extra: expect.objectContaining({
            date: TODAY,
            deferredTickers: ['AAPL', 'SPY'],
          }),
        }),
      );
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('still starts a ticker just inside the budget', async () => {
      routeQuery({
        tickers: ['SPX', 'AAPL'],
        counts: { SPX: 1, AAPL: 2 },
        onInsert: (t) => {
          if (t === 'SPX') {
            vi.setSystemTime(new Date(RUN_TIME.getTime() + 239_999));
          }
          return undefined;
        },
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(insertedTickers()).toEqual(['SPX', 'AAPL']);
      expect(res._json).toMatchObject({ status: 'success', rows: 3 });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('reports error when the budget is spent before any ticker starts', async () => {
      mockQuery.mockImplementation((text: string) => {
        if (isTickerList(text)) {
          vi.setSystemTime(new Date(RUN_TIME.getTime() + 240_000));
          return Promise.resolve([{ ticker: 'SPX' }, { ticker: 'SPY' }]);
        }
        return Promise.reject(new Error('no INSERT expected'));
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(insertCalls()).toHaveLength(0);
      expect(res._json).toMatchObject({
        status: 'error',
        rows: 0,
        deferredTickers: ['SPX', 'SPY'],
      });
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('?date= override', () => {
    it('rolls up an earlier date when given one', async () => {
      routeQuery({ tickers: ['SPX'], counts: { SPX: 9 } });

      const res = mockResponse();
      await handler(authedReq({ date: '2026-05-15' }), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        date: '2026-05-15',
        rows: 9,
      });
      for (const call of mockQuery.mock.calls) {
        expect((call[1] as unknown[])[0]).toBe('2026-05-15');
      }
    });

    it('accepts today explicitly', async () => {
      routeQuery({ tickers: ['SPX'], counts: { SPX: 2 } });
      const res = mockResponse();
      await handler(authedReq({ date: TODAY }), res);
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        date: TODAY,
        rows: 2,
      });
    });

    it.each([
      ['a non-padded date', '2026-5-15'],
      ['an impossible calendar date', '2026-02-30'],
      ['garbage', 'yesterday'],
      ['a timestamp', '2026-05-15T00:00:00Z'],
      ['an empty string', ''],
      ['a repeated param', ['2026-05-15', '2026-05-14']],
      ['a date after today', '2026-05-19'],
    ])('rejects %s without touching the DB', async (_label, date) => {
      const res = mockResponse();
      await handler(authedReq({ date }), res);

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ job: JOB, error: 'Internal error' });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
    });
  });

  describe('runtime limits', () => {
    function vercelMaxDuration(): number | undefined {
      const vercel = JSON.parse(
        readFileSync(resolve(__dirname, '../../vercel.json'), 'utf8'),
      ) as { functions: Record<string, { maxDuration?: number }> };
      return vercel.functions['api/cron/rollup-ws-gex-strike-expiry.ts']
        ?.maxDuration;
    }

    it('runs for up to 300 s, matching vercel.json', () => {
      expect(config.maxDuration).toBe(300);
      expect(vercelMaxDuration()).toBe(300);
    });

    it('has a Sentry monitor whose max runtime outlasts the function limit', () => {
      const monitor = SCHEDULE_MAP[JOB];
      expect(monitor).toBeDefined();
      expect(monitor!.maxRuntime * 60).toBeGreaterThan(config.maxDuration);
    });
  });
});
