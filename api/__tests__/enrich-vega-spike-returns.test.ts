// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
    // The morning after the fixtures' 2026-04-27 session: fwd_return_eod is
    // written only once a spike's session has closed and settled.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-28T14:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
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
      // deferSkipResponse is the wrapper's own flag (skip check-in before
      // the skip response); requireApiKey is this cron's.
      { requireApiKey: false, deferSkipResponse: true },
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

  // ── EoD bound: the regular-session close ───────────────────

  /**
   * A sql fake for one pending row that applies the cron's own bounds to
   * `candles`: the exact-minute IN list for the 5/15/30 lookups, and
   * `timestamp >= anchor AND timestamp < close` for the EoD bar. ISO
   * strings in toISOString() form compare in time order.
   */
  function fakeDb(
    row: ReturnType<typeof pendingRow>,
    candles: Array<{ timestamp: string; close: number }>,
  ) {
    mockSql.mockImplementation(
      (strings: readonly string[], ...values: unknown[]) => {
        const text = strings.join('?');
        if (text.includes('UPDATE vega_spike_events')) {
          return Promise.resolve([]);
        }
        if (text.includes('FROM vega_spike_events')) {
          return Promise.resolve([row]);
        }
        if (text.includes('timestamp IN')) {
          const isos = values.slice(1);
          return Promise.resolve(
            candles
              .filter((c) => isos.includes(c.timestamp))
              .map((c) => candleRow(c.timestamp, c.close)),
          );
        }
        if (text.includes('ORDER BY timestamp DESC')) {
          const [, fromIso, closeIso] = values as [unknown, string, string];
          const hit = candles
            .filter((c) => c.timestamp >= fromIso && c.timestamp < closeIso)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
          return Promise.resolve(eodCandleResult(hit?.close ?? null));
        }
        return Promise.reject(new Error(`unexpected SQL: ${text}`));
      },
    );
  }

  /** The bound values of the UPDATE: [r5, r15, r30, rEod, id]. */
  function updateValues(): unknown[] {
    const call = mockSql.mock.calls.find((c) =>
      sqlText(c).includes('UPDATE vega_spike_events'),
    );
    expect(call).toBeDefined();
    return call!.slice(1);
  }

  it.each([
    {
      day: 'an EDT day (16:00 ET = 20:00Z)',
      spike: '2026-04-27T16:00:00.000Z',
      lastRegular: '2026-04-27T19:59:00.000Z',
      postMarket: '2026-04-27T20:04:00.000Z',
      close: '2026-04-27T20:00:00.000Z',
      now: '2026-04-28T14:00:00.000Z',
    },
    {
      day: 'an EST day (16:00 ET = 21:00Z)',
      spike: '2026-01-15T16:00:00.000Z',
      lastRegular: '2026-01-15T20:59:00.000Z',
      postMarket: '2026-01-15T21:04:00.000Z',
      close: '2026-01-15T21:00:00.000Z',
      now: '2026-01-16T15:00:00.000Z',
    },
    {
      day: 'a half-day (Black Friday, 13:00 ET = 18:00Z)',
      spike: '2026-11-27T16:00:00.000Z',
      lastRegular: '2026-11-27T17:59:00.000Z',
      postMarket: '2026-11-27T18:04:00.000Z',
      close: '2026-11-27T18:00:00.000Z',
      now: '2026-11-30T15:00:00.000Z',
    },
  ])(
    'EoD uses the last regular-session bar and ignores a post-market bar on $day',
    async ({ spike, lastRegular, postMarket, close, now }) => {
      // fetch-etf-candles-1m's gate runs to close + 5, so etf_candles_1m
      // holds post-market bars after the close.
      vi.setSystemTime(new Date(now));
      fakeDb(pendingRow({ timestamp: spike }), [
        { timestamp: spike, close: 100 },
        { timestamp: lastRegular, close: 101 },
        { timestamp: postMarket, close: 105 },
      ]);

      await handler(AUTHORIZED_REQ(), mockResponse());

      const eodCall = mockSql.mock.calls.find((c) =>
        sqlText(c).includes('ORDER BY timestamp DESC'),
      )!;
      expect(sqlText(eodCall)).toMatch(/timestamp < \?::timestamptz/);
      expect(sqlText(eodCall)).not.toMatch(/7 hours/);
      expect(eodCall.slice(1)).toEqual(['SPY', spike, close]);
      // The 15:59 (12:59 on a half-day) close, not the post-market 105.
      expect(updateValues()[3]).toBeCloseTo(0.01, 10);
    },
  );

  it('writes no EoD return for a spike at or after the close', async () => {
    fakeDb(pendingRow({ timestamp: '2026-04-27T20:02:00.000Z' }), [
      { timestamp: '2026-04-27T20:02:00.000Z', close: 100 },
      { timestamp: '2026-04-27T20:04:00.000Z', close: 105 },
    ]);

    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(updateValues()[3]).toBeNull();
    // No session left after the spike, so no EoD lookup at all.
    expect(
      mockSql.mock.calls.some((c) =>
        sqlText(c).includes('ORDER BY timestamp DESC'),
      ),
    ).toBe(false);
  });

  // ── EoD timing: written once the session has closed + 5 min ─

  /** A full set of candles for a 12:00 ET spike on 2026-04-27. */
  const SESSION_CANDLES = [
    { timestamp: '2026-04-27T16:00:00.000Z', close: 100 },
    { timestamp: '2026-04-27T16:05:00.000Z', close: 100.5 },
    { timestamp: '2026-04-27T16:15:00.000Z', close: 101 },
    { timestamp: '2026-04-27T16:30:00.000Z', close: 101.5 },
    { timestamp: '2026-04-27T16:59:00.000Z', close: 103 }, // newest at 13:00 ET
    { timestamp: '2026-04-27T19:59:00.000Z', close: 102 }, // the 15:59 bar
  ];

  const eodLookupRan = () =>
    mockSql.mock.calls.some((c) =>
      sqlText(c).includes('ORDER BY timestamp DESC'),
    );

  it('leaves fwd_return_eod NULL while the session is open, still writing 5/15/30', async () => {
    // Before: EoD was the newest bar at enrichment time (here 13:00 ET's
    // 103, about t+60), frozen once fwd_return_30m was set.
    vi.setSystemTime(new Date('2026-04-27T17:00:00.000Z')); // 13:00 ET
    fakeDb(
      pendingRow({ timestamp: '2026-04-27T16:00:00.000Z' }),
      SESSION_CANDLES.slice(0, 5),
    );

    await handler(AUTHORIZED_REQ(), mockResponse());

    const [r5, r15, r30, rEod] = updateValues();
    expect(r5).toBeCloseTo(0.005, 10);
    expect(r15).toBeCloseTo(0.01, 10);
    expect(r30).toBeCloseTo(0.015, 10);
    expect(rEod).toBeNull();
    expect(eodLookupRan()).toBe(false);
  });

  it.each([
    { label: 'EDT close + 4:59', now: '2026-04-27T20:04:59.000Z', eod: null },
    { label: 'EDT close + 5:00', now: '2026-04-27T20:05:00.000Z', eod: 0.02 },
  ])(
    'writes fwd_return_eod only from close + 5 min ($label)',
    async ({ now, eod }) => {
      vi.setSystemTime(new Date(now));
      fakeDb(
        pendingRow({ timestamp: '2026-04-27T16:00:00.000Z' }),
        SESSION_CANDLES,
      );

      await handler(AUTHORIZED_REQ(), mockResponse());

      const rEod = updateValues()[3];
      if (eod == null) expect(rEod).toBeNull();
      else expect(rEod).toBeCloseTo(eod, 10);
    },
  );

  it.each([
    { label: 'close + 4:59', now: '2026-11-27T18:04:59.000Z', eod: null },
    { label: 'close + 5:00', now: '2026-11-27T18:05:00.000Z', eod: 0.01 },
  ])(
    'on a half-day (13:00 ET close) writes fwd_return_eod only from 13:05 ET ($label)',
    async ({ now, eod }) => {
      vi.setSystemTime(new Date(now));
      fakeDb(pendingRow({ timestamp: '2026-11-27T16:00:00.000Z' }), [
        { timestamp: '2026-11-27T16:00:00.000Z', close: 100 },
        { timestamp: '2026-11-27T17:59:00.000Z', close: 101 }, // 12:59 ET
        { timestamp: '2026-11-27T18:03:00.000Z', close: 105 }, // post-market
      ]);

      await handler(AUTHORIZED_REQ(), mockResponse());

      const rEod = updateValues()[3];
      if (eod == null) expect(rEod).toBeNull();
      else expect(rEod).toBeCloseTo(eod, 10);
    },
  );

  it('writes a previous session’s EoD on the next morning’s run', async () => {
    // A row the 16:05 run missed is picked up the next day (default clock:
    // 2026-04-28 10:00 ET) with that session's 15:59 close.
    fakeDb(
      pendingRow({ timestamp: '2026-04-27T16:00:00.000Z' }),
      SESSION_CANDLES,
    );

    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(updateValues()[3]).toBeCloseTo(0.02, 10);
  });

  it.each([
    {
      label: 'during the session: ET midnight today',
      now: '2026-04-27T17:00:00.000Z',
      bound: '2026-04-27T04:00:00.000Z',
    },
    {
      label: 'from close + 5 min: now',
      now: '2026-04-27T20:05:00.000Z',
      bound: '2026-04-27T20:05:00.000Z',
    },
    {
      label: 'during a half-day (EST): ET midnight today',
      now: '2026-11-27T17:00:00.000Z',
      bound: '2026-11-27T05:00:00.000Z',
    },
    {
      label: 'a half-day from 13:05 ET: now',
      now: '2026-11-27T18:05:00.000Z',
      bound: '2026-11-27T18:05:00.000Z',
    },
    {
      label: 'a day with no session: now',
      now: '2026-04-25T15:00:00.000Z', // Saturday
      bound: '2026-04-25T15:00:00.000Z',
    },
  ])(
    're-selects rows awaiting EoD only from settled sessions ($label)',
    async ({ now, bound }) => {
      // Today's rows wait out the session in SQL, so they can't crowd
      // newer spikes out of the LIMIT 100 while their EoD isn't due.
      vi.setSystemTime(new Date(now));
      mockSql.mockResolvedValueOnce([]);

      await handler(AUTHORIZED_REQ(), mockResponse());

      const pendingCall = mockSql.mock.calls[0]!;
      expect(sqlText(pendingCall)).toMatch(
        /fwd_return_30m IS NULL\s+OR \(fwd_return_eod IS NULL AND timestamp < \?::timestamptz\)/,
      );
      expect(pendingCall.slice(1)).toEqual([bound]);
    },
  );

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
