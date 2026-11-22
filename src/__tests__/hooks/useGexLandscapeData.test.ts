/**
 * Unit tests for useGexLandscapeData (Phase 4 — 1-min GexBot rebuild).
 *
 * Mocks global fetch + getAccessMode so the hook can be exercised
 * without a network round-trip. The contract is single-source
 * (/api/gex-landscape) and the hook owns vol-reinforcement classification
 * during the same map-build pass — see `computeVolReinforcement` in
 * `classify.ts` for the agreement rule (Locked Decision #1).
 *
 * Coverage:
 *   - projectStrike: maps gamma/charm/vanna and threads the precomputed
 *     deltas into vol-reinforcement
 *   - Happy path: 2 strikes → 2 GexStrikeLevels with correct field mapping
 *   - Empty payload (data: null, reason: 'no_slot' / 'no_spot') → no strikes
 *   - Strike missing prev5m → null in gexDelta5mMap
 *   - Strike with |prev5m| < 50 (recalibrated noise floor) → null
 *   - Strike with positive delta → correct sign + magnitude
 *   - 401 → loading false, error stays null (matches the project's
 *     "public visitors stay idle" idiom)
 *   - Vol-reinforcement is computed from the same deltas the maps expose
 *   - Freshness: capture age at receipt = (ageSec + the `Age` header) × 1000,
 *     the server's marketOpen / reason, null before the first response and
 *     for any response fetched with `at` (keyed on the `at` it was fetched
 *     with, not the panel's current one)
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
import { act, renderHook, waitFor } from '@testing-library/react';

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
    gammaPrev5m: null,
    gammaPrev15m: null,
    gammaPrev30m: null,
    charmPrev5m: null,
    charmPrev15m: null,
    charmPrev30m: null,
    vannaPrev5m: null,
    vannaPrev15m: null,
    vannaPrev30m: null,
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

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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
      null,
      null,
      null,
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
      null,
      null,
      null,
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

  it('marks volReinforcement neutral when any delta is null', () => {
    const out = projectStrike(
      makeRow({ strike: 7350, gamma: 5000 }),
      7340,
      5,
      null,
      5,
    );
    expect(out.volReinforcement).toBe('neutral');
  });

  it('marks volReinforcement reinforcing when all three deltas agree with netGamma sign', () => {
    const out = projectStrike(
      makeRow({ strike: 7350, gamma: 5000 }),
      7340,
      4,
      6,
      8,
    );
    expect(out.volReinforcement).toBe('reinforcing');
  });

  it('marks volReinforcement opposing when all three deltas push against netGamma sign', () => {
    const out = projectStrike(
      makeRow({ strike: 7350, gamma: 5000 }),
      7340,
      -4,
      -6,
      -8,
    );
    expect(out.volReinforcement).toBe('opposing');
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
  it('computes positive Δ% from prev5m, prev15m, prev30m', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev5m: 4500,
                gammaPrev15m: 4000,
                gammaPrev30m: 3500,
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
    expect(result.current.gexDelta5mMap.get(7350)).toBeCloseTo(11.11, 1);
    // ((5000 - 4000) / |4000|) * 100 = 25
    expect(result.current.gexDelta15mMap.get(7350)).toBe(25);
    // ((5000 - 3500) / |3500|) * 100 ≈ 42.86
    expect(result.current.gexDelta30mMap.get(7350)).toBeCloseTo(42.86, 1);
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
                gammaPrev5m: -2_000_000_000,
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
    expect(result.current.gexDelta5mMap.get(7350)).toBe(50);
  });

  it('returns null in the delta map when prev5m is null', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev5m: null,
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
    expect(result.current.gexDelta5mMap.get(7350)).toBeNull();
  });

  it('returns null when |prev5m| is below DELTA_NOISE_FLOOR (50, recalibrated)', async () => {
    // |20| < 50 → null. Floor was retuned to GexBot scale (was 100 for MM scale).
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev5m: 20,
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
    expect(result.current.gexDelta5mMap.get(7350)).toBeNull();
  });

  it('passes a value just above the noise floor through', async () => {
    // |60| ≥ 50 → computed delta. Half the legacy MM floor; this would have
    // been muted before.
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 90,
                gammaPrev5m: 60,
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
    expect(result.current.gexDelta5mMap.get(7350)).toBe(50); // (90-60)/60 * 100
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
                gammaPrev5m: 0,
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
    expect(result.current.gexDelta5mMap.get(7350)).toBeNull();
  });
});

describe('useGexLandscapeData — vol-reinforcement', () => {
  it('strikes carry reinforcing when all three deltas agree with netGamma', async () => {
    // gamma 5000 with prev 4500/4000/3500 → all three deltas positive.
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev5m: 4500,
                gammaPrev15m: 4000,
                gammaPrev30m: 3500,
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
    expect(result.current.strikes[0]?.volReinforcement).toBe('reinforcing');
  });

  it('strikes carry neutral when a prev value is below the noise floor', async () => {
    // gammaPrev5m=20 is below floor 50 → delta5m is null → neutral.
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev5m: 20,
                gammaPrev15m: 4000,
                gammaPrev30m: 3500,
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
    expect(result.current.strikes[0]?.volReinforcement).toBe('neutral');
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

  it('return shape exposes only gexDelta5m/15m/30m maps (no legacy compat fields)', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [
              makeRow({
                strike: 7350,
                gamma: 5000,
                gammaPrev5m: 4500,
                gammaPrev15m: 4000,
                gammaPrev30m: 3500,
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
    // The post-Phase-4 return shape is just three populated maps.
    expect(result.current.gexDelta5mMap.size).toBe(1);
    expect(result.current.gexDelta15mMap.size).toBe(1);
    expect(result.current.gexDelta30mMap.size).toBe(1);
    // Legacy fields are gone — TS would have already caught this, but
    // assert at runtime so accidental re-additions surface in tests.
    expect('gexDeltaMap' in result.current).toBe(false);
    // The pre-correction names (1m/10m mislabelled the 5m/30m priors) are gone.
    expect('gexDelta1mMap' in result.current).toBe(false);
    expect('gexDelta10mMap' in result.current).toBe(false);
    expect('naiveDelta1mMap' in result.current).toBe(false);
    expect('naiveDelta5mMap' in result.current).toBe(false);
    expect('naiveDelta10mMap' in result.current).toBe(false);
    expect('naiveDelta30mMap' in result.current).toBe(false);
  });
});

describe('useGexLandscapeData — freshness', () => {
  const SCRUB_AT = '2026-05-26T18:30:00.000Z';
  const oneStrike = {
    spot: 7340,
    strikes: [makeRow({ strike: 7350, gamma: 5000 })],
  };

  it('is null before the first response lands', async () => {
    mockFetch(() => new Promise<Response>(() => undefined));
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.freshness).toBeNull();
  });

  it('adds ageSec and the Age header: ageSec 40 + Age 20 = 60 000 ms', async () => {
    mockFetch(() =>
      jsonResponse(makeResponse({ data: oneStrike, ageSec: 40 }), 200, {
        Age: '20',
      }),
    );
    const before = Date.now();
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    expect(result.current.freshness).toMatchObject({
      serverMarketOpen: true,
      reason: null,
      dataAgeMsAtReceipt: 60_000,
    });
    // receivedAt is the arrival time, used only as a delta by the panel.
    expect(result.current.freshness!.receivedAt).toBeGreaterThanOrEqual(before);
    expect(result.current.freshness!.receivedAt).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it('counts a missing Age header as 0', async () => {
    mockFetch(() =>
      jsonResponse(makeResponse({ data: oneStrike, ageSec: 40 })),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(40_000);
  });

  it.each([['garbage'], ['-5'], ['']])(
    'counts an unusable Age header (%j) as 0',
    async (age) => {
      mockFetch(() =>
        jsonResponse(makeResponse({ data: oneStrike, ageSec: 40 }), 200, {
          Age: age,
        }),
      );
      const { result } = renderHook(() =>
        useGexLandscapeData(true, '2026-05-26'),
      );
      await waitFor(() => expect(result.current.freshness).not.toBeNull());
      expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(40_000);
    },
  );

  it('has no data age when a data response carries no ageSec', async () => {
    // JSON.stringify drops the undefined field, so the body has no ageSec.
    mockFetch(() =>
      jsonResponse(makeResponse({ data: oneStrike, ageSec: undefined }), 200, {
        Age: '20',
      }),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    expect(result.current.freshness?.dataAgeMsAtReceipt).toBeNull();
  });

  it.each([['no_slot' as const], ['no_spot' as const]])(
    'a %s response yields its reason and no data age, whatever the Age header says',
    async (reason) => {
      mockFetch(() =>
        jsonResponse(
          makeResponse({ data: null, reason, ageSec: undefined }),
          200,
          {
            Age: '20',
          },
        ),
      );
      const { result } = renderHook(() =>
        useGexLandscapeData(true, '2026-05-26'),
      );
      await waitFor(() => expect(result.current.freshness).not.toBeNull());
      expect(result.current.freshness).toMatchObject({
        reason,
        dataAgeMsAtReceipt: null,
      });
    },
  );

  it.each([[true], [false]])(
    'serverMarketOpen follows the response (marketOpen: %s)',
    async (open) => {
      mockFetch(() =>
        jsonResponse(makeResponse({ marketOpen: open, data: oneStrike })),
      );
      const { result } = renderHook(() =>
        useGexLandscapeData(true, '2026-05-26'),
      );
      await waitFor(() => expect(result.current.freshness).not.toBeNull());
      expect(result.current.freshness?.serverMarketOpen).toBe(open);
    },
  );

  it('is null for a scrubbed (at) fetch, though the response carries data', async () => {
    mockFetch(() =>
      jsonResponse(makeResponse({ data: oneStrike, ageSec: 12 }), 200, {
        Age: '3',
      }),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26', SCRUB_AT),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.freshness).toBeNull();
  });

  it('after leaving a scrub, stays null until the live response lands, then reflects it', async () => {
    let releaseLive: ((r: Response) => void) | undefined;
    mockFetch((url) => {
      if (url.includes('at=')) {
        return jsonResponse(makeResponse({ data: oneStrike, ageSec: 900 }));
      }
      return new Promise<Response>((resolve) => {
        releaseLive = resolve;
      });
    });
    const { result, rerender } = renderHook(
      ({ at }: { at: string | null }) =>
        useGexLandscapeData(true, '2026-05-26', at),
      { initialProps: { at: SCRUB_AT as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.freshness).toBeNull();

    rerender({ at: null });
    await waitFor(() => expect(releaseLive).toBeDefined());
    // The live request is in flight; the stored response is still the
    // scrubbed one, so its age must not surface as live freshness.
    expect(result.current.freshness).toBeNull();

    await act(async () => {
      releaseLive?.(
        jsonResponse(makeResponse({ data: oneStrike, ageSec: 12 }), 200, {
          Age: '3',
        }),
      );
    });
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(15_000);
  });

  it('goes null again once a scrubbed response replaces a live one', async () => {
    mockFetch((url) =>
      jsonResponse(
        makeResponse({
          data: oneStrike,
          ageSec: url.includes('at=') ? 900 : 12,
        }),
      ),
    );
    const { result, rerender } = renderHook(
      ({ at }: { at: string | null }) =>
        useGexLandscapeData(true, '2026-05-26', at),
      { initialProps: { at: null as string | null } },
    );
    await waitFor(() =>
      expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(12_000),
    );
    rerender({ at: SCRUB_AT });
    await waitFor(() => expect(result.current.freshness).toBeNull());
  });

  it('is null on a 401 (public-visitor idiom)', async () => {
    mockFetch(() => new Response('Unauthorized', { status: 401 }));
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.freshness).toBeNull();
  });

  it('keeps the last live freshness when a later poll fails, and reports the error', async () => {
    let call = 0;
    mockFetch(() => {
      call += 1;
      return call === 1
        ? jsonResponse(makeResponse({ data: oneStrike, ageSec: 12 }))
        : new Response('Server Error', { status: 500 });
    });
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    act(() => result.current.refresh());
    await waitFor(() =>
      expect(result.current.error).toBe('gex-landscape: HTTP 500'),
    );
    expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(12_000);
  });

  // R4: a good response, then a refresh that fails two other ways. Each
  // surfaces its error by name and keeps the last live freshness and strikes.
  it('keeps the last live freshness and reports a JSON error when a 2xx body is not JSON', async () => {
    let call = 0;
    mockFetch(() => {
      call += 1;
      return call === 1
        ? jsonResponse(makeResponse({ data: oneStrike, ageSec: 12 }))
        : new Response('not json', { status: 200 });
    });
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toMatch(/JSON/));
    expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(12_000);
    expect(result.current.strikes).toHaveLength(1);
  });

  it('keeps the last live freshness and reports "Failed to fetch" when fetch rejects', async () => {
    let call = 0;
    mockFetch(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse(makeResponse({ data: oneStrike, ageSec: 12 }));
      }
      throw new TypeError('Failed to fetch');
    });
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBe('Failed to fetch'));
    expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(12_000);
    expect(result.current.strikes).toHaveLength(1);
  });
});

// On `no_slot` there is no capture to measure, so the panel needs the last
// capture minute's age on the SERVER's clock: asOf (the server's `new Date()`
// on that reply) minus the day's last availableMinutes entry, plus the edge
// `Age`. The client clock never enters.
describe('useGexLandscapeData — lastCaptureAgeMsAtReceipt (no_slot)', () => {
  const noSlot = (over: Partial<GexLandscapeResponse> = {}) =>
    makeResponse({
      data: null,
      reason: 'no_slot',
      ageSec: undefined,
      asOf: '2026-11-20T15:30:10.000Z',
      availableMinutes: [
        '2026-11-20T15:27:00.000Z',
        '2026-11-20T15:28:00.000Z',
      ],
      ...over,
    });

  async function freshnessOfResponse(
    body: GexLandscapeResponse,
    headers: Record<string, string> = {},
  ) {
    mockFetch(() => jsonResponse(body, 200, headers));
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    return result.current.freshness!;
  }

  it('is asOf minus the last capture minute plus the Age header: 130 s + 5 s = 135 000 ms', async () => {
    const f = await freshnessOfResponse(noSlot(), { Age: '5' });
    expect(f.lastCaptureAgeMsAtReceipt).toBe(135_000);
    expect(f.dataAgeMsAtReceipt).toBeNull();
    expect(f.reason).toBe('no_slot');
  });

  it('counts a missing Age header as 0', async () => {
    const f = await freshnessOfResponse(noSlot());
    expect(f.lastCaptureAgeMsAtReceipt).toBe(130_000);
  });

  it('does not depend on the client clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2001-01-01T00:00:00.000Z'));
    const f = await freshnessOfResponse(noSlot(), { Age: '5' });
    expect(f.lastCaptureAgeMsAtReceipt).toBe(135_000);
  });

  it('is never negative when the last minute stamp is ahead of asOf', async () => {
    const f = await freshnessOfResponse(
      noSlot({ asOf: '2026-11-20T15:20:00.000Z' }),
      { Age: '5' },
    );
    expect(f.lastCaptureAgeMsAtReceipt).toBe(5_000);
  });

  it.each([
    ['no captures today', { availableMinutes: [] }],
    ['an unparseable last minute', { availableMinutes: ['garbage'] }],
    ['an unparseable asOf', { asOf: 'garbage' }],
    ['a no_spot reply', { reason: 'no_spot' as const }],
  ])('is null for %s', async (_label, over) => {
    const f = await freshnessOfResponse(noSlot(over), { Age: '5' });
    expect(f.lastCaptureAgeMsAtReceipt).toBeNull();
  });

  // R4: a malformed reply. The body is an unchecked cast, so a `no_slot` reply
  // can arrive without the list. That is "no capture minute", not a throw
  // inside the freshness build (which the fetch's catch would turn into an
  // error banner and a lost response).
  it('treats a no_slot body with no availableMinutes field as no capture minute, with no error', async () => {
    mockFetch(() =>
      jsonResponse(
        // JSON.stringify drops an undefined field, so the body lacks the key.
        noSlot({ availableMinutes: undefined as unknown as string[] }),
        200,
        { Age: '5' },
      ),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.freshness).not.toBeNull());
    expect(result.current.freshness?.reason).toBe('no_slot');
    expect(result.current.freshness?.lastCaptureAgeMsAtReceipt).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.timestamps).toEqual([]);
  });

  it('is null on a response that carries data', async () => {
    const f = await freshnessOfResponse(
      makeResponse({
        data: { spot: 7340, strikes: [makeRow({ strike: 7350, gamma: 1 })] },
        ageSec: 40,
      }),
      { Age: '5' },
    );
    expect(f.lastCaptureAgeMsAtReceipt).toBeNull();
    expect(f.dataAgeMsAtReceipt).toBe(45_000);
  });
});

// C1 (the render loop). The panel's effects depend on the identity of these
// values (`timestamps` is mirrored into state by an effect; `strikes` feeds
// the Top 5 tracker through `topFive`), so a render with no new response must
// hand back the very same references. Built inline per render, they loop.
describe('useGexLandscapeData — derived values are stable between responses', () => {
  const oneStrike = {
    spot: 7340,
    strikes: [
      makeRow({ strike: 7350, gamma: 5000, gammaPrev5m: 4500 }),
      makeRow({ strike: 7375, gamma: 3000, gammaPrev5m: 2500 }),
    ],
  };

  it.each([
    [
      'a stored response',
      () => jsonResponse(makeResponse({ data: oneStrike })),
      true,
      2,
    ],
    ['a pending fetch', () => new Promise<Response>(() => undefined), false, 0],
    ['a 401', () => new Response('Unauthorized', { status: 401 }), true, 0],
  ])(
    'a rerender with no new response returns the same arrays and Maps (%s)',
    async (_label, respond, settles, rowCount) => {
      mockFetch(respond);
      let renders = 0;
      const { result, rerender } = renderHook(() => {
        renders += 1;
        return useGexLandscapeData(true, '2026-05-26');
      });
      if (settles) {
        await waitFor(() => expect(result.current.loading).toBe(false));
      } else {
        expect(result.current.loading).toBe(true);
      }
      expect(result.current.strikes).toHaveLength(rowCount);
      const first = result.current;
      const rendersBefore = renders;

      rerender();
      rerender();

      expect(renders).toBeGreaterThan(rendersBefore);
      expect(result.current.strikes).toBe(first.strikes);
      expect(result.current.timestamps).toBe(first.timestamps);
      expect(result.current.gexDelta5mMap).toBe(first.gexDelta5mMap);
      expect(result.current.gexDelta15mMap).toBe(first.gexDelta15mMap);
      expect(result.current.gexDelta30mMap).toBe(first.gexDelta30mMap);
    },
  );

  it('builds new ones when a new response lands', async () => {
    let call = 0;
    mockFetch(() => {
      call += 1;
      return jsonResponse(
        makeResponse({
          data: {
            spot: 7340,
            strikes: [makeRow({ strike: 7350, gamma: 5000 * call })],
          },
        }),
      );
    });
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-05-26'),
    );
    await waitFor(() => expect(result.current.strikes).toHaveLength(1));
    const first = result.current.strikes;

    act(() => result.current.refresh());
    await waitFor(() =>
      expect(result.current.strikes[0]?.netGamma).toBe(10_000),
    );
    expect(result.current.strikes).not.toBe(first);
  });
});

// I1. `usePolling` never fetches when its gates flip, so a panel left open
// across the open would hold the previous session's response until the first
// poll, a minute later. A session edge refetches at once.
describe('useGexLandscapeData — session edge', () => {
  it('refetches at once when marketOpen flips, open or close, with no timer advance', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(
        makeResponse({
          data: { spot: 7340, strikes: [makeRow({ strike: 7350, gamma: 1 })] },
          ageSec: calls.length === 1 ? 40 : 5,
        }),
      );
    });
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useGexLandscapeData(open, '2026-05-26'),
      { initialProps: { open: false } },
    );
    await waitFor(() =>
      expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(40_000),
    );
    expect(calls).toHaveLength(1);

    // The open: the fetch is issued as the effect runs, before any timer.
    rerender({ open: true });
    expect(calls).toHaveLength(2);
    await waitFor(() =>
      expect(result.current.freshness?.dataAgeMsAtReceipt).toBe(5_000),
    );

    // The close is an edge too; a rerender that changes nothing is not.
    rerender({ open: false });
    expect(calls).toHaveLength(3);
    rerender({ open: false });
    expect(calls).toHaveLength(3);
    expect(calls.every((u) => u === '/api/gex-landscape')).toBe(true);
  });
});
