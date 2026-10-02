// @vitest-environment node

/**
 * Tests for the Flow Regime Recognition capture cron.
 *
 * The cron reads the current 30-min ws_option_trades bucket, computes
 * the two ratio metrics via the (real) Phase 1 lib, scores them against
 * the committed baseline, and UPSERTs one (date, slot) snapshot. The
 * lib is NOT mocked — we want the real metric/percentile/regime math to
 * exercise the integration. Assertions focus on:
 *   - CRON_SECRET auth guard (401 without the Bearer header).
 *   - Happy path: exactly one UPSERT with a sensible regime, and the
 *     NUMERIC-as-string + nullable delta/underlying_price coercion.
 *   - Outside-RTH no-op (status 'skipped', no DB write).
 *   - Previous-slot persistence: the closed slot is aggregated over its full
 *     window and upserted once settled, never re-written once persisted, and
 *     a failed finalize writes nothing and reports 'partial' + Sentry.
 *
 * Phase 2 of docs/superpowers/specs/flow-regime-badge-2026-06-06.md
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// The cron now reduces the window IN SQL: the aggregation runs via
// `sql.query(stmt, params)` (returning one scalar-sums row), while the baseline
// loader + the UPSERT use the tagged-template `sql\`...\``. The mock therefore
// needs BOTH surfaces.
const mockQuery: ReturnType<
  typeof vi.fn<(stmt: string, params: unknown[]) => Promise<unknown[]>>
> = vi.fn(() => Promise.resolve([]));
const mockSql = Object.assign(vi.fn(), { query: mockQuery });
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
    flush: vi.fn(() => Promise.resolve(true)),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

// The real withCronInstrumentation calls cronGuard from api-helpers.
// Mock just that so we control the auth/time gate; everything else in
// cron-instrumentation runs for real (Sentry check-in is a no-op when
// SENTRY_DSN is unset).
const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/capture-flow-regime.js';
import {
  FLOW_REGIME_BASELINE,
  computeFlowMetrics,
  type FlowMetricSums,
} from '../_lib/flow-regime.js';
import {
  __resetFlowRegimeBaselineCache,
  MIN_DAY_SLOT_TRADES,
} from '../_lib/flow-regime-baseline-live.js';
import { Sentry } from '../_lib/sentry.js';
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-06-05';

/**
 * Shape one aggregation result row (as `sql.query` returns it from the in-SQL
 * reduction) from component sums + an n_trades count. The cron's
 * `aggregateFlowWindow` selects exactly these columns; NUMERIC come back as
 * strings from Neon, so we stringify the sums to mirror that.
 */
function aggRow(sums: FlowMetricSums, nTrades: number) {
  return {
    n_trades: nTrades,
    nd_num: String(sums.ndNum),
    nd_den: String(sums.ndDen),
    total_premium: String(sums.totalPremium),
    idx_put_premium: String(sums.idxPutPremium),
  };
}

/** A loader aggregation row marking `slot` live (≥ min_days, full breakpoints). */
function liveLoaderRow(slot: number) {
  const n = FLOW_REGIME_BASELINE.percentiles.length;
  const breaks = Array.from({ length: n }, (_, i) => -0.2 + i * 0.02);
  return {
    slot,
    n_days_nd: FLOW_REGIME_BASELINE.min_days_per_slot,
    n_days_idx: FLOW_REGIME_BASELINE.min_days_per_slot,
    nd_breakpoints: breaks,
    idx_breakpoints: breaks.map((b) => b + 0.5),
  };
}

