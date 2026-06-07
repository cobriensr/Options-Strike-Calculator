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
 *
 * Phase 2 of docs/superpowers/specs/flow-regime-badge-2026-06-06.md
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

// The real withCronInstrumentation calls cronGuard from api-helpers.
// Mock just that so we control the auth/time gate; everything else in
// cron-instrumentation runs for real (Sentry check-in is a no-op when
// SENTRY_DSN is unset).
const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/capture-flow-regime.js';
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-06-05';

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockCronGuard.mockReset();
  // cronGuard returns truthy ctx on pass; the cron uses real `new Date()`
  // for date/slot derivation, so `today` here is not load-bearing.
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
    strike: string;
    expiry: string;
    executed_at: string;
    price: string;
    size: number;
    underlying_price: string | null;
    side: string;
    delta: string | null;
  }> = {},
) {
  return {
    ticker: 'SPY',
    option_type: 'C',
    strike: '500.000',
    expiry: '2026-06-05',
    executed_at: '2026-06-05T14:00:00.000Z',
    price: '1.2500',
    size: 100,
    underlying_price: '500.0000',
    side: 'ask',
    delta: '0.500000',
    ...overrides,
  };
}

describe('capture-flow-regime cron', () => {
  it('returns the cronGuard failure response without writing when unauthenticated', async () => {
    // cronGuard returns null (auth/time gate failed); the wrapper sends
    // its own response and never invokes the handler body.
    mockCronGuard.mockReturnValue(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('no-ops with status "skipped" outside RTH (no DB write)', async () => {
    // 11:00 UTC = 06:00 ET — before the 09:30 ET open → slot is null.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T11:00:00.000Z'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'skipped' });
  });

  it('UPSERTs exactly one snapshot with a sensible regime on the happy path', async () => {
    // 14:00 UTC = 10:00 ET → slot 1 ((600-570)/30). Two SQL calls
    // expected: the SELECT then the UPSERT.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    // Bearish-leaning tape: index 0DTE puts sold on the bid (seller
    // initiated → side_sign −1). ≥ MIN_BUCKET_TRADES (50) rows so the
    // low-confidence gate does NOT fire and a real directional regime is
    // exercised (a thin bucket would be force-grayed — see separate test).
    mockSql.mockReset();
    const bearishTape = Array.from({ length: 60 }, (_, i) =>
      i % 6 === 0
        ? tradeRow({
            ticker: 'AAPL',
            option_type: 'C',
            side: 'ask',
            delta: '0.300000',
            price: '1.0000',
            size: 100,
          })
        : tradeRow({
            ticker: i % 2 === 0 ? 'SPY' : 'QQQ',
            option_type: 'P',
            side: 'ask',
            delta: '-0.500000',
            price: '2.5000',
            size: 400,
          }),
    );
    mockSql.mockResolvedValueOnce(bearishTape);
    // The UPSERT.
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // SELECT + UPSERT = 2 calls.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    // UPSERT param order matches the INSERT VALUES clause:
    //   [date, slot, nd_tilt, idx0dte_put_share,
    //    nd_percentile, idxput_percentile, regime, color, n_trades,
    //    baseline_version]
    const upsertArgs = mockSql.mock.calls[1] ?? [];
    const params = upsertArgs.slice(1);
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
    // n_trades = the number of rows read (above the low-confidence floor).
    expect(params[8]).toBe(60);
    // baseline_version stamps the committed artifact's schema_version.
    expect(typeof params[9]).toBe('number');
  });

  it('suppresses a thin bucket to normal/gray despite an extreme tilt', async () => {
    // 14:00 UTC = 10:00 ET → slot 1. Only 2 trades, both aggressive
    // ask-side index puts → raw ndTilt ≈ −1 (would classify bearish/red).
    // Below MIN_BUCKET_TRADES (50) the cron must force normal/gray so the
    // badge never flashes a false signal on near-zero data.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([
      tradeRow({
        ticker: 'SPY',
        option_type: 'P',
        side: 'ask',
        delta: '-0.500000',
        price: '5.0000',
        size: 1000,
      }),
      tradeRow({
        ticker: 'QQQ',
        option_type: 'P',
        side: 'ask',
        delta: '-0.550000',
        price: '4.0000',
        size: 800,
      }),
    ]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

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

  it('coerces null delta/underlying_price without crashing the metric math', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T14:00:00.000Z'));

    mockSql.mockReset();
    // A row with null delta + null underlying_price (both nullable in
    // the schema) — delta null → 0 contribution, must not throw.
    mockSql.mockResolvedValueOnce([
      tradeRow({ delta: null, underlying_price: null }),
    ]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const params = (mockSql.mock.calls[1] ?? []).slice(1);
    // nd_tilt should be a finite number (0 when the only delta is null).
    expect(Number.isFinite(params[2] as number)).toBe(true);
    expect(params[8]).toBe(1); // n_trades
  });
});
