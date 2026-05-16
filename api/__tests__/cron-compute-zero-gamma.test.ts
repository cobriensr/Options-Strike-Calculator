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

const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

const TICKERS = ['SPX', 'SPY', 'QQQ'] as const;

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

/** A balanced put-vs-call chain that produces a confident crossing near 7105. */
function balancedChain() {
  return [
    makeStrikeRow(7095, 0, 1_000_000_000),
    makeStrikeRow(7100, 0, 1_500_000_000),
    makeStrikeRow(7105, 0, 0),
    makeStrikeRow(7110, -1_500_000_000, 0),
    makeStrikeRow(7115, -1_000_000_000, 0),
  ];
}

/**
 * Queue per-ticker mock responses. Each ticker contributes 4 SQL calls
 * (latest_ts SELECT, rows SELECT, prev net_gamma SELECT, INSERT) when a
 * snapshot exists, or 1 (latest_ts SELECT) when the snapshot is empty.
 * The prev-net-gamma SELECT was added by the dealer-regime sign-flip
 * detection in compute-zero-gamma.ts (commit 5f8eee8b).
 */
function queueAllTickersHappyPath() {
  for (let i = 0; i < TICKERS.length; i += 1) {
    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce(balancedChain())
      .mockResolvedValueOnce([]) // prev net_gamma SELECT (no prior row)
      .mockResolvedValueOnce([]); // INSERT
  }
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

  // ── No snapshot available (per-ticker) ───────────────────

  it('records "no snapshot" per ticker without inserting when latest_ts is null', async () => {
    // 3 latest_ts SELECTs (one per ticker), all returning null.
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      perTicker: Record<string, { stored: boolean; reason?: string }>;
    };
    for (const ticker of TICKERS) {
      expect(body.perTicker[ticker]).toMatchObject({
        stored: false,
        reason: 'No strike_exposures snapshot',
      });
    }
    // 3 SELECTs total, no INSERTs.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Happy path: 3 tickers, 3 INSERTs ─────────────────────

  it('inserts a gated zero_gamma row for every ticker', async () => {
    queueAllTickersHappyPath();

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      perTicker: Record<
        string,
        {
          stored: boolean;
          ticker?: string;
          spot?: number;
          zeroGamma?: number | null;
        }
      >;
    };
    for (const ticker of TICKERS) {
      const entry = body.perTicker[ticker];
      expect(entry).toBeDefined();
      expect(entry!.stored).toBe(true);
      expect(entry!.spot).toBe(7105);
      expect(entry!.zeroGamma).not.toBeNull();
    }
    // 3 tickers × 4 SQL calls = 12
    expect(mockSql).toHaveBeenCalledTimes(12);
  });

  it('queries each ticker at today (0DTE) as the primary expiry', async () => {
    queueAllTickersHappyPath();

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    // The latest_ts SELECT for each ticker interpolates (date, ticker,
    // expiry). All three tickers should query at the cron's `today` value.
    type SqlCall = unknown[];
    const calls = mockSql.mock.calls as SqlCall[];
    for (const ticker of TICKERS) {
      const latestTsCall = calls.find((c) => {
        const values = c.slice(1) as unknown[];
        return values.includes(ticker);
      });
      expect(latestTsCall).toBeDefined();
      const values = latestTsCall!.slice(1) as unknown[];
      expect(values).toContain('2026-03-24');
    }
  });

  // ── No sign change in ±3% grid: zeroGamma null, row still inserted ─

  it('stores zero_gamma as null when the gamma profile has no sign change', async () => {
    // All-positive gamma chain → calculator returns level: null because no
    // sign flip exists in the ±3% grid. The handler still inserts the row
    // for diagnostic history (full curve and confidence preserved).
    const noFlipChain = [
      makeStrikeRow(7095, 500_000_000, 200_000_000),
      makeStrikeRow(7100, 800_000_000, 300_000_000),
      makeStrikeRow(7110, 600_000_000, 400_000_000),
    ];

    // SPX has the no-flip chain; the rest skip via null latest_ts.
    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce(noFlipChain)
      .mockResolvedValueOnce([]); // SPX INSERT
    for (let i = 0; i < TICKERS.length - 1; i += 1) {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      perTicker: Record<
        string,
        { stored: boolean; zeroGamma?: number | null; confidence?: number }
      >;
    };
    expect(body.perTicker.SPX!.stored).toBe(true);
    expect(body.perTicker.SPX!.zeroGamma).toBeNull();
    expect(body.perTicker.SPX!.confidence).toBe(0);
  });

  // ── Insert wiring: verify exact arguments reach SQL ──────

  it('passes ticker, spot, confidence, and curve JSON to the INSERT', async () => {
    queueAllTickersHappyPath();

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    // INSERT for each ticker is the 4th SQL call within that ticker's
    // 4-call group. Indices: SPX=3, SPY=7, QQQ=11.
    type SqlCall = unknown[];
    const calls = mockSql.mock.calls as SqlCall[];
    const insertIndices = [3, 7, 11];
    insertIndices.forEach((idx, tickerIdx) => {
      const insertCall = calls[idx];
      expect(insertCall).toBeDefined();
      const values = insertCall!.slice(1) as unknown[];
      // Source order: ticker, spot, zeroGamma, confidence, netGamma, curveJson
      const [ticker, spot, , confidence, netGamma, curveJson] = values;
      expect(ticker).toBe(TICKERS[tickerIdx]);
      expect(spot).toBe(7105);
      expect(typeof confidence).toBe('number');
      expect(typeof netGamma).toBe('number');
      expect(typeof curveJson).toBe('string');
      const parsed = JSON.parse(curveJson as string);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty('spot');
      expect(parsed[0]).toHaveProperty('netGamma');
    });
  });

  // ── Per-ticker fault isolation ───────────────────────────

  it('isolates per-ticker DB failures — surviving tickers still complete', async () => {
    // SPX: SELECT throws. SPY/QQQ: full happy path (4 SQL calls each
    // — latest_ts, rows, prev net_gamma, INSERT).
    mockSql.mockRejectedValueOnce(new Error('SPX latest_ts query failed'));
    for (let i = 0; i < TICKERS.length - 1; i += 1) {
      mockSql
        .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
        .mockResolvedValueOnce(balancedChain())
        .mockResolvedValueOnce([]) // prev net_gamma SELECT
        .mockResolvedValueOnce([]); // INSERT
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      perTicker: Record<string, { stored: boolean; error?: string }>;
    };
    expect(body.perTicker.SPX).toMatchObject({ stored: false });
    expect(body.perTicker.SPX!.error).toBeDefined();
    expect(body.perTicker.SPY).toMatchObject({ stored: true });
    expect(body.perTicker.QQQ).toMatchObject({ stored: true });
  });
});