beforeEach(() => {
  // The on-read baseline loader caches per ET date at module scope; reset so
  // each test's loader SELECT result is recomputed, not served from cache.
  __resetFlowRegimeBaselineCache();
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([]);
  mockCronGuard.mockReset();
  // cronGuard returns truthy ctx on pass; the cron uses real `new Date()`
  // for date/slot derivation, so `today` here is not load-bearing.
  mockCronGuard.mockReturnValue({ apiKey: '', today: DATE });
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('capture-flow-regime cron', () => {
  it('returns the cronGuard failure response without writing when unauthenticated', async () => {
    // cronGuard returns null (auth/time gate failed); the wrapper sends
    // its own response and never invokes the handler body.
    mockCronGuard.mockReturnValue(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('no-ops with status "skipped" outside RTH (no DB write)', async () => {
    // 11:00 UTC = 06:00 ET — before the 09:30 ET open → slot is null.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T11:00:00.000Z'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('UPSERTs exactly one snapshot with a sensible regime on the happy path', async () => {
    // 14:00 UTC = 10:00 ET → slot 1 ((600-570)/30). The window is reduced IN
    // SQL: ONE sql.query aggregation (scalar sums row), then the baseline-loader
    // SELECT (empty table → all-fallback) + the UPSERT via the tagged template.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    // Bearish-leaning tape: index 0DTE puts hit on the ask. We derive the
    // SQL-aggregation row from this fixture via the real reducer so the regime
    // math the test exercises is identical to production. ≥ MIN_BUCKET_TRADES
    // (50) trades so the low-confidence gate does NOT fire.
    const bearishTape = Array.from({ length: 60 }, (_, i) =>
      i % 6 === 0
        ? {
            ticker: 'AAPL',
            optionType: 'C',
            expiry: DATE,
            tradeDateEt: DATE,
            side: 'ask',
            delta: 0.3,
            size: 100,
            price: 1.0,
          }
        : {
            ticker: i % 2 === 0 ? 'SPY' : 'QQQ',
            optionType: 'P',
            expiry: DATE,
            tradeDateEt: DATE,
            side: 'ask',
            delta: -0.5,
            size: 400,
            price: 2.5,
          },
    );
    const sums = computeFlowMetrics(bearishTape);
    // sql.query aggregation returns one scalar-sums row.
    mockQuery.mockResolvedValueOnce([aggRow(sums, 60)]);
    // The baseline-loader SELECT over flow_regime_slot_daily (empty table).
    mockSql.mockResolvedValueOnce([]);
    // The UPSERT.
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // ONE aggregation (sql.query) + loader SELECT + UPSERT (tagged template) =
    // 1 query call + 2 sql calls.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    // UPSERT param order matches the INSERT VALUES clause:
    //   [date, slot, nd_tilt, idx0dte_put_share,
    //    nd_percentile, idxput_percentile, regime, color, n_trades,
    //    baseline_version]. The UPSERT is the 2nd tagged-template call (loader
    //    SELECT is the 1st).
    const params = (mockSql.mock.calls[1] ?? []).slice(1);
    expect(params[0]).toBe(DATE); // date
    expect(params[1]).toBe(1); // slot
    // nd_tilt is a finite ratio in [-1, 1].
    expect(typeof params[2]).toBe('number');
    expect(params[2]).toBeGreaterThanOrEqual(-1);
    expect(params[2]).toBeLessThanOrEqual(1);
    // idx0dte_put_share is a finite share in [0, 1].
    expect(typeof params[3]).toBe('number');
    expect(params[3]).toBeGreaterThanOrEqual(0);
    expect(params[3]).toBeLessThanOrEqual(1);
    // regime + color are recognition labels.
    expect(['normal', 'caution', 'bearish', 'bullish']).toContain(params[6]);
    expect(['green', 'amber', 'red', 'gray']).toContain(params[7]);
    // n_trades = the aggregation's count(*) (above the low-confidence floor).
    expect(params[8]).toBe(60);
    // baseline_version: the loader table is empty → this slot fell back to the
    // committed JSON → version 1.
    expect(params[9]).toBe(1);
  });

  it('passes the universe/index arrays and window bounds to the aggregation', async () => {
    // 14:00 UTC = 10:00 ET → slot 1. Assert the SQL aggregation is parameterized
    // with the baseline universe/index arrays (the consistency-rule filter) and
    // the slot-start..now window + the ET trade date for the 0DTE put test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    mockQuery.mockResolvedValueOnce([aggRow(computeFlowMetrics([]), 0)]);
    mockSql.mockResolvedValueOnce([]); // loader
    mockSql.mockResolvedValueOnce([]); // upsert

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const [stmt, qParams] = mockQuery.mock.calls[0] ?? [];
    expect(String(stmt)).toContain('FROM ws_option_trades');
    expect(String(stmt)).toContain('canceled = FALSE');
    // [universe, index_set, startIso, endIso, tradeDateEt].
    expect(qParams?.[0]).toEqual(FLOW_REGIME_BASELINE.universe);
    expect(qParams?.[1]).toEqual(FLOW_REGIME_BASELINE.index_set);
    // slot 1 starts at 10:00 ET = 14:00 UTC; now = 14:00 UTC.
    expect(qParams?.[2]).toBe('2026-06-05T14:00:00.000Z');
    expect(qParams?.[3]).toBe('2026-06-05T14:00:00.000Z');
    expect(qParams?.[4]).toBe(DATE); // ET trade date for the 0DTE put test
  });

  it('suppresses a thin bucket to normal/gray despite an extreme tilt', async () => {
    // 14:00 UTC = 10:00 ET → slot 1. The aggregation reports only 2 trades with
    // a strongly negative tilt (raw ndTilt ≈ −1, would classify bearish/red).
    // Below MIN_BUCKET_TRADES (50) the cron must force normal/gray so the badge
    // never flashes a false signal on near-zero data.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    const thinTape = [
      {
        ticker: 'SPY',
        optionType: 'P',
        expiry: DATE,
        tradeDateEt: DATE,
        side: 'ask',
        delta: -0.5,
        size: 1000,
        price: 5.0,
      },
      {
        ticker: 'QQQ',
        optionType: 'P',
        expiry: DATE,
        tradeDateEt: DATE,
        side: 'ask',
        delta: -0.55,
        size: 800,
        price: 4.0,
      },
    ];
    mockQuery.mockResolvedValueOnce([aggRow(computeFlowMetrics(thinTape), 2)]);
    // loader SELECT (empty) + UPSERT.
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
    const params = (mockSql.mock.calls[1] ?? []).slice(1);
    // Raw nd_tilt is still persisted (strongly negative) for transparency...
    expect(params[2] as number).toBeLessThan(-0.5);
    // ...but the evaluator suppresses the read: percentiles are NULL and the
    // regime/color are forced to low-confidence normal/gray. Null percentiles
    // are what keep the frontend detail copy consistent with the gray pill.
    expect(params[4]).toBeNull(); // nd_percentile
    expect(params[5]).toBeNull(); // idxput_percentile
    expect(params[6]).toBe('normal'); // regime
    expect(params[7]).toBe('gray'); // color
    expect(params[8]).toBe(2); // n_trades < floor
    expect(res._json).toMatchObject({ status: 'success' });
  });

  it('handles an empty window (all sums COALESCE to 0, n_trades 0)', async () => {
    // 14:00 UTC = 10:00 ET → slot 1. An empty window: the SQL COALESCE makes
    // every sum 0 and count(*) is 0. The cron must not crash and must persist a
    // suppressed (thin-bucket) snapshot with nd_tilt 0.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    mockQuery.mockResolvedValueOnce([
      {
        n_trades: 0,
        nd_num: '0',
        nd_den: '0',
        total_premium: '0',
        idx_put_premium: '0',
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // loader
    mockSql.mockResolvedValueOnce([]); // upsert

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const params = (mockSql.mock.calls[1] ?? []).slice(1);
    expect(params[2]).toBe(0); // nd_tilt = 0 (ratio of 0/0 → 0)
    expect(params[3]).toBe(0); // idx0dte_put_share = 0
    expect(params[8]).toBe(0); // n_trades
    expect(params[6]).toBe('normal'); // suppressed (thin bucket)
  });

  it('coerces null-derived zero sums without crashing the metric math', async () => {
    // The SQL aggregation skips NULL delta/price (SUM ignores NULLs), so a
    // window of only-null rows yields zero sums. The cron must handle the
    // zero-sums row without throwing.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    mockQuery.mockResolvedValueOnce([
      {
        n_trades: 1,
        nd_num: '0',
        nd_den: '0',
        total_premium: '0',
        idx_put_premium: '0',
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // loader
    mockSql.mockResolvedValueOnce([]); // upsert

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const params = (mockSql.mock.calls[1] ?? []).slice(1);
    // nd_tilt should be a finite number (0 when the only delta is null).
    expect(Number.isFinite(params[2] as number)).toBe(true);
    expect(params[8]).toBe(1); // n_trades
  });

  it('stamps baseline_version 2 when the loader supplies live breakpoints for the slot', async () => {
    // 14:00 UTC = 10:00 ET → active slot 1. The loader returns slot 1 as live
    // (≥15 days), so the active slot was scored against DB-computed breakpoints
    // → version 2.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    const tape = Array.from({ length: 60 }, () => ({
      ticker: 'AAPL',
      optionType: 'C',
      expiry: DATE,
      tradeDateEt: DATE,
      side: 'ask',
      delta: 0.5,
      size: 100,
      price: 1.25,
    }));
    mockQuery.mockResolvedValueOnce([aggRow(computeFlowMetrics(tape), 60)]); // aggregation
    mockSql.mockResolvedValueOnce([liveLoaderRow(1)]); // loader (slot 1 live)
    mockSql.mockResolvedValueOnce([]); // UPSERT

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
    const params = (mockSql.mock.calls[1] ?? []).slice(1);
    expect(params[1]).toBe(1); // slot
    expect(params[9]).toBe(2); // baseline_version → live (DB-computed)
  });

  it('stamps baseline_version 1 when the loader marks a DIFFERENT slot live', async () => {
    // Active slot is 1, but only slot 5 is live in the loader result → the
    // active slot fell back to the committed JSON → version 1.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    const tape = Array.from({ length: 60 }, () => ({
      ticker: 'AAPL',
      optionType: 'C',
      expiry: DATE,
      tradeDateEt: DATE,
      side: 'ask',
      delta: 0.5,
      size: 100,
      price: 1.25,
    }));
    mockQuery.mockResolvedValueOnce([aggRow(computeFlowMetrics(tape), 60)]); // aggregation
    mockSql.mockResolvedValueOnce([liveLoaderRow(5)]); // loader (slot 5 live, not 1)
    mockSql.mockResolvedValueOnce([]); // UPSERT

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const params = (mockSql.mock.calls[1] ?? []).slice(1);
    expect(params[1]).toBe(1); // slot
    expect(params[9]).toBe(1); // baseline_version → fallback (committed JSON)
  });
});

