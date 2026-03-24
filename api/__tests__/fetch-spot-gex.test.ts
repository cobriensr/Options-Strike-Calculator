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

import handler from '../cron/fetch-spot-gex.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

function makeSpotRow(overrides: Partial<Record<string, string>> = {}) {
  return {
    time: '2026-03-24T14:00:00.000Z',
    start_time: '2026-03-24T14:00:00.000Z',
    price: '5750.25',
    gamma_per_one_percent_move_oi: '1000000',
    gamma_per_one_percent_move_vol: '500000',
    gamma_per_one_percent_move_dir: '300000',
    charm_per_one_percent_move_oi: '200000',
    charm_per_one_percent_move_vol: '100000',
    charm_per_one_percent_move_dir: '80000',
    vanna_per_one_percent_move_oi: '50000',
    vanna_per_one_percent_move_vol: '25000',
    vanna_per_one_percent_move_dir: '15000',
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

describe('fetch-spot-gex handler', () => {
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
    stubFetch();
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
    stubFetch();
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

  it('stores latest spot exposure and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeSpotRow()]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 1,
      stored: true,
      timestamp: expect.any(String),
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('samples multiple rows to 5-min intervals and stores latest', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Three ticks within the same 5-min window, plus one in a later window
    stubFetch([
      makeSpotRow({ start_time: '2026-03-24T14:00:00.000Z' }),
      makeSpotRow({ start_time: '2026-03-24T14:01:00.000Z' }),
      makeSpotRow({ start_time: '2026-03-24T14:04:00.000Z' }),
      makeSpotRow({ start_time: '2026-03-24T14:05:00.000Z', price: '5760.00' }),
    ]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 4,
      stored: true,
    });
    // Only stores the latest 5-min candle
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns stored false for empty API response', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 0,
      stored: false,
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('uses time field when start_time is absent', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeSpotRow();
    delete (row as Record<string, unknown>).start_time;
    stubFetch([row]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when API returns error status', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: expect.stringContaining('500') });
  });

  it('returns 500 when API returns 429', async () => {
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
  });

  it('returns 500 when DB insert throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeSpotRow()]);
    mockSql.mockRejectedValue(new Error('DB connection lost'));

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'DB connection lost' });
  });
});
