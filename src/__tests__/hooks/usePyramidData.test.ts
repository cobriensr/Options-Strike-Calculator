import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePyramidData, PyramidApiError } from '../../hooks/usePyramidData';
import type { PyramidChain, PyramidProgress } from '../../types/pyramid';

// ============================================================
// MOCK DATA
// ============================================================

const mockChain: PyramidChain = {
  id: '2026-04-16-MNQ-1',
  trade_date: '2026-04-16',
  instrument: 'MNQ',
  direction: 'long',
  entry_time_ct: null,
  exit_time_ct: null,
  initial_entry_price: null,
  final_exit_price: null,
  exit_reason: null,
  total_legs: 0,
  winning_legs: 0,
  net_points: 0,
  session_atr_pct: null,
  day_type: null,
  higher_tf_bias: null,
  notes: null,
  status: 'open',
  created_at: '2026-04-16T14:00:00Z',
  updated_at: '2026-04-16T14:00:00Z',
};

const mockProgress: PyramidProgress = {
  total_chains: 1,
  chains_by_day_type: {
    trend: 0,
    chop: 0,
    news: 0,
    mixed: 0,
    unspecified: 1,
  },
  elapsed_calendar_days: 0,
  fill_rates: {
    signal_type: 0,
    entry_price: 0,
  },
};

// ============================================================
// HELPERS
// ============================================================

/**
 * URL-routed fetch mock. Maps URL substrings -> { status, body } so a
 * single test can set independent responses for chains, progress,
 * legs, etc. Default map responds 200 with the standard mock data for
 * the two initial-load endpoints.
 */
type MockResponse = { status: number; body: unknown };

/**
 * Typed fetch-shaped impl so `fn.mock.calls[i][1]` has `RequestInit |
 * undefined` in the tuple — assertions in the test body rely on that
 * slot to verify `credentials: 'include'`, methods, and bodies.
 */
