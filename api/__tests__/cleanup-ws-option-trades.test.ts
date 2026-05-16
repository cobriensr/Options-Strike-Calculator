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

import handler from '../cron/cleanup-ws-option-trades.js';
import { Sentry } from '../_lib/sentry.js';

// Monday 12:05 UTC = 7:05am ET (DST). cronGuard derives `today` via
// getETDateStr(new Date()) → 2026-05-18 on this clock.
const RUN_TIME = new Date('2026-05-18T12:05:00.000Z');

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('cleanup-ws-option-trades handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.query = mockQuery;
    mockQuery.mockResolvedValue([]);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
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

  it('no-ops cleanly when the table holds no pre-cutoff rows', async () => {
    // Single batch DELETE returns 0 rows → loop exits, totals=0.
    mockQuery.mockResolvedValueOnce([]);

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
  });

  it('drains across multiple batches', async () => {
    const fullBatch = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    mockQuery
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalDeleted: 100_000,
      batches: 3,
      stopReason: 'drained',
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('uses an index-friendly executed_at predicate with ET TZ on the constant side', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    const [sql, params] = mockQuery.mock.calls[0]!;

    // Predicate must reference ws_option_trades and the executed_at
    // column directly (bare, not wrapped in a function), so the
    // (executed_at) B-tree index can serve the range scan. The TZ
    // conversion is on the CONSTANT ($1::date - INTERVAL …), not on
    // the column.
    expect(sql).toContain('ws_option_trades');
    expect(sql).toContain('executed_at <');
    expect(sql).toContain("AT TIME ZONE 'America/New_York'");
    expect(sql).toContain("INTERVAL '2 days'");
    // Bare column reference — would be broken if any of these match:
    expect(sql).not.toMatch(/\(executed_at[^)]*AT TIME ZONE/i);
    expect(sql).not.toMatch(/date\(executed_at\)/i);

    expect(params).toEqual(['2026-05-18']);
  });

  it('tags Sentry on the success path, not only on failure', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'cleanup-ws-option-trades',
    );
  });

  it('exits via wall_budget when the loop runs past the budget', async () => {
    const fullBatch = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    mockQuery.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce(fullBatch);

    const startWall = 1_000_000;
    let call = 0;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      // Sequence: handler entry (startedAt), then per-batch post-DELETE
      // check. Push the second check past WALL_BUDGET_MS so the loop
      // flips stopReason and exits.
      const offsets = [0, 1_000, 300_000];
      const t = startWall + (offsets[call] ?? 400_000);
      call += 1;
      return t;
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalDeleted: 100_000,
      stopReason: 'wall_budget',
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);

    dateNowSpy.mockRestore();
  });

  it('captures errors to Sentry and returns 500 with partial counts', async () => {
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
      'cleanup-ws-option-trades',
    );
  });
});
