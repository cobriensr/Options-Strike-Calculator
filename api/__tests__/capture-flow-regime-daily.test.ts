// @vitest-environment node

/**
 * Tests for the self-maintaining flow-regime baseline daily accumulator cron.
 *
 * The cron reads each ET trading date's RTH window in per-slot CHUNKS (one
 * [slotStart, slotEnd) window per 30-min slot, sequentially), merges the
 * per-slot component sums across chunks, applies the per-day volume quorum to
 * the MERGED totals, and UPSERTs one row per populated slot into
 * flow_regime_slot_daily. The in-SQL builder is NOT mocked below the
 * `sql.query` boundary — we feed the builder's raw result rows and let the real
 * coercion / merge / quorum code run. Assertions focus on:
 *   - CRON_SECRET auth guard (no DB writes when cronGuard fails).
 *   - Chunking: one builder call per slot window per date, sequential, on the
 *     absolute 09:30-ET slot grid.
 *   - Merge: the same slot reported by two chunks is summed (never written
 *     twice) and the quorum applies to the merged totals.
 *   - Happy path: a multi-slot day aggregates correctly and upserts one row per
 *     populated slot, with the per-slot sums + n_trades matching.
 *   - Failure: a chunk whose query hangs exhausts the REAL withDbRetry and the
 *     run reports `status: 'error'` without writing that date; a later date
 *     failing never loses an earlier fully-accumulated date; the wall-clock
 *     budget stops the run with partial diagnostics instead of a hard timeout.
 *
 * Resolves code-review finding #6 — see
 * docs/superpowers/specs/flow-regime-baseline-refresh-2026-06-07.md — and
 * Phase B of docs/superpowers/specs/no-errors-sweep-2026-08-19.md (the
 * 2026-08-18 full-day GROUP BY 33s `db attempt timeout`).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Both the per-chunk per-slot aggregation (`aggregateFlowWindowBySlot`) and
// `bulkUpsert({ sql, ... })` surface through `sql.query(stmt, params)`. We
// route the mock by statement content: the aggregation contains
// `GROUP BY slot`, the INSERT contains `INSERT INTO flow_regime_slot_daily`.
//
// Aggregation results are keyed by the chunk's START ISO (params[2] of the
// builder statement) so a test can populate exactly the slot windows it wants;
// every other window resolves to an empty result. `hangingWindows` never
// resolve (exercises the real withDbRetry per-attempt timeout), and
// `rejectingWindows` reject with the supplied error.
let aggByWindow = new Map<string, Record<string, unknown>[]>();
let hangingWindows = new Set<string>();
let rejectingWindows = new Map<string, Error>();
let inFlight = 0;
let maxInFlight = 0;

function routeQuery(stmt: string, params: unknown[]): Promise<unknown> {
  if (/GROUP BY slot/i.test(stmt)) {
    const startIso = String(params[2]);
    if (hangingWindows.has(startIso)) return new Promise(() => {});
    const rejectWith = rejectingWindows.get(startIso);
    if (rejectWith) return Promise.reject(rejectWith);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Resolve on a later macrotask-free tick so a concurrent caller would be
    // observable as inFlight > 1 (the handler must await each chunk).
    return Promise.resolve().then(() => {
      inFlight -= 1;
      return aggByWindow.get(startIso) ?? [];
    });
  }
  // bulkUpsert INSERT — return value is ignored by the helper.
  return Promise.resolve({ rows: [] });
}

const mockQuery: ReturnType<
  typeof vi.fn<(stmt: string, params: unknown[]) => Promise<unknown>>
> = vi.fn(routeQuery);
const mockSql = Object.assign(vi.fn(), { query: mockQuery });

// Keep the REAL withDbRetry (per-attempt timeout + backoff + TransientDbError
// exhaustion) so the "a chunk hangs → retries exhausted → error" contract is
// exercised against the production retry loop, not a stub.
vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: actual.withDbRetry,
    TransientDbError: actual.TransientDbError,
    isRetryableDbError: actual.isRetryableDbError,
  };
});

const mockCaptureException = vi.hoisted(() => vi.fn());
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: mockCaptureException,
    captureMessage: vi.fn(),
    setTag: vi.fn(),
    flush: vi.fn(() => Promise.resolve(true)),
  },
  metrics: { increment: vi.fn(), distribution: vi.fn(), gauge: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler, {
  DAILY_WALL_BUDGET_MS,
  buildDayChunkWindows,
  mergeSlotRows,
} from '../cron/capture-flow-regime-daily.js';
import {
  FLOW_REGIME_BASELINE,
  computeFlowMetrics,
  type FlowMetricSums,
  type FlowTradeRow,
} from '../_lib/flow-regime.js';
import { MIN_DAY_SLOT_TRADES } from '../_lib/flow-regime-baseline-live.js';
import type { FlowAggSlotRow } from '../_lib/flow-regime-rows.js';
import { TransientDbError } from '../_lib/db.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-06-05';
const PRIOR_DATE = '2026-06-04';
const SLOT_COUNT = FLOW_REGIME_BASELINE.slot_count; // 13
const QUORUM = MIN_DAY_SLOT_TRADES; // 500

/** UTC ISO start of `slot` on `date` (slot === SLOT_COUNT → the RTH end). */
function slotStartIso(date: string, slot: number): string {
  const iso = etWallClockToUtcIso(
    date,
    FLOW_REGIME_BASELINE.rth_start_minute +
      slot * FLOW_REGIME_BASELINE.bucket_minutes,
  );
  if (iso === null) throw new Error(`bad date ${date}`);
  return iso;
}

