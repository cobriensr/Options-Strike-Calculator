import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function installFetchMock(
  responses: Record<string, MockResponse | MockResponse[]>,
) {
  // Per-URL sequential queue — pop as each call is made.
  const cursors: Record<string, number> = {};

  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    // Preserve `init` in the call tuple so tests can assert on fetch options
    // (credentials, method, body). The no-op reference below keeps the
    // parameter meaningful to TypeScript + eslint without changing behaviour;
    // the actual assertions read it out of `fn.mock.calls` in the test body.
    if (init && init.method === undefined) {
      /* GET request — no method set by fetch helper. */
    }
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
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  // Tests don't use timers, but consistent env matches other hook tests.
});

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
});
