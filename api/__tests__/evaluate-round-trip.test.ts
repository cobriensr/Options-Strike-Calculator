// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockWithDbRetry } = vi.hoisted(() => ({
  mockSql: vi.fn() as ReturnType<typeof vi.fn>,
  // Pass-through that records (retries, timeout) so the run-budget
  // arithmetic in the handler is pinned by the tests below.
  mockWithDbRetry: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn()),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: mockWithDbRetry,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

import handler from '../cron/evaluate-round-trip.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';

const RUN_TIME = new Date('2026-05-19T18:00:00.000Z');

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

type Source = 'lottery' | 'silent_boom';

/** `count` eligible rows of one source, ids from `firstId`, newest first. */
function eligibleRows(source: Source, count: number, firstId = 1) {
  return Array.from({ length: count }, (_, i) => ({
    source,
    id: firstId + i,
    option_chain_id: `CHAIN${firstId + i}`,
    fire_time: new Date(RUN_TIME.getTime() - (61 + i) * 60_000),
    dte: 2,
  }));
}

/** Ids from..to inclusive, matching eligibleRows' numbering. */
function idRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function sqlText(call: unknown[] | undefined): string {
  return (call?.[0] as readonly string[]).join('');
}

/**
 * Route mockSql by statement instead of call order, for multi-chunk runs.
 * The aggregation echoes its unnest input (ids, sources, dtes) with a
 * net_pct of -0.80. `onAgg` runs first, so a test can move the clock, or
 * return an Error to reject that chunk's aggregation.
 */
function routeSql(opts: {
  eligible: ReturnType<typeof eligibleRows>;
  onAgg?: (chunkIndex: number) => Error | undefined;
  failUpdate?: Error;
}) {
  let aggCalls = 0;
  mockSql.mockImplementation(
    (strings: readonly string[], ...values: unknown[]) => {
      const text = strings.join('');
      if (text.includes('LEFT JOIN LATERAL')) {
        const aggError = opts.onAgg?.(aggCalls++);
        if (aggError) return Promise.reject(aggError);
        const ids = values[0] as number[];
        const sources = values[1] as Source[];
        const dtes = values[4] as number[];
        return Promise.resolve(
          ids.map((id, i) => ({
            id,
            source: sources[i],
            dte: dtes[i],
            ask_size: 10,
            bid_size: 90,
            total_size: 100,
          })),
        );
      }
      if (text.includes('UPDATE')) {
        return opts.failUpdate
          ? Promise.reject(opts.failUpdate)
          : Promise.resolve([]);
      }
      return Promise.resolve(opts.eligible);
    },
  );
}

/** The ids each aggregation call received, in call order. */
function aggregatedIds(): number[][] {
  return mockSql.mock.calls
    .filter((c) => sqlText(c).includes('LEFT JOIN LATERAL'))
    .map((c) => c[1] as number[]);
}

/** [table, ids] for each UPDATE, in call order. */
function updates(): [string, number[]][] {
  return mockSql.mock.calls
    .filter((c) => sqlText(c).includes('UPDATE'))
    .map((c) => [
      sqlText(c).includes('lottery_finder_fires')
        ? 'lottery_finder_fires'
        : 'silent_boom_alerts',
      c[1] as number[],
    ]);
}

