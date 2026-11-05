// @vitest-environment node

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

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

// cron-instrumentation.js stays real: the handler is wrapped in
// withCronCheckin, and the check-in tests below drive that wrapper end to
// end through a stubbed fetch.
import handler from '../cron/cleanup-ws-gex-strike-expiry.js';
import { reportCronRun } from '../_lib/axiom.js';
import { _resetDsnCacheForTest } from '../_lib/cron-instrumentation.js';
import { SCHEDULE_MAP } from '../_lib/cron-schedules.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

const JOB = 'cleanup-ws-gex-strike-expiry';

// Friday 12:00 UTC = 8am ET on a DST day. cronGuard derives `today`
// via getETDateStr(new Date()) which respects ET — so on this clock
// the cron's today is 2026-05-15.
const RUN_TIME = new Date('2026-05-15T12:00:00.000Z');

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('cleanup-ws-gex-strike-expiry handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-attach query fn after resetAllMocks wipes it.
    mockSql.query = mockQuery;
    mockQuery.mockResolvedValue([]);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(RUN_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    // Restores the Date.now spy from fakeClock, even when a test fails
    // before reaching its end.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Pin Date.now and return a function that moves it forward. The clock
   * advances only when a test says so (inside a batch), so the wrapper's own
   * Date.now() calls for check-in timing can't shift the budget arithmetic.
   */
  function fakeClock(): (ms: number) => void {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    return (ms) => {
      now += ms;
    };
  }

  const FULL_BATCH = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));

  it('returns 405 on non-GET', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 on wrong bearer', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('no-ops cleanly when the table holds no pre-today rows', async () => {
    // Both passes return 0 immediately → loop exits at each pass's first
    // iteration, total=0, batches=2 (one no-op batch per pass).
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      today: '2026-05-15',
      totalDeleted: 0,
      batches: 2,
      stopReason: 'drained',
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('ends a pass on a short batch, without an extra empty DELETE', async () => {
    // A batch under BATCH_SIZE means the pass predicate has nothing left.
    const shortBatch = Array.from({ length: 1_234 }, (_, i) => ({ id: i }));
    mockQuery
      .mockResolvedValueOnce(FULL_BATCH) // pass 1 batch 1
      .mockResolvedValueOnce(shortBatch) // pass 1 drained by a short batch
      .mockResolvedValueOnce(shortBatch); // pass 2 drained the same way

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalDeleted: 52_468,
      batches: 3,
      stopReason: 'drained',
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls.map(([sql]) => sql as string)).toEqual([
      expect.stringContaining('expiry < $1::date'),
      expect.stringContaining('expiry < $1::date'),
      expect.stringContaining('expiry >= $1::date'),
    ]);
  });

  it('drains both passes across multiple batches', async () => {
    // Pass 1 (past_expiry): 2 full batches then drained.
    // Pass 2 (pre_today_minutes): 1 full batch then drained.
    const fullBatch = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    mockQuery
      .mockResolvedValueOnce(fullBatch) // pass 1 batch 1
      .mockResolvedValueOnce(fullBatch) // pass 1 batch 2
      .mockResolvedValueOnce([]) //         pass 1 drained
      .mockResolvedValueOnce(fullBatch) // pass 2 batch 1
      .mockResolvedValueOnce([]); //        pass 2 drained

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalDeleted: 150_000,
      batches: 5,
      stopReason: 'drained',
    });
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  it('issues both passes with index-friendly predicates', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    // Two passes → two query invocations on the empty path. Each call
    // is `(sqlString, params)`; both bind today as $1.
    const [pass1Sql, pass1Params] = mockQuery.mock.calls[0]!;
    const [pass2Sql, pass2Params] = mockQuery.mock.calls[1]!;

    // Pass 1: past-expiry predicate hits the (ticker, expiry, …) index
    // via a bare `expiry <` comparison — no function call on the column.
    expect(pass1Sql).toContain('ws_gex_strike_expiry');
    expect(pass1Sql).toContain('expiry < $1::date');
    expect(pass1Sql).not.toContain('ts_minute AT TIME ZONE');
    expect(pass1Params).toEqual(['2026-05-15']);

    // Pass 2: today/future expiries with pre-today minutes. The TZ
    // conversion is on the CONSTANT side, not on the column — so the
    // predicate stays sargable against the (ticker, expiry, ts_minute)
    // UNIQUE index. The `::timestamp` makes it ET midnight in any session
    // zone (cleanup-ws-gex-strike-expiry-pglite.test.ts proves it).
    expect(pass2Sql).toContain('expiry >= $1::date');
    expect(pass2Sql).toContain(
      "ts_minute < ($1::date::timestamp AT TIME ZONE 'America/New_York')",
    );
    expect(pass2Params).toEqual(['2026-05-15']);
  });

  it('tags Sentry on the success path, not only on failure', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // The setTag must fire BEFORE any work, not only inside catch — so
    // a Sentry breadcrumb from this run is correctly grouped under
    // cron.job even on clean runs that don't capture an exception.
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'cleanup-ws-gex-strike-expiry',
    );
  });

  it.each([
    {
      // Equal terms. Under the old 295 s after-the-batch check, the 240.5 s
      // case below would have kept going.
      projection: 'elapsed 119.75 s + slowest 119.75 s = 239.5 s',
      fullBatchesMs: [119_750],
      queries: 3, // batch 2 drains pass 1, then pass 2 drains
      stopReason: 'drained',
    },
    {
      projection: 'elapsed 120.25 s + slowest 120.25 s = 240.5 s',
      fullBatchesMs: [120_250],
      queries: 1,
      stopReason: 'wall_budget',
    },
    {
      // Unequal terms, so each one is pinned on its own: `2 * elapsed`
      // (240.8 s) would stop here.
      projection: 'elapsed 120.4 s + slowest 119.4 s = 239.8 s',
      fullBatchesMs: [1_000, 119_400],
      queries: 4,
      stopReason: 'drained',
    },
    {
      // `2 * slowest` (200 s) or elapsed alone (190 s) would keep going.
      projection: 'elapsed 190 s + slowest 100 s = 290 s',
      fullBatchesMs: [100_000, 90_000],
      queries: 2,
      stopReason: 'wall_budget',
    },
  ])(
    'before the next batch, $projection → $stopReason',
    async ({ fullBatchesMs, queries, stopReason }) => {
      // Full batches taking the listed times; every later batch takes no
      // time and deletes nothing. Before each batch after the first, the
      // projection is elapsed time plus the slowest batch so far, against
      // the 240 s budget.
      const advance = fakeClock();
      for (const ms of fullBatchesMs) {
        mockQuery.mockImplementationOnce(async () => {
          advance(ms);
          return FULL_BATCH;
        });
      }

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        totalDeleted: fullBatchesMs.length * 50_000,
        stopReason,
      });
      expect(mockQuery).toHaveBeenCalledTimes(queries);
    },
  );

  it('checks the budget at the pass boundary, so pass 2 never starts after a late pass 1', async () => {
    // Pass 1: a quick full batch, then its draining batch ends at 241 s.
    // The budget used to be checked only after a non-empty batch, so pass
    // 2's first DELETE started past the budget and could run into
    // maxDuration, where the kill reads as a monitor timeout.
    const advance = fakeClock();
    mockQuery
      .mockImplementationOnce(async () => {
        advance(1_000); // pass 1 batch 1: ends at 1 s
        return FULL_BATCH;
      })
      .mockImplementationOnce(async () => {
        advance(240_000); // pass 1 batch 2: drains, ends at 241 s
        return [];
      });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalDeleted: 50_000,
      batches: 2,
      stopReason: 'wall_budget',
    });
    // Both pass 1 batches ran; pass 2's DELETE never did.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls.map(([sql]) => sql as string)).toEqual([
      expect.stringContaining('expiry < $1::date'),
      expect.stringContaining('expiry < $1::date'),
    ]);
  });

  it('captures errors to Sentry and returns 500 with partial counts', async () => {
    // Two successful batches then a crash on the third — partial counts
    // must still be reported so the on-call can size the residue.
    const fullBatch = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    mockQuery
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(fullBatch)
      .mockRejectedValueOnce(new Error('connection lost'));

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'cleanup failed',
      totalDeleted: 100_000,
      batches: 2,
    });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'cleanup-ws-gex-strike-expiry',
    );
  });

  // ── Axiom run event (reportCronRun) ─────────────────────────────

  describe('Axiom run event', () => {
    it('reports ok with the response summary on a drained run', async () => {
      mockQuery
        .mockResolvedValueOnce(FULL_BATCH) // pass 1 batch 1
        .mockResolvedValueOnce([]) //         pass 1 drained
        .mockResolvedValueOnce([]); //        pass 2 drained

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(reportCronRun).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledWith(JOB, {
        status: 'ok',
        today: '2026-05-15',
        totalDeleted: 50_000,
        batches: 3,
        durationMs: expect.any(Number),
        stopReason: 'drained',
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: 'drained' }),
        'ws_gex_strike_expiry retention sweep complete',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('reports partial when the wall budget ends the sweep with rows left', async () => {
      // Once a day, a handful of batches should drain the table, so a budget
      // stop leaves expired rows until tomorrow: not a clean `ok`.
      const advance = fakeClock();
      mockQuery.mockImplementationOnce(async () => {
        advance(120_250); // elapsed + slowest = 240.5 s > 240 s budget
        return FULL_BATCH;
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(reportCronRun).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledWith(JOB, {
        status: 'partial',
        today: '2026-05-15',
        totalDeleted: 50_000,
        batches: 1,
        durationMs: 120_250,
        stopReason: 'wall_budget',
      });
      // Logged as a warning, not as a completed sweep.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: 'wall_budget' }),
        'ws_gex_strike_expiry retention: wall budget exhausted with expired rows remaining',
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'ws_gex_strike_expiry retention sweep complete',
      );
    });

    it('reports error with the partial counts when a DELETE fails, never ok', async () => {
      mockQuery
        .mockResolvedValueOnce(FULL_BATCH)
        .mockRejectedValueOnce(new Error('connection lost'));

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledWith(JOB, {
        status: 'error',
        error: 'Error: connection lost',
        today: '2026-05-15',
        totalDeleted: 50_000,
        batches: 1,
        durationMs: expect.any(Number),
      });
    });

    it('sends no event when the guard rejects the request', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: { authorization: 'Bearer wrong' },
        }),
        res,
      );

      expect(res._status).toBe(401);
      expect(reportCronRun).not.toHaveBeenCalled();
    });
  });

  // ── Sentry cron monitor (withCronCheckin) ───────────────────────

  describe('Sentry cron check-ins', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      // The outer beforeEach copied process.env, so this DSN is dropped
      // when the outer afterEach restores it.
      process.env.SENTRY_DSN = 'https://pubkey@o1.ingest.us.sentry.io/42';
      _resetDsnCacheForTest();
      fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      _resetDsnCacheForTest();
    });

    interface CheckInBody {
      check_in_id: string;
      monitor_slug: string;
      status: string;
      monitor_config?: Record<string, unknown>;
    }

    /** The check-in POSTs, in order. The completion is not awaited by the wrapper. */
    async function checkIns(count: number) {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(count));
      return fetchMock.mock.calls.map(([url, init]) => ({
        url: url as string,
        body: JSON.parse((init as { body: string }).body) as CheckInBody,
      }));
    }

    it('checks in under its slug with its SCHEDULE_MAP config, in_progress then ok', async () => {
      mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      const calls = await checkIns(2);
      expect(calls[0]!.url).toContain(`/cron/${JOB}/`);
      expect(calls.map((c) => c.body.monitor_slug)).toEqual([JOB, JOB]);
      expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'ok']);
      expect(calls[1]!.body.check_in_id).toBe(calls[0]!.body.check_in_id);
      expect(calls[0]!.body.monitor_config).toMatchObject({
        schedule: { type: 'crontab', value: SCHEDULE_MAP[JOB]!.schedule },
        // LONG_RUNNER_MAX_RUNTIME: maxDuration is 300 s, so a run that
        // uses its whole budget still completes inside the max runtime.
        max_runtime: 10,
        failure_issue_threshold: 1,
      });
    });

    it('sends an error check-in, not ok, when a DELETE fails', async () => {
      const fullBatch = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
      mockQuery
        .mockResolvedValueOnce(fullBatch)
        .mockRejectedValueOnce(new Error('connection lost'));

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ error: 'cleanup failed' });
      expect(Sentry.captureException).toHaveBeenCalledOnce();
      const calls = await checkIns(2);
      expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'error']);
    });

    it('sends no check-ins for a request without the cron bearer', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: { authorization: 'Bearer wrong' },
        }),
        res,
      );

      expect(res._status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
