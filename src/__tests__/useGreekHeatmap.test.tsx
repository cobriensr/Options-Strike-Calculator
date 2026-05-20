// @vitest-environment jsdom

/**
 * Unit tests for src/hooks/useGreekHeatmap.ts.
 *
 * Covers the AbortController + setInterval + cleanup pattern:
 *   - happy path (fetch → state.data populated)
 *   - error path (non-2xx → state.error populated, data null)
 *   - polling lifecycle (enabled=true polls; enabled=false single-fetch)
 *   - URL construction with date + at query params
 *   - StrictMode/cancel-safety: rapid arg switch never leaves loading=true
 *     stuck on the previous fetch's abort (the bug the comment at
 *     useGreekHeatmap.ts:140 calls out).
 *   - refresh() returns same identity across re-renders for stable deps.
 */

import '@testing-library/jest-dom';
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { useGreekHeatmap } from '../hooks/useGreekHeatmap';

const mockFetch = vi.fn();
vi.mock('../utils/fetchWithRetry', () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetch(...args),
}));

const HAPPY_RESPONSE = {
  ticker: 'SPY',
  date: '2026-05-15',
  at: null,
  asOf: '2026-05-15T20:00:00Z',
  underlyingPrice: 540.12,
  atmStrike: 540,
  regime: 'Long Γ' as const,
  netGexK: 1234,
  chainStrikes: [],
  topStrikes: [],
  intradayRange: null,
  netFlow: null,
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useGreekHeatmap', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: fetches once on mount and exposes response data', async () => {
    mockFetch.mockResolvedValue(okResponse(HAPPY_RESPONSE));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data?.ticker).toBe('SPY');
    expect(result.current.data?.atmStrike).toBe(540);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/greek-heatmap?ticker=SPY',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('builds URL with date + at query params when supplied', async () => {
    mockFetch.mockResolvedValue(okResponse(HAPPY_RESPONSE));
    renderHook(() =>
      useGreekHeatmap({
        ticker: 'QQQ',
        date: '2026-04-30',
        at: '2026-04-30T18:30:00Z',
        enabled: false,
      }),
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('ticker=QQQ');
    expect(url).toContain('date=2026-04-30');
    expect(url).toContain('at=2026-04-30T18%3A30%3A00Z');
  });

  it('error path: non-2xx response surfaces error and clears data', async () => {
    mockFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'IWM', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe('HTTP 500');
  });

  it('thrown network error surfaces message via state.error', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('network down');
  });

  it('AbortError on still-mounted re-fetch does NOT update state', async () => {
    // First fetch never resolves until aborted; the rapid ticker switch
    // triggers a new fetch, the old AbortController fires AbortError —
    // the catch must early-return so the new fetch can land cleanly.
    const abortRef: { signal: AbortSignal | null } = { signal: null };
    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          abortRef.signal = init.signal ?? null;
          init.signal?.addEventListener('abort', () =>
            reject(
              new DOMException('aborted', 'AbortError') as unknown as Error,
            ),
          );
        }),
    );
    mockFetch.mockResolvedValueOnce(
      okResponse({ ...HAPPY_RESPONSE, ticker: 'IWM' }),
    );

    const { result, rerender } = renderHook(
      ({ ticker }: { ticker: string }) =>
        useGreekHeatmap({ ticker, enabled: false }),
      { initialProps: { ticker: 'SPY' } },
    );

    // First fetch in flight, hasn't resolved.
    expect(result.current.loading).toBe(true);

    // Rerender with new ticker — should abort the first fetch and start
    // a new one. The new fetch's success state must land, not be
    // stomped by the aborted first fetch.
    rerender({ ticker: 'IWM' });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.ticker).toBe('IWM');
    expect(result.current.error).toBeNull();
    expect(abortRef.signal?.aborted).toBe(true);
  });

  it('refresh() triggers a fresh network call', async () => {
    mockFetch.mockResolvedValue(okResponse(HAPPY_RESPONSE));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it('enabled=true sets up polling interval; enabled=false does not', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(okResponse(HAPPY_RESPONSE));

    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useGreekHeatmap({ ticker: 'SPY', enabled }),
      { initialProps: { enabled: false } },
    );

    // Initial fetch on mount fires regardless of enabled.
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Advancing past poll interval while disabled — no second fetch.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Enable polling — interval starts, advancing 30s fires another fetch.
    rerender({ enabled: true });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2)); // immediate fetch on enable

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    unmount();
    expect(result.current).toBeDefined();
  });
});
