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

function makeGreekRow(overrides = {}) {
  return {
    date: '2026-03-24',
    expiry: '2026-03-24',
    dte: 0,
    call_gamma: '500000000',
    put_gamma: '-300000000',
    call_charm: '100000',
    put_charm: '-50000',
    call_delta: '200000',
    put_delta: '-150000',
    call_vanna: '80000',
    put_vanna: '-60000',
    ...overrides,
  };
}

describe('fetch-greek-exposure handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([{ id: 1 }]);
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
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
    expect(res._status).not.toBe(401);
    vi.unstubAllGlobals();
  });

  it('passes auth when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
    vi.unstubAllGlobals();
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

  it('stores expiry rows and returns aggregateGamma', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeGreekRow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 1,
      skipped: 0,
      expiries: 1,
      aggregateGamma: expect.any(Number),
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('returns stored: 0 for empty API responses', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 0,
      expiries: 0,
    });
    expect(mockSql).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('counts skipped rows when ON CONFLICT triggers', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Empty result = no RETURNING id = duplicate/skipped
    mockSql.mockResolvedValue([]);
    const row = makeGreekRow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
      expiries: 1,
    });
    vi.unstubAllGlobals();
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API returns an error status', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      }),
    );

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: expect.stringContaining('429') });
    vi.unstubAllGlobals();
  });

  it('returns 500 when fetch throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Network error' });
    vi.unstubAllGlobals();
  });
});
