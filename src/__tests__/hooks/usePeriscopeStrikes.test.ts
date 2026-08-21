/**
 * Unit tests for usePeriscopeStrikes.
 *
 * Mocks global fetch + getAccessMode so the hook can be exercised
 * without a network round-trip.
 *
 * The load-bearing contract is the REQUEST COUNT: exactly one round-trip
 * per fetch cycle. The hook used to fire two extra lookback requests
 * (10m / 30m prior slots) to build Δ% gamma maps whose only consumer —
 * the legacy GexLandscape StrikeTable — had already moved to
 * `useGexLandscapeData`. Several cases here pin the count so those
 * wasted calls cannot silently return.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { POLL_INTERVALS } from '../../constants';

const { mockGetAccessMode } = vi.hoisted(() => ({
  mockGetAccessMode: vi.fn(),
}));

vi.mock('../../utils/auth', () => ({
  getAccessMode: mockGetAccessMode,
}));

import {
  usePeriscopeStrikes,
  type PeriscopeStrikesResponse,
} from '../../hooks/usePeriscopeStrikes';

function makeResponse(
  overrides: Partial<PeriscopeStrikesResponse> = {},
): PeriscopeStrikesResponse {
  return {
    marketOpen: true,
    asOf: '2026-05-12T18:45:00.000Z',
    capturedAt: '2026-05-12T18:40:00.000Z',
    priorCapturedAt: '2026-05-12T18:30:00.000Z',
    spot: 7340,
    strikes: [
      { strike: 7350, gamma: 5000, charm: -400000 },
      { strike: 7375, gamma: 3000, charm: 33000 },
    ],
    availableSlots: [
      '2026-05-12T18:10:00.000Z',
      '2026-05-12T18:20:00.000Z',
      '2026-05-12T18:30:00.000Z',
      '2026-05-12T18:40:00.000Z',
    ],
    ...overrides,
  };
}

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return handler(url);
    }),
  );
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mockGetAccessMode.mockReturnValue('owner');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Belt-and-suspenders: if a test left fake timers running (e.g. it
  // threw before its own try/finally restored them), reset here so the
  // shared vitest worker doesn't poison sibling test files.
  vi.useRealTimers();
});

describe('usePeriscopeStrikes', () => {
  it('fetches ONLY the latest slot — exactly one request, no lookbacks', async () => {
    // Regression pin. A populated `availableSlots` used to trigger two
    // extra round-trips (1-slot-back + 3-slots-back). Nothing reads
    // those maps any more, so a full slot list must still produce a
    // single request.
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(makeResponse());
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest?.capturedAt).toBe('2026-05-12T18:40:00.000Z');
    expect(result.current.latest?.strikes).toHaveLength(2);
    expect(result.current.error).toBeNull();
    expect(calls).toHaveLength(1);
    // Lookback fetches were the only requests that carried `time=` in
    // live mode (the primary uses `date=` alone), so this is the
    // signature to assert against.
    expect(calls.some((u) => u.includes('time='))).toBe(false);
  });

  it('fires exactly one request per poll cycle in live mode', async () => {
    // The waste this hook shed was per-POLL, not per-mount: at a 30s
    // cadence across a 6.5h session, two extra calls per cycle is
    // ~1,500 pointless round-trips a day. Pin the per-tick count.
    vi.useFakeTimers();
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(makeResponse());
    });

    try {
      renderHook(() => usePeriscopeStrikes(true, '2026-05-12'));
      // Settle the mount fetch WITHOUT advancing the clock —
      // `runOnlyPendingTimersAsync` would also fire the poll interval
      // that `usePolling` has already scheduled and inflate the count.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toHaveLength(1);

      // Each subsequent tick adds exactly one request.
      for (let expected = 2; expected <= 4; expected++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(POLL_INTERVALS.STRIKE_BATTLE_MAP);
        });
        expect(calls).toHaveLength(expected);
      }

      expect(calls.every((u) => !u.includes('time='))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll while the market is closed', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(makeResponse());
    });

    try {
      renderHook(() => usePeriscopeStrikes(false, '2026-05-12'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toHaveLength(1);
      // marketOpen=false closes the poll gate — the mount fetch is the
      // only request no matter how far the clock advances.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVALS.STRIKE_BATTLE_MAP * 4);
      });
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays idle in public access mode (no fetch fired)', async () => {
    mockGetAccessMode.mockReturnValue('public');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.latest).toBeNull();
  });

  it('surfaces an error message when fetch rejects', async () => {
    mockFetch(() => {
      throw new Error('network down');
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('network down');
    expect(result.current.latest).toBeNull();
  });

  it('returns null latest on 401 without surfacing an error', async () => {
    mockFetch(() => new Response('', { status: 401 }));

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('issues a single request when the latest slot is empty', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(
        makeResponse({
          capturedAt: null,
          priorCapturedAt: null,
          strikes: [],
          availableSlots: [],
        }),
      );
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest?.strikes).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('does NOT poll when in snapshot mode (at param set)', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(makeResponse());
    });

    try {
      renderHook(() =>
        usePeriscopeStrikes(true, '2026-05-12', '2026-05-12T18:40:00.000Z'),
      );
      // Let the initial async fetch settle.
      await vi.runOnlyPendingTimersAsync();
      // Advance well past the poll interval — no second fetch should fire.
      await vi.advanceTimersByTimeAsync(120_000);
      // The scrubbed slot is resolved by the primary fetch itself (it
      // carries `?time`), so snapshot mode is one request, full stop.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('time=');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the in-flight request on unmount', async () => {
    const aborts: AbortSignal[] = [];
    // Direct stubGlobal with both args so we can capture `init.signal`
    // — the helper `mockFetch` above only forwards the URL.
    const stub = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) aborts.push(init.signal);
        // Never resolves — request stays in-flight until aborted.
        return new Promise<Response>(() => {});
      },
    );
    vi.stubGlobal('fetch', stub);

    const { unmount } = renderHook(() =>
      usePeriscopeStrikes(true, '2026-05-12'),
    );
    await waitFor(() => expect(stub).toHaveBeenCalled());
    expect(aborts[0]?.aborted).toBe(false);

    unmount();
    expect(aborts[0]?.aborted).toBe(true);
  });

  it('aborts the in-flight request when the date prop changes mid-flight', async () => {
    const aborts: AbortSignal[] = [];
    let callCount = 0;
    // First date: requests hang until aborted (so we capture the signals).
    // Second date: requests resolve immediately so the new fetch completes.
    const stub = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount += 1;
        if (init?.signal) aborts.push(init.signal);
        // The single initial request for date #1 hangs until aborted.
        if (callCount <= 1) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          });
        }
        // Subsequent calls for date #2 resolve cleanly.
        return jsonResponse(makeResponse());
      },
    );
    vi.stubGlobal('fetch', stub);

    const { rerender } = renderHook(
      ({ d }: { d: string }) => usePeriscopeStrikes(true, d),
      { initialProps: { d: '2026-05-12' } },
    );
    await waitFor(() => expect(stub).toHaveBeenCalled());
    expect(aborts[0]?.aborted).toBe(false);

    rerender({ d: '2026-05-13' });
    await waitFor(() => expect(aborts[0]?.aborted).toBe(true));
  });
});

// ── Malformed payload validation ─────────────────────────────
// The parse used to be `(await res.json()) as PeriscopeStrikesResponse`,
// so a shapeless body reached the GexTarget MM-overlay memo and threw
// "strikes is not iterable" (src/components/GexTarget/index.tsx).

describe('usePeriscopeStrikes: malformed payloads', () => {
  it('reports a shape error on a {} latest-slot body', async () => {
    mockFetch(() => jsonResponse({}));

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/unexpected response shape/i);
    expect(result.current.latest).toBeNull();
  });

  it('reports a shape error when strikes arrives as a non-iterable object', async () => {
    mockFetch(() => jsonResponse(makeResponse({ strikes: { a: 1 } } as never)));

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/unexpected response shape/i);
    expect(result.current.latest).toBeNull();
  });

  it('reports a shape error on an HTML-ish string body', async () => {
    mockFetch(() => jsonResponse('<!doctype html><html>oops</html>'));

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/unexpected response shape/i);
    expect(result.current.latest).toBeNull();
  });

  it('drops malformed strike rows and keeps the valid ones', async () => {
    mockFetch(() =>
      jsonResponse(
        makeResponse({
          strikes: [
            { strike: 7350, gamma: 5000, charm: -400_000 },
            'garbage',
            { strike: 'oops', gamma: 1, charm: 1 },
            { strike: 7375, gamma: null, charm: 1 },
          ],
        } as never),
      ),
    );

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest?.strikes).toEqual([
      { strike: 7350, gamma: 5000, charm: -400_000 },
    ]);
    expect(result.current.error).toBeNull();
  });

  it('keeps the last-known-good latest when a later poll is malformed', async () => {
    // The soft-degrade contract: a bad payload surfaces `error` but must
    // not blank the MM overlay the panel is already rendering.
    let call = 0;
    mockFetch(() => {
      call += 1;
      return call === 1 ? jsonResponse(makeResponse()) : jsonResponse({});
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest?.strikes).toHaveLength(2);

    result.current.refresh();
    await waitFor(() =>
      expect(result.current.error).toMatch(/unexpected response shape/i),
    );
    expect(result.current.latest?.strikes).toHaveLength(2);
  });

  it('accepts the no-slot 200 payload (empty strikes, slot list present)', async () => {
    // Faithfulness guard: the handler's `slot == null` branch returns
    // `strikes: []` with a populated `availableSlots` — validation must not
    // treat that legitimate quiet-period payload as a shape error.
    mockFetch(() =>
      jsonResponse({
        marketOpen: false,
        asOf: '2026-05-12T18:45:00.000Z',
        capturedAt: null,
        priorCapturedAt: null,
        spot: 7340,
        strikes: [],
        availableSlots: ['2026-05-12T18:10:00.000Z'],
      }),
    );

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.latest?.strikes).toEqual([]);
    expect(result.current.latest?.availableSlots).toEqual([
      '2026-05-12T18:10:00.000Z',
    ]);
  });
});
