// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks (before handler import) ──────────────────────────

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

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  isMarketHours: vi.fn(() => true),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/constants.js', () => ({
  TIMEOUTS: { UW_API: 15_000 },
}));

// ── Handler import (after mocks) ───────────────────────────

import handler from '../cron/fetch-oi-per-strike.js';
import { isMarketHours } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

// ── Helpers ────────────────────────────────────────────────

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');

function makeOiRow(
  overrides: Partial<Record<string, string | number>> = {},
) {
  return {
    strike: '5750',
    call_oi: '12345',
    put_oi: '6789',
    date: '2026-03-24',
    ...overrides,
  };
}

function stubFetch(data: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data }),
    }),
  );
}

function authRequest() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

// ── Tests ──────────────────────────────────────────────────

describe('fetch-oi-per-strike handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.mocked(isMarketHours).mockReturnValue(true);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    process.env.UW_API_KEY = 'test-uw-key';
    vi.setSystemTime(MARKET_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Method guard ────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ──────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when authorization header is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  // ── Market hours guard ──────────────────────────────────

  it('skips outside market hours', async () => {
    vi.mocked(isMarketHours).mockReturnValue(false);
    const res = mockResponse();
    await handler(authRequest(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside market hours',
    });
  });

  // ── Missing API key ─────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = mockResponse();
    await handler(authRequest(), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Data already exists ─────────────────────────────────

  it('skips when data already exists for today', async () => {
    // First sql call: COUNT query returns existing data
    mockSql.mockResolvedValueOnce([{ cnt: 50 }]);
    stubFetch();

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: expect.stringContaining('Data already exists'),
    });
    // fetch should NOT have been called
    expect(fetch).not.toHaveBeenCalled();
  });

  // ── Happy path ──────────────────────────────────────────

  it('fetches and stores OI data successfully', async () => {
    const rows = [
      makeOiRow({ strike: '5700', call_oi: '1000', put_oi: '2000' }),
      makeOiRow({ strike: '5750', call_oi: '3000', put_oi: '4000' }),
      makeOiRow({ strike: '5800', call_oi: '5000', put_oi: '6000' }),
    ];

    // First call: COUNT query returns 0 (no existing data)
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // Subsequent calls: INSERT RETURNING id (one per row)
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([{ id: 2 }]);
    mockSql.mockResolvedValueOnce([{ id: 3 }]);

    stubFetch(rows);

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-oi-per-strike',
      total: 3,
      stored: 3,
      skipped: 0,
      durationMs: expect.any(Number),
    });
    // 1 COUNT + 3 INSERTs = 4 sql calls
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── Empty API response ──────────────────────────────────

  it('handles empty API response (0 rows)', async () => {
    // COUNT returns 0
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    stubFetch([]);

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-oi-per-strike',
      total: 0,
      stored: 0,
      skipped: 0,
    });
    // Only the COUNT query, no INSERTs
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Error handling ──────────────────────────────────────

  it('returns 500 and captures to Sentry on fetch error', async () => {
    // COUNT returns 0
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'fetch-oi-per-strike',
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  // ── String vs numeric values ────────────────────────────

  it('handles rows with string vs numeric values for call_oi/put_oi/strike', async () => {
    const rows = [
      // String values (typical API response)
      makeOiRow({ strike: '5700', call_oi: '1000', put_oi: '2000' }),
      // Numeric values
      makeOiRow({ strike: 5750, call_oi: 3000, put_oi: 4000 }),
      // Mixed: string strike, numeric OI
      makeOiRow({ strike: '5800', call_oi: 5000, put_oi: 6000 }),
    ];

    // COUNT returns 0
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // INSERTs all succeed
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([{ id: 2 }]);
    mockSql.mockResolvedValueOnce([{ id: 3 }]);

    stubFetch(rows);

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-oi-per-strike',
      total: 3,
      stored: 3,
      skipped: 0,
    });
    // 1 COUNT + 3 INSERTs
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  // ── DB conflict (ON CONFLICT DO NOTHING) ────────────────

  it('counts skipped rows when INSERT returns empty (conflict)', async () => {
    const rows = [
      makeOiRow({ strike: '5700' }),
      makeOiRow({ strike: '5750' }),
    ];

    // COUNT returns 0
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // First INSERT succeeds (returns id)
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    // Second INSERT hits conflict (returns empty array)
    mockSql.mockResolvedValueOnce([]);

    stubFetch(rows);

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 1,
      skipped: 1,
      total: 2,
    });
  });

  // ── DB error ────────────────────────────────────────────

  it('returns 500 when DB insert throws', async () => {
    // COUNT returns 0
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // INSERT throws
    mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

    stubFetch([makeOiRow()]);

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  // ── Network error ───────────────────────────────────────

  it('returns 500 when fetch throws a network error', async () => {
    // COUNT returns 0
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const res = mockResponse();
    await handler(authRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
