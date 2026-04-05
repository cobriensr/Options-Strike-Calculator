// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
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

import handler from '../cron/fetch-es-options-eod.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/**
 * Helper to build mock OI rows for futures_options_daily.
 * Each row has { strike, option_type, oi }.
 */
function makeOiRow(
  strike: number,
  optionType: 'C' | 'P',
  oi: number,
) {
  return {
    strike: String(strike),
    option_type: optionType,
    oi: String(oi),
  };
}

describe('fetch-es-options-eod handler', () => {
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

  it('returns early when cronGuard returns null', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── No data from sidecar ──────────────────────────────────

  it('reports missing data via Sentry when no options rows exist', async () => {
    // COUNT query returns 0 rows
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '0',
        with_oi: '0',
        with_iv: '0',
        with_delta: '0',
        unique_strikes: '0',
        option_types: '0',
      },
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-es-options-eod',
      skipped: true,
      reason: 'No EOD data from sidecar',
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ES options EOD data missing'),
      'warning',
    );
  });

  // ── Max pain computation ──────────────────────────────────

  it('computes max pain correctly from mock OI data', async () => {
    // 1. COUNT query → data exists
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '6',
        with_oi: '6',
        with_iv: '6',
        with_delta: '6',
        unique_strikes: '3',
        option_types: '2',
      },
    ]);

    // 2. OI by strike query
    // Strike 5700: Call OI=1000, Put OI=500
    // Strike 5750: Call OI=2000, Put OI=3000  (max pain should be here)
    // Strike 5800: Call OI=500, Put OI=2000
    mockSql.mockResolvedValueOnce([
      makeOiRow(5700, 'C', 1000),
      makeOiRow(5700, 'P', 500),
      makeOiRow(5750, 'C', 2000),
      makeOiRow(5750, 'P', 3000),
      makeOiRow(5800, 'C', 500),
      makeOiRow(5800, 'P', 2000),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as { maxPain: number };

    // Max pain computation:
    // At 5700: call pain from 5750 calls (2000*50) + 5800 calls (500*100) = 150000
    //          put pain from nothing (5700 lowest) = 0
    //          total = 150000
    // At 5750: call pain from 5800 calls (500*50) = 25000
    //          put pain from 5700 puts (500*50) = 25000
    //          total = 50000
    // At 5800: call pain = 0
    //          put pain from 5700 puts (500*100) + 5750 puts (3000*50) = 200000
    //          total = 200000
    // Min pain is at 5750 (50000)
    expect(json.maxPain).toBe(5750);
  });

  // ── OI concentration ratios ───────────────────────────────

  it('computes OI concentration ratios correctly', async () => {
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '8',
        with_oi: '8',
        with_iv: '8',
        with_delta: '8',
        unique_strikes: '4',
        option_types: '2',
      },
    ]);

    // Strike 5700: Call=100, Put=50
    // Strike 5750: Call=300, Put=200
    // Strike 5800: Call=100, Put=500  (max put OI at 5800)
    // Strike 5850: Call=500, Put=250  (max call OI at 5850)
    mockSql.mockResolvedValueOnce([
      makeOiRow(5700, 'C', 100),
      makeOiRow(5700, 'P', 50),
      makeOiRow(5750, 'C', 300),
      makeOiRow(5750, 'P', 200),
      makeOiRow(5800, 'C', 100),
      makeOiRow(5800, 'P', 500),
      makeOiRow(5850, 'C', 500),
      makeOiRow(5850, 'P', 250),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      oiConcentration: {
        call: { strike: number; oi: number; ratio: number };
        put: { strike: number; oi: number; ratio: number };
      };
      totalCallOi: number;
      totalPutOi: number;
    };

    // Total call OI: 100+300+100+500 = 1000
    // Total put OI: 50+200+500+250 = 1000
    expect(json.totalCallOi).toBe(1000);
    expect(json.totalPutOi).toBe(1000);

    // Max call OI: 500 at 5850 → ratio = 500/1000 = 0.5
    expect(json.oiConcentration.call.strike).toBe(5850);
    expect(json.oiConcentration.call.oi).toBe(500);
    expect(json.oiConcentration.call.ratio).toBe(0.5);

    // Max put OI: 500 at 5800 → ratio = 500/1000 = 0.5
    expect(json.oiConcentration.put.strike).toBe(5800);
    expect(json.oiConcentration.put.oi).toBe(500);
    expect(json.oiConcentration.put.ratio).toBe(0.5);
  });

  // ── Empty OI dataset (but rows exist) ─────────────────────

  it('handles rows with no OI data gracefully', async () => {
    // Data exists but no open_interest values
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '10',
        with_oi: '0',
        with_iv: '10',
        with_delta: '10',
        unique_strikes: '5',
        option_types: '2',
      },
    ]);

    // OI query returns empty (no rows with non-null OI)
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      maxPain: number | null;
      totalCallOi: number;
      totalPutOi: number;
    };
    expect(json.maxPain).toBeNull();
    expect(json.totalCallOi).toBe(0);
    expect(json.totalPutOi).toBe(0);
  });

  // ── Single strike ─────────────────────────────────────────

  it('handles single-strike dataset', async () => {
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '2',
        with_oi: '2',
        with_iv: '2',
        with_delta: '2',
        unique_strikes: '1',
        option_types: '2',
      },
    ]);

    mockSql.mockResolvedValueOnce([
      makeOiRow(5750, 'C', 1000),
      makeOiRow(5750, 'P', 800),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as { maxPain: number };
    // With only one strike, max pain is that strike
    expect(json.maxPain).toBe(5750);
  });

  // ── Response shape ────────────────────────────────────────

  it('returns correct response shape with all fields', async () => {
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '4',
        with_oi: '4',
        with_iv: '4',
        with_delta: '4',
        unique_strikes: '2',
        option_types: '2',
      },
    ]);

    mockSql.mockResolvedValueOnce([
      makeOiRow(5700, 'C', 100),
      makeOiRow(5700, 'P', 200),
      makeOiRow(5750, 'C', 300),
      makeOiRow(5750, 'P', 400),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.job).toBe('fetch-es-options-eod');
    expect(json.tradeDate).toBe('2026-04-03');
    expect(json.totalRows).toBe(4);
    expect(json.uniqueStrikes).toBe(2);
    expect(json.maxPain).toBeDefined();
    expect(json.oiConcentration).toBeDefined();
    expect(json.totalCallOi).toBeDefined();
    expect(json.totalPutOi).toBeDefined();
    expect(typeof json.durationMs).toBe('number');
  });

  // ── DB error ──────────────────────────────────────────────

  it('returns 500 and captures Sentry on DB error', async () => {
    const dbError = new Error('query timeout');
    mockSql.mockRejectedValueOnce(dbError);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'fetch-es-options-eod',
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  // ── OI query error after count succeeds ───────────────────

  it('returns 500 when OI query fails after count succeeds', async () => {
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '10',
        with_oi: '10',
        with_iv: '10',
        with_delta: '10',
        unique_strikes: '5',
        option_types: '2',
      },
    ]);
    mockSql.mockRejectedValueOnce(new Error('OI query failed'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  // ── Zero concentration when no OI ─────────────────────────

  it('returns zero concentration ratios when total OI is zero', async () => {
    mockSql.mockResolvedValueOnce([
      {
        total_rows: '2',
        with_oi: '2',
        with_iv: '0',
        with_delta: '0',
        unique_strikes: '1',
        option_types: '2',
      },
    ]);

    // OI rows with zero values
    mockSql.mockResolvedValueOnce([
      { strike: '5700', option_type: 'C', oi: '0' },
      { strike: '5700', option_type: 'P', oi: '0' },
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      oiConcentration: {
        call: { ratio: number };
        put: { ratio: number };
      };
    };
    expect(json.oiConcentration.call.ratio).toBe(0);
    expect(json.oiConcentration.put.ratio).toBe(0);
  });
});