/** Every GROUP BY (aggregation) call's [startIso, endIso] window, in order. */
function aggWindows(): [string, string][] {
  return mockQuery.mock.calls
    .filter(([stmt]) => /GROUP BY slot/i.test(String(stmt)))
    .map(([, params]) => {
      const p = params as unknown[];
      return [String(p[2]), String(p[3])];
    });
}

function insertCalls() {
  return mockQuery.mock.calls.filter(([stmt]) =>
    /INSERT INTO/i.test(String(stmt)),
  );
}

beforeEach(() => {
  aggByWindow = new Map();
  hangingWindows = new Set();
  rejectingWindows = new Map();
  inFlight = 0;
  maxInFlight = 0;
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockQuery.mockReset();
  mockQuery.mockImplementation(routeQuery);
  mockCaptureException.mockReset();
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: DATE });
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Shape one per-slot aggregation row (as `aggregateFlowWindowBySlot`'s
 * `sql.query` returns it) from a slot index, component sums, and an n_trades
 * count. NUMERIC come back as strings from Neon, so we stringify the sums.
 */
function aggSlotRow(slot: number, sums: FlowMetricSums, nTrades: number) {
  return {
    slot,
    n_trades: nTrades,
    nd_num: String(sums.ndNum),
    nd_den: String(sums.ndDen),
    total_premium: String(sums.totalPremium),
    idx_put_premium: String(sums.idxPutPremium),
  };
}

/** A FlowTradeRow fixture (already coerced — the SQL does the coercion now). */
function flowRow(overrides: Partial<FlowTradeRow> = {}): FlowTradeRow {
  return {
    ticker: 'SPY',
    optionType: 'C',
    expiry: DATE,
    tradeDateEt: DATE,
    side: 'ask',
    delta: 0.5,
    size: 100,
    price: 1.25,
    ...overrides,
  };
}

/** Build n identical FlowTradeRows and reduce them to sums via the real lib. */
function sumsFor(
  rowOverrides: Partial<FlowTradeRow>,
  n: number,
): FlowMetricSums {
  const rows = Array.from({ length: n }, () => flowRow(rowOverrides));
  return computeFlowMetrics(rows);
}

