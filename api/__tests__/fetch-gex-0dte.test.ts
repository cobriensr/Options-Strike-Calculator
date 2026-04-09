// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockQuery = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
  query: typeof mockQuery;
};
mockSql.transaction = mockTransaction;
mockSql.query = mockQuery;

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

// Phase 4A: mock the feature helper so cron tests exercise only the
// raw snapshot path by default. Specific tests override these mocks to
// cover the feature-write branches.
const mockLoadSnapshotHistory = vi.fn();
const mockWriteFeatureRows = vi.fn();
vi.mock('../_lib/gex-target-features.js', () => ({
  loadSnapshotHistory: (...args: unknown[]) => mockLoadSnapshotHistory(...args),
  writeFeatureRows: (...args: unknown[]) => mockWriteFeatureRows(...args),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: {
    schwabCall: vi.fn(() => () => {}),
    tokenRefresh: vi.fn(),
    rateLimited: vi.fn(),
    uwRateLimit: vi.fn(),
  },
}));

import handler from '../cron/fetch-gex-0dte.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');

function makeStrikeRow(overrides = {}) {
  return {
    strike: '5800',
    price: '5800.5',
    time: '2026-03-24T14:30:00Z',
    call_gamma_oi: '500000',
    put_gamma_oi: '-300000',
    call_gamma_vol: '100000',
    put_gamma_vol: '-50000',
    call_gamma_ask: '200000',
    call_gamma_bid: '150000',
    put_gamma_ask: '-100000',
    put_gamma_bid: '-80000',
    call_charm_oi: '50000',
    put_charm_oi: '-40000',
    call_charm_vol: '25000',
    put_charm_vol: '-20000',
    call_delta_oi: '100000',
    put_delta_oi: '-75000',
    call_vanna_oi: '25000',
    put_vanna_oi: '-15000',
    call_vanna_vol: '12000',
    put_vanna_vol: '-8000',
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

describe('fetch-gex-0dte handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default tagged-template response covers the post-insert data-quality
    // SELECT (handler lines ~181-198) which reads { total, nonzero }.
    mockSql.mockResolvedValue([{ total: 0, nonzero: 0 }]);
    mockSql.transaction = mockTransaction;
    mockSql.query = mockQuery;
    // Default: every submitted row gets an id back (all inserted, no conflicts)
    mockQuery.mockImplementation(
      async (_text: string, params: unknown[] = []) => {
        const COLUMNS_PER_ROW = 22;
        const rowCount = Math.floor(params.length / COLUMNS_PER_ROW);
        return Array.from({ length: rowCount }, (_v, i) => ({ id: i + 1 }));
      },
    );
    // Default: no snapshot history → feature helper is a no-op. Specific
    // tests override these to drive the write path.
    mockLoadSnapshotHistory.mockResolvedValue([]);
    mockWriteFeatureRows.mockResolvedValue({
      written: 0,
      skipped: 0,
      modes: {
        oi: { written: 0, skipped: 0 },
        vol: { written: 0, skipped: 0 },
        dir: { written: 0, skipped: 0 },
      },
    });
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
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches 0DTE strikes, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-gex-0dte',
      success: true,
      price: 5800.5,
      stored: 1,
      skipped: 0,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns correct response for empty API data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: false,
      reason: 'No 0DTE strike data',
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Simulate ON CONFLICT DO NOTHING hitting every row: RETURNING id yields []
    mockQuery.mockResolvedValueOnce([]);
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  it('filters out strikes beyond ±200 pts from ATM', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const nearStrike = makeStrikeRow({
      strike: '5800',
      price: '5800.5',
    });
    const farStrike = makeStrikeRow({
      strike: '6100',
      price: '5800.5',
    });
    stubFetch([nearStrike, farStrike]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Only near strike stored — 6100 is >200 pts away
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
    });
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('handles batch insert errors gracefully', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockQuery.mockRejectedValueOnce(new Error('DB batch insert failed'));
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      stored: 0,
      skipped: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Batch gex_strike_0dte insert failed',
    );
  });

  // ── Multi-row INSERT (BE-CRON-005) ────────────────────────

  it('issues a single multi-row INSERT for many strikes (no N+1)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Build 150 strikes in the ±200 window around price 5800.5
    const rows = Array.from({ length: 150 }, (_v, i) =>
      makeStrikeRow({ strike: String(5700 + i), price: '5800.5' }),
    );
    stubFetch(rows);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, stored: 150, skipped: 0 });
    // Exactly one INSERT call — not 150
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();

    // Params array length = rowCount * 22 columns
    const [text, params] = mockQuery.mock.calls[0]!;
    expect(typeof text).toBe('string');
    expect(text).toMatch(/INSERT INTO gex_strike_0dte/);
    expect(text).toMatch(/ON CONFLICT \(date, timestamp, strike\) DO NOTHING/);
    expect(Array.isArray(params)).toBe(true);
    expect((params as unknown[]).length).toBe(150 * 22);
    // Placeholder count matches params: ensure the final placeholder is $3300
    expect(text).toContain('$3300');
  });

  it('does NOT issue an INSERT when filtered rows are empty', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // All strikes far outside ±200 window from ATM
    const rows = [
      makeStrikeRow({ strike: '6500', price: '5800.5' }),
      makeStrikeRow({ strike: '5000', price: '5800.5' }),
    ];
    stubFetch(rows);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, stored: 0, skipped: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('pins column order: params match the documented 22-column layout', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeStrikeRow({ strike: '5800', price: '5800.5' });
    stubFetch([row]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // Column order must match the old one-row-at-a-time INSERT:
    // date, timestamp, strike, price,
    // call_gamma_oi, put_gamma_oi,
    // call_gamma_vol, put_gamma_vol,
    // call_gamma_ask, call_gamma_bid,
    // put_gamma_ask, put_gamma_bid,
    // call_charm_oi, put_charm_oi,
    // call_charm_vol, put_charm_vol,
    // call_delta_oi, put_delta_oi,
    // call_vanna_oi, put_vanna_oi,
    // call_vanna_vol, put_vanna_vol
    expect(p).toHaveLength(22);
    expect(p[0]).toBe('2026-03-24'); // today (from cronGuard on MARKET_TIME)
    expect(p[1]).toBe(new Date(row.time).toISOString()); // timestamp
    expect(p[2]).toBe(row.strike);
    expect(p[3]).toBe(row.price);
    expect(p[4]).toBe(row.call_gamma_oi);
    expect(p[5]).toBe(row.put_gamma_oi);
    expect(p[6]).toBe(row.call_gamma_vol);
    expect(p[7]).toBe(row.put_gamma_vol);
    expect(p[8]).toBe(row.call_gamma_ask);
    expect(p[9]).toBe(row.call_gamma_bid);
    expect(p[10]).toBe(row.put_gamma_ask);
    expect(p[11]).toBe(row.put_gamma_bid);
    expect(p[12]).toBe(row.call_charm_oi);
    expect(p[13]).toBe(row.put_charm_oi);
    expect(p[14]).toBe(row.call_charm_vol);
    expect(p[15]).toBe(row.put_charm_vol);
    expect(p[16]).toBe(row.call_delta_oi);
    expect(p[17]).toBe(row.put_delta_oi);
    expect(p[18]).toBe(row.call_vanna_oi);
    expect(p[19]).toBe(row.put_vanna_oi);
    expect(p[20]).toBe(row.call_vanna_vol);
    expect(p[21]).toBe(row.put_vanna_vol);
  });

  // ── Feature writes (Phase 4A) ─────────────────────────────

  it('loads snapshot history and writes features after a successful raw insert', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fakeSnapshots = [
      { timestamp: '2026-03-24T14:29:00.000Z', price: 5800, strikes: [] },
      { timestamp: '2026-03-24T14:30:00.000Z', price: 5800.5, strikes: [] },
    ];
    mockLoadSnapshotHistory.mockResolvedValueOnce(fakeSnapshots);
    mockWriteFeatureRows.mockResolvedValueOnce({
      written: 27,
      skipped: 3,
      modes: {
        oi: { written: 10, skipped: 0 },
        vol: { written: 9, skipped: 1 },
        dir: { written: 8, skipped: 2 },
      },
    });

    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Helper was invoked with (today, timestamp, FEATURE_HISTORY_SIZE)
    expect(mockLoadSnapshotHistory).toHaveBeenCalledTimes(1);
    const [loadDate, loadTs, loadSize] = mockLoadSnapshotHistory.mock.calls[0]!;
    expect(loadDate).toBe('2026-03-24');
    expect(loadTs).toBe('2026-03-24T14:30:00.000Z');
    expect(loadSize).toBe(61);

    expect(mockWriteFeatureRows).toHaveBeenCalledTimes(1);
    const [writeSnapshots, writeDate, writeTs] =
      mockWriteFeatureRows.mock.calls[0]!;
    expect(writeSnapshots).toBe(fakeSnapshots);
    expect(writeDate).toBe('2026-03-24');
    expect(writeTs).toBe('2026-03-24T14:30:00.000Z');

    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      features: {
        written: 27,
        skipped: 3,
        modes: {
          oi: { written: 10, skipped: 0 },
          vol: { written: 9, skipped: 1 },
          dir: { written: 8, skipped: 2 },
        },
      },
    });
  });

  it('skips writeFeatureRows when snapshot history is too short (<2)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockLoadSnapshotHistory.mockResolvedValueOnce([
      { timestamp: '2026-03-24T14:30:00.000Z', price: 5800.5, strikes: [] },
    ]);
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(mockLoadSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(mockWriteFeatureRows).not.toHaveBeenCalled();
    // features left null when the helper wasn't called (short history)
    expect((res._json as { features: unknown }).features).toBeNull();
    // But the raw snapshot fields are still populated
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
    });
  });

  it('does NOT run feature helpers when the raw insert stored 0 rows', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // ON CONFLICT → every row dropped → stored = 0 → feature helpers skipped
    mockQuery.mockResolvedValueOnce([]);
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 0, skipped: 1 });
    expect(mockLoadSnapshotHistory).not.toHaveBeenCalled();
    expect(mockWriteFeatureRows).not.toHaveBeenCalled();
  });

  it('returns 200 with features.error when the feature helper throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockLoadSnapshotHistory.mockResolvedValueOnce([
      { timestamp: '2026-03-24T14:29:00.000Z', price: 5800, strikes: [] },
      { timestamp: '2026-03-24T14:30:00.000Z', price: 5800.5, strikes: [] },
    ]);
    mockWriteFeatureRows.mockRejectedValueOnce(new Error('scoring boom'));
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    // Raw snapshot response fields must still be populated
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
      features: { error: true },
    });

    // Sentry received the feature-phase tag
    expect(Sentry.setTag).toHaveBeenCalledWith('feature.phase', 'write');
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'fetch-gex-0dte: feature write threw unexpectedly',
    );
  });
});
