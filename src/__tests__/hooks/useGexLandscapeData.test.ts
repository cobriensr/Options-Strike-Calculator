/**
 * Unit tests for the MM-attributed useGexLandscapeData adapter
 * (Phase 2 of docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md).
 *
 * Two surfaces are covered:
 *   1. `projectMmStrike` — pure projection of MM gamma+charm (and an
 *      optional WS side-channel row) into GexStrikeLevel. The WS row
 *      drives vol reinforcement + ask/bid; the MM row drives netGamma
 *      / netCharm.
 *   2. The hook itself — combines `usePeriscopeStrikes` (primary) and
 *      `useGexStrikeExpiry` (side channel), produces 10m/20m/30m delta
 *      maps, and leaves 1m/5m/15m maps empty for Phase 2 compat.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../hooks/usePeriscopeStrikes', () => ({
  usePeriscopeStrikes: vi.fn(),
}));

vi.mock('../../hooks/useGexStrikeExpiry', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useGexStrikeExpiry')
  >('../../hooks/useGexStrikeExpiry');
  return {
    ...actual,
    useGexStrikeExpirySpx: vi.fn(),
  };
});

import {
  projectMmStrike,
  useGexLandscapeData,
} from '../../hooks/useGexLandscapeData';
import { usePeriscopeStrikes } from '../../hooks/usePeriscopeStrikes';
import { useGexStrikeExpirySpx } from '../../hooks/useGexStrikeExpiry';
import type { GexStrikeExpiryRow } from '../../hooks/useGexStrikeExpiry';

function makeWsRow(
  overrides: Partial<GexStrikeExpiryRow> = {},
): GexStrikeExpiryRow {
  return {
    ticker: 'SPX',
    expiry: '2026-05-12',
    strike: 7350,
    ts_minute: '2026-05-12T18:40:00.000Z',
    price: 7340,
    call_gamma_oi: 0,
    put_gamma_oi: 0,
    call_charm_oi: 0,
    put_charm_oi: 0,
    call_vanna_oi: 0,
    put_vanna_oi: 0,
    call_gamma_vol: 0,
    put_gamma_vol: 0,
    call_charm_vol: 0,
    put_charm_vol: 0,
    call_vanna_vol: 0,
    put_vanna_vol: 0,
    call_gamma_ask_vol: 0,
    call_gamma_bid_vol: 0,
    put_gamma_ask_vol: 0,
    put_gamma_bid_vol: 0,
    call_charm_ask_vol: 0,
    call_charm_bid_vol: 0,
    put_charm_ask_vol: 0,
    put_charm_bid_vol: 0,
    call_vanna_ask_vol: 0,
    call_vanna_bid_vol: 0,
    put_vanna_ask_vol: 0,
    put_vanna_bid_vol: 0,
    gamma_delta_1m: null,
    gamma_delta_5m: null,
    gamma_delta_10m: null,
    gamma_delta_15m: null,
    gamma_delta_30m: null,
    ...overrides,
  };
}

describe('projectMmStrike', () => {
  it('uses MM gamma + charm for net values, with spot as price', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: -2_500_000_000, charm: 7_800_000_000 },
      7340.5,
      undefined,
    );
    expect(out.strike).toBe(7350);
    expect(out.price).toBe(7340.5);
    expect(out.netGamma).toBe(-2_500_000_000);
    expect(out.netCharm).toBe(7_800_000_000);
  });

  it('zeroes naive OI fields when no WS row is matched', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: 5000, charm: 1000 },
      7340,
      undefined,
    );
    expect(out.callGammaOi).toBe(0);
    expect(out.putGammaOi).toBe(0);
    // MM-only fields stay zero regardless — these never come from WS.
    expect(out.callCharmOi).toBe(0);
    expect(out.putCharmOi).toBe(0);
    expect(out.callVannaOi).toBe(0);
    expect(out.putVannaOi).toBe(0);
  });

  it('populates callGammaOi / putGammaOi from the WS row for naive GEX downstream', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: 5000, charm: 0 },
      7340,
      makeWsRow({
        call_gamma_oi: 14_000,
        put_gamma_oi: -3_000,
      }),
    );
    expect(out.callGammaOi).toBe(14_000);
    expect(out.putGammaOi).toBe(-3_000);
    // Naive net gamma is the consumer-side computation.
    expect(out.callGammaOi + out.putGammaOi).toBe(11_000);
  });

  it('falls back to neutral volReinforcement when no WS row is matched', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: 5000, charm: 1000 },
      7340,
      undefined,
    );
    expect(out.volReinforcement).toBe('neutral');
    expect(out.callGammaAsk).toBe(0);
    expect(out.callGammaBid).toBe(0);
    expect(out.putGammaAsk).toBe(0);
    expect(out.putGammaBid).toBe(0);
  });

  it('marks volReinforcement reinforcing when WS row OI + vol agree (both positive)', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: 5000, charm: 0 },
      7340,
      makeWsRow({
        call_gamma_oi: 100,
        put_gamma_oi: 50,
        call_gamma_vol: 20,
        put_gamma_vol: 5,
      }),
    );
    expect(out.volReinforcement).toBe('reinforcing');
  });

  it('marks volReinforcement reinforcing when WS row OI + vol both negative', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: -5000, charm: 0 },
      7340,
      makeWsRow({
        call_gamma_oi: -100,
        put_gamma_oi: -50,
        call_gamma_vol: -20,
        put_gamma_vol: -5,
      }),
    );
    expect(out.volReinforcement).toBe('reinforcing');
  });

  it('marks volReinforcement opposing when WS row OI + vol signs disagree', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: 5000, charm: 0 },
      7340,
      makeWsRow({
        call_gamma_oi: 100,
        put_gamma_oi: 50,
        call_gamma_vol: -30,
        put_gamma_vol: -5,
      }),
    );
    expect(out.volReinforcement).toBe('opposing');
  });

  it('lifts WS ask/bid attribution into callGammaAsk etc.', () => {
    const out = projectMmStrike(
      { strike: 7350, gamma: 5000, charm: 0 },
      7340,
      makeWsRow({
        call_gamma_ask_vol: 1234,
        call_gamma_bid_vol: -567,
        put_gamma_ask_vol: 89,
        put_gamma_bid_vol: -42,
      }),
    );
    expect(out.callGammaAsk).toBe(1234);
    expect(out.callGammaBid).toBe(-567);
    expect(out.putGammaAsk).toBe(89);
    expect(out.putGammaBid).toBe(-42);
  });
});

function mockPrimary(
  latest: unknown,
  lookbacks?: {
    prior10m?: Map<number, number> | null;
    prior30m?: Map<number, number> | null;
    loading?: boolean;
    error?: string | null;
  },
) {
  vi.mocked(usePeriscopeStrikes).mockReturnValue({
    latest: latest as never,
    prior10m: lookbacks?.prior10m ?? null,
    prior30m: lookbacks?.prior30m ?? null,
    loading: lookbacks?.loading ?? false,
    error: lookbacks?.error ?? null,
    refresh: vi.fn(),
  });
}

function mockWs(rows: GexStrikeExpiryRow[], spxError: string | null = null) {
  vi.mocked(useGexStrikeExpirySpx).mockReturnValue({
    data: {
      ticker: 'SPX',
      expiry: '2026-05-12',
      at: null,
      rows,
      timestamps: [],
      asOf: '2026-05-12T18:40:30.000Z',
    },
    loading: false,
    error: spxError,
    refresh: vi.fn(),
  });
}

describe('useGexLandscapeData — adapter behavior', () => {
  beforeEach(() => {
    vi.mocked(usePeriscopeStrikes).mockReset();
    vi.mocked(useGexStrikeExpirySpx).mockReset();
  });

  it('builds 10m + 30m delta maps from MM lookback gamma values', () => {
    mockPrimary(
      {
        capturedAt: '2026-05-12T18:40:00.000Z',
        spot: 7340,
        strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
        availableSlots: [],
      },
      {
        prior10m: new Map([[7350, 4500]]),
        prior30m: new Map([[7350, 3500]]),
      },
    );
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );

    // ((5000 - 4500) / |4500|) * 100 ≈ 11.11
    expect(result.current.gexDelta10mMap.get(7350)).toBeCloseTo(11.11, 1);
    // ((5000 - 3500) / |3500|) * 100 ≈ 42.86
    expect(result.current.gexDelta30mMap.get(7350)).toBeCloseTo(42.86, 1);
  });

  it('returns null delta when prior gamma is below the noise floor (|prior| < 100)', () => {
    // Phase 4 calibration: strikes with near-zero prior gamma produce
    // huge meaningless % values (a +50 strike against a 0.5 prior
    // reads 10,000%). The floor maps those to null so the BiasPanel
    // mean and the StrikeTable cells don't get poisoned.
    mockPrimary(
      {
        capturedAt: '2026-05-12T18:40:00.000Z',
        spot: 7340,
        strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
        availableSlots: [],
      },
      { prior10m: new Map([[7350, 50]]) }, // |50| < 100 → null
    );
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.gexDelta10mMap.get(7350)).toBeNull();
  });

  it('returns null delta when prior gamma is 0 (no divide by zero)', () => {
    mockPrimary(
      {
        capturedAt: '2026-05-12T18:40:00.000Z',
        spot: 7340,
        strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
        availableSlots: [],
      },
      { prior10m: new Map([[7350, 0]]) },
    );
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.gexDelta10mMap.get(7350)).toBeNull();
  });

  it('returns null delta when the strike is absent from the prior lookup', () => {
    mockPrimary(
      {
        capturedAt: '2026-05-12T18:40:00.000Z',
        spot: 7340,
        strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
        availableSlots: [],
      },
      { prior10m: new Map([[9999, 1000]]) },
    );
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.gexDelta10mMap.get(7350)).toBeNull();
  });

  it('preserves the negative sign of % change when prior gamma is negative', () => {
    // Negative-gamma regime: prior -2.0B, latest -1.0B → gamma is
    // BECOMING LESS NEGATIVE → delta is positive. Using |prior| in the
    // denominator keeps the sign reflecting movement direction.
    mockPrimary(
      {
        capturedAt: '2026-05-12T18:40:00.000Z',
        spot: 7340,
        strikes: [{ strike: 7350, gamma: -1_000_000_000, charm: 0 }],
        availableSlots: [],
      },
      { prior10m: new Map([[7350, -2_000_000_000]]) },
    );
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    // ((-1B - -2B) / |-2B|) * 100 = 50
    expect(result.current.gexDelta10mMap.get(7350)).toBe(50);
  });

  it('always returns empty 1m/5m/15m maps (Phase 2 backwards-compat)', () => {
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
      availableSlots: [],
    });
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.gexDeltaMap.size).toBe(0);
    expect(result.current.gexDelta5mMap.size).toBe(0);
    expect(result.current.gexDelta15mMap.size).toBe(0);
  });

  it('builds naive 1m / 5m / 10m / 30m maps from server-computed WS fields', () => {
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [
        { strike: 7350, gamma: 5000, charm: 0 },
        { strike: 7360, gamma: 1000, charm: 0 },
      ],
      availableSlots: [],
    });
    mockWs([
      makeWsRow({
        strike: 7350,
        gamma_delta_1m: 2.4,
        gamma_delta_5m: 7,
        gamma_delta_10m: 12.5,
        gamma_delta_30m: -8,
      }),
      // 7360 absent from WS → all four maps return null for it
    ]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.naiveDelta1mMap.get(7350)).toBe(2.4);
    expect(result.current.naiveDelta5mMap.get(7350)).toBe(7);
    expect(result.current.naiveDelta10mMap.get(7350)).toBe(12.5);
    expect(result.current.naiveDelta30mMap.get(7350)).toBe(-8);
    expect(result.current.naiveDelta1mMap.get(7360)).toBeNull();
    expect(result.current.naiveDelta5mMap.get(7360)).toBeNull();
    expect(result.current.naiveDelta10mMap.get(7360)).toBeNull();
    expect(result.current.naiveDelta30mMap.get(7360)).toBeNull();
  });

  it('projects vol reinforcement from the matching SPX WS row', () => {
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
      availableSlots: [],
    });
    mockWs([
      makeWsRow({
        strike: 7350,
        call_gamma_oi: 100,
        put_gamma_oi: 50,
        call_gamma_vol: 30,
        put_gamma_vol: 5,
      }),
    ]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.strikes[0]?.volReinforcement).toBe('reinforcing');
  });

  it('returns empty strikes when MM primary has no slot', () => {
    mockPrimary({
      capturedAt: null,
      spot: null,
      strikes: [],
      availableSlots: [],
    });
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.strikes).toEqual([]);
  });

  it('uses WS-feed minute-resolution timestamps for the picker on live responses', () => {
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
      availableSlots: ['2026-05-12T18:30:00.000Z', '2026-05-12T18:40:00.000Z'],
    });
    vi.mocked(useGexStrikeExpirySpx).mockReturnValue({
      data: {
        ticker: 'SPX',
        expiry: '2026-05-12',
        at: null,
        rows: [],
        timestamps: [
          '2026-05-12T18:38:00.000Z',
          '2026-05-12T18:39:00.000Z',
          '2026-05-12T18:40:00.000Z',
        ],
        asOf: '2026-05-12T18:40:30.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    // WS timestamps win — picker shows minute resolution.
    expect(result.current.timestamps).toEqual([
      '2026-05-12T18:38:00.000Z',
      '2026-05-12T18:39:00.000Z',
      '2026-05-12T18:40:00.000Z',
    ]);
  });

  it('resets the cached picker list when expiry changes', () => {
    // useGexStrikeExpirySpx is sticky-on-empty, so without an explicit
    // reset the picker would briefly show the prior day's minute list
    // against the new chain. Verifies the cache wipes on expiry change.
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
      availableSlots: ['2026-05-12T18:30:00.000Z', '2026-05-12T18:40:00.000Z'],
    });
    const day1Timestamps = [
      '2026-05-12T18:38:00.000Z',
      '2026-05-12T18:39:00.000Z',
      '2026-05-12T18:40:00.000Z',
    ];
    vi.mocked(useGexStrikeExpirySpx).mockReturnValue({
      data: {
        ticker: 'SPX',
        expiry: '2026-05-12',
        at: null,
        rows: [],
        timestamps: day1Timestamps,
        asOf: '2026-05-12T18:40:30.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    // First render: day 1's live response populates the cache.
    const { result, rerender } = renderHook(
      ({ expiry }: { expiry: string }) =>
        useGexLandscapeData(true, expiry, null),
      { initialProps: { expiry: '2026-05-12' } },
    );
    expect(result.current.timestamps).toEqual(day1Timestamps);

    // Day 2 fetch hasn't completed yet, so MM has new availableSlots
    // but the sticky WS hook is still showing day 1's data.
    mockPrimary({
      capturedAt: '2026-05-13T18:40:00.000Z',
      spot: 7350,
      strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
      availableSlots: ['2026-05-13T18:30:00.000Z'],
    });
    // WS hook still returns day-1 data (sticky-on-empty).

    rerender({ expiry: '2026-05-13' });
    // Picker must NOT show day-1's cached minutes; should fall back
    // to MM availableSlots until the new live WS response lands.
    expect(result.current.timestamps).not.toEqual(day1Timestamps);
    expect(result.current.timestamps).toEqual(['2026-05-13T18:30:00.000Z']);
  });

  it('keeps the cached live picker list when a scrubbed WS response arrives', () => {
    // Repro of the "scrub → Live transient flash" the reviewer flagged:
    // after a scrub, `ws.data.timestamps` is truncated to `<= at`.
    // The hook should ignore truncated lists for the picker so the
    // dropdown doesn't briefly shrink between the Live click and the
    // next live poll.
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
      availableSlots: ['2026-05-12T18:30:00.000Z', '2026-05-12T18:40:00.000Z'],
    });
    const liveTimestamps = [
      '2026-05-12T18:38:00.000Z',
      '2026-05-12T18:39:00.000Z',
      '2026-05-12T18:40:00.000Z',
    ];

    // First render: live WS response → cache populates.
    vi.mocked(useGexStrikeExpirySpx).mockReturnValue({
      data: {
        ticker: 'SPX',
        expiry: '2026-05-12',
        at: null,
        rows: [],
        timestamps: liveTimestamps,
        asOf: '2026-05-12T18:40:30.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result, rerender } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.timestamps).toEqual(liveTimestamps);

    // Now simulate a scrubbed response landing: `at` is non-null and
    // `timestamps` is truncated. The picker MUST still show the
    // cached live list, not the truncated one.
    vi.mocked(useGexStrikeExpirySpx).mockReturnValue({
      data: {
        ticker: 'SPX',
        expiry: '2026-05-12',
        at: '2026-05-12T18:39:00.000Z',
        rows: [],
        timestamps: ['2026-05-12T18:39:00.000Z'],
        asOf: '2026-05-12T18:39:30.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    rerender();
    expect(result.current.timestamps).toEqual(liveTimestamps);
  });

  it('falls back to MM availableSlots when WS timestamps are empty', () => {
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [{ strike: 7350, gamma: 5000, charm: 0 }],
      availableSlots: ['2026-05-12T18:30:00.000Z', '2026-05-12T18:40:00.000Z'],
    });
    // WS data is defined but timestamps is empty (e.g. first paint
    // before WS feed has flushed any rows for this expiry).
    mockWs([]);

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.timestamps).toEqual([
      '2026-05-12T18:30:00.000Z',
      '2026-05-12T18:40:00.000Z',
    ]);
  });

  it('surfaces primary error before WS side-channel error', () => {
    mockPrimary(null, { error: 'periscope-strikes: HTTP 500' });
    mockWs([], 'WS down');

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.error).toBe('periscope-strikes: HTTP 500');
  });

  it('prefixes WS-only errors so the user knows vol reinforcement is degraded', () => {
    mockPrimary({
      capturedAt: '2026-05-12T18:40:00.000Z',
      spot: 7340,
      strikes: [],
      availableSlots: [],
    });
    mockWs([], 'HTTP 500');

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-12'),
    );
    expect(result.current.error).toBe('SPX vol reinforcement: HTTP 500');
  });
});
