// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/enrich-vega-spike-returns.js';
import { metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Fixtures ──────────────────────────────────────────────────

const GUARD = { apiKey: '', today: '2026-04-27' };

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

/**
 * Returns the SQL text for a tagged-template call, joined with `?` so
 * tests can assert on substrings without worrying about parameter slots.
 */
function sqlText(call: unknown[]): string {
  const strings = call[0] as readonly string[];
  return strings.join('?');
}

/**
 * Helper: build a synthetic pending row.
 */
function pendingRow(
  overrides: Partial<{ id: number; ticker: string; timestamp: string }> = {},
) {
  return {
    id: 1,
    ticker: 'SPY',
    timestamp: '2026-04-27T16:00:00.000Z',
    ...overrides,
  };
}

/**
 * Helper: build a candle row at a specific ISO timestamp + close.
 */
function candleRow(timestamp: string, close: number) {
  return { timestamp, close: String(close) };
}

/**
 * Helper: build the single-row result of the EoD-candle SELECT
 * (the cron's second SELECT per pending row — last candle of the
 * spike's trading day for the same ticker).
 */
function eodCandleResult(close: number | null) {
  return close == null ? [] : [{ close: String(close) }];
}

describe('enrich-vega-spike-returns handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
  });

  // ── Guard delegation ───────────────────────────────────────

  it('exits early when cronGuard returns null (auth/method failure)', async () => {
    mockCronGuard.mockReturnValue(null);
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong (delegated to cronGuard)', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips when outside market hours (delegated to cronGuard)', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips on weekends (delegated to cronGuard)', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('passes requireApiKey: false to cronGuard (no UW key needed)', async () => {
    mockSql.mockResolvedValueOnce([]); // pending rows: empty
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(mockCronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { requireApiKey: false },
    );
  });

  // ── No pending rows ─────────────────────────────────────────

  it('returns 200 with pending=0 when there are no pending rows', async () => {
    mockSql.mockResolvedValueOnce([]); // pending rows: empty
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'enrich-vega-spike-returns',
      pending: 0,
      enriched: 0,
      skippedNoCandles: 0,
    });
    // Only one SELECT (pending rows lookup); no per-row queries.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Pending rows with all 4 candles ────────────────────────

  it('enriches a pending row when all 4 candles (anchor + t+5/15/30) exist', async () => {
    const row = pendingRow({
      id: 42,
      ticker: 'SPY',
      timestamp: '2026-04-27T16:00:00.000Z',
    });

    mockSql
      // 1) pending rows
      .mockResolvedValueOnce([row])
      // 2) candle SELECT for the row
      .mockResolvedValueOnce([
        candleRow('2026-04-27T16:00:00.000Z', 527.5),
        candleRow('2026-04-27T16:05:00.000Z', 528.0),
        candleRow('2026-04-27T16:15:00.000Z', 528.5),
        candleRow('2026-04-27T16:30:00.000Z', 529.0),
      ])
      // 3) EoD candle SELECT
      .mockResolvedValueOnce(eodCandleResult(530.5))
      // 4) UPDATE
      .mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      pending: 1,
      enriched: 1,
      skippedNoCandles: 0,
    });

    // Inspect the UPDATE call (4th SQL invocation: pending → SELECT → EoD → UPDATE).
    const updateCall = mockSql.mock.calls[3]!;
    const updateText = sqlText(updateCall);
    expect(updateText).toContain('UPDATE vega_spike_events');
    expect(updateText).toContain('fwd_return_5m');
    expect(updateText).toContain('fwd_return_15m');
    expect(updateText).toContain('fwd_return_30m');
    expect(updateText).toContain('fwd_return_eod');

    // Forward returns must be present and correctly signed/computed.
    // anchor=527.5, t+5=528.0 → r5 = (528.0-527.5)/527.5 ≈ 0.000947867
    const [, ...updateValues] = updateCall as [unknown, ...unknown[]];
    expect(updateValues).toContain(42); // id
    const r5 = updateValues[0] as number;
    const r15 = updateValues[1] as number;
    const r30 = updateValues[2] as number;
    const rEod = updateValues[3] as number;
    expect(r5).toBeCloseTo((528.0 - 527.5) / 527.5, 8);
    expect(r15).toBeCloseTo((528.5 - 527.5) / 527.5, 8);
    expect(r30).toBeCloseTo((529.0 - 527.5) / 527.5, 8);
    expect(rEod).toBeCloseTo((530.5 - 527.5) / 527.5, 8);
  });

  it('computes return correctly: anchor=100, t+5=100.5 → r5 = 0.005', async () => {
    const row = pendingRow();
    mockSql
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        candleRow('2026-04-27T16:00:00.000Z', 100),
        candleRow('2026-04-27T16:05:00.000Z', 100.5),
        candleRow('2026-04-27T16:15:00.000Z', 100.5),
        candleRow('2026-04-27T16:30:00.000Z', 100.5),
      ])
      .mockResolvedValueOnce(eodCandleResult(101))
      .mockResolvedValueOnce([]);

    await handler(AUTHORIZED_REQ(), mockResponse());

    const updateCall = mockSql.mock.calls[3]!;
    const [, ...values] = updateCall as [unknown, ...unknown[]];
    const r5 = values[0] as number;
    expect(r5).toBeCloseTo(0.005, 10);
  });

  it('returns are signed: anchor=100, t+5=99.8 → r5 = -0.002', async () => {
    const row = pendingRow();
    mockSql
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        candleRow('2026-04-27T16:00:00.000Z', 100),
        candleRow('2026-04-27T16:05:00.000Z', 99.8),
        candleRow('2026-04-27T16:15:00.000Z', 99.8),
        candleRow('2026-04-27T16:30:00.000Z', 99.8),
      ])
      .mockResolvedValueOnce(eodCandleResult(99.5))
      .mockResolvedValueOnce([]);

    await handler(AUTHORIZED_REQ(), mockResponse());

    const updateCall = mockSql.mock.calls[3]!;
    const [, ...values] = updateCall as [unknown, ...unknown[]];
    const r5 = values[0] as number;
    expect(r5).toBeCloseTo(-0.002, 10);
  });

  // ── Anchor candle missing ──────────────────────────────────

  it('skips a row when the anchor candle is missing (does NOT update)', async () => {
    const row = pendingRow();
    mockSql
      .mockResolvedValueOnce([row])
      // candle SELECT returns only forward candles, not the anchor
      .mockResolvedValueOnce([
        candleRow('2026-04-27T16:05:00.000Z', 528.0),
        candleRow('2026-04-27T16:15:00.000Z', 528.5),
        candleRow('2026-04-27T16:30:00.000Z', 529.0),
      ]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      pending: 1,
      enriched: 0,
      skippedNoCandles: 1,
    });

    // Only 2 SQL calls: pending lookup + candle SELECT. NO UPDATE.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Partial forward candles ────────────────────────────────

  it('writes partial returns when t+15/t+30 candles are missing (spike near close)', async () => {
    const row = pendingRow();
    mockSql
      .mockResolvedValueOnce([row])
      // anchor + only t+5 present
      .mockResolvedValueOnce([
        candleRow('2026-04-27T16:00:00.000Z', 100),
        candleRow('2026-04-27T16:05:00.000Z', 100.5),
      ])
      // EoD lookup also empty (spike near close, no later candles)
      .mockResolvedValueOnce(eodCandleResult(null))
      .mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      pending: 1,
      enriched: 1,
      skippedNoCandles: 0,
    });

    // UPDATE should have r5 populated, r15/r30/rEod = null.
    const updateCall = mockSql.mock.calls[3]!;
    const [, ...values] = updateCall as [unknown, ...unknown[]];
    const r5 = values[0] as number | null;
    const r15 = values[1] as number | null;
    const r30 = values[2] as number | null;
    const rEod = values[3] as number | null;

    expect(r5).toBeCloseTo(0.005, 10);
    expect(r15).toBeNull();
    expect(r30).toBeNull();
    expect(rEod).toBeNull();
  });

  it('writes fwd_return_eod when EoD candle is present but no t+5/t+15/t+30', async () => {
    const row = pendingRow();
    mockSql
      .mockResolvedValueOnce([row])
      // only anchor present
      .mockResolvedValueOnce([candleRow('2026-04-27T16:00:00.000Z', 100)])
      // EoD candle later in the day
      .mockResolvedValueOnce(eodCandleResult(101.5))
      .mockResolvedValueOnce([]);

    await handler(AUTHORIZED_REQ(), mockResponse());

    const updateCall = mockSql.mock.calls[3]!;
    const [, ...values] = updateCall as [unknown, ...unknown[]];
    const r5 = values[0] as number | null;
    const rEod = values[3] as number | null;
    expect(r5).toBeNull();
    expect(rEod).toBeCloseTo(0.015, 10);
  });

  // ── 7-day cutoff ───────────────────────────────────────────

  it("pending-rows query includes a 7-day cutoff (NOW() - INTERVAL '7 days')", async () => {
    mockSql.mockResolvedValueOnce([]);
    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(mockSql).toHaveBeenCalledTimes(1);
    const pendingCall = mockSql.mock.calls[0]!;
    const text = sqlText(pendingCall);

    // Must select pending rows by the not-null + 30 min + 7 day window.
    expect(text).toContain('fwd_return_30m IS NULL');
    expect(text).toContain("INTERVAL '30 minutes'");
    expect(text).toContain("INTERVAL '7 days'");
    expect(text).toContain('LIMIT 100');
  });

  // ── UPDATE failure handling ────────────────────────────────

  it('counts UPDATE failure as enrich_failure metric; handler still returns 200', async () => {
    const row = pendingRow();
    mockSql
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        candleRow('2026-04-27T16:00:00.000Z', 100),
        candleRow('2026-04-27T16:05:00.000Z', 100.5),
        candleRow('2026-04-27T16:15:00.000Z', 100.5),
        candleRow('2026-04-27T16:30:00.000Z', 100.5),
      ])
      .mockResolvedValueOnce(eodCandleResult(101))
      .mockRejectedValueOnce(new Error('DB UPDATE failed'));

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      pending: 1,
      enriched: 0,
      skippedNoCandles: 0,
    });
    expect(metrics.increment).toHaveBeenCalledWith('vega_spike.enrich_failure');
    expect(reportCronRun).toHaveBeenCalledWith(
      'enrich-vega-spike-returns',
      expect.objectContaining({ status: 'partial', failed: 1 }),
    );
  });

  it('fires vega_spike.enriched metric per row enriched', async () => {
    const row = pendingRow();
    mockSql
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        candleRow('2026-04-27T16:00:00.000Z', 100),
        candleRow('2026-04-27T16:05:00.000Z', 100.5),
        candleRow('2026-04-27T16:15:00.000Z', 100.5),
        candleRow('2026-04-27T16:30:00.000Z', 100.5),
      ])
      .mockResolvedValueOnce(eodCandleResult(101))
      .mockResolvedValueOnce([]);

    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(metrics.increment).toHaveBeenCalledWith('vega_spike.enriched');
  });

  // ── Top-level error handling ───────────────────────────────

  it('returns 500 when the pending-rows SELECT throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  // ── Method guard ───────────────────────────────────────────

  it('returns 405 when method is not GET (delegated to cronGuard)', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(405).json({ error: 'GET only' });
      return null;
    });
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
