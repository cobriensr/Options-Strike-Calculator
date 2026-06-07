// @vitest-environment node

/**
 * Tests for the nightly 0DTE gamma-regime self-scoring cron.
 *
 * The cron reads the day's source tables via the Task-5 helpers
 * (getGexStrikes / getPutIvSeries / getCandles30 — mocked here). Crucially it
 * reads getGexStrikes TWICE with a time anchor — the OPEN-minute profile (for
 * the forward gate + gex_open + flip) and the MIDDAY-minute profile (for
 * gex_mid + midday_deep_neg) — because the 0DTE gamma profile migrates with
 * spot through the day. It then runs a small day-OHLC query on
 * index_candles_1m and UPSERTs one row per trading day into
 * flow_regime_0dte_daily.
 *
 * The pure helpers (regime-0dte.ts) are NOT mocked — we want the real
 * gate/trigger math to exercise the integration. The query helpers ARE
 * mocked so each case can pin the source shapes without DB fixtures; the
 * getGexStrikes mock routes on its `anchor` arg so the open and midday
 * profiles are independently controllable.
 * Assertions focus on:
 *   - CRON_SECRET auth guard (cronGuard returns null → no DB write).
 *   - Happy path: deep-neg OPEN + MIDDAY profiles → exactly one UPSERT into
 *     flow_regime_0dte_daily with gate='lean_down', midday_deep_neg=true, the
 *     derived columns, and the realized-outcome coercions, using
 *     ON CONFLICT (date) DO UPDATE.
 *   - Empty-data day (no candles / thin open profile): no UPSERT, clean exit.
 *
 * Task 7 of docs/superpowers/plans/2026-06-07-regime-0dte-panel.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockGetGexStrikes = vi.hoisted(() => vi.fn());
const mockGetPutIvSeries = vi.hoisted(() => vi.fn());
const mockGetCandles30 = vi.hoisted(() => vi.fn());
vi.mock('../_lib/regime-0dte-queries.js', () => ({
  getGexStrikes: mockGetGexStrikes,
  getPutIvSeries: mockGetPutIvSeries,
  getCandles30: mockGetCandles30,
}));

import handler from '../cron/capture-regime-0dte.js';
import { mockRequest, mockResponse } from './helpers';

const DATE = '2026-06-05';

// A crash-shaped deep-negative-gamma day. Strikes are live-units magnitude
// (~1e10 scale) so gexNear at the anchor spot crosses GATE_DEEP_NEG (-1.5e10).
// Candles march steadily down (5 red, 0 green by 11:00 CT) so mostly_red
// fires; IV jumps mid-session so iv_break fires.
//
// The OPEN profile is anchored at the open spot (~7530); the MIDDAY profile is
// anchored lower (~7475) as the day sold off and the 0DTE gamma profile
// migrated with spot. Both sum to ~-3e10 in-band → gate 'lean_down' +
// midday_deep_neg true — exercising the time-anchored reconstruction.
function deepNegOpenProfile() {
  return {
    strikes: [
      { strike: 7510, netGex: -6e9 },
      { strike: 7520, netGex: -6e9 },
      { strike: 7530, netGex: -6e9 },
      { strike: 7540, netGex: -6e9 },
      { strike: 7550, netGex: -6e9 },
    ],
    spot: 7530,
  };
}

function deepNegMiddayProfile() {
  return {
    strikes: [
      { strike: 7455, netGex: -6e9 },
      { strike: 7465, netGex: -6e9 },
      { strike: 7475, netGex: -6e9 },
      { strike: 7485, netGex: -6e9 },
      { strike: 7495, netGex: -6e9 },
    ],
    spot: 7475,
  };
}

/** Route the getGexStrikes mock by its time anchor (open vs midday). */
function deepNegByAnchor(_date: string, anchor: 'latest' | 'open' | 'midday') {
  return anchor === 'midday' ? deepNegMiddayProfile() : deepNegOpenProfile();
}

function deepNegIv() {
  return [
    { ctMin: 520, iv: 0.2 },
    { ctMin: 580, iv: 0.21 },
    { ctMin: 650, iv: 0.27 },
  ];
}

function deepNegCandles() {
  return [
    { ctMin: 510, open: 7530, close: 7520 },
    { ctMin: 540, open: 7520, close: 7510 },
    { ctMin: 570, open: 7510, close: 7500 },
    { ctMin: 600, open: 7500, close: 7480 },
    { ctMin: 630, open: 7480, close: 7470 },
  ];
}

