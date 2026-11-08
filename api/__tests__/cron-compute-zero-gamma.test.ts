// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

import handler from '../cron/compute-zero-gamma.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';

const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z'); // 10:00 ET
const BEFORE_0940_ET = new Date('2026-03-24T13:39:59.000Z');
const AT_0940_ET = new Date('2026-03-24T13:40:00.000Z');
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

const TICKERS = ['SPX', 'SPY', 'QQQ'] as const;

// The newest ladder fetch-strike-exposure stored: its 5-minute bucket began
// 10 minutes before MARKET_TIME. The row computed from it is labelled with
// the END of that bucket, 5 minutes later.
const LADDER_TS = '2026-03-24T13:50:00.000Z';
const LABEL_TS = '2026-03-24T13:55:00.000Z';

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
  timestamp = LADDER_TS,
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
 * Queue one ticker's SQL calls, in the order the handler makes them:
 * latest_ts SELECT, rows SELECT, INSERT ... RETURNING id, and, only when the
 * INSERT stored a row, the previous-ladder net_gamma SELECT. A stale or empty
 * ticker stops after the latest_ts SELECT.
 */
function queueStored(prev: unknown[] = []) {
  mockSql
    .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
    .mockResolvedValueOnce(balancedChain())
    .mockResolvedValueOnce([{ id: 1 }]) // INSERT stored the ladder
    .mockResolvedValueOnce(prev); // previous ladder's net_gamma
}

