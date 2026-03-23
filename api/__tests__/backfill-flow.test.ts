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

import handler from '../cron/backfill-flow.js';

function makeTideRow(date: string, timestamp: string) {
  return {
    date,
    net_call_premium: '1000000',
    net_put_premium: '-500000',
    net_volume: 12345,
    timestamp,
  };
}

// Run handler while advancing fake timers so setTimeout delays don't block tests
async function runHandler(
  req: ReturnType<typeof mockRequest>,
  res: ReturnType<typeof mockResponse>,
) {
  const p = handler(req, res);
  await vi.runAllTimersAsync();
  return p;
}

describe('backfill-flow handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    // Fake both Date and setTimeout so per-day delays don't slow tests
    vi.useFakeTimers({ now: new Date('2026-03-25T12:00:00.000Z') });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-POST requests', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await runHandler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'POST only' });
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'POST', headers: {} });
    const res = mockResponse();
    await runHandler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET header value is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'POST',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await runHandler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const req = mockRequest({ method: 'POST', headers: {} });
    const res = mockResponse();
    await runHandler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches and stores candles for each trading day and returns summary', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const rows = [
      makeTideRow('2026-03-24', '2026-03-24T14:00:00.000Z'),
      makeTideRow('2026-03-24', '2026-03-24T14:05:00.000Z'),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: rows }),
      }),
    );
    // Each INSERT RETURNING returns 1 row (newly stored)
    mockSql.mockResolvedValue([{ id: 1 }]);

    const req = mockRequest({
      method: 'POST',
      headers: {},
      query: { days: '1' },
    });
    const res = mockResponse();
    await runHandler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      daysProcessed: number;
      totalCandles: number;
      newlyStored: number;
      duplicatesSkipped: number;
      dateRange: { from: string; to: string };
    };
    expect(json.daysProcessed).toBe(1);
    // 2 rows per source × 2 sources
    expect(json.totalCandles).toBe(4);
    expect(json.newlyStored).toBe(4);
    expect(json.duplicatesSkipped).toBe(0);
    expect(json.dateRange.from).toBe(json.dateRange.to);
    vi.unstubAllGlobals();
  });

  it('counts duplicates when INSERT returns 0 rows', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const rows = [makeTideRow('2026-03-24', '2026-03-24T14:00:00.000Z')];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: rows }),
      }),
    );
    // INSERT RETURNING returns empty (conflict — duplicate)
    mockSql.mockResolvedValue([]);

    const req = mockRequest({
      method: 'POST',
      headers: {},
      query: { days: '1' },
    });
    const res = mockResponse();
    await runHandler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      newlyStored: number;
      duplicatesSkipped: number;
    };
    expect(json.newlyStored).toBe(0);
    expect(json.duplicatesSkipped).toBe(2); // 1 row × 2 sources
    vi.unstubAllGlobals();
  });

  it('continues when one date returns empty data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const req = mockRequest({
      method: 'POST',
      headers: {},
      query: { days: '1' },
    });
    const res = mockResponse();
    await runHandler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { totalCandles: number };
    expect(json.totalCandles).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // ── days parameter clamping ───────────────────────────────

  it('clamps days to minimum of 1', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const req = mockRequest({
      method: 'POST',
      headers: {},
      query: { days: '0' },
    });
    const res = mockResponse();
    await runHandler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { daysProcessed: number };
    expect(json.daysProcessed).toBe(1);
    vi.unstubAllGlobals();
  });

  it('clamps days to maximum of 30', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const req = mockRequest({
      method: 'POST',
      headers: {},
      query: { days: '999' },
    });
    const res = mockResponse();
    await runHandler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { daysProcessed: number };
    expect(json.daysProcessed).toBe(30);
    vi.unstubAllGlobals();
  });

  it('uses 30 days by default when days param is absent', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const req = mockRequest({ method: 'POST', headers: {}, query: {} });
    const res = mockResponse();
    await runHandler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { daysProcessed: number };
    expect(json.daysProcessed).toBe(30);
    vi.unstubAllGlobals();
  });

  // ── Error handling ────────────────────────────────────────

  it('logs a warning and continues when UW API returns an error for one date', async () => {
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
      method: 'POST',
      headers: {},
      query: { days: '1' },
    });
    const res = mockResponse();
    await runHandler(req, res);

    // Should still return 200 — errors are per-row warnings, not fatal
    expect(res._status).toBe(200);
    const json = res._json as { totalCandles: number };
    expect(json.totalCandles).toBe(0);
    vi.unstubAllGlobals();
  });

  it('continues when a DB insert throws for one row', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const rows = [
      makeTideRow('2026-03-24', '2026-03-24T14:00:00.000Z'),
      makeTideRow('2026-03-24', '2026-03-24T14:05:00.000Z'),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: rows }),
      }),
    );
    // First insert fails, second succeeds
    mockSql
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValue([{ id: 1 }]);

    const req = mockRequest({
      method: 'POST',
      headers: {},
      query: { days: '1' },
    });
    const res = mockResponse();
    await runHandler(req, res);

    // Still 200 — row-level errors are caught and logged
    expect(res._status).toBe(200);
    vi.unstubAllGlobals();
  });
});
