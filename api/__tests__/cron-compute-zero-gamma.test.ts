// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

import handler from '../cron/compute-zero-gamma.js';

// Fixed times (2026-03-24 is a Tuesday):
//   14:00 UTC = 10:00 AM ET → inside market hours
//   11:00 UTC = 07:00 AM ET → before market hours
//   Saturday 2026-03-28 → weekend
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

/**
 * Build a strike_exposures row. `timestamp` is shared across all rows in a
 * single snapshot so loadLatestSnapshot() pulls them together. `price` is
 * the spot at that snapshot — same across rows by convention.
 */
function makeStrikeRow(
  strike: number,
  callGamma: number,
  putGamma: number,
  price = 7105,
  timestamp = '2026-03-24T13:55:00.000Z',
) {
  return {
    strike: String(strike),
    price: String(price),
    call_gamma_oi: String(callGamma),
    put_gamma_oi: String(putGamma),
    timestamp,
  };
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('compute-zero-gamma handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when CRON_SECRET env is not set', async () => {
    delete process.env.CRON_SECRET;
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ───────────────────────────────────

  it('skips before 9:30 AM ET', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── No snapshot available ────────────────────────────────

  it('gracefully no-ops when no strike_exposures snapshot exists', async () => {
    // latest_ts query returns null
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'No strike_exposures snapshot',
    });
    // Only the latest_ts SELECT ran — no INSERT.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('no-ops when latest timestamp exists but returns no strike rows', async () => {
    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    // 2 SELECTs, no INSERT
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Happy path: inserts gated level ──────────────────────

  it('inserts a gated zero_gamma row for a balanced put-vs-call chain', async () => {
    // Balanced chain around 7105 — the calculator's 9-test suite covers
    // this exact shape. We only need to check the handler wires the
    // result into the INSERT correctly.
    const strikes = [
      makeStrikeRow(7095, 0, 1_000_000_000),
      makeStrikeRow(7100, 0, 1_500_000_000),
      makeStrikeRow(7105, 0, 0),
      makeStrikeRow(7110, -1_500_000_000, 0),
      makeStrikeRow(7115, -1_000_000_000, 0),
    ];

    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce(strikes)
      .mockResolvedValueOnce([]); // INSERT

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      stored: boolean;
      ticker: string;
      spot: number;
      zeroGamma: number | null;
      confidence: number;
    };
    expect(body.stored).toBe(true);
    expect(body.ticker).toBe('SPX');
    expect(body.spot).toBe(7105);
    expect(body.confidence).toBeGreaterThan(0.5);
    expect(body.zeroGamma).not.toBeNull();
    // 3 SQL calls: latest_ts, strikes, INSERT
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Low confidence: level stored as null, row still inserted ─

  it('stores zero_gamma as null when confidence < 0.5 but preserves diagnostics', async () => {
    // All-positive gamma chain: the calculator returns { level: null,
    // confidence: 0 } with a fully positive curve. The handler should
    // still insert the row (for diagnostic history) with zero_gamma null.
    const strikes = [
      makeStrikeRow(7095, 500_000_000, 200_000_000),
      makeStrikeRow(7100, 800_000_000, 300_000_000),
      makeStrikeRow(7110, 600_000_000, 400_000_000),
    ];

    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce(strikes)
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      stored: boolean;
      zeroGamma: number | null;
      confidence: number;
    };
    expect(body.stored).toBe(true);
    expect(body.zeroGamma).toBeNull();
    expect(body.confidence).toBe(0);
    // INSERT still ran — diagnostics preserved
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Insert wiring: verify exact arguments reach SQL ──────

  it('passes ticker, spot, confidence, and curve JSON to the INSERT', async () => {
    const strikes = [
      makeStrikeRow(7095, 0, 1_000_000_000),
      makeStrikeRow(7100, 0, 1_500_000_000),
      makeStrikeRow(7110, -1_500_000_000, 0),
      makeStrikeRow(7115, -1_000_000_000, 0),
    ];

    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce(strikes)
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // Third SQL call is the INSERT; neon tagged template arguments are the
    // interpolated values in the order they appear in the template.
    const insertCall = mockSql.mock.calls[2];
    expect(insertCall).toBeDefined();
    // tagged-template args: (strings, ...values) — values start at index 1
    const values = insertCall!.slice(1) as unknown[];
    // Values, in source order: ticker, spot, zeroGamma, confidence,
    //   netGamma, curveJson
    const [ticker, spot, zeroGamma, confidence, netGamma, curveJson] = values;
    expect(ticker).toBe('SPX');
    expect(spot).toBe(7105);
    expect(typeof confidence).toBe('number');
    expect(typeof netGamma).toBe('number');
    expect(zeroGamma).not.toBeNull();
    expect(typeof curveJson).toBe('string');
    // curve is a JSON-encoded array of {spot, netGamma}
    const parsed = JSON.parse(curveJson as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('spot');
    expect(parsed[0]).toHaveProperty('netGamma');
  });

  // ── Error handling ──────────────────────────────────────

  it('returns 500 when the SELECT throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when the INSERT throws', async () => {
    const strikes = [
      makeStrikeRow(7095, 0, 1_000_000_000),
      makeStrikeRow(7110, -1_500_000_000, 0),
    ];
    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce(strikes)
      .mockRejectedValueOnce(new Error('insert failed'));

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });
});