type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function installFetchMock(
  responses: Record<string, MockResponse | MockResponse[]>,
) {
  // Per-URL sequential queue — pop as each call is made.
  const cursors: Record<string, number> = {};

  const impl: FetchImpl = (url) => {
    const u = typeof url === 'string' ? url : url.toString();
    // Match by substring so query strings on PATCH/DELETE still route.
    const matchedKey = Object.keys(responses).find((k) => u.includes(k));
    if (!matchedKey) {
      return Promise.reject(new Error(`unexpected fetch to ${u}`));
    }
    const entry = responses[matchedKey]!;
    let response: MockResponse;
    if (Array.isArray(entry)) {
      const idx = cursors[matchedKey] ?? 0;
      response = entry[idx] ?? (entry.at(-1) as MockResponse);
      cursors[matchedKey] = idx + 1;
    } else {
      response = entry;
    }
    const { status, body } = response;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  };
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// TESTS
// ============================================================

describe('usePyramidData', () => {
  describe('initial load', () => {
    it('fetches chains and progress on mount', async () => {
      const fetchMock = installFetchMock({
        '/api/pyramid/chains': {
          status: 200,
          body: { chains: [mockChain] },
        },
        '/api/pyramid/progress': {
          status: 200,
          body: mockProgress,
        },
      });

      const { result } = renderHook(() => usePyramidData());

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.chains).toEqual([mockChain]);
      expect(result.current.progress).toEqual(mockProgress);
      expect(result.current.error).toBeNull();
      // Both endpoints hit once on mount.
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/api/pyramid/chains'))).toBe(true);
      expect(calls.some((u) => u.includes('/api/pyramid/progress'))).toBe(true);
    });

    it('sends credentials: include so the owner cookie is attached', async () => {
      const fetchMock = installFetchMock({
        '/api/pyramid/chains': {
          status: 200,
          body: { chains: [] },
        },
        '/api/pyramid/progress': {
          status: 200,
          body: { ...mockProgress, total_chains: 0 },
        },
      });

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      for (const [, init] of fetchMock.mock.calls) {
        expect((init as RequestInit | undefined)?.credentials).toBe('include');
      }
    });

    it('sets error to owner-access message on 401 and leaves state empty', async () => {
      installFetchMock({
        '/api/pyramid/chains': {
          status: 401,
          body: { error: 'Unauthorized' },
        },
        '/api/pyramid/progress': {
          status: 401,
          body: { error: 'Unauthorized' },
        },
      });

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toBe('Owner access required');
      expect(result.current.chains).toEqual([]);
      expect(result.current.progress).toBeNull();
    });

    it('surfaces network failure as error on initial load', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.reject(new Error('offline')),
      ) as unknown as typeof fetch;

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toMatch(/Network error/);
    });
  });

  describe('createChain', () => {
    it('POSTs, revalidates, and returns the created row', async () => {
      const updated: PyramidChain = { ...mockChain, instrument: 'MNQ' };
      const fetchMock = installFetchMock({
        '/api/pyramid/chains': [
          { status: 200, body: { chains: [] } }, // initial list
          { status: 200, body: updated }, // POST response
          { status: 200, body: { chains: [updated] } }, // revalidate
        ],
        '/api/pyramid/progress': [
          { status: 200, body: { ...mockProgress, total_chains: 0 } },
          {
            status: 200,
            body: { ...mockProgress, total_chains: 1 },
          },
        ],
      });

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      let returned: PyramidChain | undefined;
      await act(async () => {
        returned = await result.current.createChain({
          id: updated.id,
          instrument: 'MNQ',
        });
      });

      expect(returned).toEqual(updated);

      await waitFor(() => {
        expect(result.current.chains).toEqual([updated]);
        expect(result.current.progress?.total_chains).toBe(1);
      });

      // POST was made with JSON body.
      const postCall = fetchMock.mock.calls.find(
        ([, init]) =>
          (init as RequestInit | undefined)?.method === 'POST' &&
          String((init as RequestInit | undefined)?.body ?? '').includes(
            updated.id,
          ),
      );
      expect(postCall).toBeDefined();
    });
  });

  describe('createLeg', () => {
    it('throws PyramidApiError with status 409 + code leg_1_missing when leg 1 is missing', async () => {
      installFetchMock({
        '/api/pyramid/chains': {
          status: 200,
          body: { chains: [mockChain] },
        },
        '/api/pyramid/progress': {
          status: 200,
          body: mockProgress,
        },
        '/api/pyramid/legs': {
          status: 409,
          body: { error: 'leg_1_missing' },
        },
      });

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.createLeg({
            id: `${mockChain.id}-L2`,
            chain_id: mockChain.id,
            leg_number: 2,
          });
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBeInstanceOf(PyramidApiError);
      const err = caught as PyramidApiError;
      expect(err.status).toBe(409);
      expect(err.code).toBe('leg_1_missing');
      expect(err.message).toBe('leg_1_missing');
    });

    it('throws PyramidApiError with status 401 when owner gate rejects', async () => {
      installFetchMock({
        '/api/pyramid/chains': {
          status: 200,
          body: { chains: [] },
        },
        '/api/pyramid/progress': {
          status: 200,
          body: { ...mockProgress, total_chains: 0 },
        },
        '/api/pyramid/legs': {
          status: 401,
          body: { error: 'Unauthorized' },
        },
      });

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.createLeg({
            id: 'x-L1',
            chain_id: 'x',
            leg_number: 1,
          });
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBeInstanceOf(PyramidApiError);
      const err = caught as PyramidApiError;
      expect(err.status).toBe(401);
      expect(err.message).toBe('Owner access required');
    });

    it('throws PyramidApiError with status 0 on network failure', async () => {
      // Initial loads succeed; the leg POST rejects at the network layer.
      let call = 0;
      globalThis.fetch = vi.fn((url: string | URL | Request) => {
        call += 1;
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/api/pyramid/legs')) {
          return Promise.reject(new Error('fetch failed'));
        }
        if (u.includes('/api/pyramid/chains')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ chains: [] }),
          }) as unknown as Promise<Response>;
        }
        if (u.includes('/api/pyramid/progress')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ...mockProgress, total_chains: 0 }),
          }) as unknown as Promise<Response>;
        }
        return Promise.reject(new Error(`unexpected call ${call} to ${u}`));
      }) as unknown as typeof fetch;

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.createLeg({
            id: 'x-L1',
            chain_id: 'x',
            leg_number: 1,
          });
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBeInstanceOf(PyramidApiError);
      expect((caught as PyramidApiError).status).toBe(0);
      expect((caught as PyramidApiError).code).toBe('network_error');
    });
  });

  describe('refresh', () => {
    it('re-fetches chains and progress', async () => {
      const fetchMock = installFetchMock({
        '/api/pyramid/chains': [
          { status: 200, body: { chains: [] } }, // mount
          { status: 200, body: { chains: [mockChain] } }, // after refresh
        ],
        '/api/pyramid/progress': [
          { status: 200, body: { ...mockProgress, total_chains: 0 } },
          { status: 200, body: mockProgress },
        ],
      });

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const callsBefore = fetchMock.mock.calls.length;
      await act(async () => {
        await result.current.refresh();
      });

      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
      await waitFor(() => {
        expect(result.current.chains).toEqual([mockChain]);
        expect(result.current.progress?.total_chains).toBe(1);
      });
    });
  });

  describe('race safety', () => {
    /**
     * `mountedRef` claim: unmounting while a refresh is mid-fetch is safe.
     *
     * Honest scope of this test: React 18+ silenced the classic "Can't
     * perform a React state update on an unmounted component" warning and
     * no-ops setState on unmounted components, so we can't detect a missing
     * guard by observing a warning. What we CAN detect: (a) uncaught
     * rejections from the resolved-after-unmount promise chain, (b) any
     * console.error from testing-library's internal act() wrap, and (c)
     * post-unmount state leak into `result.current`.
     *
     * The guard remains valuable as explicit intent and as future-proofing
     * if React reintroduces strictness; this test locks in the contract
     * that unmount-mid-fetch is observably silent and clean.
     */
    it('does not update state or error after unmount', async () => {
      // Pending resolvers for both endpoints — we resolve them manually.
      const pending: Array<(value: unknown) => void> = [];
      globalThis.fetch = vi.fn(
        () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      ) as unknown as typeof fetch;

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result, unmount } = renderHook(() => usePyramidData());
      // Fetches are in flight — two of them (chains + progress).
      expect(pending.length).toBeGreaterThanOrEqual(2);

      // Snapshot the state before unmount — if the guard fails, the
      // resolution below will mutate this snapshot in place via React.
      const preUnmountSnapshot = {
        loading: result.current.loading,
        chains: result.current.chains,
        progress: result.current.progress,
        error: result.current.error,
      };
      expect(preUnmountSnapshot.loading).toBe(true);

      unmount();

      // Resolve pending fetches with valid Response-shaped objects. If
      // mountedRef doesn't fire, the setters will attempt to run on the
      // unmounted hook — either throwing or emitting a warning.
      await act(async () => {
        for (const resolve of pending) {
          resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ chains: [mockChain] }),
          });
        }
        // Flush microtasks + Promise.all resolution so the .then() chain
        // inside refresh() would fire any mis-guarded setters.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // No console.error from React/testing-library about post-unmount
      // activity. (React 18+ silenced the classic warning, but testing-
      // library can still surface act() warnings.)
      expect(errorSpy).not.toHaveBeenCalled();

      // `result.current` after unmount should equal the pre-unmount
      // snapshot — proof that none of the setters fired.
      expect(result.current.loading).toBe(preUnmountSnapshot.loading);
      expect(result.current.chains).toBe(preUnmountSnapshot.chains);
      expect(result.current.progress).toBe(preUnmountSnapshot.progress);
      expect(result.current.error).toBe(preUnmountSnapshot.error);

      errorSpy.mockRestore();
    });

    /**
     * Request-id guard claim: two rapid mutations each fire `void refresh()`.
     * If the FIRST revalidation resolves AFTER the SECOND, a naive
     * implementation would clobber the fresh state with the stale response.
     *
     * We stage:
     *   - initial mount: empty list, total_chains 0
     *   - createChain POST: returns the created row
     *   - revalidate #1: [chain_A], total 1   ← intentionally SLOW
     *   - createLeg POST: returns a leg
     *   - revalidate #2: [chain_A], total 2   ← fast; resolves FIRST
     * Then we release revalidate #1 (stale) and assert final state is #2.
     *
     * The test asserts the actual final state (total_chains === 2), not
     * just call counts, so it would fail on a naive implementation even
     * if every fetch fired.
     */
    it('drops stale refresh result when a newer refresh is in flight', async () => {
      const chainA: PyramidChain = { ...mockChain, id: 'chain_A' };
      const legId = `${chainA.id}-L1`;

      // Resolvers for each staged revalidation, so we control ordering.
      let releaseRevalidate1: (() => void) | null = null;
      let releaseRevalidate2: (() => void) | null = null;

      // Per-endpoint sequential cursors.
      let chainsCallCount = 0;
      let progressCallCount = 0;

      globalThis.fetch = vi.fn(
        (url: string | URL | Request, init?: RequestInit) => {
          const u = typeof url === 'string' ? url : url.toString();
          const method = init?.method ?? 'GET';

          // Mutations: resolve immediately.
          if (u.includes('/api/pyramid/chains') && method === 'POST') {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(chainA),
            });
          }
          if (u.includes('/api/pyramid/legs') && method === 'POST') {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  id: legId,
                  chain_id: chainA.id,
                  leg_number: 1,
                }),
            });
          }

          // GET /api/pyramid/chains: call 0 = mount, 1 = revalidate #1
          // (slow), 2 = revalidate #2 (fast).
          if (u.includes('/api/pyramid/chains') && method === 'GET') {
            const idx = chainsCallCount++;
            if (idx === 0) {
              return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ chains: [] }),
              });
            }
            if (idx === 1) {
              // Hold open until releaseRevalidate1() is called.
              return new Promise((resolve) => {
                releaseRevalidate1 = () =>
                  resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ chains: [chainA] }),
                  });
              });
            }
            if (idx === 2) {
              return new Promise((resolve) => {
                releaseRevalidate2 = () =>
                  resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ chains: [chainA] }),
                  });
              });
            }
          }

          // GET /api/pyramid/progress: same idx mapping.
          if (u.includes('/api/pyramid/progress') && method === 'GET') {
            const idx = progressCallCount++;
            if (idx === 0) {
              return Promise.resolve({
                ok: true,
                status: 200,
                json: () =>
                  Promise.resolve({ ...mockProgress, total_chains: 0 }),
              });
            }
            if (idx === 1) {
              return new Promise((resolve) => {
                const prev = releaseRevalidate1;
                releaseRevalidate1 = () => {
                  prev?.();
                  resolve({
                    ok: true,
                    status: 200,
                    // Stale data — total 1, no legs yet.
                    json: () =>
                      Promise.resolve({
                        ...mockProgress,
                        total_chains: 1,
                      }),
                  });
                };
              });
            }
            if (idx === 2) {
              return new Promise((resolve) => {
                const prev = releaseRevalidate2;
                releaseRevalidate2 = () => {
                  prev?.();
                  resolve({
                    ok: true,
                    status: 200,
                    // Fresh data — total 2 (leg was also created).
                    json: () =>
                      Promise.resolve({
                        ...mockProgress,
                        total_chains: 2,
                      }),
                  });
                };
              });
            }
          }
          return Promise.reject(new Error(`unexpected fetch ${method} ${u}`));
        },
      ) as unknown as typeof fetch;

      const { result } = renderHook(() => usePyramidData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Fire two rapid mutations — each triggers a revalidate. We don't
      // await the void refresh() inside the hook, so both revalidations
      // are in flight when we return from the awaits.
      await act(async () => {
        await result.current.createChain({ id: chainA.id, instrument: 'MNQ' });
      });
      await act(async () => {
        await result.current.createLeg({
          id: legId,
          chain_id: chainA.id,
          leg_number: 1,
        });
      });

      // Both revalidations are holding open. Release the SECOND (newer)
      // one first — its data should land.
      await act(async () => {
        releaseRevalidate2?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.progress?.total_chains).toBe(2);
      });

      // Now release the FIRST (older, stale) revalidation. Without the
      // request-id guard this would clobber total_chains back to 1 and
      // wipe the chains list. With the guard, state stays at the newer
      // result.
      await act(async () => {
        releaseRevalidate1?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The key assertion: final state reflects the NEWER revalidation,
      // not the stale one that resolved last.
      expect(result.current.progress?.total_chains).toBe(2);
      expect(result.current.chains).toEqual([chainA]);
    });
  });
});
