// @vitest-environment jsdom

import '@testing-library/jest-dom';
import { act, renderHook, waitFor } from '@testing-library/react';
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

    it('builds URL with ticker + side + fire time for sibling-confirm', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() =>
        useGexbotData(
          {
            view: 'sibling-confirm',
            ticker: 'AAPL',
            side: 'call',
            at: '2026-10-29T14:00:10.000Z',
          },
          true,
        ),
      );
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalled());
      expect(mockFetchJson.mock.calls[0]![0]).toBe(
        '/api/gexbot?view=sibling-confirm&ticker=AAPL&side=call&at=2026-10-29T14%3A00%3A10.000Z',
      );
    });

    it('re-fetches when the fire time changes (sibling-confirm view)', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      const { rerender } = renderHook(
        ({ at }: { at: string }) =>
          useGexbotData(
            { view: 'sibling-confirm', ticker: 'AAPL', side: 'call', at },
            true,
          ),
        { initialProps: { at: '2026-10-29T14:00:10.000Z' } },
      );
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(1));
      rerender({ at: '2026-10-29T15:00:10.000Z' });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(2));
      expect(mockFetchJson.mock.calls[1]![0]).toContain(
        'at=2026-10-29T15%3A00%3A10.000Z',
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
            {
              view: 'sibling-confirm',
              ticker,
              side: 'call',
              at: '2026-10-29T14:00:10.000Z',
            },
            true,
          ),
        { initialProps: { ticker: 'AAPL' } },
      );
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(1));
      rerender({ ticker: 'NVDA' });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(2));
      expect(mockFetchJson.mock.calls[1]![0]).toBe(
        '/api/gexbot?view=sibling-confirm&ticker=NVDA&side=call&at=2026-10-29T14%3A00%3A10.000Z',
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

      // Five concurrent consumers — mirrors the Gexbot panels that request
      // view=snapshots-latest on pageload.
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
    // Advance the fake clock inside act so state updates render between ticks.
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

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

    it('polls the snapshots view every 30 s while marketOpen', async () => {
      vi.useFakeTimers();
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() => useGexbotData({ view: 'snapshots-latest' }, true));
      await vi.advanceTimersByTimeAsync(60_000);
      // mount fetch + ticks at 30 s and 60 s
      expect(mockFetchJson).toHaveBeenCalledTimes(3);
    });

    it('never polls sibling-confirm: the read at a past fire time is final', async () => {
      vi.useFakeTimers();
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() =>
        useGexbotData(
          {
            view: 'sibling-confirm',
            ticker: 'AAPL',
            side: 'call',
            at: '2026-10-29T14:00:10.000Z',
          },
          true,
        ),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    describe('a failed sibling-confirm read', () => {
      const SIBLING = {
        view: 'sibling-confirm' as const,
        ticker: 'AAPL',
        side: 'call' as const,
        at: '2026-10-29T14:00:10.000Z',
      };
      const OK = { data: { rows: [{ ticker: 'QQQ', verdict: 'agree' }] } };
      const FAIL = { error: 'Internal error', status: 500 };

      it('retries on the 30 s tick, then stops once a read succeeds', async () => {
        vi.useFakeTimers();
        mockFetchJson.mockResolvedValueOnce(FAIL).mockResolvedValue(OK);
        const { result } = renderHook(() => useGexbotData(SIBLING, true));
        await advance(0);
        expect(result.current.error).toBe('Internal error (HTTP 500)');
        expect(mockFetchJson).toHaveBeenCalledTimes(1);

        await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.error).toBeNull();
        expect(result.current.rows).toHaveLength(1);

        // Recovered: a past fire's answer is final, so no further reads.
        await advance(120_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
      });

      it('keeps retrying while the read keeps failing', async () => {
        vi.useFakeTimers();
        mockFetchJson
          .mockResolvedValueOnce(FAIL)
          .mockResolvedValueOnce(FAIL)
          .mockResolvedValue(OK);
        const { result } = renderHook(() => useGexbotData(SIBLING, true));
        await advance(0);
        await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.error).toBe('Internal error (HTTP 500)');
        await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(3);
        expect(result.current.error).toBeNull();
        await advance(120_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(3);
      });

      it.each([
        ['a network failure, timeout or abort', 0],
        ['a request timeout', 408],
        ['rate limiting', 429],
        ['a server error', 500],
        ['an unavailable upstream', 503],
      ])(
        'retries %s (status %i) with the market closed, then stops once a read succeeds',
        async (_name, status) => {
          vi.useFakeTimers();
          mockFetchJson
            .mockResolvedValueOnce({ error: 'Upstream down', status })
            .mockResolvedValue(OK);
          const { result } = renderHook(() => useGexbotData(SIBLING, false));
          await advance(0);
          expect(result.current.error).toBe(`Upstream down (HTTP ${status})`);
          expect(mockFetchJson).toHaveBeenCalledTimes(1);

          await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(2);
          expect(result.current.error).toBeNull();
          expect(result.current.rows).toHaveLength(1);

          await advance(120_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(2);
        },
      );

      it.each(
        [400, 401, 403, 404].flatMap((status) => [
          [status, true],
          [status, false],
        ]),
      )(
        'does not retry a permanent failure (status %i, marketOpen %s)',
        async (status, marketOpen) => {
          vi.useFakeTimers();
          mockFetchJson.mockResolvedValue({ error: 'Rejected', status });
          const { result } = renderHook(() =>
            useGexbotData(SIBLING, marketOpen as boolean),
          );
          await advance(0);
          expect(result.current.error).toBe(`Rejected (HTTP ${status})`);
          // Step tick by tick: the gate opens on a render, not mid-advance.
          for (let tick = 0; tick < 4; tick += 1) await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(1);
        },
      );

      it('stops after 5 failed retries: the mount read plus 5 retries, then nothing', async () => {
        vi.useFakeTimers();
        mockFetchJson.mockResolvedValue({ error: 'Unavailable', status: 503 });
        const { result } = renderHook(() => useGexbotData(SIBLING, true));
        await advance(0);
        for (let retry = 1; retry <= 5; retry += 1) {
          await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(1 + retry);
        }
        await advance(60_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(6);
        // The row keeps showing why it has no pills.
        expect(result.current.error).toBe('Unavailable (HTTP 503)');
      });

      it('counts a mix of transient failures and ends on a permanent one', async () => {
        vi.useFakeTimers();
        mockFetchJson
          .mockResolvedValueOnce({ error: 'Unavailable', status: 503 })
          .mockResolvedValueOnce({ error: 'Too many requests', status: 429 })
          .mockResolvedValue({ error: 'Forbidden', status: 403 });
        const { result } = renderHook(() => useGexbotData(SIBLING, true));
        await advance(0);
        await advance(30_000);
        await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(3);
        expect(result.current.error).toBe('Forbidden (HTTP 403)');
        await advance(120_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(3);
      });

      it('starts the count again when the fire time changes', async () => {
        vi.useFakeTimers();
        mockFetchJson.mockResolvedValue({ error: 'Unavailable', status: 503 });
        const { rerender } = renderHook(
          ({ at }: { at: string }) => useGexbotData({ ...SIBLING, at }, true),
          { initialProps: { at: SIBLING.at } },
        );
        await advance(0);
        for (let retry = 0; retry < 3; retry += 1) await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(4);

        rerender({ at: '2026-10-29T15:00:10.000Z' });
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(5);
        // The new URL gets its own five retries, not the two left over.
        for (let retry = 0; retry < 5; retry += 1) await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(10);
        await advance(60_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(10);
      });
    });

    describe('a round trip through a URL that never answers', () => {
      const SIBLING = {
        view: 'sibling-confirm' as const,
        ticker: 'AAPL',
        side: 'call' as const,
        at: '2026-10-29T14:00:10.000Z',
      };
      // Its own fire time: the hook's in-flight map is module state, so a
      // pending read of a URL other tests use would hang them.
      const AT_PENDING = '2026-10-29T16:00:10.000Z';
      const OK = { data: { rows: [{ ticker: 'QQQ', verdict: 'agree' }] } };
      const FAIL_503 = { error: 'Unavailable', status: 503 };

      it.each([
        ['after three failed reads', 3, false],
        ['after three failed reads and then a good one', 3, true],
      ])(
        'gives the URL a fresh count when the user comes back to it %s',
        async (_name, failedReads, goodReadFirst) => {
          vi.useFakeTimers();
          let resolvePending!: (v: unknown) => void;
          const pending = new Promise((r) => {
            resolvePending = r;
          });
          let aReads = 0;
          mockFetchJson.mockImplementation((url: string) => {
            if (url.includes('T16%3A00%3A10')) return pending;
            aReads += 1;
            return Promise.resolve(
              goodReadFirst && aReads === failedReads + 1 ? OK : FAIL_503,
            );
          });
          const { rerender } = renderHook(
            ({ at }: { at: string }) => useGexbotData({ ...SIBLING, at }, true),
            { initialProps: { at: SIBLING.at } },
          );
          await advance(0);
          const readsBeforeLeaving = failedReads + (goodReadFirst ? 1 : 0);
          for (let tick = 1; tick < readsBeforeLeaving; tick += 1) {
            await advance(30_000);
          }
          expect(aReads).toBe(readsBeforeLeaving);

          // Away to a URL that has not answered, then back to the first.
          rerender({ at: AT_PENDING });
          await advance(0);
          rerender({ at: SIBLING.at });
          await advance(0);
          expect(aReads).toBe(readsBeforeLeaving + 1);

          // A fresh read plus its own five retries, then nothing.
          for (let retry = 1; retry <= 5; retry += 1) {
            await advance(30_000);
            expect(aReads).toBe(readsBeforeLeaving + 1 + retry);
          }
          await advance(60_000);
          expect(aReads).toBe(readsBeforeLeaving + 6);

          // Release the module's in-flight slot for the pending URL.
          resolvePending({ data: { rows: [] } });
          await advance(0);
        },
      );
    });

    describe('a failed read after a good one for the same URL', () => {
      it('keeps the last good rows and freshest time and sets the error', async () => {
        vi.useFakeTimers();
        const rows = [{ ticker: 'SPX', capturedAt: '2026-10-29T14:04:00Z' }];
        mockFetchJson
          .mockResolvedValueOnce({ data: { rows } })
          .mockResolvedValue({ error: 'Unavailable', status: 503 });
        const { result } = renderHook(() =>
          useGexbotData({ view: 'snapshots-latest' }, true),
        );
        await advance(0);
        expect(result.current.error).toBeNull();
        expect(result.current.rows).toEqual(rows);

        await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.error).toBe('Unavailable (HTTP 503)');
        expect(result.current.loading).toBe(false);
        expect(result.current.rows).toEqual(rows);
        expect(result.current.freshestAt).toBe('2026-10-29T14:04:00Z');
      });
    });

    describe('a failed read on any other view', () => {
      it('keeps the market-open gate: no retry after hours', async () => {
        vi.useFakeTimers();
        mockFetchJson.mockResolvedValue({ error: 'Unavailable', status: 503 });
        renderHook(() => useGexbotData({ view: 'snapshots-latest' }, false));
        await advance(120_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
      });

      it('keeps polling every 30 s while open, with no cap or status filter', async () => {
        vi.useFakeTimers();
        mockFetchJson.mockResolvedValue({ error: 'Forbidden', status: 403 });
        renderHook(() => useGexbotData({ view: 'snapshots-latest' }, true));
        await advance(0);
        for (let tick = 0; tick < 10; tick += 1) await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(11);
      });
    });
  });

  // ── Superseded sibling-confirm requests ───────────────────

  describe('sibling-confirm when the fire time changes', () => {
    const AT_OLD = '2026-10-29T14:00:10.000Z';
    const AT_NEW = '2026-10-29T15:00:10.000Z';
    const useSibling = ({ at }: { at: string }) =>
      useGexbotData(
        { view: 'sibling-confirm', ticker: 'AAPL', side: 'call', at },
        true,
      );

    // Let a late promise settle and any state update it triggers flush.
    const settle = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

    function deferred() {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('ignores a late response for the superseded fire time', async () => {
      const oldReq = deferred();
      const newReq = deferred();
      mockFetchJson
        .mockReturnValueOnce(oldReq.promise)
        .mockReturnValueOnce(newReq.promise);
      const { result, rerender } = renderHook(useSibling, {
        initialProps: { at: AT_OLD },
      });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(1));
      rerender({ at: AT_NEW });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(2));

      newReq.resolve({ data: { rows: [{ ticker: 'SPY', verdict: 'agree' }] } });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows).toEqual([
        { ticker: 'SPY', verdict: 'agree' },
      ]);

      // The older request lands last and must not overwrite the newer one.
      oldReq.resolve({
        data: { rows: [{ ticker: 'QQQ', verdict: 'disagree' }] },
      });
      await settle();
      expect(result.current.rows).toEqual([
        { ticker: 'SPY', verdict: 'agree' },
      ]);
    });

    it('ignores a late error for the superseded fire time', async () => {
      const oldReq = deferred();
      const newReq = deferred();
      mockFetchJson
        .mockReturnValueOnce(oldReq.promise)
        .mockReturnValueOnce(newReq.promise);
      const { result, rerender } = renderHook(useSibling, {
        initialProps: { at: AT_OLD },
      });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(1));
      rerender({ at: AT_NEW });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(2));
      newReq.resolve({ data: { rows: [] } });
      await waitFor(() => expect(result.current.loading).toBe(false));
      oldReq.resolve({ error: 'Internal error', status: 500 });
      await settle();
      expect(result.current.error).toBeNull();
    });

    it('drops the previous fire rows and shows loading until the new read lands', async () => {
      const newReq = deferred();
      mockFetchJson
        .mockResolvedValueOnce({
          data: { rows: [{ ticker: 'QQQ', verdict: 'agree' }] },
        })
        .mockReturnValueOnce(newReq.promise);
      const { result, rerender } = renderHook(useSibling, {
        initialProps: { at: AT_OLD },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows).toHaveLength(1);

      rerender({ at: AT_NEW });
      expect(result.current.loading).toBe(true);
      expect(result.current.rows).toEqual([]);
      expect(result.current.freshestAt).toBeNull();

      newReq.resolve({ data: { rows: [] } });
      await waitFor(() => expect(result.current.loading).toBe(false));
    });
  });
});