/** The bulkUpsert INSERT call's flat params array (the non-aggregation query). */
function insertParams(): unknown[] {
  const call = insertCalls()[0];
  if (!call) throw new Error('no INSERT call recorded');
  return call[1] as unknown[];
}

/** Post-close on the trade day so getETDateStr(now) === DATE. 21:55Z = 17:55 EDT. */
function freezePostClose(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));
}

describe('buildDayChunkWindows', () => {
  it('splits an EDT date into one [start, end) window per 30-min RTH slot on the 09:30 ET grid', () => {
    const windows = buildDayChunkWindows(DATE);
    expect(windows).toHaveLength(SLOT_COUNT);
    // 09:30 EDT = 13:30Z … 16:00 EDT = 20:00Z.
    expect(windows[0]).toEqual({
      startIso: '2026-06-05T13:30:00.000Z',
      endIso: '2026-06-05T14:00:00.000Z',
    });
    expect(windows.at(-1)).toEqual({
      startIso: '2026-06-05T19:30:00.000Z',
      endIso: '2026-06-05T20:00:00.000Z',
    });
    // Contiguous, slot-aligned: each chunk ends where the next starts.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.startIso).toBe(windows[i - 1]!.endIso);
      expect(windows[i]!.startIso).toBe(slotStartIso(DATE, i));
    }
  });

  it('is DST-safe (EST date shifts the whole grid by an hour)', () => {
    const windows = buildDayChunkWindows('2026-01-15');
    expect(windows).toHaveLength(SLOT_COUNT);
    expect(windows[0]!.startIso).toBe('2026-01-15T14:30:00.000Z');
    expect(windows.at(-1)!.endIso).toBe('2026-01-15T21:00:00.000Z');
  });

  it('returns no windows for a malformed date', () => {
    expect(buildDayChunkWindows('not-a-date')).toEqual([]);
  });
});

describe('mergeSlotRows', () => {
  it('sums the five component fields per slot across chunks and keeps distinct slots apart', () => {
    const acc = new Map<number, FlowAggSlotRow>();
    mergeSlotRows(acc, [
      {
        slot: 1,
        nTrades: 10,
        ndNum: 1,
        ndDen: 2,
        idxPutPremium: 3,
        totalPremium: 4,
      },
      {
        slot: 2,
        nTrades: 5,
        ndNum: 5,
        ndDen: 6,
        idxPutPremium: 7,
        totalPremium: 8,
      },
    ]);
    mergeSlotRows(acc, [
      {
        slot: 1,
        nTrades: 20,
        ndNum: 10,
        ndDen: 20,
        idxPutPremium: 30,
        totalPremium: 40,
      },
    ]);
    expect(acc.get(1)).toEqual({
      slot: 1,
      nTrades: 30,
      ndNum: 11,
      ndDen: 22,
      idxPutPremium: 33,
      totalPremium: 44,
    });
    expect(acc.get(2)).toEqual({
      slot: 2,
      nTrades: 5,
      ndNum: 5,
      ndDen: 6,
      idxPutPremium: 7,
      totalPremium: 8,
    });
    expect(acc.size).toBe(2);
  });
});

