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

import handler from '../cron/fetch-flow.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z'); // 10:00 AM ET
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z'); // 6:00 AM ET
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

function makeTideRow(overrides = {}) {
  return {
    date: '2026-03-24',
    net_call_premium: '1000000',
    net_put_premium: '-500000',
    net_volume: 12345,
    timestamp: '2026-03-24T14:00:00.000Z',
    ...overrides,
  };
}

describe('fetch-flow handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: return a row that satisfies both data-quality SELECT
    // shapes (handler destructures rows[0]!) and any INSERT.
    mockSql.mockResolvedValue([{ total: 0, nonzero: 0 }]);
    process.env = { ...originalEnv };
    // Default: market hours, API key set, no cron secret
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    // Should not be 401
    expect(res._status).not.toBe(401);
    vi.unstubAllGlobals();
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

  it('stores the latest candle from each source and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeTideRow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: true,
      market_tide: { stored: true, timestamp: row.timestamp },
      market_tide_otm: { stored: true, timestamp: row.timestamp },
    });
    // Two INSERT calls (one per source) + 2 data-quality SELECTs
    expect(mockSql).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });

  it('returns stored: false for empty API responses', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: true,
      market_tide: { stored: false },
      market_tide_otm: { stored: false },
    });
    // No INSERTs, but 2 data-quality SELECTs still run
    expect(mockSql).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
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
    expect(res._json).toMatchObject({
      market_tide: { stored: false },
      market_tide_otm: { stored: false },
    });
    vi.unstubAllGlobals();
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 with structured sources when the UW API returns an error status (BE-CRON-007)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // BE-CRON-007: total failure returns 500 so Vercel cron dashboard
    // still flags the run, but the `sources` shape is included in the
    // body so monitoring can pinpoint which stage failed.
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'All sources failed',
      stored: false,
      partial: true,
      sources: {
        marketTide: { succeeded: false, stage: 'fetch' },
        marketTideOtm: { succeeded: false, stage: 'fetch' },
      },
    });
    vi.unstubAllGlobals();
  });

  it('returns 500 with structured sources when fetch throws (BE-CRON-007)', async () => {
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
    expect(res._json).toMatchObject({
      error: 'All sources failed',
      stored: false,
      partial: true,
      sources: {
        marketTide: { succeeded: false, stage: 'fetch' },
        marketTideOtm: { succeeded: false, stage: 'fetch' },
      },
    });
    const body = res._json as {
      sources: {
        marketTide: { reason: string };
        marketTideOtm: { reason: string };
      };
    };
    expect(body.sources.marketTide.reason).toContain('Network error');
    expect(body.sources.marketTideOtm.reason).toContain('Network error');
    vi.unstubAllGlobals();
  });

  it('returns 500 with structured sources when fetch times out (AbortError) (BE-CRON-007)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new DOMException('The operation was aborted.', 'AbortError'),
        ),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'All sources failed',
      stored: false,
      partial: true,
      sources: {
        marketTide: { succeeded: false, stage: 'fetch' },
        marketTideOtm: { succeeded: false, stage: 'fetch' },
      },
    });
    vi.unstubAllGlobals();
  });

  // ── BE-CRON-007: per-source status shape ─────────────────

  it('BE-CRON-007 (a): both sources succeed → sources.*.succeeded true, partial false', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeTideRow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: true,
      partial: false,
      sources: {
        marketTide: { succeeded: true, fetched: 1, storedRows: 1 },
        marketTideOtm: { succeeded: true, fetched: 1, storedRows: 1 },
      },
    });
    vi.unstubAllGlobals();
  });

  it('BE-CRON-007 (b): market_tide fetch rejects → marketTide.stage=fetch, marketTideOtm succeeds, partial true', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeTideRow();
    // Route by URL: the all-in call has no `otm_only=true`; the OTM call does.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('otm_only=true')) {
          return {
            ok: true,
            json: async () => ({ data: [row] }),
          };
        }
        throw new Error('boom all-in');
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      partial: true,
      sources: {
        marketTide: { succeeded: false, stage: 'fetch' },
        marketTideOtm: { succeeded: true, fetched: 1, storedRows: 1 },
      },
    });
    const body = res._json as {
      sources: { marketTide: { reason: string } };
    };
    expect(body.sources.marketTide.reason).toContain('boom all-in');
    vi.unstubAllGlobals();
  });

  it('BE-CRON-007 (c): market_tide_otm store rejects → marketTideOtm.stage=store, partial true', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeTideRow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    // Both fetches succeed. First INSERT (market_tide) succeeds, second
    // INSERT (market_tide_otm) rejects. Data-quality SELECTs still run
    // after, so keep them responding.
    //
    // mockReset() here wipes the `beforeEach` blanket default
    // (`mockResolvedValue([{ total: 0, nonzero: 0 }])`) so we can set up
    // a strict sequence of Once-handlers. If a future store call sneaks
    // in (e.g. a third source added) it will receive `undefined` and
    // surface as a test failure rather than silently landing.
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]); // market_tide INSERT ok
    mockSql.mockRejectedValueOnce(new Error('db write failed')); // market_tide_otm INSERT fails
    // Data-quality SELECTs (2 of them) — return the expected shape
    mockSql.mockResolvedValueOnce([{ total: 0, nonzero: 0 }]);
    mockSql.mockResolvedValueOnce([{ total: 0, nonzero: 0 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      partial: true,
      sources: {
        marketTide: { succeeded: true, fetched: 1, storedRows: 1 },
        marketTideOtm: { succeeded: false, stage: 'store' },
      },
    });
    const body = res._json as {
      sources: { marketTideOtm: { reason: string } };
    };
    expect(body.sources.marketTideOtm.reason).toContain('db write failed');
    vi.unstubAllGlobals();
  });

  it('BE-CRON-007 (d): both fetches reject → 500 with structured sources, Vercel cron dashboard still sees failure', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('total outage')),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Total failure returns 500 so Vercel cron dashboard still flags
    // the failed run. The new `sources` shape is included in the body
    // so monitoring can distinguish fetch vs store failures even on 500.
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'All sources failed',
      stored: false,
      partial: true,
      sources: {
        marketTide: { succeeded: false, stage: 'fetch' },
        marketTideOtm: { succeeded: false, stage: 'fetch' },
      },
    });
    const body = res._json as {
      sources: {
        marketTide: { reason: string };
        marketTideOtm: { reason: string };
      };
    };
    expect(body.sources.marketTide.reason).toContain('total outage');
    expect(body.sources.marketTideOtm.reason).toContain('total outage');
    vi.unstubAllGlobals();
  });
});
