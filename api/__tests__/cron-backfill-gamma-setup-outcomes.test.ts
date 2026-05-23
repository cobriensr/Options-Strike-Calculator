// @vitest-environment node

/**
 * Tests for the daily backfill cron at
 * /api/cron/backfill-gamma-setup-outcomes.
 *
 * Verifies the auth guard, the empty-pending fast-path, the per-fire
 * SQL fan-out (3 horizon lookups + EOD lookup + conditional UPDATE),
 * the direction-adjusted return convention per signal_type, the
 * "skip when no horizon resolved" branch, and the metadata shape
 * propagated by withCronInstrumentation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

import handler from '../cron/backfill-gamma-setup-outcomes.js';

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/**
 * Pull the bound values out of a tagged-template SQL call. Neon's
 * template-string SQL builder is invoked as `sql\`...\`(...binds)`, so
 * `mockSql.mock.calls[N]` is `[stringsArray, ...binds]`.
 */
function sqlBinds(callIndex: number): unknown[] {
  const call = mockSql.mock.calls[callIndex];
  if (!call) throw new Error(`No SQL call at index ${callIndex}`);
  return call.slice(1);
}

describe('cron backfill-gamma-setup-outcomes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong-secret' },
      }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('empty pending set returns success with rows=0', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT pending

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(0);
    // metadata is spread onto the body by withCronInstrumentation
    expect(body.pending).toBe(0);
    expect(body.lookback_days).toBe(2);
    // Only the single pending-fires SELECT should have been issued.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('e1_long_call fire — all horizons resolve, UPDATE bound correctly', async () => {
    // entry close = 7400, +15m=7402 (+2), +30m=7405 (+5), +60m=7401 (+1),
    // EOD=7398 (-2). e1_long_call sign convention: end - entry.
    mockSql
      .mockResolvedValueOnce([
        {
          id: 1,
          fired_at: '2026-05-21T18:30:00Z',
          signal_type: 'e1_long_call',
          bar_close: '7400',
        },
      ])
      .mockResolvedValueOnce([{ close: '7402' }]) // +15m
      .mockResolvedValueOnce([{ close: '7405' }]) // +30m
      .mockResolvedValueOnce([{ close: '7401' }]) // +60m
      .mockResolvedValueOnce([{ close: '7398' }]) // EOD
      .mockResolvedValueOnce([]); // UPDATE

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(1);
    expect(body.pending).toBe(1);
    expect(body.lookback_days).toBe(2);

    // 1 select + 4 lookups + 1 update = 6 SQL calls.
    expect(mockSql).toHaveBeenCalledTimes(6);

    // UPDATE call is index 5 (0-based). Bound order in the source:
    // ret_15m, ret_30m, ret_60m, ret_eod, id.
    const updateBinds = sqlBinds(5);
    expect(updateBinds).toEqual([2, 5, 1, -2, 1]);
  });

  it('e5_long_put fire — sign flipped (entry - end)', async () => {
    // entry=7400, lookups 7395/7390/7385/7380 → signed returns
    // 5 / 10 / 15 / 20 (positive when price dropped).
    mockSql
      .mockResolvedValueOnce([
        {
          id: 42,
          fired_at: '2026-05-21T18:30:00Z',
          signal_type: 'e5_long_put',
          bar_close: 7400, // numeric to exercise the Number() coercion branch
        },
      ])
      .mockResolvedValueOnce([{ close: '7395' }])
      .mockResolvedValueOnce([{ close: '7390' }])
      .mockResolvedValueOnce([{ close: '7385' }])
      .mockResolvedValueOnce([{ close: '7380' }])
      .mockResolvedValueOnce([]); // UPDATE

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { rows: number }).rows).toBe(1);

    const updateBinds = sqlBinds(5);
    expect(updateBinds).toEqual([5, 10, 15, 20, 42]);
  });

  it('pcs_monday fire — same sign as e1_long_call (end - entry)', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          id: 7,
          fired_at: '2026-05-18T18:30:00Z',
          signal_type: 'pcs_monday',
          bar_close: '7400',
        },
      ])
      .mockResolvedValueOnce([{ close: '7410' }]) // +15m → +10
      .mockResolvedValueOnce([{ close: '7415' }]) // +30m → +15
      .mockResolvedValueOnce([{ close: '7412' }]) // +60m → +12
      .mockResolvedValueOnce([{ close: '7420' }]) // EOD → +20
      .mockResolvedValueOnce([]); // UPDATE

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { rows: number }).rows).toBe(1);

    const updateBinds = sqlBinds(5);
    expect(updateBinds).toEqual([10, 15, 12, 20, 7]);
  });

  it('partial resolution — empty +15m and +60m lookups still UPDATE with nulls', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          id: 11,
          fired_at: '2026-05-21T18:30:00Z',
          signal_type: 'e1_long_call',
          bar_close: '7400',
        },
      ])
      .mockResolvedValueOnce([]) // +15m → no bar in window
      .mockResolvedValueOnce([{ close: '7402' }]) // +30m → +2
      .mockResolvedValueOnce([]) // +60m → no bar in window
      .mockResolvedValueOnce([{ close: '7390' }]) // EOD → -10
      .mockResolvedValueOnce([]); // UPDATE

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.rows).toBe(1);
    expect(body.pending).toBe(1);

    expect(mockSql).toHaveBeenCalledTimes(6);
    const updateBinds = sqlBinds(5);
    expect(updateBinds).toEqual([null, 2, null, -10, 11]);
  });

  it('all-empty lookups → row is SKIPPED, no UPDATE issued', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          id: 99,
          fired_at: '2026-05-21T18:30:00Z',
          signal_type: 'e1_long_call',
          bar_close: '7400',
        },
      ])
      .mockResolvedValueOnce([]) // +15m
      .mockResolvedValueOnce([]) // +30m
      .mockResolvedValueOnce([]) // +60m
      .mockResolvedValueOnce([]); // EOD

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(0);
    expect(body.pending).toBe(1);

    // 1 select + 4 lookups. No UPDATE because nothing resolved.
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('multiple fires — mix of fully resolved, partial, and all-null', async () => {
    mockSql
      // SELECT pending → 3 fires
      .mockResolvedValueOnce([
        {
          id: 101,
          fired_at: '2026-05-21T18:00:00Z',
          signal_type: 'e1_long_call',
          bar_close: '7400',
        },
        {
          id: 102,
          fired_at: '2026-05-21T18:15:00Z',
          signal_type: 'e5_long_put',
          bar_close: '7400',
        },
        {
          id: 103,
          fired_at: '2026-05-21T18:30:00Z',
          signal_type: 'pcs_monday',
          bar_close: '7400',
        },
      ])
      // Fire 101 — fully resolved, then UPDATE
      .mockResolvedValueOnce([{ close: '7402' }])
      .mockResolvedValueOnce([{ close: '7405' }])
      .mockResolvedValueOnce([{ close: '7401' }])
      .mockResolvedValueOnce([{ close: '7398' }])
      .mockResolvedValueOnce([])
      // Fire 102 — partial (only +30m resolved), then UPDATE
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ close: '7390' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // Fire 103 — nothing resolved, NO UPDATE
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    // Two rows updated (101, 102); 103 skipped.
    expect(body.rows).toBe(2);
    expect(body.pending).toBe(3);

    // 1 select
    // + 5 calls for fire 101 (4 lookups + update)
    // + 5 calls for fire 102 (4 lookups + update)
    // + 4 calls for fire 103 (4 lookups, no update)
    // = 15 total.
    expect(mockSql).toHaveBeenCalledTimes(15);

    // Spot-check the two UPDATE binds.
    // Fire 101 UPDATE is call index 5 (after select@0 + 4 lookups@1..4).
    expect(sqlBinds(5)).toEqual([2, 5, 1, -2, 101]);
    // Fire 102 UPDATE is call index 10 (after select@0 + 5 calls for 101
    // @1..5 + 4 lookups for 102 @6..9).
    // e5_long_put: only +30m resolved → entry - end = 7400 - 7390 = 10.
    expect(sqlBinds(10)).toEqual([null, 10, null, null, 102]);
  });

  it('metadata includes lookback_days=2', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Record<string, unknown>;
    expect(body.lookback_days).toBe(2);
    expect(body.pending).toBe(0);
  });

  it('accepts Date instance for fired_at as well as ISO string', async () => {
    // The handler has a `row.fired_at instanceof Date` branch — exercise it
    // explicitly so the coverage tool marks it hit.
    mockSql
      .mockResolvedValueOnce([
        {
          id: 200,
          fired_at: new Date('2026-05-21T18:30:00Z'),
          signal_type: 'e1_long_call',
          bar_close: '7400',
        },
      ])
      .mockResolvedValueOnce([{ close: '7401' }])
      .mockResolvedValueOnce([{ close: '7402' }])
      .mockResolvedValueOnce([{ close: '7403' }])
      .mockResolvedValueOnce([{ close: '7404' }])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { rows: number }).rows).toBe(1);
    expect(sqlBinds(5)).toEqual([1, 2, 3, 4, 200]);
  });
});