/** One day-OHLC aggregate row as Neon returns it (NUMERIC → string). */
function ohlcRow(
  overrides: Partial<{
    day_open: string;
    day_close: string;
    day_hi: string;
    day_lo: string;
  }> = {},
) {
  return {
    day_open: '7530.00',
    day_close: '7445.00',
    day_hi: '7535.00',
    day_lo: '7440.00',
    ...overrides,
  };
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: DATE });
  mockGetGexStrikes.mockReset();
  mockGetPutIvSeries.mockReset();
  mockGetCandles30.mockReset();
});

describe('capture-regime-0dte cron', () => {
  it('returns the cronGuard failure response without writing when unauthenticated', async () => {
    // cronGuard returns null (auth/time gate failed); the wrapper sends
    // its own response and never invokes the handler body.
    mockCronGuard.mockReturnValue(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    expect(mockGetGexStrikes).not.toHaveBeenCalled();
  });

  it('UPSERTs one lean_down row on a deep-neg crash-shaped day', async () => {
    mockGetGexStrikes.mockImplementation(
      (d: string, a: 'latest' | 'open' | 'midday') =>
        Promise.resolve(deepNegByAnchor(d, a)),
    );
    mockGetPutIvSeries.mockResolvedValue(deepNegIv());
    mockGetCandles30.mockResolvedValue(deepNegCandles());
    // The day-OHLC query returns one aggregate row.
    mockSql.mockResolvedValueOnce([ohlcRow()]);
    // The UPSERT.
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // One OHLC SELECT + one UPSERT = 2 SQL calls.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    // The cron reads BOTH time-anchored profiles (open + midday), never the
    // default 'latest' EOD snapshot for the gate.
    const anchors = mockGetGexStrikes.mock.calls.map((c) => c[1]);
    expect(anchors).toContain('open');
    expect(anchors).toContain('midday');
    expect(anchors).not.toContain('latest');

    // UPSERT param order matches the INSERT VALUES clause:
    //   [date, gate, gex_open, gex_mid, flip_minus_open_pct,
    //    mostly_red, mostly_red_at, iv_break, iv_break_at, iv_break_mag_pct,
    //    midday_deep_neg, oc_ret_pct, range_pct, dir_eff, big_down, big_up]
    const upsertArgs = mockSql.mock.calls[1] ?? [];
    const params = upsertArgs.slice(1);
    expect(params[0]).toBe(DATE); // date
    expect(params[1]).toBe('lean_down'); // gate
    // gex_open / gex_mid are net-GEX sums near the open / midday spot.
    expect(typeof params[2]).toBe('number'); // gex_open
    expect(params[2]).toBeLessThan(0);
    expect(typeof params[3]).toBe('number'); // gex_mid
    // mostly_red fired on the all-red day.
    expect(params[5]).toBe(true); // mostly_red
    expect(params[6]).toBe('11:00'); // mostly_red_at (660 CT → HH:MM)
    // iv_break fired (0.27 > 0.21 * 1.02 within 10:00–12:30 CT).
    expect(params[7]).toBe(true); // iv_break
    expect(params[8]).toBe('10:50'); // iv_break_at (650 CT → HH:MM)
    expect(typeof params[9]).toBe('number'); // iv_break_mag_pct
    // midday_deep_neg: midday profile sums to ~-3e10 ≤ GATE_DEEP_NEG (-1.5e10).
    expect(params[10]).toBe(true); // midday_deep_neg

    // Realized outcome: open 7530 → close 7445 = −1.13% (big_down),
    // range (7535−7440)/7530 = 1.26%, dir_eff = 85/95 ≈ 0.895.
    expect(params[11]).toBeCloseTo(-1.1287, 3); // oc_ret_pct
    expect(params[12]).toBeCloseTo(1.2616, 3); // range_pct
    expect(params[13]).toBeCloseTo(0.8947, 3); // dir_eff
    expect(params[14]).toBe(true); // big_down (oc ≤ −1)
    expect(params[15]).toBe(false); // big_up (oc ≥ +1)

    // Idempotent upsert keyed on the DATE primary key.
    const sqlText = (upsertArgs[0] as string[]).join('');
    expect(sqlText).toContain('INSERT INTO flow_regime_0dte_daily');
    expect(sqlText).toContain('ON CONFLICT (date) DO UPDATE');
  });

  it('skips the upsert on an empty-data day (no candles, thin open profile)', async () => {
    // Both anchors resolve empty → open profile under MIN_STRIKES → guard fires.
    mockGetGexStrikes.mockResolvedValue({ strikes: [], spot: null });
    mockGetPutIvSeries.mockResolvedValue([]);
    mockGetCandles30.mockResolvedValue([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // No SQL at all — the guard returns before the OHLC query / upsert.
    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'skipped' });
  });
});
