/**
 * Unit tests for the WS-row → GexStrikeLevel projection and the
 * per-window Δ% map projection that together power `useGexLandscapeData`.
 *
 * The projection helpers stay pure functions (testable without React);
 * the delta-map plumbing through the hook itself is exercised via
 * `renderHook` with `useGexStrikeExpiry` mocked, so we don't take a
 * network round-trip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  projectExpiryRowToStrike,
  useGexLandscapeData,
} from '../../hooks/useGexLandscapeData';
import type { GexStrikeExpiryRow } from '../../hooks/useGexStrikeExpiry';

// Mock useGexStrikeExpiry so the consumer hook can be tested without a
// network round-trip. The mock returns a per-test-controlled payload.
vi.mock('../../hooks/useGexStrikeExpiry', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useGexStrikeExpiry')
  >('../../hooks/useGexStrikeExpiry');
  return {
    ...actual,
    useGexStrikeExpiry: vi.fn(),
  };
});

import { useGexStrikeExpiry } from '../../hooks/useGexStrikeExpiry';

function makeRow(
  overrides: Partial<GexStrikeExpiryRow> = {},
): GexStrikeExpiryRow {
  return {
    ticker: 'SPY',
    expiry: '2026-05-04',
    strike: 720,
    ts_minute: '2026-05-04T19:30:00.000Z',
    price: 722.5,
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

describe('projectExpiryRowToStrike', () => {
  it('renames bid/ask vol fields to GexStrikeLevel naming', () => {
    const row = makeRow({
      call_gamma_ask_vol: 1234,
      call_gamma_bid_vol: -567,
      put_gamma_ask_vol: 89,
      put_gamma_bid_vol: -42,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.callGammaAsk).toBe(1234);
    expect(out.callGammaBid).toBe(-567);
    expect(out.putGammaAsk).toBe(89);
    expect(out.putGammaBid).toBe(-42);
  });

  it('passes strike + price through unchanged', () => {
    const row = makeRow({ strike: 5310, price: 5318.42 });
    const out = projectExpiryRowToStrike(row);
    expect(out.strike).toBe(5310);
    expect(out.price).toBe(5318.42);
  });

  it('derives netGamma / netCharm / netVanna from call+put OI sums', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: -50,
      call_charm_oi: 200,
      put_charm_oi: 75,
      call_vanna_oi: -30,
      put_vanna_oi: 15,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBe(50);
    expect(out.netCharm).toBe(275);
    expect(out.netVanna).toBe(-15);
  });

  it('derives netGammaVol / netCharmVol / netVannaVol from call+put vol sums', () => {
    const row = makeRow({
      call_gamma_vol: 10,
      put_gamma_vol: -3,
      call_charm_vol: 5,
      put_charm_vol: 8,
      call_vanna_vol: -2,
      put_vanna_vol: 1,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGammaVol).toBe(7);
    expect(out.netCharmVol).toBe(13);
    expect(out.netVannaVol).toBe(-1);
  });

  it('marks volReinforcement reinforcing when netGammaOi and netGammaVol agree (positive)', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: 50,
      call_gamma_vol: 20,
      put_gamma_vol: 5,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBeGreaterThan(0);
    expect(out.netGammaVol).toBeGreaterThan(0);
    expect(out.volReinforcement).toBe('reinforcing');
  });

  it('marks volReinforcement reinforcing when both nets are negative', () => {
    const row = makeRow({
      call_gamma_oi: -100,
      put_gamma_oi: -50,
      call_gamma_vol: -20,
      put_gamma_vol: -5,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBeLessThan(0);
    expect(out.netGammaVol).toBeLessThan(0);
    expect(out.volReinforcement).toBe('reinforcing');
  });

  it('marks volReinforcement opposing when nets disagree in sign', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: 50,
      call_gamma_vol: -20,
      put_gamma_vol: -5,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBeGreaterThan(0);
    expect(out.netGammaVol).toBeLessThan(0);
    expect(out.volReinforcement).toBe('opposing');
  });

  it('marks volReinforcement neutral when net OI is exactly zero', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: -100,
      call_gamma_vol: 50,
      put_gamma_vol: 25,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBe(0);
    expect(out.volReinforcement).toBe('neutral');
  });

  it('marks volReinforcement neutral when net vol is exactly zero', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: 50,
      call_gamma_vol: 25,
      put_gamma_vol: -25,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGammaVol).toBe(0);
    expect(out.volReinforcement).toBe('neutral');
  });

  it('coalesces null inputs to 0 across every numeric field', () => {
    const row: GexStrikeExpiryRow = {
      ticker: 'SPY',
      expiry: '2026-05-04',
      strike: 720,
      ts_minute: '2026-05-04T19:30:00.000Z',
      price: null,
      call_gamma_oi: null,
      put_gamma_oi: null,
      call_charm_oi: null,
      put_charm_oi: null,
      call_vanna_oi: null,
      put_vanna_oi: null,
      call_gamma_vol: null,
      put_gamma_vol: null,
      call_charm_vol: null,
      put_charm_vol: null,
      call_vanna_vol: null,
      put_vanna_vol: null,
      call_gamma_ask_vol: null,
      call_gamma_bid_vol: null,
      put_gamma_ask_vol: null,
      put_gamma_bid_vol: null,
      call_charm_ask_vol: null,
      call_charm_bid_vol: null,
      put_charm_ask_vol: null,
      put_charm_bid_vol: null,
      call_vanna_ask_vol: null,
      call_vanna_bid_vol: null,
      put_vanna_ask_vol: null,
      put_vanna_bid_vol: null,
      gamma_delta_1m: null,
      gamma_delta_5m: null,
      gamma_delta_10m: null,
      gamma_delta_15m: null,
      gamma_delta_30m: null,
    };
    const out = projectExpiryRowToStrike(row);
    expect(out.price).toBe(0);
    expect(out.callGammaOi).toBe(0);
    expect(out.putGammaOi).toBe(0);
    expect(out.netGamma).toBe(0);
    expect(out.callGammaVol).toBe(0);
    expect(out.putGammaVol).toBe(0);
    expect(out.netGammaVol).toBe(0);
    expect(out.callGammaAsk).toBe(0);
    expect(out.callGammaBid).toBe(0);
    expect(out.putGammaAsk).toBe(0);
    expect(out.putGammaBid).toBe(0);
    expect(out.callCharmOi).toBe(0);
    expect(out.putCharmOi).toBe(0);
    expect(out.netCharm).toBe(0);
    expect(out.callCharmVol).toBe(0);
    expect(out.putCharmVol).toBe(0);
    expect(out.netCharmVol).toBe(0);
    expect(out.callVannaOi).toBe(0);
    expect(out.putVannaOi).toBe(0);
    expect(out.netVanna).toBe(0);
    expect(out.callVannaVol).toBe(0);
    expect(out.putVannaVol).toBe(0);
    expect(out.netVannaVol).toBe(0);
    expect(out.volReinforcement).toBe('neutral');
  });

  it('defaults delta fields to 0 (no NaN) since the WS channel does not publish them', () => {
    const row = makeRow({ call_gamma_oi: 100, put_gamma_oi: 50 });
    const out = projectExpiryRowToStrike(row);
    expect(out.callDeltaOi).toBe(0);
    expect(out.putDeltaOi).toBe(0);
    expect(out.netDelta).toBe(0);
    expect(Number.isNaN(out.callDeltaOi)).toBe(false);
    expect(Number.isNaN(out.putDeltaOi)).toBe(false);
    expect(Number.isNaN(out.netDelta)).toBe(false);
  });
});

describe('useGexLandscapeData — Δ% maps from server-side LAG', () => {
  beforeEach(() => {
    vi.mocked(useGexStrikeExpiry).mockReset();
  });

  function mockResponse(rows: GexStrikeExpiryRow[]): void {
    vi.mocked(useGexStrikeExpiry).mockReturnValue({
      data: {
        SPY: {
          ticker: 'SPY',
          expiry: '2026-05-04',
          at: null,
          rows,
          timestamps: [],
          asOf: '2026-05-04T19:31:00.000Z',
        },
        QQQ: null,
        SPX: null,
        NDX: null,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  }

  it('keys each delta map by strike and lifts gamma_delta_* fields through unchanged', () => {
    mockResponse([
      makeRow({
        strike: 720,
        gamma_delta_1m: 1.25,
        gamma_delta_5m: 4.0,
        gamma_delta_10m: 7.5,
        gamma_delta_15m: 12,
        gamma_delta_30m: 22,
      }),
      makeRow({
        strike: 725,
        gamma_delta_1m: -0.5,
        gamma_delta_5m: -2.1,
        gamma_delta_10m: -3.2,
        gamma_delta_15m: -4.4,
        gamma_delta_30m: -8,
      }),
    ]);

    const { result } = renderHook(() =>
      useGexLandscapeData('SPY', true, '2026-05-04'),
    );

    expect(result.current.gexDeltaMap.get(720)).toBe(1.25);
    expect(result.current.gexDelta5mMap.get(720)).toBe(4.0);
    expect(result.current.gexDelta10mMap.get(720)).toBe(7.5);
    expect(result.current.gexDelta15mMap.get(720)).toBe(12);
    expect(result.current.gexDelta30mMap.get(720)).toBe(22);

    expect(result.current.gexDeltaMap.get(725)).toBe(-0.5);
    expect(result.current.gexDelta5mMap.get(725)).toBe(-2.1);
    expect(result.current.gexDelta10mMap.get(725)).toBe(-3.2);
    expect(result.current.gexDelta15mMap.get(725)).toBe(-4.4);
    expect(result.current.gexDelta30mMap.get(725)).toBe(-8);
  });

  it('preserves null deltas (no fallback to 0) so the table can render an em-dash', () => {
    mockResponse([
      makeRow({
        strike: 720,
        gamma_delta_1m: 1.25,
        gamma_delta_5m: null,
        gamma_delta_10m: null,
        gamma_delta_15m: null,
        gamma_delta_30m: null,
      }),
    ]);

    const { result } = renderHook(() =>
      useGexLandscapeData('SPY', true, '2026-05-04'),
    );

    expect(result.current.gexDeltaMap.get(720)).toBe(1.25);
    expect(result.current.gexDelta5mMap.get(720)).toBeNull();
    expect(result.current.gexDelta10mMap.get(720)).toBeNull();
    expect(result.current.gexDelta15mMap.get(720)).toBeNull();
    expect(result.current.gexDelta30mMap.get(720)).toBeNull();
  });

  it('returns empty maps when the requested ticker has no payload', () => {
    vi.mocked(useGexStrikeExpiry).mockReturnValue({
      data: { SPY: null, QQQ: null, SPX: null, NDX: null },
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    const { result } = renderHook(() =>
      useGexLandscapeData('SPY', true, '2026-05-04'),
    );

    expect(result.current.strikes).toEqual([]);
    expect(result.current.gexDeltaMap.size).toBe(0);
    expect(result.current.gexDelta5mMap.size).toBe(0);
    expect(result.current.gexDelta10mMap.size).toBe(0);
    expect(result.current.gexDelta15mMap.size).toBe(0);
    expect(result.current.gexDelta30mMap.size).toBe(0);
  });

  it('builds maps stably across renders when sourceRows reference is unchanged', () => {
    const rows = [
      makeRow({ strike: 720, gamma_delta_1m: 2.5 }),
      makeRow({ strike: 725, gamma_delta_1m: -1 }),
    ];
    mockResponse(rows);

    const { result, rerender } = renderHook(() =>
      useGexLandscapeData('SPY', true, '2026-05-04'),
    );

    const firstMap = result.current.gexDeltaMap;
    rerender();
    // Same source rows array → memoized map keeps identity, avoiding
    // downstream re-render loops in BiasPanel / StrikeTable.
    expect(result.current.gexDeltaMap).toBe(firstMap);
  });
});
