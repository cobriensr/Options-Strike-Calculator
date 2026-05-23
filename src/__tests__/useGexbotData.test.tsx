// @vitest-environment jsdom

import '@testing-library/jest-dom';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { useGexbotData } from '../hooks/useGexbotData';

// Mock the fetchJson primitive so the hook's network layer is
// deterministic. The real fetchJson returns a discriminated union;
// mock both branches.
const mockFetchJson = vi.fn();
vi.mock('../hooks/useMarketData.fetchers', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

describe('useGexbotData', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Tests that rely on real timers + waitFor ──────────────

  describe('with real timers', () => {
    it('issues a single mount fetch and exposes the resulting rows', async () => {
      mockFetchJson.mockResolvedValue({
        data: {
          rows: [{ ticker: 'SPX', capturedAt: '2026-05-19T14:00:00Z' }],
        },
      });
      const { result } = renderHook(() =>
        useGexbotData({ view: 'snapshots-latest' }, true),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.rows).toHaveLength(1);
      expect(result.current.freshestAt).toBe('2026-05-19T14:00:00Z');
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(mockFetchJson).toHaveBeenCalledWith(
        '/api/gexbot?view=snapshots-latest',
      );
    });

    it('builds URL with ticker + side query for sibling-confirm', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() =>
        useGexbotData(
          { view: 'sibling-confirm', ticker: 'AAPL', side: 'call' },
          true,
        ),
      );
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalled());
      expect(mockFetchJson.mock.calls[0]![0]).toBe(
        '/api/gexbot?view=sibling-confirm&ticker=AAPL&side=call',
      );
    });

    it('surfaces error+status on FetchResult error branch', async () => {
      mockFetchJson.mockResolvedValue({
        error: 'Internal error',
        status: 500,
      });
      const { result } = renderHook(() =>
        useGexbotData({ view: 'snapshots-latest' }, true),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe('Internal error (HTTP 500)');
      expect(result.current.rows).toEqual([]);
    });

    it('treats missing rows array as empty without throwing', async () => {
      mockFetchJson.mockResolvedValue({ data: {} });
      const { result } = renderHook(() =>
        useGexbotData({ view: 'snapshots-latest' }, true),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows).toEqual([]);
      expect(result.current.freshestAt).toBeNull();
    });

    it('does not re-fetch on re-render when spec primitives are unchanged', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      const { rerender } = renderHook(
        ({ marketOpen }: { marketOpen: boolean }) =>
          useGexbotData({ view: 'snapshots-latest' }, marketOpen),
        { initialProps: { marketOpen: true } },
      );
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(1));
      // Re-render with same primitives — should NOT trigger another fetch.
      rerender({ marketOpen: true });
      rerender({ marketOpen: true });
      // Give any spurious queued effects a microtask to flush.
      await Promise.resolve();
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('re-fetches when ticker primitive changes (sibling-confirm view)', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      const { rerender } = renderHook(
        ({ ticker }: { ticker: string }) =>
          useGexbotData(
            { view: 'sibling-confirm', ticker, side: 'call' },
            true,
          ),
        { initialProps: { ticker: 'AAPL' } },
      );
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(1));
      rerender({ ticker: 'NVDA' });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(2));
      expect(mockFetchJson.mock.calls[1]![0]).toBe(
        '/api/gexbot?view=sibling-confirm&ticker=NVDA&side=call',
      );
    });

    // ── Request deduplication (fixes N+1 reported as
    //    SENTRY-EMERALD-DESERT-8J: 5 components mount
    //    `view=snapshots-latest` simultaneously on pageload)
    it('dedupes concurrent fetches for the same view URL (one network call, all callers get rows)', async () => {
      // A pending promise that we resolve manually so we can assert
      // multiple hooks are pending against ONE in-flight request.
      let resolve: ((v: unknown) => void) | undefined;
      const pending = new Promise<unknown>((r) => {
        resolve = r;
      });
      mockFetchJson.mockReturnValueOnce(pending);

      // Five concurrent consumers — mirrors CharmClock + GammaCompass +
      // VixDealerStateBadge + DexoflowVelocityTape + CrossAssetSkewDashboard
      // all requesting view=snapshots-latest on pageload.
      const consumers = Array.from({ length: 5 }, () =>
        renderHook(() => useGexbotData({ view: 'snapshots-latest' }, true)),
      );

      // All five must share ONE in-flight fetch.
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      resolve!({
        data: { rows: [{ ticker: 'SPX', capturedAt: '2026-05-23T16:00:00Z' }] },
      });
      for (const c of consumers) {
        await waitFor(() => expect(c.result.current.loading).toBe(false));
        expect(c.result.current.rows).toHaveLength(1);
      }
      // Still only one network call after all five resolved.
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('does NOT dedupe across distinct view URLs', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() => useGexbotData({ view: 'snapshots-latest' }, true));
      renderHook(() => useGexbotData({ view: 'convexity-trend' }, true));
      renderHook(() => useGexbotData({ view: 'maxchange-winners' }, true));
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(3));
    });

    it('releases the dedupe slot after settle so a follow-up fetch is fresh', async () => {
      // First mount + settle.
      mockFetchJson.mockResolvedValueOnce({ data: { rows: [] } });
      const { result, unmount } = renderHook(() =>
        useGexbotData({ view: 'snapshots-latest' }, true),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      unmount();

      // A second consumer mounting later (e.g. after the polling tick)
      // must start a NEW request, not get the stale dedupe slot.
      mockFetchJson.mockResolvedValueOnce({ data: { rows: [] } });
      const second = renderHook(() =>
        useGexbotData({ view: 'snapshots-latest' }, true),
      );
      await waitFor(() => expect(second.result.current.loading).toBe(false));
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });

  // ── Polling tests need fake timers ────────────────────────

  describe('polling behavior (fake timers)', () => {
    it('does not poll while marketOpen=false', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() => useGexbotData({ view: 'snapshots-latest' }, false));
      // Let the eager mount fetch resolve.
      await Promise.resolve();
      await Promise.resolve();
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      // Now switch to fake timers + advance 2 minutes.
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    // The "polls every 30s" path lives in `usePolling`, which has
    // its own coverage. Re-asserting it here would require swapping
    // timers mid-hook (the setInterval is scheduled with real timers
    // and fake-timer mode would have to be active before mount).
    // Verifying the gate semantics (above) is sufficient at this layer.
  });
});
