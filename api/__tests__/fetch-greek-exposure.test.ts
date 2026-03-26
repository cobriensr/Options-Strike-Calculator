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

import handler from '../cron/fetch-greek-exposure.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

function makeAggregateRow(overrides = {}) {
  return {
    date: '2026-03-24',
    call_gamma: '5000000',
    put_gamma: '-3000000',
    call_charm: '100000',
    put_charm: '-80000',
    call_delta: '200000',
    put_delta: '-150000',
    call_vanna: '50000',
    put_vanna: '-30000',
    ...overrides,
  };
}

function makeExpiryRow(overrides = {}) {
  return {
    date: '2026-03-24',
    expiry: '2026-03-24',
    dte: 0,
    call_gamma: null,
    put_gamma: null,
    call_charm: '50000',
    put_charm: '-40000',
    call_delta: '100000',
    put_delta: '-75000',
    call_vanna: '25000',
    put_vanna: '-15000',
    ...overrides,
  };
}

/** Stub fetch to return different data for aggregate vs expiry URLs */
function stubFetch(aggData: unknown[] = [], expiryData: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/greek-exposure/expiry')) {
        return { ok: true, json: async () => ({ data: expiryData }) };
      }
      return { ok: true, json: async () => ({ data: aggData }) };
    }),
  );
}

describe('fetch-greek-exposure handler', () => {
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
      reason: 'Outside market hours',
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

  it('stores aggregate and expiry rows and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeAggregateRow()], [makeExpiryRow()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      aggregateStored: true,
      expiries: 1,
      stored: 1,
      skipped: 0,
    });
    // 1 aggregate insert + 1 expiry insert = 2
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('handles empty aggregate with expiry rows', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([], [makeExpiryRow()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      aggregateStored: false,
      expiries: 1,
      stored: 1,
    });
    // Only 1 expiry insert, no aggregate
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns zeros for empty API responses', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([], []);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      aggregateStored: false,
      expiries: 0,
      stored: 0,
      skipped: 0,
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Empty result = ON CONFLICT DO NOTHING (duplicate)
    mockSql.mockResolvedValue([]);
    stubFetch([], [makeExpiryRow()]);

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

  it('returns 500 when aggregate API fails', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/greek-exposure/expiry')) {
          return { ok: true, json: async () => ({ data: [] }) };
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

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when expiry API fails', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/greek-exposure/expiry')) {
          return { ok: false, status: 429, text: async () => 'Rate limited' };
        }
        return { ok: true, json: async () => ({ data: [makeAggregateRow()] }) };
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

  it('returns 500 when fetch throws', async () => {
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
});
