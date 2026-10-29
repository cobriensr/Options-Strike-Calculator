// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockQuery, wrapped } = vi.hoisted(() => {
  const queryFn = vi.fn();
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    query: typeof queryFn;
  };
  fn.query = queryFn;
  return { mockSql: fn, mockQuery: queryFn, wrapped: { name: '' } };
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
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

// The check-in wrapper is exercised in cron-instrumentation.test.ts; here it
// is a passthrough that records the monitor slug it was registered under.
vi.mock('../_lib/cron-instrumentation.js', () => ({
  withCronCheckin: (name: string, fn: unknown) => {
    wrapped.name = name;
    return fn;
  },
}));

import handler from '../cron/cleanup-ws-option-trades.js';
import { reportCronRun } from '../_lib/axiom.js';
import { SCHEDULE_MAP } from '../_lib/cron-schedules.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// Monday 12:05 UTC = 08:05 ET (EDT). cronGuard derives `today` via
// getETDateStr(new Date()) → 2026-05-18 on this clock.
const RUN_TIME = new Date('2026-05-18T12:05:00.000Z');
// Cutoff for today = 2026-05-16 00:00 ET = 04:00 UTC (EDT).
const CUTOFF = new Date('2026-05-16T04:00:00.000Z');
const HOUR_MS = 3_600_000;
const BATCH = 50_000;

interface BatchRow {
  deleted: number;
  frontier: Date | string | null;
  cutoff: Date | string;
}

/** One batch result row as the DELETE … RETURNING aggregate returns it. */
function batch(deleted: number, frontierLagHours = 72): BatchRow[] {
  return [
    {
      deleted,
      frontier:
        deleted > 0
          ? new Date(CUTOFF.getTime() - frontierLagHours * HOUR_MS)
          : null,
      cutoff: CUTOFF,
    },
  ];
}

/** The EXPLAIN (FORMAT JSON) result shape for the backlog estimate. */
function explainRows(planRows: number) {
  return [
    {
      'QUERY PLAN': [
        { Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': planRows } },
      ],
    },
  ];
}

function isExplain(sql: unknown): boolean {
  return String(sql).trimStart().startsWith('EXPLAIN');
}

/**
 * Route the mocked `db.query`: EXPLAIN → `explain()`, every DELETE batch →
 * the next entry of `batches`, advancing the wall clock by `batchMs` so the
 * handler's budget arithmetic sees real elapsed time.
 */
function routeQueries(opts: {
  batches: BatchRow[][];
  batchMs?: number;
  explain?: () => Promise<unknown>;
}) {
  const queue = [...opts.batches];
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (isExplain(sql)) {
      return opts.explain ? opts.explain() : explainRows(0);
    }
    if (opts.batchMs) vi.setSystemTime(new Date(Date.now() + opts.batchMs));
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra batch');
    return next;
  });
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function deleteCalls() {
  return mockQuery.mock.calls.filter(([sql]) => !isExplain(sql));
}

