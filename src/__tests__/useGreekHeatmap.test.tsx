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
import { captureUnlessAuth } from '../lib/sentry-helpers';

const mockFetch = vi.fn();
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
vi.mock('../utils/fetchWithRetry', () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetch(...args),
  // The hook now derives its transient flag from this classifier; the real
  // implementation (502/503/504) is trivial, so mirror it rather than
  // importOriginal — keeps the mock self-contained.
  isTransientHttpStatus: (status: number) => TRANSIENT_STATUSES.has(status),
}));

// Mock the Sentry helper so we can assert the hook reports backend
// contract drift (Zod failure) without touching the real Sentry SDK.
vi.mock('../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

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
    mockCaptureUnlessAuth.mockReset();
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
    expect(result.current.stale).toBe(false);
  });

  it('first-load failure (no prior data) sets data null, error, stale false', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe('network down');
    expect(result.current.stale).toBe(false);
  });

  it('preserves last-good data on a transient poll failure and flags stale', async () => {
    // First fetch succeeds, second (a refresh) fails — the grid must NOT
    // blank: keep the previous data, surface the error, mark stale.
    mockFetch.mockResolvedValueOnce(okResponse(HAPPY_RESPONSE));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.ticker).toBe('SPY');
    expect(result.current.stale).toBe(false);

    mockFetch.mockRejectedValueOnce(new Error('poll boom'));
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.error).toBe('poll boom'));
    // Last-good data preserved, not blanked.
    expect(result.current.data?.ticker).toBe('SPY');
    expect(result.current.data?.atmStrike).toBe(540);
    expect(result.current.stale).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('503 response flags transient and keeps last-good data', async () => {
    // First fetch succeeds, then the server returns a transient 503
    // (retryable Neon timeout). The grid must keep last-good data, mark
    // stale, AND set transient so the UI can show a soft placeholder
    // instead of the hard error card.
    mockFetch.mockResolvedValueOnce(okResponse(HAPPY_RESPONSE));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.ticker).toBe('SPY');
    expect(result.current.transient).toBe(false);

    mockFetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.error).toBe('HTTP 503'));
    expect(result.current.transient).toBe(true);
    // Last-good data preserved, not blanked.
    expect(result.current.data?.ticker).toBe('SPY');
    expect(result.current.stale).toBe(true);
  });

  it('503 first-load (no prior data) flags transient with null data', async () => {
    mockFetch.mockResolvedValue(new Response('busy', { status: 503 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe('HTTP 503');
    expect(result.current.transient).toBe(true);
    // stale is false because there is no last-good data to fall back on.
    expect(result.current.stale).toBe(false);
  });

  it('502 response (gateway hiccup) flags transient', async () => {
    mockFetch.mockResolvedValue(new Response('bad gw', { status: 502 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('HTTP 502');
    expect(result.current.transient).toBe(true);
  });

  it('504 response (gateway timeout) flags transient', async () => {
    mockFetch.mockResolvedValue(new Response('gw timeout', { status: 504 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('HTTP 504');
    expect(result.current.transient).toBe(true);
  });

  it('escalates to a hard error after >4 consecutive transient failures', async () => {
    // Sustained outage: 5 consecutive 503 polls. The first four keep the
    // soft transient flag; the fifth (count = 5 > MAX_TRANSIENT_RETRIES = 4)
    // flips transient back to false so the UI shows the hard error card.
    mockFetch.mockResolvedValue(new Response('busy', { status: 503 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    // Failure #1 (mount fetch).
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.transient).toBe(true);

    // Failures #2, #3, #4 — still soft.
    for (let i = 2; i <= 4; i++) {
      await act(async () => {
        result.current.refresh();
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.transient).toBe(true);
    }

    // Failure #5 — count exceeds MAX_TRANSIENT_RETRIES → escalate (hard).
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBe('HTTP 503'));
    expect(result.current.transient).toBe(false);
  });

  it('a success between transient failures resets the escalation counter', async () => {
    // 4 transient failures, then a success (resets the counter), then 4
    // more transient failures must STILL be soft — the counter restarted,
    // so we have not exceeded MAX_TRANSIENT_RETRIES.
    mockFetch.mockResolvedValue(new Response('busy', { status: 503 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    for (let i = 2; i <= 4; i++) {
      await act(async () => {
        result.current.refresh();
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
    }
    expect(result.current.transient).toBe(true);

    // Success resets the counter.
    mockFetch.mockResolvedValueOnce(okResponse(HAPPY_RESPONSE));
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.data?.ticker).toBe('SPY'));

    // 4 more transient failures — counter restarted, so still soft.
    mockFetch.mockResolvedValue(new Response('busy', { status: 503 }));
    for (let i = 1; i <= 4; i++) {
      await act(async () => {
        result.current.refresh();
      });
      await waitFor(() => expect(result.current.error).toBe('HTTP 503'));
    }
    expect(result.current.transient).toBe(true);
  });

  it('500 response sets error with transient false', async () => {
    mockFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('HTTP 500');
    expect(result.current.transient).toBe(false);
  });

  it('a successful fetch resets transient back to false', async () => {
    // First fetch is a transient 503, then a refresh succeeds — transient
    // must clear so the placeholder gives way to the real grid.
    mockFetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.transient).toBe(true));

    mockFetch.mockResolvedValueOnce(okResponse(HAPPY_RESPONSE));
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.data?.ticker).toBe('SPY'));
    expect(result.current.transient).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('malformed JSON (fails Zod) routes through error path without throwing', async () => {
    // First fetch returns a valid payload, second returns a shape that
    // fails validation (atmStrike is a string). The hook must not throw,
    // must keep last-good data, and must mark stale.
    mockFetch.mockResolvedValueOnce(okResponse(HAPPY_RESPONSE));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.ticker).toBe('SPY');

    mockFetch.mockResolvedValueOnce(
      okResponse({ ...HAPPY_RESPONSE, atmStrike: 'not-a-number' }),
    );
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data?.ticker).toBe('SPY');
    expect(result.current.stale).toBe(true);
  });

  it('malformed JSON on first load (no prior data) sets data null + error', async () => {
    mockFetch.mockResolvedValue(
      okResponse({ ...HAPPY_RESPONSE, atmStrike: 'not-a-number' }),
    );
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.stale).toBe(false);
    // A schema failure is a genuine error, not a transient degrade.
    expect(result.current.transient).toBe(false);
  });

  it('reports a Zod-failing response to Sentry exactly once', async () => {
    // A malformed payload (atmStrike is a string) fails schema validation.
    // The hook must report the contract drift to Sentry via the helper
    // exactly once, with the request context attached.
    mockFetch.mockResolvedValue(
      okResponse({ ...HAPPY_RESPONSE, atmStrike: 'not-a-number' }),
    );
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', date: '2026-05-15', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(mockCaptureUnlessAuth).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        contexts: expect.objectContaining({
          greekHeatmap: expect.objectContaining({
            ticker: 'SPY',
            date: '2026-05-15',
            issues: expect.any(Array),
          }),
        }),
      }),
    );
  });

  it('does NOT report to Sentry on a successful response', async () => {
    mockFetch.mockResolvedValue(okResponse(HAPPY_RESPONSE));
    const { result } = renderHook(() =>
      useGreekHeatmap({ ticker: 'SPY', enabled: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data?.ticker).toBe('SPY');
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
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
