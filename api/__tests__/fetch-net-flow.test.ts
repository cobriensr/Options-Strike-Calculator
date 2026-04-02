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

import handler from '../cron/fetch-net-flow.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

/** Creates a single incremental net-prem tick */
function makeNetPremTick(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-03-24',
    tape_time: '2026-03-24T14:00:00.000Z',
    net_call_premium: '500000',
    net_put_premium: '-200000',
    net_call_volume: 100,
    net_put_volume: 50,
    net_delta: '1000',
    call_volume: 200,
    put_volume: 150,
    ...overrides,
  };
}

/** Stubs global fetch so all 3 ticker calls return the same data */
function stubFetchWith(data: unknown[], ok = true) {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        ok
          ? { ok: true, json: async () => ({ data }) }
          : { ok: false, status: 429, text: async () => 'Rate limited' },
      ),
  );
}

describe('fetch-net-flow handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: return a row that satisfies both INSERT RETURNING and
    // data-quality SELECT shapes (the handler destructures rows[0]!).
    mockSql.mockResolvedValue([{ id: 1, total: 0, nonzero: 0 }]);
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
    stubFetchWith([]);
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

  it('fetches all 3 tickers and stores results', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const tick = makeNetPremTick();
    stubFetchWith([tick]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true });

    // 3 fetch calls — one per ticker (SPX, SPY, QQQ)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);

    // 3 SQL inserts (one per ticker) + 3 data-quality SELECTs = 6
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('includes all 3 sources in results', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const tick = makeNetPremTick();
    stubFetchWith([tick]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const { results } = res._json as {
      results: Record<string, { stored: number }>;
    };
    expect(results.spx_flow).toMatchObject({ stored: 1 });
    expect(results.spy_flow).toMatchObject({ stored: 1 });
    expect(results.qqq_flow).toMatchObject({ stored: 1 });
  });

  it('returns stored: false for empty API responses', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetchWith([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { results } = res._json as {
      results: Record<string, { stored: number }>;
    };
    expect(results.spx_flow).toMatchObject({ stored: 0 });
    expect(results.spy_flow).toMatchObject({ stored: 0 });
    expect(results.qqq_flow).toMatchObject({ stored: 0 });
    // No inserts, only 3 data-quality SELECTs
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('returns stored: false when API response has no data field', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { results } = res._json as {
      results: Record<string, { stored: number }>;
    };
    expect(results.spx_flow).toMatchObject({ stored: 0 });
  });

  // ── Cumulation logic ──────────────────────────────────────

  it('cumulates incremental ticks before storing', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Two ticks in the same 5-min window — cumulation should sum them
    const ticks = [
      makeNetPremTick({
        tape_time: '2026-03-24T14:01:00.000Z',
        net_call_premium: '100000',
        net_put_premium: '-50000',
        net_call_volume: 10,
        net_put_volume: 5,
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:02:00.000Z',
        net_call_premium: '200000',
        net_put_premium: '-100000',
        net_call_volume: 20,
        net_put_volume: 10,
      }),
    ];
    stubFetchWith(ticks);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both ticks fall in the 14:00 window, so the stored candle should have
    // cumulated values: ncp = 100000+200000 = 300000, npp = -50000+-100000 = -150000
    // 3 inserts (one per ticker) + 3 data-quality SELECTs = 6
    expect(mockSql).toHaveBeenCalledTimes(6);

    // Check the first SQL call (an INSERT) has the cumulated ncp value
    const firstCall = mockSql.mock.calls[0]!;
    // Tagged template: strings array + interpolated values
    // Values are: date, timestamp, source, ncp, npp, netVolume
    const callValues = firstCall.slice(1);
    // ncp (4th interpolated value, index 3) should be 300000
    expect(callValues[3]).toBe(300000);
    // npp (5th interpolated value, index 4) should be -150000
    expect(callValues[4]).toBe(-150000);
  });

  // ── 5-minute sampling ─────────────────────────────────────

  it('samples ticks at 5-minute boundaries', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Ticks spanning two 5-min windows
    const ticks = [
      makeNetPremTick({
        tape_time: '2026-03-24T14:01:00.000Z',
        net_call_premium: '100000',
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:04:00.000Z',
        net_call_premium: '200000',
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:06:00.000Z',
        net_call_premium: '300000',
      }),
    ];
    stubFetchWith(ticks);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Two 5-min windows (14:00, 14:05): storeAllCandles stores 2 candles
    // per ticker → 3 tickers × 2 = 6 inserts + 3 data-quality SELECTs = 9
    expect(mockSql).toHaveBeenCalledTimes(9);
  });

  // ── Error handling ────────────────────────────────────────

  it('handles individual ticker API failures gracefully', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // First call succeeds, second/third fail
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({ data: [makeNetPremTick()] }),
          };
        }
        return { ok: false, status: 500, text: async () => 'Server error' };
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Should still return 200 — per-ticker errors are caught
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true });
  });

  it('handles fetch throwing for a ticker without crashing', async () => {
    process.env.UW_API_KEY = 'uwkey';

    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({ data: [makeNetPremTick()] }),
          };
        }
        throw new Error('Parse error');
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Should still return 200 with partial results
    expect(res._status).toBe(200);
  });

  // ── Fetch URL verification ────────────────────────────────

  it('calls the correct UW API endpoints per ticker', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetchWith([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const fetchMock = vi.mocked(globalThis.fetch);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);

    expect(urls).toContain(
      'https://api.unusualwhales.com/api/stock/SPX/net-prem-ticks',
    );
    expect(urls).toContain(
      'https://api.unusualwhales.com/api/stock/SPY/net-prem-ticks',
    );
    expect(urls).toContain(
      'https://api.unusualwhales.com/api/stock/QQQ/net-prem-ticks',
    );
  });

  it('passes the API key as Bearer token', async () => {
    process.env.UW_API_KEY = 'my-test-key';
    stubFetchWith([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const fetchMock = vi.mocked(globalThis.fetch);
    const opts = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer my-test-key',
    });
  });

  // ── Cumulation with zero/null values ─────────────────────

  it('treats zero string premium as 0 in cumulation', async () => {
    process.env.UW_API_KEY = 'uwkey';

    const ticks = [
      makeNetPremTick({
        tape_time: '2026-03-24T14:01:00.000Z',
        net_call_premium: '0',
        net_put_premium: '0',
        net_call_volume: 0,
        net_put_volume: 0,
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:02:00.000Z',
        net_call_premium: '100000',
        net_put_premium: '-50000',
        net_call_volume: 10,
        net_put_volume: 5,
      }),
    ];
    stubFetchWith(ticks);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both ticks land in the 14:00 window — cumulated ncp = 0 + 100000
    const firstCall = mockSql.mock.calls[0]!;
    const callValues = firstCall.slice(1);
    expect(callValues[3]).toBe(100000);
    expect(callValues[4]).toBe(-50000);
    // netVolume = (0 + 10) + (0 + 5) = 15
    expect(callValues[5]).toBe(15);
  });

  it('treats non-numeric premium strings as 0 via || 0 fallback', async () => {
    process.env.UW_API_KEY = 'uwkey';

    const ticks = [
      makeNetPremTick({
        tape_time: '2026-03-24T14:01:00.000Z',
        net_call_premium: 'N/A',
        net_put_premium: '',
        net_call_volume: null,
        net_put_volume: undefined,
      }),
    ];
    stubFetchWith(ticks);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Non-numeric parseFloat → NaN, || 0 → 0; null/undefined volumes → 0
    const firstCall = mockSql.mock.calls[0]!;
    const callValues = firstCall.slice(1);
    expect(callValues[3]).toBe(0); // ncp
    expect(callValues[4]).toBe(0); // npp
    expect(callValues[5]).toBe(0); // netVolume
  });

  // ── Skipped rows (ON CONFLICT DO NOTHING) ────────────────

  it('counts skipped rows when INSERT returns empty', async () => {
    process.env.UW_API_KEY = 'uwkey';

    const ticks = [
      makeNetPremTick({ tape_time: '2026-03-24T14:01:00.000Z' }),
    ];
    stubFetchWith(ticks);

    // First 3 calls are INSERTs (one per ticker) — return empty to
    // simulate ON CONFLICT DO NOTHING; remaining 3 are data-quality SELECTs
    mockSql
      .mockResolvedValueOnce([]) // SPX insert → skipped
      .mockResolvedValueOnce([]) // SPY insert → skipped
      .mockResolvedValueOnce([]) // QQQ insert → skipped
      .mockResolvedValue([{ id: 1, total: 0, nonzero: 0 }]); // quality checks

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { results } = res._json as {
      results: Record<string, { stored: number; skipped: number }>;
    };
    expect(results.spx_flow).toMatchObject({ stored: 0, skipped: 1 });
    expect(results.spy_flow).toMatchObject({ stored: 0, skipped: 1 });
    expect(results.qqq_flow).toMatchObject({ stored: 0, skipped: 1 });
  });

  // ── Sampling boundary conditions ─────────────────────────

  it('keeps only the last tick per 5-min window', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Three ticks in the same 5-min window: only the last should be stored
    const ticks = [
      makeNetPremTick({
        tape_time: '2026-03-24T14:00:30.000Z',
        net_call_premium: '100000',
        net_put_premium: '-50000',
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:01:30.000Z',
        net_call_premium: '200000',
        net_put_premium: '-100000',
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:03:00.000Z',
        net_call_premium: '300000',
        net_put_premium: '-150000',
      }),
    ];
    stubFetchWith(ticks);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // All 3 ticks → same 14:00 window → 1 candle per ticker
    // 3 inserts + 3 quality checks = 6
    expect(mockSql).toHaveBeenCalledTimes(6);

    // The stored candle should have the cumulated value of all 3 ticks
    const firstCall = mockSql.mock.calls[0]!;
    const callValues = firstCall.slice(1);
    // ncp = 100000 + 200000 + 300000 = 600000
    expect(callValues[3]).toBe(600000);
    // npp = -50000 + -100000 + -150000 = -300000
    expect(callValues[4]).toBe(-300000);
  });

  it('produces sorted output across multiple 5-min windows', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Ticks spanning 3 distinct 5-min windows
    const ticks = [
      makeNetPremTick({
        tape_time: '2026-03-24T14:11:00.000Z',
        net_call_premium: '100000',
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:01:00.000Z',
        net_call_premium: '200000',
      }),
      makeNetPremTick({
        tape_time: '2026-03-24T14:06:00.000Z',
        net_call_premium: '300000',
      }),
    ];
    stubFetchWith(ticks);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // 3 windows × 3 tickers = 9 inserts + 3 quality = 12
    expect(mockSql).toHaveBeenCalledTimes(12);
  });
});
