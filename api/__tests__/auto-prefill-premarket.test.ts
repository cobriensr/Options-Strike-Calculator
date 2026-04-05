// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-04-03'),
}));

import handler from '../cron/auto-prefill-premarket.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('auto-prefill-premarket handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';

    vi.mocked(cronGuard).mockReturnValue({
      apiKey: '',
      today: '2026-04-03',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Guard ─────────────────────────────────────────────────

  it('returns early when cronGuard returns null (missing CRON_SECRET)', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    // Handler returns early, no DB calls
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── No overnight bars ─────────────────────────────────────

  it('skips when no overnight ES bars found', async () => {
    // Query returns no globex_high (null row)
    mockSql.mockResolvedValueOnce([
      {
        globex_high: null,
        globex_low: null,
        globex_close: null,
        vwap: null,
        bar_count: '0',
      },
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'No overnight bars',
    });
    // Only 1 SQL call (the SELECT from futures_bars)
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Happy path: existing snapshot ─────────────────────────

  it('computes correct Globex OHLCV and updates existing snapshot', async () => {
    // 1. SELECT from futures_bars → aggregated bar data
    mockSql.mockResolvedValueOnce([
      {
        globex_high: '5720.50',
        globex_low: '5685.25',
        globex_close: '5710.00',
        vwap: '5702.375',
        bar_count: '42',
      },
    ]);
    // 2. SELECT id FROM market_snapshots → existing row
    mockSql.mockResolvedValueOnce([{ id: 99 }]);
    // 3. UPDATE market_snapshots
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'auto-prefill-premarket',
      stored: true,
      tradeDate: '2026-04-03',
      globexHigh: 5720.5,
      globexLow: 5685.25,
      globexClose: 5710,
      globexVwap: 5702.375,
      barCount: 42,
    });
    // 3 SQL calls: SELECT bars, SELECT snapshot, UPDATE snapshot
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Happy path: no existing snapshot ──────────────────────

  it('inserts new snapshot when none exists for today', async () => {
    // 1. SELECT from futures_bars
    mockSql.mockResolvedValueOnce([
      {
        globex_high: '5700',
        globex_low: '5680',
        globex_close: '5695',
        vwap: '5690.50',
        bar_count: '30',
      },
    ]);
    // 2. SELECT id FROM market_snapshots → empty
    mockSql.mockResolvedValueOnce([]);
    // 3. INSERT INTO market_snapshots
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'auto-prefill-premarket',
      stored: true,
      globexHigh: 5700,
      globexLow: 5680,
      globexClose: 5695,
      globexVwap: 5690.5,
      barCount: 30,
    });
    // 3 SQL calls: SELECT bars, SELECT snapshot, INSERT snapshot
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── VWAP null handling ────────────────────────────────────

  it('handles null VWAP (zero volume)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        globex_high: '5700',
        globex_low: '5680',
        globex_close: '5695',
        vwap: null,
        bar_count: '5',
      },
    ]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: true,
      globexVwap: null,
    });
  });

  // ── Correct number parsing ────────────────────────────────

  it('parses string DB values to correct numeric types', async () => {
    mockSql.mockResolvedValueOnce([
      {
        globex_high: '5710.75',
        globex_low: '5690.25',
        globex_close: '5705.50',
        vwap: '5698.123456',
        bar_count: '100',
      },
    ]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const json = res._json as Record<string, unknown>;
    expect(typeof json.globexHigh).toBe('number');
    expect(typeof json.globexLow).toBe('number');
    expect(typeof json.globexClose).toBe('number');
    expect(typeof json.globexVwap).toBe('number');
    expect(typeof json.barCount).toBe('number');
    expect(json.globexHigh).toBe(5710.75);
    expect(json.globexVwap).toBeCloseTo(5698.123456);
  });

  // ── Response includes durationMs ──────────────────────────

  it('includes durationMs in success response', async () => {
    mockSql.mockResolvedValueOnce([
      {
        globex_high: '5700',
        globex_low: '5680',
        globex_close: '5690',
        vwap: '5685',
        bar_count: '10',
      },
    ]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const json = res._json as Record<string, unknown>;
    expect(json.durationMs).toBeDefined();
    expect(typeof json.durationMs).toBe('number');
  });

  // ── DB error: bars query fails ────────────────────────────

  it('returns 500 and captures Sentry on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'auto-prefill-premarket',
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  // ── DB error: update fails ────────────────────────────────

  it('returns 500 when snapshot update query fails', async () => {
    mockSql.mockResolvedValueOnce([
      {
        globex_high: '5700',
        globex_low: '5680',
        globex_close: '5690',
        vwap: '5685',
        bar_count: '10',
      },
    ]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockRejectedValueOnce(new Error('write timeout'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  // ── Empty result array ────────────────────────────────────

  it('skips when bars query returns empty array', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    // bars[0]?.globex_high is undefined → treated as no data
    expect(res._status).toBe(200);
  });
});
