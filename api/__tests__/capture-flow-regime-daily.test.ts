// @vitest-environment node

/**
 * Tests for the self-maintaining flow-regime baseline daily accumulator cron.
 *
 * The cron reads the whole day's ws_option_trades RTH window, buckets rows into
 * their ET 30-min slot, reduces each bucket to component sums via the (real)
 * Phase 1 lib, and UPSERTs one row per populated slot into
 * flow_regime_slot_daily. The lib is NOT mocked — we want the real bucketing /
 * metric math to run. Assertions focus on:
 *   - CRON_SECRET auth guard (no DB writes when cronGuard fails).
 *   - Happy path: a multi-slot day aggregates correctly and upserts one row per
 *     populated slot, with the per-slot sums + n_trades matching.
 *   - null/NaN coercion: a null delta + non-numeric price don't crash the math.
 *
 * Resolves code-review finding #6 — see
 * docs/superpowers/specs/flow-regime-baseline-refresh-2026-06-07.md.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// The daily cron now reduces each date's window IN SQL: the per-date per-slot
// aggregation runs via `sql.query(stmt, params)` (returning per-slot scalar-sum
// rows), and `bulkUpsert({ sql, ... })` ALSO calls `sql.query(stmt, params)` for
// the single batched INSERT. Both surface through `sql.query` now (the old raw
// tagged-template `sql\`...\`` SELECTs are gone). We route the mock by statement
// content: the aggregation contains `GROUP BY slot`, the INSERT contains
// `INSERT INTO flow_regime_slot_daily`.
//
// `aggResults` is a FIFO queue of per-date aggregation results, one entry per
// `accumulateDate` call (today, then each lookback date), set per test.
let aggResults: Record<string, unknown>[][] = [];
const mockQuery: ReturnType<
  typeof vi.fn<(stmt: string, params: unknown[]) => Promise<unknown>>
> = vi.fn((stmt: string) => {
  if (/GROUP BY slot/i.test(stmt)) {
    return Promise.resolve(aggResults.shift() ?? []);
  }
  // bulkUpsert INSERT — return value is ignored by the helper.
  return Promise.resolve({ rows: [] });
});
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

const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/capture-flow-regime-daily.js';
import {
  computeFlowMetrics,
  type FlowMetricSums,
  type FlowTradeRow,
} from '../_lib/flow-regime.js';
import { MIN_DAY_SLOT_TRADES } from '../_lib/flow-regime-baseline-live.js';
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-06-05';

beforeEach(() => {
  aggResults = [];
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockQuery.mockReset();
  mockQuery.mockImplementation((stmt: string) => {
    if (/GROUP BY slot/i.test(stmt)) {
      return Promise.resolve(aggResults.shift() ?? []);
    }
    return Promise.resolve({ rows: [] });
  });
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: DATE });
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const QUORUM = MIN_DAY_SLOT_TRADES; // 500

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
  const call = mockQuery.mock.calls.find(([stmt]) =>
    /INSERT INTO/i.test(String(stmt)),
  );
  if (!call) throw new Error('no INSERT call recorded');
  return call[1] as unknown[];
}

describe('capture-flow-regime-daily cron', () => {
  it('does not write when cronGuard rejects the request', async () => {
    mockCronGuard.mockReturnValue(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('aggregates a multi-slot day and batches one INSERT for all populated slots', async () => {
    // Post-close on the trade day so getETDateStr(now) === DATE (the cron
    // stamps the ET trade date from real `now`). 21:55 UTC = 17:55 ET (EDT).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));

    // Two slots, each ABOVE the per-day quorum: slot 1 and slot 3. The SQL
    // aggregation reduces+buckets in-DB; here we feed its result directly. Build
    // expected sums via the real lib so the assertions match production algebra.
    const expSlot1 = sumsFor({ side: 'ask' }, QUORUM);
    const expSlot3 = sumsFor(
      { ticker: 'AAPL', side: 'ask', delta: 0.6, price: 3.0, size: 200 },
      QUORUM,
    );

    // today's aggregation → two populated slots; the prior-date aggregation is
    // empty. (FIFO order: today first, then the 1-day lookback.)
    aggResults = [
      [aggSlotRow(1, expSlot1, QUORUM), aggSlotRow(3, expSlot3, QUORUM)],
      [],
    ];

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // 2 aggregation sql.query calls (today + 1 prior date), then ONE batched
    // INSERT via sql.query → 3 sql.query calls total, 0 tagged-template calls.
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(3);
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
    expect(params[5]).toBeCloseTo(expSlot1.totalPremium, 3);
    expect(params[6]).toBe(QUORUM); // n_trades in slot 1
    // Row 1 = slot 3.
    expect(params[9]).toBe(3);
    expect(params[10]).toBeCloseTo(expSlot3.ndNum, 3);
    expect(params[13]).toBeCloseTo(expSlot3.totalPremium, 3);
    expect(params[14]).toBe(QUORUM); // n_trades in slot 3
  });

  it('skips persisting a slot below the per-day volume quorum', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));

    // One slot well below the quorum (a holiday/partial straggler) → dropped.
    aggResults = [[aggSlotRow(1, sumsFor({}, 10), 10)], []];

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // No slot cleared the quorum → no INSERT (only the 2 aggregation queries).
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(
      mockQuery.mock.calls.some(([stmt]) => /INSERT INTO/i.test(String(stmt))),
    ).toBe(false);
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('re-accumulates the prior trading date too (catch-up lookback)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));

    // Today empty, but the prior date (2026-06-04) has a quorum-clearing slot 1.
    // The prior-date aggregation is the 2nd FIFO entry; its rows are stamped the
    // PRIOR ET date by the cron (accumulateDate is called with the prior date).
    aggResults = [[], [aggSlotRow(1, sumsFor({}, QUORUM), QUORUM)]];

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // 2 aggregation queries + 1 INSERT.
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    // The single upserted row is stamped the PRIOR ET date, not today.
    const params = insertParams();
    expect(params[0]).toBe('2026-06-04');
    expect(params[1]).toBe(1); // slot 1
  });

  it('skips with no write when there are no RTH trades', async () => {
    // Both dates aggregate to no populated slots (empty windows).
    aggResults = [[], []];

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // Only the 2 aggregation queries ran; no INSERT.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(
      mockQuery.mock.calls.some(([stmt]) => /INSERT INTO/i.test(String(stmt))),
    ).toBe(false);
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('handles null-derived zero sums (SQL skips NULL delta/price) without crashing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));

    // The SQL aggregation skips NULL delta/price (SUM ignores NULLs), so a slot
    // of only-null rows reports zero sums but a real count. COALESCE guards the
    // empty-sum NULL → 0. n_trades clears the quorum → persisted.
    aggResults = [
      [
        {
          slot: 1,
          n_trades: QUORUM,
          nd_num: '0',
          nd_den: '0',
          total_premium: '0',
          idx_put_premium: '0',
        },
      ],
      [],
    ];

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
});