function queueAllTickersHappyPath() {
  for (let i = 0; i < TICKERS.length; i += 1) queueStored();
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

type Body = {
  status: string;
  failedLegs: number;
  totalLegs: number;
  skippedLegs: number;
  perTicker: Record<
    string,
    {
      stored: boolean;
      reason?: string;
      skip?: string;
      error?: string;
      spot?: number;
      zeroGamma?: number | null;
      confidence?: number;
    }
  >;
};

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

  // ── Happy path: 3 tickers, 3 INSERTs ─────────────────────

  it('inserts a zero_gamma row for every ticker', async () => {
    queueAllTickersHappyPath();

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Body;
    for (const ticker of TICKERS) {
      const entry = body.perTicker[ticker];
      expect(entry).toBeDefined();
      expect(entry!.stored).toBe(true);
      expect(entry!.spot).toBe(7105);
      expect(entry!.zeroGamma).not.toBeNull();
    }
    // 3 tickers × 4 SQL calls = 12
    expect(mockSql).toHaveBeenCalledTimes(12);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
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

    // SPX has the no-flip chain; the rest have no snapshot.
    mockSql
      .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
      .mockResolvedValueOnce(noFlipChain)
      .mockResolvedValueOnce([{ id: 1 }]) // SPX INSERT
      .mockResolvedValueOnce([]); // SPX previous ladder
    for (let i = 0; i < TICKERS.length - 1; i += 1) {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Body;
    expect(body.perTicker.SPX!.stored).toBe(true);
    expect(body.perTicker.SPX!.zeroGamma).toBeNull();
    expect(body.perTicker.SPX!.confidence).toBe(0);
  });

  // ── Insert wiring: verify exact arguments reach SQL ──────

  it('passes ticker, spot, confidence, curve JSON and the ladder timestamp to the INSERT', async () => {
    queueAllTickersHappyPath();

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    // The INSERT for each ticker is the 3rd SQL call of that ticker's group
    // of 4. Indices: SPX=2, SPY=6, QQQ=10.
    type SqlCall = unknown[];
    const calls = mockSql.mock.calls as SqlCall[];
    const insertIndices = [2, 6, 10];
    insertIndices.forEach((idx, tickerIdx) => {
      const insertCall = calls[idx];
      expect(insertCall).toBeDefined();
      const values = insertCall!.slice(1) as unknown[];
      // Source order: ticker, spot, zeroGamma, confidence, netGamma,
      // curveJson, ts
      const [ticker, spot, , confidence, netGamma, curveJson, ts] = values;
      expect(ticker).toBe(TICKERS[tickerIdx]);
      expect(spot).toBe(7105);
      expect(typeof confidence).toBe('number');
      expect(typeof netGamma).toBe('number');
      expect(typeof curveJson).toBe('string');
      const parsed = JSON.parse(curveJson as string);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty('spot');
      expect(parsed[0]).toHaveProperty('netGamma');
      // R6: the row is keyed on its source ladder, so the same ladder
      // recomputed at 14:00 or 14:05 hits ON CONFLICT (ticker, ts) and
      // writes nothing. The label is the END of the ladder's bucket: not the
      // compute time (14:00, the column default), and not the bucket floor
      // (13:50, which is up to ~4 minutes before the data existed).
      expect(ts).toBe(LABEL_TS);
      expect(ts).not.toBe(MARKET_TIME.toISOString());
      expect(ts).not.toBe(LADDER_TS);
    });
  });

  it('labels a row with the bucket end even when that is ahead of the clock', async () => {
    // The cron runs at :04; the ladder observed at :02 is stamped :00, so its
    // label (:05) is a minute AHEAD of the clock. It is stored all the same.
    vi.setSystemTime(new Date('2026-03-24T13:59:00.000Z'));
    mockSql
      .mockResolvedValueOnce([{ latest_ts: '2026-03-24T13:55:00.000Z' }])
      .mockResolvedValueOnce(balancedChain())
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect((res._json as Body).perTicker.SPX).toMatchObject({ stored: true });
    const insert = (mockSql.mock.calls as unknown[][])[2]!;
    const label = insert.slice(1).at(-1);
    expect(label).toBe('2026-03-24T14:00:00.000Z');
    expect(Date.parse(label as string)).toBeGreaterThan(Date.now());
  });

  // ── The SQL text is the contract (R6) ────────────────────

  // The strings of a tagged-template call, joined with a placeholder.
  const sqlText = (call: unknown[]) => (call[0] as string[]).join('?');

  it('inserts with ON CONFLICT (ticker, ts) DO NOTHING ... RETURNING id', async () => {
    queueStored();
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    await handler(authedReq(), mockResponse());

    const insert = sqlText((mockSql.mock.calls as unknown[][])[2]!);
    expect(insert).toMatch(/INSERT INTO zero_gamma_levels/);
    // Without the conflict clause a repeat of one ladder would raise on the
    // unique index (or, before it, write a duplicate).
    expect(insert).toMatch(/ON CONFLICT \(ticker, ts\) DO NOTHING/);
    expect(insert).toMatch(/RETURNING id/);
    // ts is written explicitly; it is not left to the NOW() default.
    expect(insert).toMatch(/gamma_curve, ts\b/);
  });

  it('reads the previous ladder with a strict ts < (never <=, which would read the row just written)', async () => {
    queueStored([{ net_gamma_at_spot: '-250000000' }]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    await handler(authedReq(), mockResponse());

    const prev = sqlText((mockSql.mock.calls as unknown[][])[3]!);
    expect(prev).toMatch(/FROM zero_gamma_levels/);
    expect(prev).toMatch(/\bts < \?/);
    expect(prev).not.toMatch(/ts <= /);
    expect(prev).toMatch(/ORDER BY ts DESC/);
  });

  it('writes nothing, and says so, when the ladder was already stored (a recompute of the same source)', async () => {
    // fetch-strike-exposure stored no newer ladder, so latest_ts is the one
    // the previous run already used: the INSERT conflicts and returns no row.
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql
        .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
        .mockResolvedValueOnce(balancedChain())
        .mockResolvedValueOnce([]); // INSERT ... RETURNING id: conflict
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Body;
    for (const ticker of TICKERS) {
      expect(body.perTicker[ticker]).toMatchObject({
        stored: false,
        reason: 'ladder already stored',
      });
    }
    // No previous-ladder read and no sign-flip log for a ladder not stored.
    expect(mockSql).toHaveBeenCalledTimes(9);
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    // Every ticker skipped: not a success.
    expect(body.status).toBe('skipped');
  });

  // ── Sign flip compares against the previous ladder ───────

  it('reads the previous ladder strictly before this ladder and logs a sign flip', async () => {
    // balancedChain() is net long at spot (positive); the previous ladder was
    // net short (negative), so the regime flipped.
    queueStored([{ net_gamma_at_spot: '-250000000' }]);
    for (let i = 0; i < TICKERS.length - 1; i += 1) {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    }

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    // SPX's previous-ladder SELECT is its 4th call. It binds the ticker and
    // this ladder's label, so it never reads the row it just wrote.
    const prevCall = (mockSql.mock.calls as unknown[][])[3]!;
    const values = prevCall.slice(1) as unknown[];
    expect(values).toEqual(['SPX', LABEL_TS]);
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'dealer-regime' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'dealer_regime_sign_flip' }),
      'dealer-regime sign flip',
    );
  });

  it('logs no sign flip when the previous ladder has the same sign', async () => {
    queueStored([{ net_gamma_at_spot: '250000000' }]);
    for (let i = 0; i < TICKERS.length - 1; i += 1) {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    }

    await handler(authedReq(), mockResponse());

    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  // ── R-stale and the empty source: one rule, three kinds ──

  const MINUTE = 60_000;
  const agoIso = (ms: number) =>
    new Date(MARKET_TIME.getTime() - ms).toISOString();

  // Each way the source ladder is unusable, the latest_ts it produces, the
  // reason in the response, and the metric it counts.
  const SKIPS: Array<{
    kind: string;
    metric: string;
    latestTs: string | null;
  }> = [
    {
      kind: 'stale_source',
      metric: 'stale_source_skip',
      // 16 minutes old, same ET day.
      latestTs: agoIso(16 * MINUTE),
    },
    {
      kind: 'stale',
      metric: 'stale_cache_skip',
      // Friday's 15:55 ET ladder at Monday's... here, yesterday's close.
      latestTs: '2026-03-23T19:55:00.000Z',
    },
    { kind: 'empty', metric: 'empty_ladder_skip', latestTs: null },
  ];

  function queueSkippedTickers(latestTs: string | null) {
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql.mockResolvedValueOnce([{ latest_ts: latestTs }]);
    }
  }

  it.each(SKIPS)(
    '$kind: stores nothing, reads no rows, reports skipped (never success) and counts $metric',
    async ({ kind, metric, latestTs }) => {
      queueSkippedTickers(latestTs);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      const body = res._json as Body;
      expect(body.status).toBe('skipped');
      expect(body.skippedLegs).toBe(TICKERS.length);
      expect(body.failedLegs).toBe(0);
      for (const ticker of TICKERS) {
        expect(body.perTicker[ticker]).toMatchObject({
          stored: false,
          skip: kind,
        });
      }
      // One latest_ts SELECT per ticker: no rows read, nothing inserted.
      expect(mockSql).toHaveBeenCalledTimes(TICKERS.length);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kind, ticker: 'SPX' }),
        expect.stringContaining('skipping store'),
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        `compute_zero_gamma.${metric}`,
      );
      expect(metrics.increment).toHaveBeenCalledTimes(TICKERS.length);
    },
  );

  it.each(SKIPS)(
    '$kind: sends a Sentry error naming the kind and ticker from 09:40 ET',
    async ({ kind, latestTs }) => {
      vi.setSystemTime(AT_0940_ET);
      // Keep the ages relative to the new clock for the stale_source case.
      const ts =
        kind === 'stale_source'
          ? new Date(AT_0940_ET.getTime() - 16 * MINUTE).toISOString()
          : latestTs;
      queueSkippedTickers(ts);

      await handler(authedReq(), mockResponse());

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(TICKERS.length);
      const messages = vi
        .mocked(Sentry.captureMessage)
        .mock.calls.map(([m]) => m);
      for (const ticker of TICKERS) {
        expect(
          messages.some(
            (m) =>
              m.includes('compute-zero-gamma') &&
              m.includes(`${kind} ladder for ${ticker}`),
          ),
        ).toBe(true);
      }
      for (const [, level] of vi.mocked(Sentry.captureMessage).mock.calls) {
        expect(level).toBe('error');
      }
    },
  );

  it.each(SKIPS)(
    '$kind: stays quiet in Sentry before 09:40 ET, still warns and counts',
    async ({ kind, metric, latestTs }) => {
      vi.setSystemTime(BEFORE_0940_ET);
      const ts =
        kind === 'stale_source'
          ? new Date(BEFORE_0940_ET.getTime() - 16 * MINUTE).toISOString()
          : latestTs;
      queueSkippedTickers(ts);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect((res._json as Body).status).toBe('skipped');
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        `compute_zero_gamma.${metric}`,
      );
    },
  );

  it('computes from a source exactly 15 minutes old and skips one a second older', async () => {
    // 15:00 old: allowed. The threshold is "older than 15 minutes".
    mockSql
      .mockResolvedValueOnce([{ latest_ts: agoIso(15 * MINUTE) }])
      .mockResolvedValueOnce(balancedChain())
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);
    // SPY: 15:01 old, skipped. QQQ: no snapshot.
    mockSql
      .mockResolvedValueOnce([{ latest_ts: agoIso(15 * MINUTE + 1000) }])
      .mockResolvedValueOnce([{ latest_ts: null }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Body;
    expect(body.perTicker.SPX).toMatchObject({ stored: true });
    expect(body.perTicker.SPY).toMatchObject({
      stored: false,
      skip: 'stale_source',
    });
  });

  it('a skipped ticker does not stop the others, and the run is not "skipped"', async () => {
    // SPX stale; SPY and QQQ store.
    mockSql.mockResolvedValueOnce([{ latest_ts: agoIso(16 * MINUTE) }]);
    queueStored();
    queueStored();

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Body;
    expect(body.perTicker.SPX).toMatchObject({
      stored: false,
      skip: 'stale_source',
    });
    expect(body.perTicker.SPY).toMatchObject({ stored: true });
    expect(body.perTicker.QQQ).toMatchObject({ stored: true });
    expect(body.status).toBe('success');
    expect(body.skippedLegs).toBe(1);
  });

  it('skips as "all_zero" when the newest ladder has no gamma on any strike', async () => {
    const zeroChain = [
      makeStrikeRow(7095, 0, 0),
      makeStrikeRow(7100, 0, 0),
      makeStrikeRow(7105, 0, 0),
    ];
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql
        .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
        .mockResolvedValueOnce(zeroChain);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Body;
    expect(body.status).toBe('skipped');
    expect(body.perTicker.SPX).toMatchObject({
      stored: false,
      skip: 'all_zero',
    });
    expect(metrics.increment).toHaveBeenCalledWith(
      'compute_zero_gamma.zero_snapshot_skip',
    );
    // 2 SQL calls per ticker, no INSERT.
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('skips as "empty" when the rows SELECT returns nothing (the snapshot vanished between the two reads)', async () => {
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql
        .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
        .mockResolvedValueOnce([]);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Body;
    expect(body.status).toBe('skipped');
    expect(body.perTicker.SPX).toMatchObject({ stored: false, skip: 'empty' });
    expect(metrics.increment).toHaveBeenCalledWith(
      'compute_zero_gamma.empty_ladder_skip',
    );
    // 2 SQL calls per ticker, no INSERT.
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it.each(['0', '-7105', 'not-a-number'])(
    'skips as "empty" when the snapshot spot is not a positive number (%s)',
    async (price) => {
      for (let i = 0; i < TICKERS.length; i += 1) {
        mockSql
          .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
          .mockResolvedValueOnce(balancedChain().map((r) => ({ ...r, price })));
      }

      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as Body;
      expect(body.status).toBe('skipped');
      expect(body.perTicker.QQQ).toMatchObject({
        stored: false,
        skip: 'empty',
      });
      expect(mockSql).toHaveBeenCalledTimes(6);
    },
  );

  it('stores the row but counts the leg failed when the previous-ladder SELECT rejects; the next run says "already stored"', async () => {
    const dbError = new Error('previous-ladder select rejected');
    // Run 1: SPX inserts its row, then the previous-ladder read rejects.
    mockSql
      .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
      .mockResolvedValueOnce(balancedChain())
      .mockResolvedValueOnce([{ id: 1 }]) // INSERT stored the ladder
      .mockRejectedValueOnce(dbError);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const first = mockResponse();
    await handler(authedReq(), first);

    const firstBody = first._json as Body;
    expect(firstBody.perTicker.SPX).toMatchObject({ stored: false });
    expect(firstBody.perTicker.SPX!.error).toContain('previous-ladder');
    expect(firstBody.failedLegs).toBe(1);
    expect(firstBody.status).toBe('error');
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    // The INSERT ran: the row is in the table despite the failed leg.
    expect(sqlText((mockSql.mock.calls as unknown[][])[2]!)).toMatch(
      /INSERT INTO zero_gamma_levels/,
    );

    // Run 2: the same ladder; the INSERT conflicts, so it is "already stored".
    mockSql
      .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
      .mockResolvedValueOnce(balancedChain())
      .mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);

    const second = mockResponse();
    await handler(authedReq(), second);

    expect((second._json as Body).perTicker.SPX).toMatchObject({
      stored: false,
      reason: 'ladder already stored',
    });
    expect((second._json as Body).failedLegs).toBe(0);
  });

  // ── Per-ticker fault isolation ───────────────────────────

  it('isolates per-ticker DB failures — surviving tickers still complete', async () => {
    mockSql.mockRejectedValueOnce(new Error('SPX latest_ts query failed'));
    queueStored();
    queueStored();

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Body;
    expect(body.perTicker.SPX).toMatchObject({ stored: false });
    expect(body.perTicker.SPX!.error).toBeDefined();
    expect(body.perTicker.SPY).toMatchObject({ stored: true });
    expect(body.perTicker.QQQ).toMatchObject({ stored: true });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  // ── Aggregate status (AUD-M8) ────────────────────────────

  it('reports status "success" when every ticker stores a row', async () => {
    queueAllTickersHappyPath();

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as Body).status).toBe('success');
  });

  it('reports a non-success status when ALL tickers fail', async () => {
    // Every ticker's first SELECT (latest_ts) throws → all three legs fail.
    // The cron must NOT report 'success' when nothing landed.
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql.mockRejectedValueOnce(new Error(`leg ${i} latest_ts failed`));
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    // HTTP stays 200; the cron-level status carries the failure signal.
    expect(res._status).toBe(200);
    const body = res._json as Body;
    expect(body.status).not.toBe('success');
    expect(body.status).toBe('error');
    expect(body.failedLegs).toBe(TICKERS.length);
    expect(body.totalLegs).toBe(TICKERS.length);
    for (const ticker of TICKERS) {
      expect(body.perTicker[ticker]).toMatchObject({ stored: false });
      expect(body.perTicker[ticker]!.error).toBeDefined();
    }
  });

  it('reports status "partial" when some tickers fail and others store', async () => {
    mockSql.mockRejectedValueOnce(new Error('SPX latest_ts failed'));
    queueStored();
    queueStored();

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Body;
    expect(body.status).toBe('partial');
    expect(body.failedLegs).toBe(1);
    expect(body.totalLegs).toBe(TICKERS.length);
  });

  it('is an error, not a success, when the INSERT is rejected (R4)', async () => {
    const dbError = new Error('insert rejected');
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql
        .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
        .mockResolvedValueOnce(balancedChain())
        .mockRejectedValueOnce(dbError);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Body;
    expect(body.status).toBe('error');
    expect(body.failedLegs).toBe(TICKERS.length);
    expect(Sentry.captureException).toHaveBeenCalledTimes(TICKERS.length);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  it('is an error when the rows SELECT is rejected', async () => {
    const dbError = new Error('rows select rejected');
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql
        .mockResolvedValueOnce([{ latest_ts: LADDER_TS }])
        .mockRejectedValueOnce(dbError);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    expect((res._json as Body).status).toBe('error');
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  it('reports "skipped", not "success", when every ticker has no snapshot (quiet window)', async () => {
    // No snapshots anywhere → nothing computed. Not a failure, but not a
    // success either: every ticker was skipped.
    for (let i = 0; i < TICKERS.length; i += 1) {
      mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    }

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Body;
    expect(body.status).toBe('skipped');
    expect(body.failedLegs).toBe(0);
    expect(body.totalLegs).toBe(0);
    for (const ticker of TICKERS) {
      expect(body.perTicker[ticker]).toMatchObject({
        stored: false,
        reason: 'No strike_exposures snapshot',
      });
    }
    // 3 SELECTs total, no INSERTs.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });
});
