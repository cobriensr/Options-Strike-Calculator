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
 *   - After the close (spec: gexbot-after-close-design): `asOf` exposed; a
 *     body from before today's open dropped at render once the market is
 *     open; the final fetch at close + 3 min; a failed fetch while closed
 *     keeping the held response with no error and retrying 5 × 30 s; one
 *     refetch when the ET date argument rolls; the `no_slot` stall age read
 *     from the body's `lastMinuteAgeSec`. A scrub (`at` set) ignores all of it.
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
import { StrictMode } from 'react';
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

// Tue 2026-05-26 14:45 ET, mid-session. The hook drops a live body from before
// today's open once the market is open, and arms a timer for 16:03 ET, so a test
// on the wall clock would change with the hour and day it ran at. `toFake:
// ['Date']` leaves setTimeout, and so `waitFor`, alone. Tests that need the
// timers run on `fakeClock`.
const IN_SESSION = '2026-05-26T18:45:00.000Z';

beforeEach(() => {
  mockGetAccessMode.mockReturnValue('owner');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(IN_SESSION));
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

// On `no_slot` there is no capture to measure and `asOf` is null (no capture
// backs the reply), so the panel needs the last capture minute's age on the
// SERVER's clock: the body's `lastMinuteAgeSec` (server now minus the last
// availableMinutes entry), plus the edge `Age`. The client clock never enters.
describe('useGexLandscapeData — lastCaptureAgeMsAtReceipt (no_slot)', () => {
  // Fri 2026-11-20 10:30:10 ET, in session: nothing here is carried over.
  const SESSION_NOW = '2026-11-20T15:30:10.000Z';

  beforeEach(() => {
    vi.setSystemTime(new Date(SESSION_NOW));
  });

  const noSlot = (over: Partial<GexLandscapeResponse> = {}) =>
    makeResponse({
      data: null,
      reason: 'no_slot',
      ageSec: undefined,
      asOf: null,
      lastMinuteAgeSec: 130,
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

  it('is the body’s lastMinuteAgeSec plus the Age header: 130 s + 5 s = 135 000 ms', async () => {
    const f = await freshnessOfResponse(noSlot(), { Age: '5' });
    expect(f.lastCaptureAgeMsAtReceipt).toBe(135_000);
    expect(f.dataAgeMsAtReceipt).toBeNull();
    expect(f.reason).toBe('no_slot');
  });

  it('a 360 s stall with asOf null reads 360 000 ms plus the edge age', async () => {
    const f = await freshnessOfResponse(noSlot({ lastMinuteAgeSec: 360 }), {
      Age: '7',
    });
    expect(f.lastCaptureAgeMsAtReceipt).toBe(367_000);
  });

  it('counts a missing Age header as 0', async () => {
    const f = await freshnessOfResponse(noSlot());
    expect(f.lastCaptureAgeMsAtReceipt).toBe(130_000);
  });

  // The server measured the age. A client clock hours ahead of the capture
  // minutes (same session, so the body is not carried over) or in 2001 changes
  // nothing.
  it.each([
    ['the year 2001', '2001-01-01T00:00:00.000Z'],
    ['five hours past the capture minute', '2026-11-20T20:30:00.000Z'],
  ])('does not depend on the client clock (%s)', async (_label, clock) => {
    vi.setSystemTime(new Date(clock));
    const f = await freshnessOfResponse(noSlot(), { Age: '5' });
    expect(f.lastCaptureAgeMsAtReceipt).toBe(135_000);
  });

  it('is never negative when the server reports a minute stamp ahead of its clock', async () => {
    const f = await freshnessOfResponse(noSlot({ lastMinuteAgeSec: -40 }), {
      Age: '5',
    });
    expect(f.lastCaptureAgeMsAtReceipt).toBe(5_000);
  });

  it.each([
    [
      'no captures today (the server sends no age)',
      { availableMinutes: [], lastMinuteAgeSec: undefined },
    ],
    [
      'a reply without lastMinuteAgeSec (an older server)',
      { lastMinuteAgeSec: undefined },
    ],
    [
      'a lastMinuteAgeSec that is not a number',
      { lastMinuteAgeSec: '130' as unknown as number },
    ],
    [
      'a null lastMinuteAgeSec (what JSON makes of Infinity)',
      { lastMinuteAgeSec: null as unknown as number },
    ],
    ['a no_spot reply', { reason: 'no_spot' as const }],
  ])('is null for %s', async (_label, over) => {
    const f = await freshnessOfResponse(noSlot(over), { Age: '5' });
    expect(f.lastCaptureAgeMsAtReceipt).toBeNull();
  });

  // R4: a malformed reply. The body is an unchecked cast, so a `no_slot` reply
  // can arrive without the list. That is "no capture minute", not a throw
  // inside the freshness build or the carried-over check (which the fetch's
  // catch would turn into an error banner and a lost response).
  it('treats a no_slot body with no availableMinutes field as no capture minute, with no error', async () => {
    mockFetch(() =>
      jsonResponse(
        // JSON.stringify drops an undefined field, so the body lacks the key.
        noSlot({
          availableMinutes: undefined as unknown as string[],
          lastMinuteAgeSec: undefined,
        }),
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
        asOf: '2026-11-20T15:29:30.000Z',
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

// ── After the close ──────────────────────────────────────────────────────────
// After the close /api/gex-landscape serves the last session's panels with a
// capture-time `asOf`. Fixtures: Fri 2026-11-20, a full session in EST (open
// 14:30Z, close 21:00Z, the final fetch due 21:03Z), and the Monday after.

const FRI_CLOSE_AT = '2026-11-20T21:00:50.036Z'; // the session's last capture
const FRI_MINUTES = [
  '2026-11-20T20:58:00.000Z',
  '2026-11-20T20:59:00.000Z',
  '2026-11-20T21:00:00.000Z',
];
const FRI_EVENING = '2026-11-20T21:01:00.000Z'; // 16:01:00 ET: 120 s to the final fetch
const FRI_LATER = '2026-11-20T22:00:00.000Z'; // 17:00 ET: the final fetch is days off
const FINAL_FETCH_IN_MS = 120_000;
const MON_BEFORE_OPEN = '2026-11-23T14:29:50.000Z'; // 09:29:50 ET
const MON_JUST_OPEN = '2026-11-23T14:30:05.000Z'; // 09:30:05 ET
const MON_10_CT = '2026-11-23T16:00:00.000Z'; // 10:00 CT, 11:00 ET

/** Fake timers on a fixed clock, for tests that move time. */
function fakeClock(now: string) {
  vi.useRealTimers();
  vi.useFakeTimers({ now: new Date(now) });
}

// Advance the fake clock inside act so state updates render between ticks.
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const sixStrike = makeRow({ strike: 6000, gamma: 5000 });

/** What the endpoint answers after the close: the last session, with `asOf`. */
function closedBody(
  over: Partial<GexLandscapeResponse> = {},
): GexLandscapeResponse {
  return makeResponse({
    marketOpen: false,
    asOf: FRI_CLOSE_AT,
    // A closed reply's ageSec is hours (server now minus the capture): not a stall.
    ageSec: 5 * 3600,
    data: { spot: 6000, strikes: [sixStrike] },
    availableMinutes: FRI_MINUTES,
    ...over,
  });
}

/** A body from today's session, captured `asOf`. */
function liveBody(asOf: string, gamma = 7000): GexLandscapeResponse {
  return makeResponse({
    marketOpen: true,
    asOf,
    ageSec: 8,
    data: { spot: 6010, strikes: [makeRow({ strike: 6010, gamma })] },
    availableMinutes: [asOf],
  });
}

type Answer = () => Response | Promise<Response>;
const answerWith =
  (body: GexLandscapeResponse): Answer =>
  () =>
    jsonResponse(body);
const unavailable: Answer = () => new Response('Unavailable', { status: 503 });
const refused =
  (status: number): Answer =>
  () =>
    new Response('Refused', { status });

/** Answer call n with answers[n], and the last answer from then on. */
function mockFetchSequence(...answers: Answer[]): MockInstance {
  let call = 0;
  return mockFetch(() => {
    const answer = answers[Math.min(call, answers.length - 1)]!;
    call += 1;
    return answer();
  });
}

describe('useGexLandscapeData — a closed body', () => {
  it('exposes asOf and renders the last session’s strikes while the market is closed', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.strikes[0]).toMatchObject({
      strike: 6000,
      price: 6000,
      netGamma: 5000,
    });
    expect(result.current.timestamps).toEqual(FRI_MINUTES);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    // The hours-old ageSec is not read as a stall: the reply says closed, and
    // the panel's age rules apply only to a market-open reply.
    expect(result.current.freshness?.serverMarketOpen).toBe(false);
  });

  it('exposes asOf on a no_spot body too, with no strikes', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(
      answerWith(
        closedBody({ data: null, reason: 'no_spot', ageSec: undefined }),
      ),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
    expect(result.current.strikes).toEqual([]);
    expect(result.current.timestamps).toEqual(FRI_MINUTES);
  });

  it('has no asOf on a closed no_slot body, and keeps the session’s minutes', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(
      answerWith(
        closedBody({
          data: null,
          reason: 'no_slot',
          asOf: null,
          ageSec: undefined,
          lastMinuteAgeSec: 3600,
        }),
      ),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(result.current.asOf).toBeNull();
    expect(result.current.strikes).toEqual([]);
    expect(result.current.timestamps).toEqual(FRI_MINUTES);
    expect(result.current.error).toBeNull();
  });

  // R4: the body is an unchecked cast, so asOf can be anything. It is read as
  // no asOf, and the strikes still render.
  it.each([
    ['a number', 1_764_000_000],
    // Date.parse reads both of these as a date.
    ['a number that reads as a year', 2026],
    ['a string that reads as a year', '2026'],
    ['a string that reads as a month', '5'],
    ['an empty string', ''],
    ['text that is not a date', 'yesterday'],
    ['an object', { at: FRI_CLOSE_AT }],
    ['an array holding a timestamp', [FRI_CLOSE_AT]],
  ])('reads %s as no asOf and still returns the strikes', async (_n, asOf) => {
    fakeClock(FRI_LATER);
    mockFetchSequence(
      answerWith(closedBody({ asOf: asOf as unknown as string })),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(result.current.asOf).toBeNull();
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });
});

describe('useGexLandscapeData — a body from before today’s open, once the market is open', () => {
  it('is dropped at 09:30:05 ET: no strikes, minutes, asOf or freshness, and no error', async () => {
    fakeClock(MON_JUST_OPEN);
    const spy = mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23'),
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.strikes).toEqual([]);
    expect(result.current.timestamps).toEqual([]);
    expect(result.current.gexDelta5mMap.size).toBe(0);
    expect(result.current.asOf).toBeNull();
    expect(result.current.freshness).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('is dropped by its last listed minute when asOf is null (a closed no_slot)', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(
      answerWith(
        closedBody({
          data: null,
          reason: 'no_slot',
          asOf: null,
          ageSec: undefined,
        }),
      ),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23'),
    );
    await advance(0);
    expect(result.current.timestamps).toEqual([]);
    expect(result.current.freshness).toBeNull();
  });

  it('is dropped by its last listed minute when asOf is not a timestamp', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(answerWith(closedBody({ asOf: 'yesterday' })));
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23'),
    );
    await advance(0);
    expect(result.current.strikes).toEqual([]);
    expect(result.current.timestamps).toEqual([]);
  });

  it('is kept when captured at the open instant, dropped a millisecond before', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(
      answerWith(liveBody('2026-11-23T14:30:00.000Z')),
      answerWith(liveBody('2026-11-23T14:29:59.999Z')),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23'),
    );
    await advance(0);
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.asOf).toBe('2026-11-23T14:30:00.000Z');

    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.strikes).toEqual([]);
    expect(result.current.asOf).toBeNull();
  });

  it('is kept while the market is closed', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-23'),
    );
    await advance(0);
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
  });

  // The pill must never read LIVE over Friday's strikes: a response held across
  // the open is dropped on the render of the flip itself, before the refetch
  // that the flip starts has landed.
  it('is dropped on the render of the flip, before the refetch lands', async () => {
    fakeClock(MON_BEFORE_OPEN);
    let landLive: ((r: Response) => void) | undefined;
    const spy = mockFetchSequence(
      answerWith(closedBody()),
      () =>
        new Promise<Response>((resolve) => {
          landLive = resolve;
        }),
    );
    const renders: Array<{ open: boolean; strikes: number; asOf: unknown }> =
      [];
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => {
        const out = useGexLandscapeData(open, '2026-11-23');
        renders.push({
          open,
          strikes: out.strikes.length,
          asOf: out.asOf,
        });
        return out;
      },
      { initialProps: { open: false } },
    );
    await advance(0);
    expect(result.current.strikes).toHaveLength(1);

    // 09:30:00 ET: the market opens and the refetch is still out.
    await advance(10_000);
    rerender({ open: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.strikes).toEqual([]);
    expect(result.current.timestamps).toEqual([]);
    expect(result.current.asOf).toBeNull();
    // No render with the market open ever carried Friday's strikes.
    const openRenders = renders.filter((r) => r.open);
    expect(openRenders.length).toBeGreaterThan(0);
    expect(openRenders.filter((r) => r.strikes > 0 || r.asOf != null)).toEqual(
      [],
    );

    // The live answer lands and replaces the empty panel.
    await act(async () => {
      landLive?.(jsonResponse(liveBody('2026-11-23T14:30:02.000Z')));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.asOf).toBe('2026-11-23T14:30:02.000Z');
  });

  it('stays empty when the read at the open still answers with the last session, then takes the next live poll', async () => {
    fakeClock(MON_BEFORE_OPEN);
    mockFetchSequence(
      answerWith(closedBody()),
      // An edge cache that still holds Friday's close.
      answerWith(closedBody()),
      answerWith(liveBody('2026-11-23T14:30:50.000Z')),
    );
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useGexLandscapeData(open, '2026-11-23'),
      { initialProps: { open: false } },
    );
    await advance(10_000);
    rerender({ open: true });
    await advance(0);
    expect(result.current.strikes).toEqual([]);
    expect(result.current.error).toBeNull();

    // The first poll after the open lands today's capture.
    await advance(60_000);
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.asOf).toBe('2026-11-23T14:30:50.000Z');
  });

  it('keeps an in-session no_slot’s minutes: asOf null, today’s minutes', async () => {
    fakeClock(MON_10_CT);
    mockFetchSequence(
      answerWith(
        makeResponse({
          marketOpen: true,
          asOf: null,
          data: null,
          reason: 'no_slot',
          ageSec: undefined,
          lastMinuteAgeSec: 360,
          availableMinutes: [
            '2026-11-23T15:53:00.000Z',
            '2026-11-23T15:54:00.000Z',
          ],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23'),
    );
    await advance(0);
    expect(result.current.timestamps).toEqual([
      '2026-11-23T15:53:00.000Z',
      '2026-11-23T15:54:00.000Z',
    ]);
    expect(result.current.strikes).toEqual([]);
    expect(result.current.asOf).toBeNull();
    expect(result.current.freshness).toMatchObject({
      reason: 'no_slot',
      serverMarketOpen: true,
      lastCaptureAgeMsAtReceipt: 360_000,
    });
  });

  it('keeps an in-session no_slot that lists no minutes yet', async () => {
    fakeClock(MON_JUST_OPEN);
    mockFetchSequence(
      answerWith(
        makeResponse({
          marketOpen: true,
          asOf: null,
          data: null,
          reason: 'no_slot',
          ageSec: undefined,
          availableMinutes: [],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23'),
    );
    await advance(0);
    expect(result.current.freshness?.reason).toBe('no_slot');
    expect(result.current.timestamps).toEqual([]);
  });
});

describe('useGexLandscapeData — a scrub (at set) ignores the after-close rules', () => {
  const SCRUB_AT = '2026-11-20T20:59:00.000Z';

  it('keeps a scrubbed body from before today’s open, with no asOf', async () => {
    fakeClock(MON_JUST_OPEN);
    const spy = mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23', SCRUB_AT),
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.timestamps).toEqual(FRI_MINUTES);
    expect(result.current.asOf).toBeNull();
    expect(result.current.freshness).toBeNull();
  });

  it('arms no final fetch', async () => {
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(answerWith(closedBody()));
    renderHook(() => useGexLandscapeData(false, '2026-11-20', SCRUB_AT));
    await advance(FINAL_FETCH_IN_MS + 10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows a failed read, though the market is closed and a response is held, and does not retry it', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20', SCRUB_AT),
    );
    await advance(0);
    expect(result.current.strikes).toHaveLength(1);

    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');
    expect(result.current.strikes).toHaveLength(1);

    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('shows a failed scrub read though a live response is held, and exposes no asOf while scrubbing', async () => {
    fakeClock(FRI_LATER);
    mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result, rerender } = renderHook(
      ({ at }: { at: string | null }) =>
        useGexLandscapeData(false, '2026-11-20', at),
      { initialProps: { at: null as string | null } },
    );
    await advance(0);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);

    // The user steps back: the scrub read fails over the held live response.
    rerender({ at: SCRUB_AT });
    await advance(0);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');
    expect(result.current.asOf).toBeNull();
    expect(result.current.strikes).toHaveLength(1);
  });
});

describe('useGexLandscapeData — the final fetch', () => {
  it('fires once at 16:03 ET, not before, and shows what it finds', async () => {
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(
      answerWith(closedBody()),
      answerWith(
        closedBody({
          asOf: '2026-11-20T21:02:10.000Z',
          data: {
            spot: 6001,
            strikes: [makeRow({ strike: 6000, gamma: 9999 })],
          },
        }),
      ),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(FINAL_FETCH_IN_MS - 1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);

    await advance(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(
      '/api/gex-landscape',
      expect.anything(),
    );
    expect(result.current.asOf).toBe('2026-11-20T21:02:10.000Z');
    expect(result.current.strikes[0]?.netGamma).toBe(9999);
  });

  it('re-arms for the next trading day', async () => {
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(answerWith(closedBody()));
    renderHook(() => useGexLandscapeData(false, '2026-11-20'));
    await advance(FINAL_FETCH_IN_MS);
    expect(spy).toHaveBeenCalledTimes(2);

    // Mon 16:03 ET is 72 h after Fri 16:03 ET: the same EST offset.
    await advance(72 * 3_600_000 - 1);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('fires for a tab that stayed open through the close', async () => {
    fakeClock('2026-11-20T20:59:50.000Z');
    const spy = mockFetchSequence(
      answerWith(liveBody('2026-11-20T20:59:20.000Z')),
      answerWith(closedBody()),
    );
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useGexLandscapeData(open, '2026-11-20'),
      { initialProps: { open: true } },
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);

    // The close at 21:00:00: the session edge refetches, then 21:03:00 is the
    // final fetch, 180 s after it.
    await advance(10_000);
    rerender({ open: false });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);

    await advance(179_999);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('makes no request for a public visitor', async () => {
    mockGetAccessMode.mockReturnValue('public');
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(answerWith(closedBody()));
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(FINAL_FETCH_IN_MS + 10 * 60_000);
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('stops when the hook unmounts', async () => {
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(answerWith(closedBody()));
    const { unmount } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    unmount();
    await advance(FINAL_FETCH_IN_MS + 10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('useGexLandscapeData — a failed fetch while the market is closed', () => {
  it('keeps the held strikes with no error when the final fetch fails, and retries 30 s later', async () => {
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(
      answerWith(closedBody()),
      unavailable,
      answerWith(closedBody({ asOf: '2026-11-20T21:02:10.000Z' })),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(FINAL_FETCH_IN_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.strikes).toHaveLength(1);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);

    await advance(29_999);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result.current.asOf).toBe('2026-11-20T21:02:10.000Z');
    expect(result.current.error).toBeNull();
  });

  it('keeps the held strikes through every retry of a final fetch, then stops after the fifth', async () => {
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(FINAL_FETCH_IN_MS);
    for (let retry = 1; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(spy).toHaveBeenCalledTimes(2 + retry);
      expect(result.current.error).toBeNull();
      expect(result.current.strikes).toHaveLength(1);
    }
    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(7);
    expect(result.current.error).toBeNull();
    expect(result.current.strikes).toHaveLength(1);
  });

  it('retries a failed refresh of a held response 5 times, 30 s apart, with no error', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.strikes).toHaveLength(1);
    for (let retry = 1; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(spy).toHaveBeenCalledTimes(2 + retry);
    }
    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(7);
    expect(result.current.error).toBeNull();
  });

  it('shows the error while it retries when nothing is held: 1 + 5 requests, then stops', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(unavailable);
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');
    expect(result.current.strikes).toEqual([]);
    expect(result.current.loading).toBe(false);

    await advance(29_999);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(spy).toHaveBeenCalledTimes(2);
    for (let retry = 2; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(spy).toHaveBeenCalledTimes(1 + retry);
    }
    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(6);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');
  });

  it('makes the same 1 + 5 requests under StrictMode, whose first mount read is superseded', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(unavailable);
    const { result } = renderHook(
      () => useGexLandscapeData(false, '2026-11-20'),
      { wrapper: StrictMode },
    );
    await advance(0);
    // StrictMode mounts twice: two requests, the first one superseded.
    expect(spy).toHaveBeenCalledTimes(2);
    for (let retry = 1; retry <= 5; retry += 1) {
      await advance(30_000);
      expect(spy).toHaveBeenCalledTimes(2 + retry);
    }
    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(7);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');
  });

  it('shows the strikes and clears the error once a retry succeeds, then stops', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(unavailable, answerWith(closedBody()));
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');

    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.strikes).toHaveLength(1);

    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a dropped connection, whose fetch rejects, as a transient failure', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(() => {
      throw new TypeError('Failed to fetch');
    }, answerWith(closedBody()));
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(result.current.error).toBe('Failed to fetch');
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.strikes).toHaveLength(1);
  });

  it('retries a 2xx body that is not JSON, and names it', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(
      () => new Response('<html>', { status: 200 }),
      answerWith(closedBody()),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(result.current.error).toMatch(/JSON/);
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it.each([400, 403, 404])(
    'does not retry a refused request (status %i), and shows it when nothing is held',
    async (status) => {
      fakeClock(FRI_LATER);
      const spy = mockFetchSequence(refused(status));
      const { result } = renderHook(() =>
        useGexLandscapeData(false, '2026-11-20'),
      );
      await advance(0);
      await advance(6 * 30_000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBe(`gex-landscape: HTTP ${status}`);
    },
  );

  it('does not retry a 401, which leaves the panel idle with no error (the public-visitor idiom)', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(refused(401));
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    await advance(6 * 30_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.strikes).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('does not retry a refused final fetch, and keeps the held strikes with no error', async () => {
    fakeClock(FRI_EVENING);
    const spy = mockFetchSequence(answerWith(closedBody()), refused(403));
    const { result } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(FINAL_FETCH_IN_MS);
    await advance(6 * 30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.strikes).toHaveLength(1);
  });

  it('shows a failed read when only a scrubbed response is held, not a live one', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(answerWith(closedBody()), unavailable);
    const { result, rerender } = renderHook(
      ({ at }: { at: string | null }) =>
        useGexLandscapeData(false, '2026-11-20', at),
      { initialProps: { at: FRI_MINUTES[0] as string | null } },
    );
    await advance(0);
    expect(result.current.strikes).toHaveLength(1);

    // Back to live: the stored response is still the scrubbed one.
    rerender({ at: null });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');
  });

  it('stops retrying when the hook unmounts', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(unavailable);
    const { unmount } = renderHook(() =>
      useGexLandscapeData(false, '2026-11-20'),
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    unmount();
    await advance(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores a read that the close-edge refetch superseded, though it fails late', async () => {
    fakeClock('2026-11-20T20:59:50.000Z');
    let failLate: ((r: Response) => void) | undefined;
    const spy = mockFetchSequence(
      answerWith(liveBody('2026-11-20T20:59:20.000Z')),
      () =>
        new Promise<Response>((resolve) => {
          failLate = resolve;
        }),
      answerWith(closedBody()),
    );
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useGexLandscapeData(open, '2026-11-20'),
      { initialProps: { open: true } },
    );
    await advance(0);

    // A re-read is out when the market closes; the close edge supersedes it.
    act(() => result.current.refresh());
    await advance(10_000);
    expect(spy).toHaveBeenCalledTimes(2);
    rerender({ open: false });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);

    // The superseded read answers 503 late: no error, no retry series.
    failLate?.(new Response('Unavailable', { status: 503 }));
    await advance(0);
    expect(result.current.error).toBeNull();
    expect(result.current.asOf).toBe(FRI_CLOSE_AT);
    await advance(60_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('useGexLandscapeData — a failed fetch while the market is open', () => {
  it('shows the error over the held strikes and starts no retry series: the poll is the retry', async () => {
    fakeClock(MON_10_CT);
    const spy = mockFetchSequence(
      answerWith(liveBody('2026-11-23T15:59:30.000Z')),
      unavailable,
      answerWith(liveBody('2026-11-23T16:01:30.000Z', 8000)),
    );
    const { result } = renderHook(() =>
      useGexLandscapeData(true, '2026-11-23'),
    );
    await advance(0);
    expect(result.current.strikes).toHaveLength(1);

    // The poll at +60 s fails: the error shows, the strikes stay.
    await advance(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('gex-landscape: HTTP 503');
    expect(result.current.strikes).toHaveLength(1);

    // No retry 30 s later; the next poll is at +120 s.
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.strikes[0]?.netGamma).toBe(8000);
  });
});

describe('useGexLandscapeData — the ET date rolling', () => {
  it('refetches once when the date argument changes, and a rerender on the same date does not', async () => {
    fakeClock(FRI_LATER);
    const spy = mockFetchSequence(answerWith(closedBody()));
    const { result, rerender } = renderHook(
      ({ date }: { date: string }) => useGexLandscapeData(false, date),
      { initialProps: { date: '2026-11-20' } },
    );
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const before = result.current.timestamps;

    // ET midnight: the panel clears its mirrored scrub list at the roll, and
    // only a new response (a new `timestamps` array) refills it.
    rerender({ date: '2026-11-21' });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.timestamps).toEqual(FRI_MINUTES);
    expect(result.current.timestamps).not.toBe(before);

    rerender({ date: '2026-11-21' });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
