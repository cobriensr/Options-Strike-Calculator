import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMLInsights } from '../../hooks/useMLInsights';
import type { MLPlotsResponse } from '../../hooks/useMLInsights';

// ============================================================
// MOCK DATA
// ============================================================

const mockPlotsResponse: MLPlotsResponse = {
  plots: [
    {
      name: 'timeline',
      imageUrl: '/plots/timeline.png',
      analysis: {
        what_it_means: 'Shows trend over time',
        how_to_apply: 'Use for timing entries',
        watch_out_for: 'Regime changes',
      },
      model: 'claude-sonnet-4-20250514',
      pipelineDate: '2026-04-03',
      updatedAt: '2026-04-03T06:00:00Z',
    },
    {
      name: 'correlations',
      imageUrl: '/plots/correlations.png',
      analysis: null,
      model: 'claude-sonnet-4-20250514',
      pipelineDate: '2026-04-03',
      updatedAt: '2026-04-03T06:00:00Z',
    },
  ],
  findings: {
    dataset: { total_days: 120, labeled_days: 95 },
    eda: { overall_accuracy: 0.72 },
    health: { status: 'healthy' },
  },
  pipelineDate: '2026-04-03',
};

// ============================================================
// HELPERS
// ============================================================

function mockFetch(
  overrides: {
    status?: number;
    body?: MLPlotsResponse | Record<string, unknown>;
    rejectWith?: Error;
  } = {},
) {
  const status = overrides.status ?? 200;
  const body = overrides.body ?? mockPlotsResponse;

  if (overrides.rejectWith) {
    return vi.fn(() =>
      Promise.reject(overrides.rejectWith),
    ) as unknown as typeof fetch;
  }

  return vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// BASIC BEHAVIOR
// ============================================================

describe('useMLInsights: basic behavior', () => {
  it('starts with loading=true and empty plots', async () => {
    globalThis.fetch = mockFetch();
    const { result } = renderHook(() => useMLInsights());
    expect(result.current.loading).toBe(true);
    expect(result.current.plots).toEqual([]);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('fetches plots successfully on mount', async () => {
    globalThis.fetch = mockFetch();
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.plots).toHaveLength(2);
    expect(result.current.plots[0]!.name).toBe('timeline');
    expect(result.current.findings).not.toBeNull();
    expect(result.current.pipelineDate).toBe('2026-04-03');
    expect(result.current.error).toBeNull();
  });

  it('calls /api/ml/plots endpoint', async () => {
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ml/plots',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

describe('useMLInsights: error handling', () => {
  it('sets error on HTTP failure', async () => {
    globalThis.fetch = mockFetch({ status: 500, body: {} });
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Failed to fetch ML plots (HTTP 500)');
    expect(result.current.plots).toEqual([]);
  });

  it('sets error on network failure', async () => {
    globalThis.fetch = mockFetch({
      rejectWith: new Error('Network error'),
    });
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Network error');
    expect(result.current.plots).toEqual([]);
  });

  it('sets generic error for non-Error throws', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject('string error'),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('string error');
  });

  it('ignores AbortError', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new DOMException('Aborted', 'AbortError')),
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useMLInsights());

    // AbortError should not set error state; loading stays true because
    // finally block still runs setLoading(false)
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});

// ============================================================
// REFETCH
// ============================================================

describe('useMLInsights: refetch', () => {
  it('refetch re-fetches data', async () => {
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsBefore = (fetchMock as ReturnType<typeof vi.fn>).mock.calls
      .length;

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(
      (fetchMock as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(callsBefore);
  });

  it('refetch clears previous error', async () => {
    // First call fails
    globalThis.fetch = mockFetch({ status: 500, body: {} });
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();

    // Replace with successful fetch
    globalThis.fetch = mockFetch();

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.plots).toHaveLength(2);
  });
});

// ============================================================
// CLEANUP
// ============================================================

describe('useMLInsights: cleanup', () => {
  it('aborts fetch on unmount', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    globalThis.fetch = mockFetch();
    const { result, unmount } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();
    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
  });
});

// ============================================================
// EDGE CASES
// ============================================================

describe('useMLInsights: edge cases', () => {
  it('handles null/missing fields in response', async () => {
    globalThis.fetch = mockFetch({
      body: {
        plots: null,
        findings: null,
        pipelineDate: null,
      } as unknown as MLPlotsResponse,
    });
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.plots).toEqual([]);
    expect(result.current.findings).toBeNull();
    expect(result.current.pipelineDate).toBeNull();
  });

  it('handles empty plots array', async () => {
    globalThis.fetch = mockFetch({
      body: {
        plots: [],
        findings: null,
        pipelineDate: null,
      },
    });
    const { result } = renderHook(() => useMLInsights());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.plots).toEqual([]);
  });
});