describe('evaluate-round-trip handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(RUN_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('returns 405 on non-GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when CRON_SECRET is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer nope' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 200 with rows=0 when no eligible alerts', async () => {
    mockSql.mockResolvedValueOnce([]); // eligible-alerts SELECT
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
    // Exactly one DB call: just the eligible-alerts SELECT.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('applies -3 deduct when net_pct < -0.50', async () => {
    // One lottery alert is eligible.
    mockSql.mockResolvedValueOnce([
      {
        source: 'lottery',
        id: 42,
        option_chain_id: 'NVDA260620C00200000',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
        dte: 3,
      },
    ]);
    // Batched aggregation returns one row keyed by id+source —
    // net_pct = (10 - 90) / 100 = -0.80 → deduct -3.
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        source: 'lottery',
        dte: 3,
        ask_size: 10,
        bid_size: 90,
        total_size: 100,
      },
    ]);
    // Single batched UPDATE for the lottery side.
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      eligible: 1,
      evaluated: 1,
      deducted: 1,
      noFlow: 0,
    });
    // Exactly three DB calls: eligible SELECT + batched aggregation +
    // one lottery batched UPDATE (no silent_boom rows → branch skipped).
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('applies -2 deduct in [-0.50, -0.30)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'lottery',
        id: 7,
        option_chain_id: 'SPY260620P00500000',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
        dte: 5,
      },
    ]);
    // net_pct = (30 - 70) / 100 = -0.40 → deduct -2
    mockSql.mockResolvedValueOnce([
      {
        id: 7,
        source: 'lottery',
        dte: 5,
        ask_size: 30,
        bid_size: 70,
        total_size: 100,
      },
    ]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._json).toMatchObject({
      evaluated: 1,
      deducted: 1,
    });
  });

  it('applies -1 deduct in [-0.30, -0.10)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'silent_boom',
        id: 11,
        option_chain_id: 'TSLA260620P00300000',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
        dte: 0,
      },
    ]);
    // net_pct = (40 - 60) / 100 = -0.20 → deduct -1
    mockSql.mockResolvedValueOnce([
      {
        id: 11,
        source: 'silent_boom',
        dte: 0,
        ask_size: 40,
        bid_size: 60,
        total_size: 100,
      },
    ]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._json).toMatchObject({
      evaluated: 1,
      deducted: 1,
    });
  });

  it('applies 0 deduct when net_pct >= -0.10', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'lottery',
        id: 99,
        option_chain_id: 'QQQ260620C00650000',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
        dte: 1,
      },
    ]);
    // net_pct = (50 - 50) / 100 = 0.0 → deduct 0
    mockSql.mockResolvedValueOnce([
      {
        id: 99,
        source: 'lottery',
        dte: 1,
        ask_size: 50,
        bid_size: 50,
        total_size: 100,
      },
    ]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._json).toMatchObject({
      evaluated: 1,
      deducted: 0,
    });
  });

  it('writes net_pct but skips deduct when dte > 7 (any-DTE structural read)', async () => {
    // Phase 1 EDA: AUC collapses to 0.528 at 8-30 DTE, so the score
    // penalty is gated to ≤7. The cron still computes net_pct so the
    // front-end "Hide round-tripped (any DTE)" filter can read it.
    mockSql.mockResolvedValueOnce([
      {
        source: 'silent_boom',
        id: 200,
        option_chain_id: 'MSTR260529P00180000',
        fire_time: new Date('2026-05-15T18:45:00.000Z'),
        dte: 14,
      },
    ]);
    // net_pct = (10 - 90) / 100 = -0.80 — would be -3 if dte≤7.
    mockSql.mockResolvedValueOnce([
      {
        id: 200,
        source: 'silent_boom',
        dte: 14,
        ask_size: 10,
        bid_size: 90,
        total_size: 100,
      },
    ]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);
    // evaluated counts the row (flow was non-zero), but deducted is 0
    // because dte > SCORE_DEDUCT_DTE_MAX.
    expect(res._json).toMatchObject({
      eligible: 1,
      evaluated: 1,
      deducted: 0,
      noFlow: 0,
    });
  });

  it('handles no-flow case by writing 0 and counting noFlow', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'lottery',
        id: 1,
        option_chain_id: 'ILLIQUID',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
        dte: 2,
      },
    ]);
    // No post-fire trades at all.
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        source: 'lottery',
        dte: 2,
        ask_size: 0,
        bid_size: 0,
        total_size: 0,
      },
    ]);
    // Batched UPDATE still fires (with deduct=0, net_pct=0).
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._json).toMatchObject({
      rows: 1,
      evaluated: 0,
      deducted: 0,
      noFlow: 1,
    });
  });

  it('processes both sources as single-source chunks, silent_boom first', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'lottery',
        id: 1,
        option_chain_id: 'A',
        fire_time: new Date('2026-05-19T16:51:00.000Z'),
        dte: 0,
      },
      {
        source: 'silent_boom',
        id: 2,
        option_chain_id: 'B',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
        dte: 4,
      },
    ]);
    // silent_boom chunk: aggregation + its UPDATE.
    mockSql.mockResolvedValueOnce([
      {
        id: 2,
        source: 'silent_boom',
        dte: 4,
        ask_size: 80,
        bid_size: 20,
        total_size: 100,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // silent_boom UPDATE
    // lottery chunk: aggregation + its UPDATE.
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        source: 'lottery',
        dte: 0,
        ask_size: 5,
        bid_size: 95,
        total_size: 100,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // lottery UPDATE

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._json).toMatchObject({
      eligible: 2,
      evaluated: 2,
      deducted: 1,
      noFlow: 0,
      deferred: 0,
    });
    // SELECT + (agg + UPDATE) per single-source chunk.
    expect(mockSql).toHaveBeenCalledTimes(5);
    expect(aggregatedIds()).toEqual([[2], [1]]);
    expect(updates()).toEqual([
      ['silent_boom_alerts', [2]],
      ['lottery_finder_fires', [1]],
    ]);
  });

  it('writes silent_boom no-flow row via the silent_boom UPDATE branch', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'silent_boom',
        id: 42,
        option_chain_id: 'AAPL260620C00200000',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
        dte: 6,
      },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        source: 'silent_boom',
        dte: 6,
        ask_size: 0,
        bid_size: 0,
        total_size: 0,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // the batched UPDATE silent_boom_alerts call

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._json).toMatchObject({ noFlow: 1 });
    // Inspect the actual UPDATE template to confirm it routed to silent_boom_alerts.
    const updateCall = mockSql.mock.calls[2];
    const updateSql = (updateCall?.[0] as readonly string[]).join('');
    expect(updateSql).toContain('silent_boom_alerts');
    expect(updateSql).not.toContain('lottery_finder_fires');
    // Batched UPDATE uses unnest, not per-row WHERE id = ...
    expect(updateSql).toContain('unnest');
  });

  it('eligibility SELECT pulls dte but no longer filters on it', async () => {
    // The DTE filter on the SELECT was removed so net_pct is computed for
    // ALL DTEs (the 8+ rows feed the front-end "Hide round-tripped (any
    // DTE)" structural filter). Score deduct is gated in-code by
    // SCORE_DEDUCT_DTE_MAX = 7 instead. INTERVAL syntax remains the
    // safe `(N::int * INTERVAL '1 minute')` pattern.
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    const selectCall = mockSql.mock.calls[0];
    const selectSql = (selectCall?.[0] as readonly string[]).join('');
    // dte is now in the SELECT projection, not in the WHERE clause.
    expect(selectSql).toContain('fire_time, dte');
    expect(selectSql).not.toMatch(/dte\s*<=/);
    // Unsafe pattern that would silently break — must not appear.
    expect(selectSql).not.toMatch(/INTERVAL\s+'\s*minutes/);
    expect(selectSql).not.toMatch(/INTERVAL\s+'\s*hour/);
    // Safe pattern — bound value × unit interval.
    expect(selectSql).toContain("* INTERVAL '1 minute'");
    expect(selectSql).toContain("* INTERVAL '1 hour'");
  });

  it('tags Sentry with cron.job on the success path', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'evaluate-round-trip',
    );
  });

  // ── Per-run work bound ─────────────────────────────────────────
  // A run that evaluated every eligible alert in one query outgrew the 60 s
  // maxDuration on 2026-10-16. Vercel killed it before its UPDATEs and its
  // Sentry completion check-in, the backlog compounded, and every session
  // tick through 10-23 18:50 UTC died the same way.

  describe('per-run work bound', () => {
    it('reads the eligible set newest first', async () => {
      mockSql.mockResolvedValueOnce([]);
      await handler(authedReq(), mockResponse());
      expect(sqlText(mockSql.mock.calls[0])).toMatch(
        /ORDER BY fire_time DESC\s*$/,
      );
    });

    it('aggregates and writes 100-alert chunks, each written before the next is read', async () => {
      routeSql({ eligible: eligibleRows('lottery', 250) });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 250,
        eligible: 250,
        evaluated: 250,
        deducted: 250,
        deferred: 0,
      });
      expect(aggregatedIds()).toEqual([
        idRange(1, 100),
        idRange(101, 200),
        idRange(201, 250),
      ]);
      // SELECT, then agg → UPDATE per chunk: progress is committed chunk
      // by chunk, so a run that dies keeps what it already wrote.
      const kinds = mockSql.mock.calls.slice(1).map((c) => {
        const text = sqlText(c);
        return text.includes('UPDATE') ? 'update' : 'agg';
      });
      expect(kinds).toEqual([
        'agg',
        'update',
        'agg',
        'update',
        'agg',
        'update',
      ]);
      expect(updates().map(([table]) => table)).toEqual([
        'lottery_finder_fires',
        'lottery_finder_fires',
        'lottery_finder_fires',
      ]);
    });

    it('stops starting chunks once the 20 s budget is spent and defers the rest', async () => {
      routeSql({
        eligible: eligibleRows('lottery', 250),
        onAgg: (chunk) => {
          // The first chunk is slow: the clock reaches the budget during it.
          if (chunk === 0) {
            vi.setSystemTime(new Date(RUN_TIME.getTime() + 20_000));
          }
          return undefined;
        },
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      // The run returns normally, so the wrapper sends its completion
      // check-in instead of being killed at maxDuration.
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 100,
        eligible: 250,
        evaluated: 100,
        deferred: 150,
      });
      // The chunk already aggregated is still written.
      expect(updates()).toEqual([['lottery_finder_fires', idRange(1, 100)]]);
      expect(aggregatedIds()).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eligible: 250,
          deferred: 150,
          budgetMs: 20_000,
        }),
        expect.stringContaining('run budget spent'),
      );
    });

    it('still starts a chunk just inside the budget', async () => {
      routeSql({
        eligible: eligibleRows('lottery', 250),
        onAgg: (chunk) => {
          const elapsed = chunk === 0 ? 19_999 : 20_000;
          vi.setSystemTime(new Date(RUN_TIME.getTime() + elapsed));
          return undefined;
        },
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(aggregatedIds()).toEqual([idRange(1, 100), idRange(101, 200)]);
      expect(res._json).toMatchObject({ evaluated: 200, deferred: 50 });
    });

    it('spends the budget on silent_boom before lottery', async () => {
      routeSql({
        eligible: [
          ...eligibleRows('lottery', 150, 1),
          ...eligibleRows('silent_boom', 30, 1001),
        ],
        onAgg: () => {
          vi.setSystemTime(new Date(RUN_TIME.getTime() + 20_000));
          return undefined;
        },
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(updates()).toEqual([
        ['silent_boom_alerts', Array.from({ length: 30 }, (_, i) => 1001 + i)],
      ]);
      expect(res._json).toMatchObject({ evaluated: 30, deferred: 150 });
    });

    it('bounds every DB call so the worst case fits the 60 s maxDuration', async () => {
      routeSql({ eligible: eligibleRows('lottery', 1) });
      await handler(authedReq(), mockResponse());

      // SELECT, aggregation, UPDATE: one retry each, per-attempt timeouts.
      const [select, agg, update] = mockWithDbRetry.mock.calls.map((call) => {
        // The mock is typed with fn only; the handler passes all three.
        const [, retries, timeoutMs] = call as unknown[];
        return { retries: retries as number, timeoutMs: timeoutMs as number };
      });
      expect([select, agg, update]).toEqual([
        { retries: 1, timeoutMs: 8_000 },
        { retries: 1, timeoutMs: 8_000 },
        { retries: 1, timeoutMs: 5_000 },
      ]);

      // withDbRetry's worst case: every attempt times out, with a
      // 1 s × attempt backoff between attempts.
      const worst = (b: { retries: number; timeoutMs: number } | undefined) => {
        if (!b) throw new Error('missing withDbRetry call');
        let ms = (b.retries + 1) * b.timeoutMs;
        for (let a = 1; a <= b.retries; a++) ms += 1_000 * a;
        return ms;
      };
      const IN_PROGRESS_POST_MS = 5_000; // before the handler, in budget
      const COMPLETION_POST_MS = 5_000; // after the handler
      // A chunk can start up to the 20 s budget and then run its
      // aggregation and UPDATE to their worst case.
      const handlerEndMs = Math.max(
        IN_PROGRESS_POST_MS + worst(select),
        20_000 + worst(agg) + worst(update),
      );
      // Leave at least 5 s of the 60 s for the Axiom event and response.
      expect(handlerEndMs + COMPLETION_POST_MS).toBeLessThanOrEqual(55_000);
    });

    it('serialises a string fire_time from the driver', async () => {
      mockSql.mockResolvedValueOnce([
        {
          source: 'lottery',
          id: 5,
          option_chain_id: 'SPY260519C00590000',
          fire_time: '2026-05-19T16:50:00.000Z',
          dte: 0,
        },
      ]);
      mockSql.mockResolvedValueOnce([
        {
          id: 5,
          source: 'lottery',
          dte: 0,
          ask_size: 50,
          bid_size: 50,
          total_size: 100,
        },
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      // unnest input: ids, sources, chains, fires, dtes.
      expect(mockSql.mock.calls[1]?.[4]).toEqual(['2026-05-19T16:50:00.000Z']);
    });
  });

  // ── Failure modes ──────────────────────────────────────────────
  // Each DB step that rejects must surface as a 500 + Sentry exception +
  // error log (the wrapper also sends the 'error' check-in), never as a
  // success, and must not lose chunks already written.

  describe('failure modes', () => {
    it('surfaces an eligible-SELECT failure and writes nothing', async () => {
      const err = new Error('Neon HTTP 503');
      mockSql.mockRejectedValueOnce(err);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({
        job: 'evaluate-round-trip',
        error: 'Internal error',
      });
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        'evaluate-round-trip error',
      );
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('surfaces an aggregation failure and keeps the chunks already written', async () => {
      const err = new Error('db attempt timeout');
      routeSql({
        eligible: eligibleRows('lottery', 250),
        onAgg: (chunk) => (chunk === 1 ? err : undefined),
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        'evaluate-round-trip error',
      );
      // Chunk 1 was written before chunk 2's aggregation failed.
      expect(updates()).toEqual([['lottery_finder_fires', idRange(1, 100)]]);
      // Chunk 3 never started.
      expect(aggregatedIds()).toHaveLength(2);
    });

    it('surfaces an UPDATE failure and starts no further chunk', async () => {
      const err = new Error('deadlock detected');
      routeSql({ eligible: eligibleRows('lottery', 250), failUpdate: err });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ error: 'Internal error' });
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
      expect(aggregatedIds()).toHaveLength(1);
      expect(updates()).toHaveLength(1);
    });
  });

  // ── Time gate: open buffer through close + 80 min ─────────────
  // Fires from the session's last hour need their 60-min post-fire window
  // before they can be evaluated. The old isMarketHours() gate closed at
  // close + 5, so Friday's 15:00–16:05 ET fires waited for a Monday run
  // that was past the 24 h catch-up floor and after the tape sweep —
  // they were never evaluated. These run the REAL cronGuard and calendar.

  describe('post-close evaluation window', () => {
    it('evaluates a Friday 15:30 ET fire on the 16:30 ET after-close run', async () => {
      vi.setSystemTime(new Date('2026-09-25T20:30:00.000Z')); // Fri 16:30 EDT
      mockSql.mockResolvedValueOnce([
        {
          source: 'lottery',
          id: 501,
          option_chain_id: 'SPY260925C00660000',
          fire_time: new Date('2026-09-25T19:30:00.000Z'), // 15:30 ET
          dte: 0,
        },
      ]);
      // net_pct = (10 - 90) / 100 = -0.80 → deduct -3
      mockSql.mockResolvedValueOnce([
        {
          id: 501,
          source: 'lottery',
          dte: 0,
          ask_size: 10,
          bid_size: 90,
          total_size: 100,
        },
      ]);
      mockSql.mockResolvedValueOnce([]); // lottery UPDATE

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        eligible: 1,
        evaluated: 1,
        deducted: 1,
      });
      expect(mockSql).toHaveBeenCalledTimes(3);
    });

    it.each([
      [
        '2026-09-25T21:10:00.000Z',
        'Fri 17:10 EDT — first tick to see a 16:05 ET fire',
      ],
      [
        '2026-09-25T21:20:00.000Z',
        'Fri 17:20 EDT — close + 80, the retry tick',
      ],
      ['2026-12-04T22:10:00.000Z', 'Fri 17:10 EST — needs the 22:xx UTC hour'],
      ['2026-12-04T22:20:00.000Z', 'Fri 17:20 EST — close + 80'],
      ['2026-09-28T13:25:00.000Z', 'Mon 09:25 EDT — open buffer, unchanged'],
    ])('runs at %s (%s)', async (iso) => {
      vi.setSystemTime(new Date(iso));
      mockSql.mockResolvedValueOnce([]); // eligible-alerts SELECT

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ status: 'success', rows: 0 });
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['2026-09-25T21:30:00.000Z', 'Fri 17:30 EDT — past close + 80'],
      ['2026-12-04T22:30:00.000Z', 'Fri 17:30 EST — past close + 80'],
      ['2026-09-26T20:30:00.000Z', 'Saturday 16:30 EDT'],
      ['2026-09-28T13:20:00.000Z', 'Mon 09:20 EDT — before the open buffer'],
    ])('skips at %s (%s)', async (iso) => {
      vi.setSystemTime(new Date(iso));

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        skipped: true,
        reason: 'Outside time window',
      });
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('skips all day on a market holiday (Thanksgiving)', async () => {
      // Precondition from the shared calendar, so a calendar change fails
      // here rather than silently changing what this test covers.
      expect(getMarketCloseHourET('2026-11-26')).toBeNull();
      vi.setSystemTime(new Date('2026-11-26T17:00:00.000Z')); // 12:00 EST

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._json).toMatchObject({ skipped: true });
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('follows a half-day close: runs to 13:00 + 80 = 14:20 ET, skips after', async () => {
      expect(getMarketCloseHourET('2026-11-27')).toBe(13); // Black Friday

      vi.setSystemTime(new Date('2026-11-27T19:20:00.000Z')); // 14:20 EST
      mockSql.mockResolvedValueOnce([]);
      const atGateEnd = mockResponse();
      await handler(authedReq(), atGateEnd);
      expect(atGateEnd._json).toMatchObject({ status: 'success' });
      expect(mockSql).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-11-27T19:30:00.000Z')); // 14:30 EST
      const pastGate = mockResponse();
      await handler(authedReq(), pastGate);
      expect(pastGate._json).toMatchObject({ skipped: true });
      expect(mockSql).toHaveBeenCalledTimes(1); // no new DB call
    });
  });
});
