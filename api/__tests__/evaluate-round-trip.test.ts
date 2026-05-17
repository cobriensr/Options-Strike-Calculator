// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

import handler from '../cron/evaluate-round-trip.js';
import { Sentry } from '../_lib/sentry.js';

const RUN_TIME = new Date('2026-05-19T18:00:00.000Z');

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
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
      },
    ]);
    // Batched aggregation returns one row keyed by id+source —
    // net_pct = (10 - 90) / 100 = -0.80 → deduct -3.
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        source: 'lottery',
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
      },
    ]);
    // net_pct = (30 - 70) / 100 = -0.40 → deduct -2
    mockSql.mockResolvedValueOnce([
      { id: 7, source: 'lottery', ask_size: 30, bid_size: 70, total_size: 100 },
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
      },
    ]);
    // net_pct = (40 - 60) / 100 = -0.20 → deduct -1
    mockSql.mockResolvedValueOnce([
      {
        id: 11,
        source: 'silent_boom',
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
      },
    ]);
    // net_pct = (50 - 50) / 100 = 0.0 → deduct 0
    mockSql.mockResolvedValueOnce([
      {
        id: 99,
        source: 'lottery',
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

  it('handles no-flow case by writing 0 and counting noFlow', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'lottery',
        id: 1,
        option_chain_id: 'ILLIQUID',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
      },
    ]);
    // No post-fire trades at all.
    mockSql.mockResolvedValueOnce([
      { id: 1, source: 'lottery', ask_size: 0, bid_size: 0, total_size: 0 },
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

  it('processes both lottery and silent_boom alerts in one batch', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'lottery',
        id: 1,
        option_chain_id: 'A',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
      },
      {
        source: 'silent_boom',
        id: 2,
        option_chain_id: 'B',
        fire_time: new Date('2026-05-19T16:51:00.000Z'),
      },
    ]);
    // One batched aggregation returns BOTH rows — id+source preserved
    // from the unnest input.
    mockSql.mockResolvedValueOnce([
      { id: 1, source: 'lottery', ask_size: 5, bid_size: 95, total_size: 100 },
      {
        id: 2,
        source: 'silent_boom',
        ask_size: 80,
        bid_size: 20,
        total_size: 100,
      },
    ]);
    // Two batched UPDATEs — one per source table.
    mockSql.mockResolvedValueOnce([]); // lottery UPDATE
    mockSql.mockResolvedValueOnce([]); // silent_boom UPDATE

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._json).toMatchObject({
      eligible: 2,
      evaluated: 2,
      deducted: 1,
      noFlow: 0,
    });
    // 4 calls flat: SELECT + agg + lottery UPDATE + silent_boom UPDATE.
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('writes silent_boom no-flow row via the silent_boom UPDATE branch', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'silent_boom',
        id: 42,
        option_chain_id: 'AAPL260620C00200000',
        fire_time: new Date('2026-05-19T16:50:00.000Z'),
      },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        source: 'silent_boom',
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

  it('eligibility SELECT enforces dte <= 7 and uses safe INTERVAL pattern', async () => {
    // The DTE constraint and INTERVAL syntax are spec-load-bearing (signal collapses
    // above DTE 7 per the per-DTE AUC slice; `INTERVAL '${N} minutes'` would parse
    // the placeholder as raw text and silently break). Both are in the SQL string
    // only — fully-mocked tests don't execute the query, so we assert on the
    // template fragments directly.
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    const selectCall = mockSql.mock.calls[0];
    const selectSql = (selectCall?.[0] as readonly string[]).join('');
    expect(selectSql).toContain('dte <=');
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
});
