/**
 * Unit tests for useGexLandscapeData (Phase 2 — 1-min GexBot rebuild).
 *
 * Mocks global fetch + getAccessMode so the hook can be exercised
 * without a network round-trip. The new contract is single-source
 * (/api/gex-landscape) so the surface is much simpler than the
 * legacy MM+WS dual-path tests this file replaces.
 *
 * Coverage:
 *   - Happy path: 2 strikes → 2 GexStrikeLevels with correct field mapping
 *   - Empty payload (data: null, reason: 'no_slot') → no strikes, no error
 *   - Strike missing prev1m → null in gexDeltaMap
 *   - Strike with |prev1m| < 100 (noise floor) → null in gexDeltaMap
 *   - Strike with positive delta → correct sign + magnitude
 *   - 401 → loading false, error stays null (matches the project's
 *     "public visitors stay idle" idiom)
 *   - Phase 2 compat: naive maps + 15m/30m maps are all empty
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockGetAccessMode } = vi.hoisted(() => ({
  mockGetAccessMode: vi.fn(),
}));

vi.mock('../../utils/auth', () => ({
  getAccessMode: mockGetAccessMode,
}));

import {
  projectStrike,
  useGexLandscapeData,
  type GexLandscapeResponse,
  type GexLandscapeStrikeRow,
} from '../../hooks/useGexLandscapeData';

function makeRow(
  overrides: Partial<GexLandscapeStrikeRow> = {},
): GexLandscapeStrikeRow {
  return {
    strike: 7350,
    gamma: 0,
    charm: 0,
    vanna: 0,
    gammaPrev1m: null,
    gammaPrev5m: null,
    gammaPrev10m: null,
    charmPrev1m: null,
    charmPrev5m: null,
    charmPrev10m: null,
    vannaPrev1m: null,
    vannaPrev5m: null,
    vannaPrev10m: null,
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<GexLandscapeResponse> = {},
): GexLandscapeResponse {
  return {
    marketOpen: true,
    asOf: '2026-05-26T18:40:00.000Z',
    data: {
      strikes: [],
      spot: 7340,
    },
    ageSec: 5,
    availableMinutes: [
      '2026-05-26T18:38:00.000Z',
      '2026-05-26T18:39:00.000Z',
      '2026-05-26T18:40:00.000Z',
    ],
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(
  handler: (url: string) => Response | Promise<Response>,
): MockInstance {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  mockGetAccessMode.mockReturnValue('owner');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('projectStrike', () => {
  it('maps gamma/charm/vanna into the netGamma/netCharm/netVanna slots', () => {
    const out = projectStrike(
      makeRow({
        strike: 7350,
        gamma: -2_500_000_000,
        charm: 7_800_000_000,
        vanna: 1_200_000_000,
      }),
      7340.5,
    );
    expect(out.strike).toBe(7350);
    expect(out.price).toBe(7340.5);
    expect(out.netGamma).toBe(-2_500_000_000);
    expect(out.netCharm).toBe(7_800_000_000);
    expect(out.netVanna).toBe(1_200_000_000);
  });

  it('zeroes every call/put split + vol field (WS side channel is gone)', () => {
    const out = projectStrike(
      makeRow({ strike: 7350, gamma: 5000, charm: 1000, vanna: 50 }),
      7340,
    );
    expect(out.callGammaOi).toBe(0);
    expect(out.putGammaOi).toBe(0);
    expect(out.callCharmOi).toBe(0);
    expect(out.putCharmOi).toBe(0);
    expect(out.callVannaOi).toBe(0);
    expect(out.putVannaOi).toBe(0);
    expect(out.callGammaVol).toBe(0);
    expect(out.putGammaVol).toBe(0);
    expect(out.callGammaAsk).toBe(0);
    expect(out.callGammaBid).toBe(0);
    expect(out.netDelta).toBe(0);
    expect(out.netGammaVol).toBe(0);
    expect(out.netCharmVol).toBe(0);
    expect(out.netVannaVol).toBe(0);
  });

  it('marks volReinforcement neutral (Phase 3 redefines this signal)', () => {
    const out = projectStrike(makeRow({ strike: 7350, gamma: 5000 }), 7340);
    expect(out.volReinforcement).toBe('neutral');
  });
});

describe('useGexLandscapeData — happy path', () => {
  it('fetches once and projects each strike row into a GexStrikeLevel', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(
        makeResponse({
          data: {
            spot: 7340.5,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                charm: -2000,
                vanna: 100,
              }),
              makeRow({
                strike: 7375,
                gamma: 3000,
                charm: 1500,
                vanna: 50,
              }),
            ],
          },
        }),
      );
    });

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('/api/gex-landscape');
    expect(result.current.strikes).toHaveLength(2);
    expect(result.current.strikes[0]).toMatchObject({
      strike: 7350,
      price: 7340.5,
      netGamma: 5000,
      netCharm: -2000,
      netVanna: 100,
    });
    expect(result.current.strikes[1]).toMatchObject({
      strike: 7375,
      price: 7340.5,
      netGamma: 3000,
      netCharm: 1500,
      netVanna: 50,
    });
    expect(result.current.error).toBeNull();
  });

  it('passes ?at=ISO when a scrub timestamp is provided', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(makeResponse());
    });

    renderHook(() =>
      useGexLandscapeData(true, '2026-05-26', '2026-05-26T18:30:00.000Z'),
    );

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain('at=');
    expect(decodeURIComponent(calls[0] ?? '')).toContain(
      '2026-05-26T18:30:00.000Z',
    );
  });

  it('exposes the endpoint availableMinutes as `timestamps`', async () => {
    const minutes = [
      '2026-05-26T18:38:00.000Z',
      '2026-05-26T18:39:00.000Z',
      '2026-05-26T18:40:00.000Z',
    ];
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          availableMinutes: minutes,
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timestamps).toEqual(minutes);
  });
});

describe('useGexLandscapeData — delta maps', () => {
  it('computes positive Δ% from prev1m, prev5m, prev10m', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev1m: 4500,
                gammaPrev5m: 4000,
                gammaPrev10m: 3500,
              }),
            ],
          },
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // ((5000 - 4500) / |4500|) * 100 ≈ 11.11
    expect(result.current.gexDeltaMap.get(7350)).toBeCloseTo(11.11, 1);
    // ((5000 - 4000) / |4000|) * 100 = 25
    expect(result.current.gexDelta5mMap.get(7350)).toBe(25);
    // ((5000 - 3500) / |3500|) * 100 ≈ 42.86
    expect(result.current.gexDelta10mMap.get(7350)).toBeCloseTo(42.86, 1);
  });

  it('preserves negative-prev sign convention (|prev| in denominator)', async () => {
    // Negative-gamma regime: prior -2B, current -1B → gamma becoming
    // less negative → delta should be +50, not -50.
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: -1_000_000_000,
                gammaPrev1m: -2_000_000_000,
              }),
            ],
          },
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gexDeltaMap.get(7350)).toBe(50);
  });

  it('returns null in the delta map when prev1m is null', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev1m: null,
              }),
            ],
          },
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gexDeltaMap.get(7350)).toBeNull();
  });

  it('returns null when |prev1m| is below DELTA_NOISE_FLOOR (100)', async () => {
    // |50| < 100 → null. Stops a +5000 strike against a noise-floor
    // prior from reading 10,000% Δ.
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev1m: 50,
              }),
            ],
          },
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gexDeltaMap.get(7350)).toBeNull();
  });

  it('returns null when prev gamma is exactly 0 (no divide by zero)', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev1m: 0,
              }),
            ],
          },
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gexDeltaMap.get(7350)).toBeNull();
  });
});

describe('useGexLandscapeData — edge cases', () => {
  it('returns empty strikes when endpoint reports no_slot', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: null,
          reason: 'no_slot',
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.strikes).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('returns empty strikes when endpoint reports no_spot', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: null,
          reason: 'no_spot',
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.strikes).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('on 401 leaves error null and strikes empty (matches public-visitor idiom)', async () => {
    mockFetch(() => new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.strikes).toEqual([]);
  });

  it('on 500 sets error and stops loading', async () => {
    mockFetch(() => new Response('Server Error', { status: 500 }));

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() =>
      expect(result.current.error).toBe('gex-landscape: HTTP 500'),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.strikes).toEqual([]);
  });

  it('Phase 2 compat: naive + 15m + 30m maps are empty', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev1m: 4500,
                gammaPrev5m: 4000,
                gammaPrev10m: 3500,
              }),
            ],
          },
        }),
      ),
    );

    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gexDelta15mMap.size).toBe(0);
    expect(result.current.gexDelta30mMap.size).toBe(0);
    expect(result.current.naiveDelta1mMap.size).toBe(0);
    expect(result.current.naiveDelta5mMap.size).toBe(0);
    expect(result.current.naiveDelta10mMap.size).toBe(0);
    expect(result.current.naiveDelta30mMap.size).toBe(0);
  });
});
