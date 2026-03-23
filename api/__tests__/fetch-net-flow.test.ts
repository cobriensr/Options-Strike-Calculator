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
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
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

  it('passes auth when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    process.env.UW_API_KEY = 'uwkey';
    stubFetchWith([]);
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours (early morning)', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside market hours',
    });
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const req = mockRequest({ method: 'GET', headers: {} });
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

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true });

    // 3 fetch calls — one per ticker (SPX, SPY, QQQ)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);

    // 3 SQL inserts — one latest candle per ticker
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('includes all 3 sources in results', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const tick = makeNetPremTick();
    stubFetchWith([tick]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    const { results } = res._json as {
      results: Record<string, { stored: boolean }>;
    };
    expect(results.spx_flow).toMatchObject({ stored: true });
    expect(results.spy_flow).toMatchObject({ stored: true });
    expect(results.qqq_flow).toMatchObject({ stored: true });
  });

  it('returns stored: false for empty API responses', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetchWith([]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { results } = res._json as {
      results: Record<string, { stored: boolean }>;
    };
    expect(results.spx_flow).toMatchObject({ stored: false });
    expect(results.spy_flow).toMatchObject({ stored: false });
    expect(results.qqq_flow).toMatchObject({ stored: false });
    expect(mockSql).not.toHaveBeenCalled();
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

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { results } = res._json as {
      results: Record<string, { stored: boolean }>;
    };
    expect(results.spx_flow).toMatchObject({ stored: false });
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

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both ticks fall in the 14:00 window, so the stored candle should have
    // cumulated values: ncp = 100000+200000 = 300000, npp = -50000+-100000 = -150000
    // The tagged template call args include the cumulated values
    expect(mockSql).toHaveBeenCalledTimes(3);

    // Check one of the SQL calls has the cumulated ncp value
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

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    // Two 5-min windows (14:00, 14:05) but storeLatestCandle only stores
    // the LAST candle, so only 1 insert per ticker
    expect(mockSql).toHaveBeenCalledTimes(3);
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

    const req = mockRequest({ method: 'GET', headers: {} });
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
        throw new Error('Network timeout');
      }),
    );

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    // Should still return 200 with partial results
    expect(res._status).toBe(200);
  });

  // ── Fetch URL verification ────────────────────────────────

  it('calls the correct UW API endpoints per ticker', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetchWith([]);

    const req = mockRequest({ method: 'GET', headers: {} });
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

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    const fetchMock = vi.mocked(globalThis.fetch);
    const opts = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer my-test-key',
    });
  });
});
