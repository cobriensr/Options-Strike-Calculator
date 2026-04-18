import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
    ],
    vxTermSpread: -1.5,
    vxTermStructure: 'CONTANGO',
    esSpxBasis: 2.5,
    updatedAt: '2026-04-17T14:30:00Z',
    oldestTs: '2026-03-01T13:30:00Z',
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

// ============================================================
// TESTS
// ============================================================

describe('useFuturesData — historical mode', () => {
  it('appends ?at=<ISO> when at is provided', async () => {
    const at = '2026-04-17T14:30:00.000Z';
    mockOkResponse(makeApiResponse({ requestedAt: at }));

    const { result } = renderHook(() => useFuturesData(at));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // encodeURIComponent(':') -> '%3A'; URLSearchParams encodes colons
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/futures/snapshot?at=${encodeURIComponent(at)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('omits the query string when at is undefined', async () => {
    mockOkResponse(makeApiResponse());

    const { result } = renderHook(() => useFuturesData(undefined));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/futures/snapshot',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('exposes oldestTs on returned state', async () => {
    const oldest = '2026-03-01T13:30:00Z';
    mockOkResponse(makeApiResponse({ oldestTs: oldest }));

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.oldestTs).toBe(oldest);
  });

  it('aborts the prior request and refetches when at changes', async () => {
    const firstAt = '2026-04-17T14:30:00.000Z';
    const secondAt = '2026-04-17T15:00:00.000Z';

    // First fetch: capture the signal so we can assert it gets aborted.
    let firstSignal: AbortSignal | null | undefined;
    mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
      firstSignal = init?.signal;
      // Never resolve — we want to catch the abort before it completes.
      return new Promise(() => {});
    });

    // Second fetch resolves normally.
    mockOkResponse(makeApiResponse({ requestedAt: secondAt }));

    const { result, rerender } = renderHook(
      ({ at }: { at: string }) => useFuturesData(at),
      { initialProps: { at: firstAt } },
    );

    // Trigger the rerender with a new at value. The effect re-runs, which
    // calls fetchData, which calls abortRef.current.abort() on the prior
    // controller.
    rerender({ at: secondAt });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      `/api/futures/snapshot?at=${encodeURIComponent(firstAt)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      `/api/futures/snapshot?at=${encodeURIComponent(secondAt)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('surfaces a 400 malformed-at response via error state', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Invalid query' }),
    });

    const { result } = renderHook(() => useFuturesData('not-a-real-datetime'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Backend's error string is surfaced verbatim in the message.
    expect(result.current.error).toContain('Invalid query');
    expect(result.current.error).toContain('400');
    expect(result.current.snapshots).toEqual([]);
  });

  it('surfaces the backend error string for 400 future-at responses', async () => {
    const backendMsg = 'at must not be in the future';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: backendMsg }),
    });

    const { result } = renderHook(() =>
      useFuturesData('2099-01-01T00:00:00.000Z'),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain(backendMsg);
    expect(result.current.error).toContain('400');
  });

  it('falls back to generic message when 400 body has no error string', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      // body parses but .error is missing / non-string
      json: () => Promise.resolve({ details: { foo: 'bar' } }),
    });

    const { result } = renderHook(() => useFuturesData('not-a-real-datetime'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain('Failed to fetch futures data');
    expect(result.current.error).toContain('400');
  });

  it('falls back to generic message when response body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    });

    const { result } = renderHook(() => useFuturesData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain('Failed to fetch futures data');
    expect(result.current.error).toContain('500');
  });
});
