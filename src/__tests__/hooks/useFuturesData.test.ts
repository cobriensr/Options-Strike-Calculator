import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useFuturesData } from '../../hooks/useFuturesData';
import type { FuturesSnapshotResponse } from '../../hooks/useFuturesData';

// ============================================================
// MOCK FETCH
// ============================================================

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────

function makeApiResponse(
  overrides: Partial<FuturesSnapshotResponse> = {},
): FuturesSnapshotResponse {
  return {
    snapshots: [
      {
        symbol: 'ES',
        price: 5700,
        change1hPct: 0.15,
        changeDayPct: -0.3,
        volumeRatio: 1.2,
      },
      {
        symbol: 'NQ',
        price: 20500,
        change1hPct: 0.25,
        changeDayPct: 0.5,
        volumeRatio: 0.9,
      },
    ],
    vxTermSpread: -1.5,
    vxTermStructure: 'CONTANGO',
    esSpxBasis: 2.5,
    updatedAt: '2026-04-05T15:30:00Z',
    oldestTs: null,
    requestedAt: null,
    ...overrides,
  };
}

function mockOkResponse(data: FuturesSnapshotResponse) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  });
}

function mockErrorResponse(status = 500) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({ error: 'Server error' }),
  });
}

// ============================================================
// TESTS
// ============================================================

describe('useFuturesData', () => {
  // ── Loading state ───────────────────────────────────────

  it('returns loading state initially', () => {
    // Never resolve so we stay in loading state
    mockFetch.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useFuturesData());

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshots).toEqual([]);
  });

  // ── Successful fetch ────────────────────────────────────

  it('fetches data on mount and populates all fields', async () => {
    const apiData = makeApiResponse();
    mockOkResponse(apiData);

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.snapshots).toHaveLength(2);
    expect(result.current.snapshots[0]!.symbol).toBe('ES');
    expect(result.current.snapshots[0]!.price).toBe(5700);
    expect(result.current.vxTermSpread).toBe(-1.5);
    expect(result.current.vxTermStructure).toBe('CONTANGO');
    expect(result.current.esSpxBasis).toBe(2.5);
    expect(result.current.updatedAt).toBe('2026-04-05T15:30:00Z');
    expect(result.current.error).toBeNull();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/futures/snapshot',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // ── Error handling ──────────────────────────────────────

  it('handles fetch error gracefully', async () => {
    mockErrorResponse(500);

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain('Failed to fetch futures data');
    expect(result.current.error).toContain('500');
    expect(result.current.snapshots).toEqual([]);
  });

  it('handles network error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network failure');
    expect(result.current.snapshots).toEqual([]);
  });

  // ── AbortController cleanup ─────────────────────────────

  it('aborts fetch on unmount', async () => {
    let abortSignal: AbortSignal | null | undefined;
    mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
      abortSignal = init?.signal;
      return new Promise(() => {}); // never resolve
    });

    const { unmount } = renderHook(() => useFuturesData());
    unmount();

    expect(abortSignal?.aborted).toBe(true);
  });

  // ── Refetch ─────────────────────────────────────────────

  it('refetch function triggers a new fetch', async () => {
    const firstData = makeApiResponse();
    mockOkResponse(firstData);

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.snapshots).toHaveLength(2);

    // Set up second fetch with different data
    const secondData = makeApiResponse({
      snapshots: [
        {
          symbol: 'ES',
          price: 5750,
          change1hPct: 0.5,
          changeDayPct: 0.8,
          volumeRatio: 1.5,
        },
      ],
      updatedAt: '2026-04-05T16:00:00Z',
    });
    mockOkResponse(secondData);

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.snapshots).toHaveLength(1);
    expect(result.current.snapshots[0]!.price).toBe(5750);
    expect(result.current.updatedAt).toBe('2026-04-05T16:00:00Z');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ── Null fields ─────────────────────────────────────────

  it('handles null fields in API response', async () => {
    const data = makeApiResponse({
      snapshots: [
        {
          symbol: 'ES',
          price: 5700,
          change1hPct: null,
          changeDayPct: null,
          volumeRatio: null,
        },
      ],
      vxTermSpread: null,
      vxTermStructure: null,
      esSpxBasis: null,
    });
    mockOkResponse(data);

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const snap = result.current.snapshots[0]!;
    expect(snap.change1hPct).toBeNull();
    expect(snap.changeDayPct).toBeNull();
    expect(snap.volumeRatio).toBeNull();
    expect(result.current.vxTermSpread).toBeNull();
    expect(result.current.vxTermStructure).toBeNull();
    expect(result.current.esSpxBasis).toBeNull();
  });

  // ── Empty snapshots ─────────────────────────────────────

  it('returns empty snapshots array when API returns no data', async () => {
    const data = makeApiResponse({
      snapshots: [],
      vxTermSpread: null,
      vxTermStructure: null,
      esSpxBasis: null,
    });
    mockOkResponse(data);

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.snapshots).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // ── AbortError is silenced ──────────────────────────────

  it('does not set error on AbortError', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortError);

    const { result } = renderHook(() => useFuturesData());

    // Give the effect time to settle. Since AbortError is swallowed,
    // loading should eventually turn false via the finally block.
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeNull();
  });
});
