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

const mockSql = vi.fn();
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
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-06-05';

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: DATE });
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

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

  it('aggregates a multi-slot day and upserts one row per populated slot', async () => {
    // Post-close on the trade day so getETDateStr(now) === DATE (the cron
    // stamps the ET trade date from real `now`). 21:55 UTC = 17:55 ET (EDT).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));

    // Two slots: slot 1 (10:00 ET = 14:00 UTC) and slot 3 (11:00 ET = 15:00
    // UTC). 14:00/15:00 UTC are EDT wall-clock 10:00/11:00 ET.
    const slot1Rows = [
      tradeRow({ executed_at: '2026-06-05T14:00:00.000Z', side: 'ask' }),
      tradeRow({
        executed_at: '2026-06-05T14:10:00.000Z',
        ticker: 'QQQ',
        option_type: 'P',
        side: 'bid',
        delta: '-0.400000',
        price: '2.0000',
        size: 50,
      }),
    ];
    const slot3Rows = [
      tradeRow({
        executed_at: '2026-06-05T15:00:00.000Z',
        ticker: 'AAPL',
        option_type: 'C',
        side: 'ask',
        delta: '0.600000',
        price: '3.0000',
        size: 200,
      }),
    ];
    const allRows = [...slot1Rows, ...slot3Rows];

    // SELECT returns the day; each UPSERT returns [].
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce(allRows); // SELECT
    mockSql.mockResolvedValue([]); // UPSERTs

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // 1 SELECT + 2 UPSERTs (slot 1 + slot 3).
    expect(mockSql).toHaveBeenCalledTimes(3);
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

    // UPSERT param order: [date, slot, nd_num, nd_den, idx_put_premium,
    //                      total_premium, n_trades]
    const upsert1 = (mockSql.mock.calls[1] ?? []).slice(1);
    expect(upsert1[0]).toBe(DATE);
    expect(upsert1[1]).toBe(1); // slot 1
    expect(upsert1[2]).toBeCloseTo(expSlot1.ndNum, 6);
    expect(upsert1[3]).toBeCloseTo(expSlot1.ndDen, 6);
    expect(upsert1[4]).toBeCloseTo(expSlot1.idxPutPremium, 6);
    expect(upsert1[5]).toBeCloseTo(expSlot1.totalPremium, 6);
    expect(upsert1[6]).toBe(2); // n_trades in slot 1

    const upsert3 = (mockSql.mock.calls[2] ?? []).slice(1);
    expect(upsert3[1]).toBe(3); // slot 3
    expect(upsert3[2]).toBeCloseTo(expSlot3.ndNum, 6);
    expect(upsert3[5]).toBeCloseTo(expSlot3.totalPremium, 6);
    expect(upsert3[6]).toBe(1); // n_trades in slot 3
  });

  it('skips with no write when there are no RTH trades', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]); // SELECT → empty day

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // Only the SELECT ran; no UPSERT.
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('coerces null delta / non-numeric price without crashing the metric math', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T21:55:00.000Z'));
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([
      tradeRow({ delta: null, price: 'not-a-number', side: 'ask' }),
    ]);
    mockSql.mockResolvedValue([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const upsert = (mockSql.mock.calls[1] ?? []).slice(1);
    // delta null → 0 → nd_num/nd_den both finite (0). price NaN → 0 → excluded
    // from premium → total_premium finite (0).
    expect(Number.isFinite(upsert[2] as number)).toBe(true); // nd_num
    expect(Number.isFinite(upsert[3] as number)).toBe(true); // nd_den
    expect(Number.isFinite(upsert[5] as number)).toBe(true); // total_premium
    expect(upsert[6]).toBe(1); // n_trades
  });
});