describe('cleanup-ws-option-trades handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.query = mockQuery;
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.useFakeTimers();
    vi.setSystemTime(RUN_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('returns 405 on non-GET', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const res = mockResponse();
    await handler(authedReq(), res);
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
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('deletes oldest-first: the batch orders by executed_at under a sargable cutoff', async () => {
    routeQueries({ batches: [batch(0)] });
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    const [sql, params] = deleteCalls()[0]!;
    const text = String(sql);

    // Oldest-first: the ctid subquery walks the (executed_at) index in order
    // and takes the first BATCH_SIZE expired rows. The old unordered LIMIT
    // planned as a Seq Scan and pruned in physical order.
    expect(text).toMatch(
      /SELECT ctid FROM ws_option_trades[\s\S]*ORDER BY executed_at[\s\S]*LIMIT 50000/,
    );
    expect(text).toMatch(/DELETE FROM ws_option_trades\s+WHERE ctid = ANY/);
    // Bare column vs a constant-side TZ conversion keeps the index usable.
    expect(text).toContain(
      "executed_at < (($1::date - INTERVAL '2 days') AT TIME ZONE 'America/New_York')",
    );
    expect(text).not.toMatch(/\(executed_at[^)]*AT TIME ZONE/i);
    expect(text).not.toMatch(/date\(executed_at\)/i);
    // The batch returns a count + frontier, never the deleted ids.
    expect(text).toContain('count(*)::int AS deleted');
    expect(text).not.toMatch(/RETURNING id/);
    // Each batch starts at the previous frontier (inclusive, for ties).
    expect(text).toContain(
      "executed_at >= COALESCE($2::timestamptz, '-infinity')",
    );

    // First batch: no frontier yet → unbounded below.
    expect(params).toEqual(['2026-05-18', null]);
  });

  it('starts each batch at the previous batch’s frontier so deleted index entries are not re-walked', async () => {
    routeQueries({ batches: [batch(BATCH, 80), batch(BATCH, 60), batch(7)] });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const params = deleteCalls().map(([, p]) => p);
    expect(params).toEqual([
      ['2026-05-18', null],
      ['2026-05-18', new Date(CUTOFF.getTime() - 80 * HOUR_MS).toISOString()],
      ['2026-05-18', new Date(CUTOFF.getTime() - 60 * HOUR_MS).toISOString()],
    ]);
  });

  it('no-ops with one cheap batch when nothing is expired', async () => {
    routeQueries({ batches: [batch(0)] });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      today: '2026-05-18',
      totalDeleted: 0,
      batches: 1,
      stopReason: 'drained',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('stops on a partial batch without issuing an extra empty batch', async () => {
    routeQueries({ batches: [batch(BATCH), batch(BATCH), batch(1_234)] });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalDeleted: 101_234,
      batches: 3,
      stopReason: 'drained',
    });
    expect(deleteCalls()).toHaveLength(3);
    // Drained → no backlog estimate and no alert.
    expect(mockQuery.mock.calls.some(([sql]) => isExplain(sql))).toBe(false);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('budget exhaustion with more than a day of backlog sends a fingerprinted Sentry warning with the estimate', async () => {
    // 100 s per batch: after batch 2, elapsed (200 s) + slowest (100 s)
    // passes the 240 s budget → stop before a third batch.
    routeQueries({
      batches: [batch(BATCH, 80), batch(BATCH, 72)],
      batchMs: 100_000,
      explain: async () => explainRows(24_000_000),
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(deleteCalls()).toHaveLength(2);
    expect(res._json).toMatchObject({
      totalDeleted: 100_000,
      batches: 2,
      stopReason: 'wall_budget',
      backlog: {
        estimatedBacklogRows: 24_000_000,
        lagHours: 72,
        oldestRemaining: new Date(
          CUTOFF.getTime() - 72 * HOUR_MS,
        ).toISOString(),
        cutoff: CUTOFF.toISOString(),
      },
    });

    // The estimate is a planner-only EXPLAIN on the same cutoff.
    const explainCall = mockQuery.mock.calls.find(([sql]) => isExplain(sql));
    expect(String(explainCall?.[0])).toContain('EXPLAIN (FORMAT JSON)');
    expect(explainCall?.[1]).toEqual(['2026-05-18']);

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(message).toContain('24000000');
    expect(context).toMatchObject({
      level: 'warning',
      fingerprint: ['cleanup-ws-option-trades', 'backlog'],
      tags: { 'cron.anomaly': 'ws-option-trades-retention-backlog' },
      extra: expect.objectContaining({
        estimatedBacklogRows: 24_000_000,
        lagHours: 72,
        totalDeleted: 100_000,
        stopReason: 'wall_budget',
      }),
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('a budget stop within one session of the cutoff logs a warning but does not alert', async () => {
    // A normal first post-midnight run: the just-expired session is half
    // deleted, the frontier sits ~10 h before the cutoff, the next hourly
    // run drains it.
    routeQueries({
      batches: [batch(BATCH, 10)],
      batchMs: 150_000,
      explain: async () => explainRows(3_000_000),
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stopReason: 'wall_budget',
      backlog: { estimatedBacklogRows: 3_000_000, lagHours: 10 },
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'wall_budget', lagHours: 10 }),
      expect.stringContaining('budget'),
    );
  });

  it('still alerts, with a null estimate, when the backlog estimate query fails', async () => {
    routeQueries({
      batches: [batch(BATCH, 96)],
      batchMs: 150_000,
      explain: async () => {
        throw new Error('estimate blew up');
      },
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(Sentry.captureMessage).mock.calls[0]![1]).toMatchObject({
      extra: expect.objectContaining({ estimatedBacklogRows: null }),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('estimate failed'),
    );
  });

  it('parses ISO-string timestamps from the driver as well as Dates', async () => {
    const frontier = new Date(CUTOFF.getTime() - 30 * HOUR_MS).toISOString();
    routeQueries({
      batches: [[{ deleted: BATCH, frontier, cutoff: CUTOFF.toISOString() }]],
      batchMs: 150_000,
      explain: async () => explainRows(9_000_000),
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({
      backlog: { lagHours: 30, oldestRemaining: frontier },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
  });

  it('alerts (fail loud) when the lag cannot be computed from the batch result', async () => {
    routeQueries({
      batches: [[{ deleted: BATCH, frontier: 'garbage', cutoff: CUTOFF }]],
      batchMs: 150_000,
      explain: async () => explainRows(5_000_000),
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(message).toContain('unknown');
    expect(context).toMatchObject({
      extra: expect.objectContaining({
        lagHours: null,
        oldestRemaining: null,
      }),
    });
  });

  it('reads the estimate when the driver hands EXPLAIN JSON back as a string', async () => {
    routeQueries({
      batches: [batch(BATCH, 30)],
      batchMs: 150_000,
      explain: async () => [
        {
          'QUERY PLAN': JSON.stringify([{ Plan: { 'Plan Rows': 4_200_000 } }]),
        },
      ],
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({
      backlog: { estimatedBacklogRows: 4_200_000 },
    });
  });

  it('reports a null estimate for an unparseable EXPLAIN result and still alerts', async () => {
    routeQueries({
      batches: [batch(BATCH, 30)],
      batchMs: 150_000,
      explain: async () => [{ 'QUERY PLAN': 'not json' }],
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({
      backlog: { estimatedBacklogRows: null, lagHours: 30 },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
  });

  it('surfaces a DB reject as a 500 + captureException, never a success', async () => {
    let call = 0;
    mockQuery.mockImplementation(async () => {
      call += 1;
      if (call === 1) return batch(BATCH);
      throw new Error('connection lost');
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'cleanup failed',
      totalDeleted: 50_000,
      batches: 1,
    });
    expect(res._json).not.toHaveProperty('stopReason');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), totalDeleted: 50_000 }),
      'cleanup-ws-option-trades failed',
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('treats an empty batch result as a failure, not as drained', async () => {
    // A DELETE aggregate always returns one row; an empty result must not be
    // read as "0 deleted → drained → success".
    mockQuery.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('treats a non-numeric deleted count as a failure, not as drained', async () => {
    // What count(*) without the ::int cast would return through the driver.
    mockQuery.mockResolvedValueOnce([
      { deleted: '50000', frontier: CUTOFF, cutoff: CUTOFF },
    ]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'cleanup-ws-option-trades failed',
    );
  });

  describe('Axiom run event', () => {
    const JOB = 'cleanup-ws-option-trades';

    it('reports ok with the response summary on a drained run', async () => {
      routeQueries({ batches: [batch(BATCH), batch(1_234)], batchMs: 10_000 });
      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(reportCronRun).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledWith(JOB, {
        status: 'ok',
        today: '2026-05-18',
        totalDeleted: 51_234,
        batches: 2,
        durationMs: 20_000,
        rowsPerSec: 2_562,
        stopReason: 'drained',
      });
    });

    it('reports ok with the backlog when the wall budget stops the sweep', async () => {
      // Same run as the >1 day backlog test above: still `ok` (a budget stop
      // is not a failed write); the Sentry warning carries the alert.
      routeQueries({
        batches: [batch(BATCH, 80), batch(BATCH, 72)],
        batchMs: 100_000,
        explain: async () => explainRows(24_000_000),
      });
      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledWith(JOB, {
        status: 'ok',
        today: '2026-05-18',
        totalDeleted: 100_000,
        batches: 2,
        durationMs: 200_000,
        rowsPerSec: 500,
        stopReason: 'wall_budget',
        backlog: {
          estimatedBacklogRows: 24_000_000,
          oldestRemaining: new Date(
            CUTOFF.getTime() - 72 * HOUR_MS,
          ).toISOString(),
          cutoff: CUTOFF.toISOString(),
          lagHours: 72,
        },
      });
    });

    it('reports error with the partial counts when a DELETE fails, never ok', async () => {
      let call = 0;
      mockQuery.mockImplementation(async () => {
        call += 1;
        if (call === 1) return batch(BATCH);
        throw new Error('connection lost');
      });

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledOnce();
      expect(reportCronRun).toHaveBeenCalledWith(JOB, {
        status: 'error',
        error: 'Error: connection lost',
        today: '2026-05-18',
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

  it('tags Sentry with the job name on the success path', async () => {
    routeQueries({ batches: [batch(0)] });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'cleanup-ws-option-trades',
    );
  });

  it('is wrapped in a Sentry cron check-in whose schedule never touches market hours', () => {
    expect(wrapped.name).toBe('cleanup-ws-option-trades');
    const entry = SCHEDULE_MAP['cleanup-ws-option-trades'];
    expect(entry).toBeDefined();
    // Expand the hour field and make sure none of 13–21 UTC (the weekday
    // market-hours window, when uw-stream is inserting) is scheduled.
    const hourField = entry!.schedule.split(/\s+/)[1]!;
    const hours = new Set<number>();
    for (const part of hourField.split(',')) {
      const [lo, hi] = part.split('-').map((h) => Number.parseInt(h, 10));
      for (let h = lo!; h <= (hi ?? lo!); h++) hours.add(h);
    }
    for (let h = 13; h <= 21; h++) expect(hours.has(h)).toBe(false);
    // Runs at least every hour of the post-midnight window so a ~9M-row
    // session (two runs) clears before the open.
    for (let h = 5; h <= 12; h++) expect(hours.has(h)).toBe(true);
  });
});
