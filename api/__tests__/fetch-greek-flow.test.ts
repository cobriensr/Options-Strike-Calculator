// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

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

import handler from '../cron/fetch-greek-flow.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

function makeGreekFlowTick(overrides = {}) {
  return {
    timestamp: '2026-03-24T14:32:00Z',
    ticker: 'SPX',
    expiry: '2026-03-24',
    total_delta_flow: '5000000',
    dir_delta_flow: '-3000000',
    total_vega_flow: '200000',
    dir_vega_flow: '-100000',
    otm_total_delta_flow: '3000000',
    otm_dir_delta_flow: '-1500000',
    otm_total_vega_flow: '150000',
    otm_dir_vega_flow: '-75000',
    transactions: 4500,
    volume: 120000,
    ...overrides,
  };
}

/** Stub fetch with the flat UW greek-flow response structure */
function stubFetch(ticks: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: ticks }),
    }),
  );
}

describe('fetch-greek-flow handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([{ id: 1 }]);
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is set and header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    stubFetch();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours (early morning)', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches ticks, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeGreekFlowTick()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 1,
      stored: 1,
      skipped: 0,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('persists OTM delta flow fields via the INSERT (ENH-FIX-001)', async () => {
    // Regression test for the pre-fix bug where otm_total_delta_flow and
    // otm_dir_delta_flow arrived in the UW response but were never written
    // to flow_data. See migration #48 and docs/superpowers/specs/
    // analyze-prompt-enhancements-2026-04-08.md (ENH-FIX-001).
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeGreekFlowTick({
        total_delta_flow: '5000000',
        dir_delta_flow: '-3000000',
        otm_total_delta_flow: '2500000',
        otm_dir_delta_flow: '-1800000',
      }),
    ]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);

    // Verify the INSERT targets the new OTM columns.
    const [strings, ...values] = mockSql.mock.calls[0]!;
    const sqlText = (strings as readonly string[]).join('?');
    expect(sqlText).toContain('otm_ncp');
    expect(sqlText).toContain('otm_npp');

    // Verify the interpolated values include the OTM data from the fixture.
    expect(values).toContain('2500000');
    expect(values).toContain('-1800000');
  });

  it('handles empty data (no ticks)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 0,
      stored: 0,
      skipped: 0,
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── 5-min sampling ────────────────────────────────────────

  it('samples ticks to 5-min intervals (two ticks in same window = one insert)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeGreekFlowTick({ timestamp: '2026-03-24T14:31:00Z' }),
      makeGreekFlowTick({ timestamp: '2026-03-24T14:33:00Z' }),
    ]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both ticks round to 14:30, so only 1 insert
    expect(res._json).toMatchObject({ ticks: 2, stored: 1, skipped: 0 });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('ticks in different 5-min windows produce separate inserts', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeGreekFlowTick({ timestamp: '2026-03-24T14:31:00Z' }),
      makeGreekFlowTick({ timestamp: '2026-03-24T14:36:00Z' }),
    ]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // 14:31 → 14:30 window, 14:36 → 14:35 window
    expect(res._json).toMatchObject({ ticks: 2, stored: 2, skipped: 0 });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Duplicate handling ────────────────────────────────────

  it('counts skipped duplicates correctly (ON CONFLICT DO NOTHING)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Empty result = ON CONFLICT DO NOTHING (duplicate)
    mockSql.mockResolvedValue([]);
    stubFetch([makeGreekFlowTick()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails (non-ok response)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when fetch throws (network error)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('handles insert errors gracefully (counts as skipped)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockRejectedValueOnce(new Error('DB insert failed'));
    stubFetch([makeGreekFlowTick()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  // ── Correct API endpoint ──────────────────────────────────

  it('calls the correct UW API endpoint (/stock/SPX/greek-flow/)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeGreekFlowTick()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toContain('/stock/SPX/greek-flow/');
  });
});