describe('capture-flow-regime previous-slot persistence', () => {
  // Vercel fires the 5-min crons ~45–50 s after the minute. 14:05:50 UTC =
  // 10:05:50 ET is the SECOND tick of slot 1: slot 0 = [09:30, 10:00) ET closed
  // 5:50 ago, past the 5-min settle margin. 14:00:50 is the first tick.
  const FIRST_TICK = '2026-06-05T14:00:50.000Z';
  const SETTLED_TICK = '2026-06-05T14:05:50.000Z';
  const SLOT0_START = '2026-06-05T13:30:00.000Z';
  const SLOT0_END = '2026-06-05T14:00:00.000Z';
  const QUORUM = MIN_DAY_SLOT_TRADES;

  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
  });

  /** The tagged-template SQL text of mockSql call `i`. */
  function sqlText(i: number): string {
    const strings = mockSql.mock.calls[i]?.[0] as
      | TemplateStringsArray
      | undefined;
    return strings ? strings.join('?') : '';
  }

  function insertCalls(): unknown[][] {
    return mockSql.mock.calls
      .map((c, i) => ({ c, text: sqlText(i) }))
      .filter(({ text }) => /INSERT INTO flow_regime_slot_daily/.test(text))
      .map(({ c }) => c.slice(1));
  }

  /** Live-window aggregation (this tick) — enough trades for a real read. */
  function liveAgg() {
    mockQuery.mockResolvedValueOnce([aggRow(computeFlowMetrics([]), 60)]);
  }

  /** Loader SELECT + this tick's snapshot UPSERT. */
  function snapshotCalls() {
    mockSql.mockResolvedValueOnce([]); // loader
    mockSql.mockResolvedValueOnce([]); // snapshot UPSERT
  }

  async function runAt(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    return res;
  }

  it('finalizes the previous slot over its full [start, end) window on the first tick past the settle margin', async () => {
    liveAgg();
    const prevSums = {
      ndNum: -40,
      ndDen: 120,
      idxPutPremium: 25_000,
      totalPremium: 80_000,
    };
    mockQuery.mockResolvedValueOnce([aggRow(prevSums, QUORUM + 7)]);
    snapshotCalls();
    mockSql.mockResolvedValueOnce([]); // persisted slots for today: none
    mockSql.mockResolvedValueOnce([]); // INSERT slot 0

    const res = await runAt(SETTLED_TICK);

    // Second aggregation = slot 0's FULL window, not the live partial one.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1]![1]!.slice(2)).toEqual([
      SLOT0_START,
      SLOT0_END,
      DATE,
    ]);
    expect(sqlText(2)).toMatch(/SELECT slot FROM flow_regime_slot_daily/);
    expect(mockSql.mock.calls[2]!.slice(1)).toEqual([DATE]);
    // Upserted on the (date, slot) key with the full-window sums.
    expect(sqlText(3)).toContain('ON CONFLICT (date, slot) DO UPDATE');
    expect(insertCalls()).toEqual([
      [DATE, 0, -40, 120, 25_000, 80_000, QUORUM + 7],
    ]);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      finalize: { slot: 0, outcome: 'written', nTrades: QUORUM + 7 },
    });
  });

  it('waits out the settle margin: the first tick of the next slot does not finalize yet', async () => {
    liveAgg();
    snapshotCalls();

    const res = await runAt(FIRST_TICK);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({
      status: 'success',
      finalize: { slot: 0, outcome: 'unsettled' },
    });
  });

  it('is idempotent across ticks: an already-persisted previous slot is not re-aggregated or re-written', async () => {
    liveAgg();
    snapshotCalls();
    mockSql.mockResolvedValueOnce([{ slot: 0 }]); // already persisted

    const res = await runAt('2026-06-05T14:10:50.000Z');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(insertCalls()).toEqual([]);
    expect(res._json).toMatchObject({
      status: 'success',
      finalize: { slot: 0, outcome: 'already-persisted' },
    });
  });

  it('does not persist a previous slot below the per-day quorum', async () => {
    liveAgg();
    mockQuery.mockResolvedValueOnce([aggRow(computeFlowMetrics([]), 12)]);
    snapshotCalls();
    mockSql.mockResolvedValueOnce([]); // none persisted

    const res = await runAt(SETTLED_TICK);

    expect(insertCalls()).toEqual([]);
    expect(res._json).toMatchObject({
      status: 'success',
      finalize: { slot: 0, outcome: 'thin', nTrades: 12 },
    });
  });

  it('has nothing to finalize on slot 0, the first slot of the day', async () => {
    liveAgg();
    snapshotCalls();

    // 13:35:50 UTC = 09:35:50 ET → slot 0.
    const res = await runAt('2026-06-05T13:35:50.000Z');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({
      finalize: { slot: null, outcome: 'none' },
    });
  });

  it('R4: a failed previous-slot aggregation writes nothing and reports partial + Sentry, not success', async () => {
    liveAgg();
    mockQuery.mockRejectedValueOnce(new Error('canceling statement'));
    snapshotCalls();
    mockSql.mockResolvedValueOnce([]); // none persisted

    const res = await runAt(SETTLED_TICK);

    expect(insertCalls()).toEqual([]);
    // This tick's own snapshot still landed.
    expect(sqlText(1)).toContain('INSERT INTO flow_regime_snapshots');
    expect(res._json).toMatchObject({
      status: 'partial',
      finalize: { slot: 0, outcome: 'failed', error: 'canceling statement' },
    });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(vi.mocked(Sentry.captureException).mock.calls[0]![1]).toMatchObject({
      tags: { 'flow_regime.step': 'slot-finalize' },
      extra: { date: DATE, slot: 0 },
    });
  });

  it('R4: a rejected previous-slot upsert reports partial + Sentry, not success', async () => {
    liveAgg();
    mockQuery.mockResolvedValueOnce([aggRow(computeFlowMetrics([]), QUORUM)]);
    snapshotCalls();
    mockSql.mockResolvedValueOnce([]); // none persisted
    mockSql.mockRejectedValueOnce(new Error('could not extend file'));

    const res = await runAt(SETTLED_TICK);

    expect(res._json).toMatchObject({
      status: 'partial',
      finalize: { slot: 0, outcome: 'failed' },
    });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('R4: a rejected persisted-slot read reports partial + Sentry and never aggregates or writes', async () => {
    liveAgg();
    snapshotCalls();
    mockSql.mockRejectedValueOnce(new Error('connection refused'));

    const res = await runAt(SETTLED_TICK);

    expect(mockQuery).toHaveBeenCalledTimes(1); // only the live window
    expect(insertCalls()).toEqual([]);
    expect(res._json).toMatchObject({
      status: 'partial',
      finalize: { slot: 0, outcome: 'failed', error: 'connection refused' },
    });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });
});
