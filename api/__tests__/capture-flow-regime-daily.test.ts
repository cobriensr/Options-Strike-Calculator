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

// The daily cron uses the tagged-template `sql\`...\`` for the per-date SELECTs
// and `bulkUpsert({ sql, ... })` which calls `sql.query(stmt, params)` for the
// single batched UPSERT. The mock therefore needs BOTH surfaces.
const mockQuery: ReturnType<
  typeof vi.fn<
    (stmt: string, params: unknown[]) => Promise<{ rows: unknown[] }>
  >
> = vi.fn(() => Promise.resolve({ rows: [] }));
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
import { computeFlowMetrics } from '../_lib/flow-regime.js';
import { MIN_DAY_SLOT_TRADES } from '../_lib/flow-regime-baseline-live.js';
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-06-05';

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: DATE });
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Repeat a base trade row `n` times (to clear the per-day volume quorum). */
function repeat(base: ReturnType<typeof tradeRow>, n: number) {
  return Array.from({ length: n }, () => ({ ...base }));
}

const QUORUM = MIN_DAY_SLOT_TRADES; // 500

/** One ws_option_trades row as Neon returns it (NUMERIC → string). */
function tradeRow(
  overrides: Partial<{
    ticker: string;
    option_type: string;
    expiry: string;
    executed_at: string;
    price: string;
    size: number;
    side: string;
    delta: string | null;
  }> = {},
) {
  return {
    ticker: 'SPY',
    option_type: 'C',
    expiry: '2026-06-05',
    executed_at: '2026-06-05T14:00:00.000Z', // 10:00 ET → slot 1
    price: '1.2500',
    size: 100,
    side: 'ask',
    delta: '0.500000',
    ...overrides,
  };
}

describe('capture-flow-regime-daily cron', () => {
  it('does not write when cronGuard rejects the request', async () => {
    mockCronGuard.mockReturnValue(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('aggregates a multi-slot day and batches one INSERT for all populated slots', async () => {
    // Post-close on the trade day so getETDateStr(now) === DATE (the cron
    // stamps the ET trade date from real `now`). 21:55 UTC = 17:55 ET (EDT).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));

    // Two slots, each ABOVE the per-day quorum: slot 1 (10:00 ET = 14:00 UTC)
    // and slot 3 (11:00 ET = 15:00 UTC). Each slot gets QUORUM rows so neither
    // is dropped by the volume floor.
    const slot1Base = tradeRow({
      executed_at: '2026-06-05T14:00:00.000Z',
      side: 'ask',
    });
    const slot3Base = tradeRow({
      executed_at: '2026-06-05T15:00:00.000Z',
      ticker: 'AAPL',
      option_type: 'C',
      side: 'ask',
      delta: '0.600000',
      price: '3.0000',
      size: 200,
    });
    const slot1Rows = repeat(slot1Base, QUORUM);
    const slot3Rows = repeat(slot3Base, QUORUM);
    const todayRows = [...slot1Rows, ...slot3Rows];

    // SELECT for today returns the day; SELECT for the prior date is empty.
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce(todayRows); // today SELECT
    mockSql.mockResolvedValueOnce([]); // prior-date SELECT (lookback)

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // 2 SELECTs (today + 1 prior date), then ONE batched INSERT via sql.query.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({ status: 'success', rows: 2 });

    // Build the expected per-slot sums via the real lib (same coercion the cron
    // applies: delta/price strings → numbers, expiry/tradeDate both '...-05').
    const toFlow = (r: ReturnType<typeof tradeRow>) => ({
      ticker: r.ticker,
      optionType: r.option_type,
      expiry: r.expiry,
      tradeDateEt: DATE,
      side: r.side,
      delta: Number(r.delta),
      size: r.size,
      price: Number(r.price),
    });
    const expSlot1 = computeFlowMetrics(slot1Rows.map(toFlow));
    const expSlot3 = computeFlowMetrics(slot3Rows.map(toFlow));

    // bulkUpsert flattens rows into a single params array, 8 cols per row:
    // [date, slot, nd_num, nd_den, idx_put_premium, total_premium, n_trades,
    //  computed_at]. Two rows → 16 params.
    const params = mockQuery.mock.calls[0]![1] as unknown[];
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
    const thinSlot = repeat(
      tradeRow({ executed_at: '2026-06-05T14:00:00.000Z' }),
      10,
    );
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce(thinSlot); // today SELECT
    mockSql.mockResolvedValueOnce([]); // prior-date SELECT

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // No slot cleared the quorum → no INSERT, status skipped.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('re-accumulates the prior trading date too (catch-up lookback)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));

    // Today empty, but the prior date (2026-06-04) has a quorum-clearing slot 1.
    // The prior-date rows are stamped executed_at on 2026-06-04 so they land in
    // that date's RTH window.
    const priorRows = repeat(
      tradeRow({
        executed_at: '2026-06-04T14:00:00.000Z',
        expiry: '2026-06-04',
      }),
      QUORUM,
    );
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]); // today SELECT (empty)
    mockSql.mockResolvedValueOnce(priorRows); // prior-date SELECT

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    // The single upserted row is stamped the PRIOR ET date, not today.
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[0]).toBe('2026-06-04');
    expect(params[1]).toBe(1); // slot 1
  });

  it('skips with no write when there are no RTH trades', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]); // today SELECT
    mockSql.mockResolvedValueOnce([]); // prior-date SELECT

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // Only the SELECTs ran; no INSERT.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('coerces null delta / non-numeric price without crashing the metric math', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));
    mockSql.mockReset();
    // QUORUM rows (clears the floor) with null delta + non-numeric price.
    const badRows = repeat(
      tradeRow({ delta: null, price: 'not-a-number', side: 'ask' }),
      QUORUM,
    );
    mockSql.mockResolvedValueOnce(badRows); // today SELECT
    mockSql.mockResolvedValueOnce([]); // prior-date SELECT

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    // delta null → 0 → nd_num/nd_den both finite (0). price NaN → 0 → excluded
    // from premium → total_premium finite (0).
    expect(Number.isFinite(params[2] as number)).toBe(true); // nd_num
    expect(Number.isFinite(params[3] as number)).toBe(true); // nd_den
    expect(Number.isFinite(params[5] as number)).toBe(true); // total_premium
    expect(params[6]).toBe(QUORUM); // n_trades
  });
});
