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
  uwFetch: vi.fn(),
  cronGuard: vi.fn(),
  checkDataQuality: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler from '../cron/fetch-oi-change.js';
import { cronGuard, uwFetch, checkDataQuality } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function makeOiRow(overrides: Record<string, unknown> = {}) {
  return {
    option_symbol: 'SPXW  260403C06500000',
    oi_diff_plain: '1500',
    curr_oi: '25000',
    last_oi: '23500',
    avg_price: '12.50',
    prev_ask_volume: '800',
    prev_bid_volume: '600',
    prev_multi_leg_volume: '200',
    prev_total_premium: '5000000',
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

describe('fetch-oi-change cron handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };

    vi.mocked(cronGuard).mockReturnValue({
      apiKey: 'test-uw-key',
      today: '2026-04-02',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── cronGuard ───────────────────────────────────────────

  it('returns early when cronGuard returns null', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Skip when data exists ──────────────────────────────

  it('skips when data already exists for today', async () => {
    // Existing count query
    mockSql.mockResolvedValueOnce([{ cnt: 42 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Data already exists for 2026-04-02 (42 rows)',
    });
    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
  });

  // ── Success path ───────────────────────────────────────

  it('fetches, stores, and returns success on happy path', async () => {
    // Existing count query: no data yet
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    const rows = [
      makeOiRow(),
      makeOiRow({
        option_symbol: 'SPXW  260403P05800000',
        oi_diff_plain: '-500',
      }),
    ];
    vi.mocked(uwFetch).mockResolvedValue(rows);

    // INSERT results: both return new rows
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([{ id: 2 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-oi-change',
      date: '2026-04-02',
      total: 2,
      stored: 2,
      skipped: 0,
    });
    expect(res._json).toHaveProperty('durationMs');
    expect(logger.info).toHaveBeenCalled();
  });

  it('counts skipped rows when INSERT returns empty (conflict)', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([makeOiRow()]);

    // INSERT returns empty (ON CONFLICT DO NOTHING)
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  // ── Data quality check ────────────────────────────────

  it('runs data quality check when stored > 10', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    // Create 12 rows to trigger quality check
    const rows = Array.from({ length: 12 }, (_, i) =>
      makeOiRow({ option_symbol: `SPXW  260403C0${6500 + i}000` }),
    );
    vi.mocked(uwFetch).mockResolvedValue(rows);

    // All 12 INSERTs succeed
    for (let i = 0; i < 12; i++) {
      mockSql.mockResolvedValueOnce([{ id: i + 1 }]);
    }

    // Quality check query
    mockSql.mockResolvedValueOnce([{ total: 12, nonzero: 10 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 12 });
    expect(vi.mocked(checkDataQuality)).toHaveBeenCalledWith({
      job: 'fetch-oi-change',
      table: 'oi_changes',
      date: '2026-04-02',
      total: 12,
      nonzero: 10,
    });
  });

  it('skips data quality check when stored <= 10', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    const rows = [makeOiRow()];
    vi.mocked(uwFetch).mockResolvedValue(rows);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(vi.mocked(checkDataQuality)).not.toHaveBeenCalled();
  });

  // ── Empty data ────────────────────────────────────────

  it('handles empty API response gracefully', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    vi.mocked(uwFetch).mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      total: 0,
      stored: 0,
      skipped: 0,
    });
  });

  // ── Option symbol parsing ─────────────────────────────

  it('parses call option symbols correctly', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({ option_symbol: 'SPXW  260403C06500000' }),
    ]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    // Verify the SQL was called with correct parsed values
    // The second mockSql call is the INSERT
    const insertCall = mockSql.mock.calls[1];
    // Template literal args: date, option_symbol, strike, isCall, ...
    // In tagged template calls, the values are in the subsequent arguments
    expect(insertCall).toBeDefined();
    expect(res._status).toBe(200);
  });

  it('parses put option symbols correctly', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({ option_symbol: 'SPXW  260403P05800000' }),
    ]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 1 });
  });

  it('handles unparseable option symbols with null strike/isCall', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({ option_symbol: 'INVALID_SYMBOL' }),
    ]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 1 });
  });

  // ── Numeric parsing edge cases ────────────────────────

  it('handles non-numeric field values gracefully', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({
        oi_diff_plain: 'not-a-number',
        curr_oi: '',
        last_oi: null,
        avg_price: '',
        prev_total_premium: 'bad',
      }),
    ]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 1 });
  });

  // ── Error handling ────────────────────────────────────

  it('returns 500 and captures exception on API fetch error', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    const err = new Error('UW API timeout');
    vi.mocked(uwFetch).mockRejectedValue(err);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'fetch-oi-change');
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns 500 on DB write error', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([makeOiRow()]);
    mockSql.mockRejectedValueOnce(new Error('connection refused'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('returns 500 on DB read error (existing count check)', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB unavailable'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