describe('capture-flow-regime-daily cron', () => {
  it('does not write when cronGuard rejects the request', async () => {
    mockCronGuard.mockReturnValue(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('queries each RTH slot window as its own chunk, sequentially, today first then the lookback date', async () => {
    freezePostClose();

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const windows = aggWindows();
    // 13 slot chunks per date × 2 dates (today + the 1-day lookback).
    expect(windows).toHaveLength(SLOT_COUNT * 2);
    for (let i = 0; i < SLOT_COUNT; i++) {
      // Today's chunk i = [slot i start, slot i+1 start) on the absolute
      // 09:30-ET grid (the last chunk ends at the 16:00 ET RTH end).
      expect(windows[i]).toEqual([
        slotStartIso(DATE, i),
        slotStartIso(DATE, i + 1),
      ]);
      expect(windows[SLOT_COUNT + i]).toEqual([
        slotStartIso(PRIOR_DATE, i),
        slotStartIso(PRIOR_DATE, i + 1),
      ]);
    }
    // Every chunk was awaited before the next was issued.
    expect(maxInFlight).toBe(1);
    // Nothing populated → no INSERT.
    expect(insertCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('aggregates a multi-slot day and batches one INSERT for all populated slots (a slot that fits in one chunk is written unchanged)', async () => {
    freezePostClose();

    // Two slots, each ABOVE the per-day quorum: slot 1 and slot 3, each
    // reported by its own chunk (the production case — chunks are
    // slot-aligned). Build expected sums via the real lib so the assertions
    // match production algebra.
    const expSlot1 = sumsFor({ side: 'ask' }, QUORUM);
    const expSlot3 = sumsFor(
      { ticker: 'AAPL', side: 'ask', delta: 0.6, price: 3.0, size: 200 },
      QUORUM,
    );
    aggByWindow.set(slotStartIso(DATE, 1), [aggSlotRow(1, expSlot1, QUORUM)]);
    aggByWindow.set(slotStartIso(DATE, 3), [aggSlotRow(3, expSlot3, QUORUM)]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // 26 chunk aggregations, then ONE batched INSERT via sql.query → 27
    // sql.query calls total, 0 tagged-template calls.
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(SLOT_COUNT * 2 + 1);
    expect(insertCalls()).toHaveLength(1);
    expect(res._json).toMatchObject({ status: 'success', rows: 2 });

    // bulkUpsert flattens rows into a single params array, 8 cols per row:
    // [date, slot, nd_num, nd_den, idx_put_premium, total_premium, n_trades,
    //  computed_at]. Two rows → 16 params.
    const params = insertParams();
    expect(params).toHaveLength(16);
    // Row 0 = slot 1.
    expect(params[0]).toBe(DATE);
    expect(params[1]).toBe(1);
    expect(params[2]).toBeCloseTo(expSlot1.ndNum, 3);
    expect(params[3]).toBeCloseTo(expSlot1.ndDen, 3);
    expect(params[4]).toBeCloseTo(expSlot1.idxPutPremium, 3);
    expect(params[5]).toBeCloseTo(expSlot1.totalPremium, 3);
    expect(params[6]).toBe(QUORUM); // n_trades in slot 1
    // Row 1 = slot 3.
    expect(params[9]).toBe(3);
    expect(params[10]).toBeCloseTo(expSlot3.ndNum, 3);
    expect(params[13]).toBeCloseTo(expSlot3.totalPremium, 3);
    expect(params[14]).toBe(QUORUM); // n_trades in slot 3
  });

  it('merges the same slot across chunks (never written twice) and applies the quorum to the MERGED totals', async () => {
    freezePostClose();

    // Two chunks each report slot 1 with 300 trades (below the 500 quorum on
    // their own); merged = 600 → clears the quorum and is written ONCE with
    // summed components. A third chunk reports slot 5 with 300 → stays below
    // the quorum after merging (only one contribution) → dropped.
    const half = sumsFor({ side: 'ask' }, 300);
    const whole = sumsFor({ side: 'ask' }, 600);
    aggByWindow.set(slotStartIso(DATE, 1), [aggSlotRow(1, half, 300)]);
    aggByWindow.set(slotStartIso(DATE, 2), [aggSlotRow(1, half, 300)]);
    aggByWindow.set(slotStartIso(DATE, 5), [aggSlotRow(5, half, 300)]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    expect(insertCalls()).toHaveLength(1);
    const params = insertParams();
    expect(params).toHaveLength(8); // exactly ONE row for slot 1
    expect(params[0]).toBe(DATE);
    expect(params[1]).toBe(1);
    expect(params[2]).toBeCloseTo(whole.ndNum, 3);
    expect(params[3]).toBeCloseTo(whole.ndDen, 3);
    expect(params[4]).toBeCloseTo(whole.idxPutPremium, 3);
    expect(params[5]).toBeCloseTo(whole.totalPremium, 3);
    expect(params[6]).toBe(600); // merged n_trades
    // The thin slot 5 was counted as skipped (quorum on merged totals).
    expect(res._json).toMatchObject({ skippedThin: 1 });
  });

  it('skips persisting a slot below the per-day volume quorum', async () => {
    freezePostClose();

    // One slot well below the quorum (a holiday/partial straggler) → dropped.
    aggByWindow.set(slotStartIso(DATE, 1), [
      aggSlotRow(1, sumsFor({}, 10), 10),
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // No slot cleared the quorum → no INSERT (only the chunk aggregations).
    expect(mockQuery).toHaveBeenCalledTimes(SLOT_COUNT * 2);
    expect(insertCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('re-accumulates the prior trading date too (catch-up lookback)', async () => {
    freezePostClose();

    // Today empty, but the prior date (2026-06-04) has a quorum-clearing
    // slot 1. Its rows are stamped the PRIOR ET date by the cron.
    aggByWindow.set(slotStartIso(PRIOR_DATE, 1), [
      aggSlotRow(1, sumsFor({}, QUORUM), QUORUM),
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(SLOT_COUNT * 2 + 1);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    // The single upserted row is stamped the PRIOR ET date, not today.
    const params = insertParams();
    expect(params[0]).toBe(PRIOR_DATE);
    expect(params[1]).toBe(1); // slot 1
  });

  it('skips with no write when there are no RTH trades', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // Only the chunk aggregations ran; no INSERT.
    expect(mockQuery).toHaveBeenCalledTimes(SLOT_COUNT * 2);
    expect(insertCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('reports a per-date summary with chunk count and elapsed ms', async () => {
    freezePostClose();
    aggByWindow.set(slotStartIso(DATE, 1), [
      aggSlotRow(1, sumsFor({}, QUORUM), QUORUM),
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { perDate: Record<string, unknown>[] };
    expect(body.perDate).toHaveLength(2);
    expect(body.perDate[0]).toMatchObject({
      date: DATE,
      slots: 1,
      totalRows: QUORUM,
      chunks: SLOT_COUNT,
    });
    expect(typeof body.perDate[0]!.ms).toBe('number');
    expect(body.perDate[1]).toMatchObject({
      date: PRIOR_DATE,
      slots: 0,
      chunks: SLOT_COUNT,
    });
  });

  it('handles null-derived zero sums (SQL skips NULL delta/price) without crashing', async () => {
    freezePostClose();

    // The SQL aggregation skips NULL delta/price (SUM ignores NULLs), so a slot
    // of only-null rows reports zero sums but a real count. COALESCE guards the
    // empty-sum NULL → 0. n_trades clears the quorum → persisted.
    aggByWindow.set(slotStartIso(DATE, 1), [
      {
        slot: 1,
        n_trades: QUORUM,
        nd_num: '0',
        nd_den: '0',
        total_premium: '0',
        idx_put_premium: '0',
      },
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const params = insertParams();
    expect(Number.isFinite(params[2] as number)).toBe(true); // nd_num
    expect(Number.isFinite(params[3] as number)).toBe(true); // nd_den
    expect(Number.isFinite(params[5] as number)).toBe(true); // total_premium
    expect(params[6]).toBe(QUORUM); // n_trades
  });

  it('a chunk whose query hangs exhausts withDbRetry → status error, no write for that date, lookback not attempted', async () => {
    freezePostClose();

    // Today's chunks 0 and 1 succeed (slot 1 clears the quorum on its own);
    // chunk 2 never resolves. The REAL withDbRetry races each attempt against
    // its 10s per-attempt timeout: 3 attempts (2 retries) + 1s/2s backoff →
    // TransientDbError('db attempt timeout'). The date is abandoned — its
    // already-accumulated slot 1 must NOT be written (no silent partial day).
    aggByWindow.set(slotStartIso(DATE, 1), [
      aggSlotRow(1, sumsFor({}, QUORUM), QUORUM),
    ]);
    hangingWindows.add(slotStartIso(DATE, 2));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    const run = handler(req, res);
    await vi.runAllTimersAsync();
    await run;

    // 2 good chunks + 3 attempts on the hanging chunk; no lookback-date chunk.
    const windows = aggWindows();
    expect(windows).toHaveLength(5);
    expect(windows.slice(2).every(([s]) => s === slotStartIso(DATE, 2))).toBe(
      true,
    );
    expect(insertCalls()).toHaveLength(0);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      rows: 0,
      failedDate: DATE,
      failedChunk: 2,
      chunksDone: 2,
      chunksTotal: SLOT_COUNT,
      budgetHit: false,
      datesWritten: [],
    });
    expect(String((res._json as { message: string }).message)).toMatch(
      /db attempt timeout/,
    );
    // The exhausted transient error is captured with the chunk diagnostics.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [captured, hint] = mockCaptureException.mock.calls[0] as [
      unknown,
      { extra?: Record<string, unknown> },
    ];
    expect(captured).toBeInstanceOf(TransientDbError);
    expect(hint.extra).toMatchObject({ date: DATE, chunk: 2, chunksDone: 2 });
  });

  it('a lookback date failing does not lose the already-complete current date (written + reported as error)', async () => {
    freezePostClose();

    // Today fully accumulates (slot 1 clears the quorum). The prior date's
    // first chunk fails with a GENUINE (non-retryable) error → withDbRetry
    // rethrows immediately. Today's rows still land; the run is honest about
    // the failed date.
    const exp = sumsFor({}, QUORUM);
    aggByWindow.set(slotStartIso(DATE, 1), [aggSlotRow(1, exp, QUORUM)]);
    rejectingWindows.set(
      slotStartIso(PRIOR_DATE, 0),
      new Error('relation "ws_option_trades" does not exist'),
    );

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // 13 today chunks + 1 failed prior chunk (no retry on a genuine error).
    expect(aggWindows()).toHaveLength(SLOT_COUNT + 1);
    expect(insertCalls()).toHaveLength(1);
    const params = insertParams();
    expect(params).toHaveLength(8);
    expect(params[0]).toBe(DATE);
    expect(params[1]).toBe(1);
    expect(params[6]).toBe(QUORUM);
    expect(res._json).toMatchObject({
      status: 'error',
      rows: 1,
      slotsUpserted: 1,
      datesWritten: [DATE],
      failedDate: PRIOR_DATE,
      failedChunk: 0,
      chunksDone: 0,
      budgetHit: false,
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('stops with an honest error + partial diagnostics when the wall-clock budget is exhausted', async () => {
    freezePostClose();

    // The first chunk "takes" longer than the whole budget (the mock advances
    // the fake clock past the deadline while resolving), so the guard fires
    // before chunk 1 is issued: no Vercel hard timeout, no write, diagnostics.
    const slowStart = slotStartIso(DATE, 0);
    mockQuery.mockImplementation((stmt: string, params: unknown[]) => {
      if (/GROUP BY slot/i.test(stmt) && String(params[2]) === slowStart) {
        vi.setSystemTime(Date.now() + DAILY_WALL_BUDGET_MS + 1);
      }
      return routeQuery(stmt, params);
    });
    aggByWindow.set(slotStartIso(DATE, 1), [
      aggSlotRow(1, sumsFor({}, QUORUM), QUORUM),
    ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(aggWindows()).toHaveLength(1);
    expect(insertCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({
      status: 'error',
      rows: 0,
      budgetHit: true,
      failedDate: DATE,
      failedChunk: 1,
      chunksDone: 1,
      chunksTotal: SLOT_COUNT,
      datesWritten: [],
    });
    expect(String((res._json as { message: string }).message)).toMatch(
      /wall-clock budget/,
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
