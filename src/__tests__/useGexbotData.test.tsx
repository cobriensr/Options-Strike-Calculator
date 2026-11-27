// @vitest-environment jsdom

import '@testing-library/jest-dom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { useGexbotData } from '../hooks/useGexbotData';

// Mock the fetchJson primitive so the hook's network layer is
// deterministic. The real fetchJson returns a discriminated union;
// mock both branches.
const mockFetchJson = vi.fn();
vi.mock('../hooks/useMarketData.fetchers', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

// Resolvers of the reads a test left open. The hook's in-flight map is module
// state: a read still pending after a failed test would hang every later test
// on the same URL, so afterEach settles them.
const openReads: Array<(v: unknown) => void> = [];

/** A read the test settles by hand. */
function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  openReads.push(resolve);
  return { promise, resolve };
}

// Let a late promise settle and any state update it triggers flush.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

// Mon 2026-11-23 12:00 ET (17:00Z), mid-session. The four views that keep the
// last session arm a final fetch for 16:03 ET, and a body from before today's
// open is dropped by the clock, so a test on the real wall clock would change
// with the hour and day it ran at. Every fake-timer test starts from a fixed
// instant instead.
const MIDSESSION = '2026-11-23T17:00:00Z';

/** Fake timers on a fixed clock. */
function fakeClock(now: string = MIDSESSION) {
  vi.useFakeTimers({ now: new Date(now) });
}

// Advance the fake clock inside act so state updates render between ticks.
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useGexbotData', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const resolve of openReads.splice(0)) {
      resolve({ data: { rows: [] } });
    }
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

    it('builds the expected-move URL with no extra params', async () => {
      mockFetchJson.mockResolvedValue({
        data: {
          rows: [{ ticker: 'SPX', capturedAt: '2025-07-23T15:13:14.000Z' }],
        },
      });
      const { result } = renderHook(() =>
        useGexbotData({ view: 'expected-move' }, true),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockFetchJson).toHaveBeenCalledWith(
        '/api/gexbot?view=expected-move',
      );
      expect(result.current.freshestAt).toBe('2025-07-23T15:13:14.000Z');
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
    it('does not poll while marketOpen=false', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() => useGexbotData({ view: 'snapshots-latest' }, false));
      // Let the eager mount fetch resolve.
      await Promise.resolve();
      await Promise.resolve();
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      // Now switch to fake timers + advance 2 minutes.
      fakeClock();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('polls the snapshots view every 30 s while marketOpen', async () => {
      fakeClock();
      mockFetchJson.mockResolvedValue({ data: { rows: [] } });
      renderHook(() => useGexbotData({ view: 'snapshots-latest' }, true));
      await vi.advanceTimersByTimeAsync(60_000);
      // mount fetch + ticks at 30 s and 60 s
      expect(mockFetchJson).toHaveBeenCalledTimes(3);
    });

    it('never polls sibling-confirm: the read at a past fire time is final', async () => {
      fakeClock();
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
        fakeClock();
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
        fakeClock();
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
          fakeClock();
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
          fakeClock();
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
        fakeClock();
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

      it('counts one failure when two overlapping reads share one request', async () => {
        // StrictMode runs the mount effect twice; both calls join one deduped
        // request, so its answer reaches the hook twice. Only the newest call
        // may apply it, or the first failure counts as two and the row gets a
        // retry fewer.
        fakeClock();
        mockFetchJson.mockResolvedValue({ error: 'Unavailable', status: 503 });
        const { result } = renderHook(() => useGexbotData(SIBLING, true), {
          wrapper: StrictMode,
        });
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
        for (let retry = 1; retry <= 5; retry += 1) {
          await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(1 + retry);
        }
        await advance(60_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(6);
        expect(result.current.error).toBe('Unavailable (HTTP 503)');
      });

      it('counts a mix of transient failures and ends on a permanent one', async () => {
        fakeClock();
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
        fakeClock();
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
          fakeClock();
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
        fakeClock();
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
      // The four views that keep the last session retry a closed-hour failure
      // (see "the last session, after the close"); expected-move does not.
      it('keeps the market-open gate: no retry after hours', async () => {
        fakeClock();
        mockFetchJson.mockResolvedValue({ error: 'Unavailable', status: 503 });
        renderHook(() => useGexbotData({ view: 'expected-move' }, false));
        await advance(120_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
      });

      it('keeps polling every 30 s while open, with no cap or status filter', async () => {
        fakeClock();
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

  // ── The market's open edge ────────────────────────────────
  //
  // A tab left open overnight holds yesterday's last rows. usePolling never
  // calls fn on a gate flip, so without a read at the flip those rows would
  // render as live until the first 30 s tick. No timer is advanced below: a
  // read that needs one is the bug.

  describe('when the market opens (marketOpen goes false to true)', () => {
    const PRIOR = { ticker: 'SPX', capturedAt: '2026-11-24T20:59:59Z' };
    const FRESH = { ticker: 'SPX', capturedAt: '2026-11-25T14:30:05Z' };
    const useView = ({
      view,
      marketOpen,
    }: {
      view:
        | 'snapshots-latest'
        | 'velocity'
        | 'convexity-trend'
        | 'maxchange-winners'
        | 'expected-move';
      marketOpen: boolean;
    }) => useGexbotData({ view }, marketOpen);

    it.each([
      'snapshots-latest',
      'velocity',
      'convexity-trend',
      'maxchange-winners',
      'expected-move',
    ] as const)(
      'drops the prior session rows and reads %s at once',
      async (view) => {
        mockFetchJson.mockResolvedValueOnce({ data: { rows: [PRIOR] } });
        const { result, rerender } = renderHook(useView, {
          initialProps: { view, marketOpen: false },
        });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.rows).toEqual([PRIOR]);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);

        const fresh = deferred();
        mockFetchJson.mockReturnValueOnce(fresh.promise);
        rerender({ view, marketOpen: true });

        // The read went out on the flip itself, not on a later tick.
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(mockFetchJson).toHaveBeenLastCalledWith(
          `/api/gexbot?view=${view}`,
        );
        // Between the flip and the answer nothing of yesterday is returned.
        expect(result.current.loading).toBe(true);
        expect(result.current.rows).toEqual([]);
        expect(result.current.freshestAt).toBeNull();

        fresh.resolve({ data: { rows: [FRESH] } });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.rows).toEqual([FRESH]);
        expect(result.current.freshestAt).toBe(FRESH.capturedAt);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
      },
    );

    it('drops a held error too and shows loading until the new read lands', async () => {
      mockFetchJson.mockResolvedValueOnce({
        error: 'Unavailable',
        status: 503,
      });
      const { result, rerender } = renderHook(useView, {
        initialProps: { view: 'expected-move' as const, marketOpen: false },
      });
      await waitFor(() =>
        expect(result.current.error).toBe('Unavailable (HTTP 503)'),
      );

      const fresh = deferred();
      mockFetchJson.mockReturnValueOnce(fresh.promise);
      rerender({ view: 'expected-move', marketOpen: true });
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();

      fresh.resolve({ data: { rows: [FRESH] } });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.rows).toEqual([FRESH]);
    });

    it('joins a read that is still in flight: one request, answered once', async () => {
      // A flip that lands while an earlier read of the same URL is still out
      // (a tab loaded seconds before 09:30): marketOpen starts false and
      // flips at the open while the mount read has not answered.
      const mount = deferred();
      mockFetchJson.mockReturnValueOnce(mount.promise);
      const { result, rerender } = renderHook(useView, {
        initialProps: { view: 'expected-move' as const, marketOpen: false },
      });
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      rerender({ view: 'expected-move', marketOpen: true });
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(true);

      mount.resolve({ data: { rows: [FRESH] } });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows).toEqual([FRESH]);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('reads again on every later opening, not only the first', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [FRESH] } });
      const { result, rerender } = renderHook(useView, {
        initialProps: { view: 'expected-move' as const, marketOpen: false },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      rerender({ view: 'expected-move', marketOpen: true });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockFetchJson).toHaveBeenCalledTimes(2);

      rerender({ view: 'expected-move', marketOpen: false });
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
      rerender({ view: 'expected-move', marketOpen: true });
      await waitFor(() => expect(mockFetchJson).toHaveBeenCalledTimes(3));
    });

    it('reads at the next opening of a tab that mounted open and saw the close', async () => {
      // Overnight: loaded in the session, closed at 16:00, open again at 09:30.
      mockFetchJson.mockResolvedValue({ data: { rows: [FRESH] } });
      const { result, rerender } = renderHook(useView, {
        initialProps: { view: 'expected-move' as const, marketOpen: true },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ view: 'expected-move', marketOpen: false });
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      const fresh = deferred();
      mockFetchJson.mockReturnValueOnce(fresh.promise);
      rerender({ view: 'expected-move', marketOpen: true });
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
      expect(result.current.loading).toBe(true);
      expect(result.current.rows).toEqual([]);

      fresh.resolve({ data: { rows: [FRESH] } });
      await waitFor(() => expect(result.current.loading).toBe(false));
    });

    it('fires nothing when it mounts open, and nothing on a later render while open', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [FRESH] } });
      const { result, rerender } = renderHook(useView, {
        initialProps: { view: 'expected-move' as const, marketOpen: true },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      rerender({ view: 'expected-move', marketOpen: true });
      await settle();
      // The mount read, and no second one for starting open.
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(result.current.rows).toEqual([FRESH]);
    });

    it('fires nothing at the close and keeps the last rows', async () => {
      mockFetchJson.mockResolvedValue({ data: { rows: [FRESH] } });
      const { result, rerender } = renderHook(useView, {
        initialProps: { view: 'expected-move' as const, marketOpen: true },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      rerender({ view: 'expected-move', marketOpen: false });
      await settle();
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.rows).toEqual([FRESH]);
    });

    it('leaves sibling-confirm alone: its gate is its own retry rule', async () => {
      const sibling = {
        view: 'sibling-confirm' as const,
        ticker: 'AAPL',
        side: 'call' as const,
        at: '2026-10-29T14:00:10.000Z',
      };
      const rows = [{ ticker: 'QQQ', verdict: 'agree' }];
      mockFetchJson.mockResolvedValue({ data: { rows } });
      const { result, rerender } = renderHook(
        ({ marketOpen }: { marketOpen: boolean }) =>
          useGexbotData(sibling, marketOpen),
        { initialProps: { marketOpen: false } },
      );
      await waitFor(() => expect(result.current.loading).toBe(false));

      rerender({ marketOpen: true });
      await settle();
      // A past fire's answer is final: no clear, no second read.
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.rows).toEqual(rows);
    });
  });

  // ── The last session, after the close ─────────────────────
  //
  // Tue 2026-11-24 closes at 16:00 ET (21:00Z, EST) and its one final fetch is
  // due at 16:03 ET (21:03Z). The server answers a closed read with the last
  // session's rows and their capture time as `asOf`; the hook keeps them, and
  // drops them again once the market is open. A fake clock drives every case.

  describe('the last session, after the close', () => {
    const CLOSE_AT = '2026-11-24T20:59:00Z';
    const CLOSE_ROW = { ticker: 'SPX', capturedAt: CLOSE_AT };
    const CLOSED_BODY = { data: { rows: [CLOSE_ROW], asOf: CLOSE_AT } };
    // A capture that landed after CLOSE_AT, as the final fetch finds it.
    const LAST_ROW = { ticker: 'SPX', capturedAt: '2026-11-24T21:00:00Z' };
    const LAST_BODY = { data: { rows: [LAST_ROW], asOf: LAST_ROW.capturedAt } };
    const UNAVAILABLE = { error: 'Unavailable', status: 503 };
    const IN_SCOPE_VIEWS = [
      'snapshots-latest',
      'velocity',
      'convexity-trend',
      'maxchange-winners',
    ] as const;
    /** Tue 16:01 ET: closed, with the final fetch two minutes off. */
    const AFTER_CLOSE = '2026-11-24T21:01:00Z';
    const FINAL_FETCH_IN_MS = 120_000;
    /** Tue 16:10 ET: the final fetch is behind, the next one is tomorrow. */
    const LATER = '2026-11-24T21:10:00Z';
    /** Wed 09:30:05 ET: the market has just opened. */
    const JUST_OPEN = '2026-11-25T14:30:05Z';

    const useSnapshots = ({ marketOpen }: { marketOpen: boolean }) =>
      useGexbotData({ view: 'snapshots-latest' }, marketOpen);

    function mount(marketOpen: boolean, wrapper?: typeof StrictMode) {
      return renderHook(useSnapshots, {
        initialProps: { marketOpen },
        wrapper,
      });
    }

    describe('asOf', () => {
      it('is the body asOf', async () => {
        fakeClock();
        mockFetchJson.mockResolvedValue({
          data: { rows: [], asOf: '2026-11-23T16:00:00Z' },
        });
        const { result } = mount(true);
        await advance(0);
        expect(result.current.asOf).toBe('2026-11-23T16:00:00Z');
      });

      it('is null while the first read is out, and when the body has none', async () => {
        fakeClock();
        mockFetchJson.mockResolvedValue({ data: { rows: [] } });
        const { result } = mount(true);
        expect(result.current.asOf).toBeNull();
        await advance(0);
        expect(result.current.loading).toBe(false);
        expect(result.current.asOf).toBeNull();
      });

      it.each([
        ['a number', 1_764_000_000],
        // Date.parse reads both of these as a date once they are strings.
        ['a number that reads as a year', 2026],
        ['an array holding a timestamp', [CLOSE_AT]],
        ['an empty string', ''],
        ['text that is not a date', 'yesterday'],
        ['null', null],
        ['an object', { at: CLOSE_AT }],
      ])('reads %s as no asOf and still returns the rows', async (_n, asOf) => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson.mockResolvedValue({ data: { rows: [CLOSE_ROW], asOf } });
        const { result } = mount(false);
        await advance(0);
        expect(result.current.asOf).toBeNull();
        expect(result.current.rows).toEqual([CLOSE_ROW]);
      });
    });

    describe('a body from before today’s open, once the market is open', () => {
      it.each(IN_SCOPE_VIEWS)(
        'drops it for %s: no rows, no asOf, no error',
        async (view) => {
          fakeClock(JUST_OPEN);
          mockFetchJson.mockResolvedValue(CLOSED_BODY);
          const { result } = renderHook(() => useGexbotData({ view }, true));
          await advance(0);
          expect(mockFetchJson).toHaveBeenCalledTimes(1);
          expect(result.current.rows).toEqual([]);
          expect(result.current.asOf).toBeNull();
          expect(result.current.freshestAt).toBeNull();
          expect(result.current.error).toBeNull();
          expect(result.current.loading).toBe(false);
        },
      );

      it('keeps the same body while the market is closed', async () => {
        fakeClock(JUST_OPEN);
        mockFetchJson.mockResolvedValue(CLOSED_BODY);
        const { result } = mount(false);
        await advance(0);
        expect(result.current.rows).toEqual([CLOSE_ROW]);
        expect(result.current.asOf).toBe(CLOSE_AT);
        expect(result.current.freshestAt).toBe(CLOSE_AT);
      });

      it('keeps a body captured at the open instant', async () => {
        fakeClock(JUST_OPEN);
        const row = { ticker: 'SPX', capturedAt: '2026-11-25T14:30:00Z' };
        mockFetchJson.mockResolvedValue({
          data: { rows: [row], asOf: row.capturedAt },
        });
        const { result } = mount(true);
        await advance(0);
        expect(result.current.rows).toEqual([row]);
        expect(result.current.asOf).toBe(row.capturedAt);
      });

      it('leaves expected-move alone: its rows are not the last session', async () => {
        fakeClock(JUST_OPEN);
        mockFetchJson.mockResolvedValue(CLOSED_BODY);
        const { result } = renderHook(() =>
          useGexbotData({ view: 'expected-move' }, true),
        );
        await advance(0);
        expect(result.current.rows).toEqual([CLOSE_ROW]);
        expect(result.current.asOf).toBe(CLOSE_AT);
      });

      it('stays empty when the read at the open still answers with the last session, then takes the next live read', async () => {
        fakeClock(JUST_OPEN);
        const live = { ticker: 'SPX', capturedAt: '2026-11-25T14:30:00Z' };
        mockFetchJson.mockResolvedValueOnce(CLOSED_BODY);
        const { result, rerender } = mount(false);
        await advance(0);
        expect(result.current.rows).toEqual([CLOSE_ROW]);

        // An edge cache still holds Tuesday's close when the market opens.
        mockFetchJson.mockResolvedValueOnce(CLOSED_BODY);
        rerender({ marketOpen: true });
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.rows).toEqual([]);
        expect(result.current.asOf).toBeNull();
        expect(result.current.loading).toBe(false);

        mockFetchJson.mockResolvedValueOnce({
          data: { rows: [live], asOf: live.capturedAt },
        });
        await advance(30_000);
        expect(result.current.rows).toEqual([live]);
        expect(result.current.asOf).toBe(live.capturedAt);
      });
    });

    describe('the final fetch', () => {
      it('fires once at 16:03 ET, not before, and shows what it finds', async () => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson
          .mockResolvedValueOnce(CLOSED_BODY)
          .mockResolvedValue(LAST_BODY);
        const { result } = mount(false);
        await advance(FINAL_FETCH_IN_MS - 1);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
        expect(result.current.rows).toEqual([CLOSE_ROW]);

        await advance(1);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(mockFetchJson).toHaveBeenLastCalledWith(
          '/api/gexbot?view=snapshots-latest',
        );
        expect(result.current.rows).toEqual([LAST_ROW]);
        expect(result.current.asOf).toBe(LAST_ROW.capturedAt);
        expect(result.current.freshestAt).toBe(LAST_ROW.capturedAt);
      });

      it('fires for a tab that stayed open through the close', async () => {
        fakeClock('2026-11-24T20:59:50Z');
        mockFetchJson
          .mockResolvedValueOnce(CLOSED_BODY)
          .mockResolvedValue(LAST_BODY);
        const { result, rerender } = mount(true);
        await advance(0);
        rerender({ marketOpen: false });
        // 190 s to 21:03:00.
        await advance(189_999);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.rows).toEqual([LAST_ROW]);
      });

      it('re-arms for the next trading day', async () => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson.mockResolvedValue(CLOSED_BODY);
        mount(false);
        await advance(FINAL_FETCH_IN_MS);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);

        // Wed 16:03 ET is 24 h on: same EST offset.
        await advance(24 * 3_600_000 - 1);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(mockFetchJson).toHaveBeenCalledTimes(3);
      });

      it.each([
        [
          'sibling-confirm',
          {
            view: 'sibling-confirm' as const,
            ticker: 'AAPL',
            side: 'call' as const,
            at: '2026-11-24T14:00:10.000Z',
          },
        ],
        ['expected-move', { view: 'expected-move' as const }],
      ])('makes no request at 16:03 ET for %s', async (_name, spec) => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson.mockResolvedValue({ data: { rows: [] } });
        renderHook(() => useGexbotData(spec, false));
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
        await advance(10 * 60_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
      });

      it('is one request when two panels of the same view fire it together', async () => {
        fakeClock(AFTER_CLOSE);
        const final = deferred();
        mockFetchJson
          .mockResolvedValueOnce(CLOSED_BODY)
          .mockReturnValueOnce(final.promise);
        const first = mount(false);
        const second = mount(false);
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);

        await advance(FINAL_FETCH_IN_MS);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);

        final.resolve(LAST_BODY);
        await advance(0);
        expect(first.result.current.rows).toEqual([LAST_ROW]);
        expect(second.result.current.rows).toEqual([LAST_ROW]);
      });
    });

    describe('a failed fetch while the market is closed', () => {
      it('keeps the held rows with no error when the final fetch fails, and retries 30 s later', async () => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson
          .mockResolvedValueOnce(CLOSED_BODY)
          .mockResolvedValueOnce(UNAVAILABLE)
          .mockResolvedValue(LAST_BODY);
        const { result } = mount(false);
        await advance(FINAL_FETCH_IN_MS);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.error).toBeNull();
        expect(result.current.loading).toBe(false);
        expect(result.current.rows).toEqual([CLOSE_ROW]);
        expect(result.current.asOf).toBe(CLOSE_AT);
        expect(result.current.freshestAt).toBe(CLOSE_AT);

        await advance(29_999);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(mockFetchJson).toHaveBeenCalledTimes(3);
        expect(result.current.rows).toEqual([LAST_ROW]);
        expect(result.current.error).toBeNull();
      });

      it('keeps the held rows through every retry, then stops after the fifth', async () => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson
          .mockResolvedValueOnce(CLOSED_BODY)
          .mockResolvedValue(UNAVAILABLE);
        const { result } = mount(false);
        await advance(FINAL_FETCH_IN_MS);
        for (let retry = 1; retry <= 5; retry += 1) {
          await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(2 + retry);
          expect(result.current.error).toBeNull();
          expect(result.current.rows).toEqual([CLOSE_ROW]);
        }
        await advance(120_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(7);
        expect(result.current.rows).toEqual([CLOSE_ROW]);
        expect(result.current.error).toBeNull();
      });

      it('shows the error while it retries when nothing is held, then the rows once a retry succeeds', async () => {
        fakeClock(LATER);
        mockFetchJson
          .mockResolvedValueOnce(UNAVAILABLE)
          .mockResolvedValue(CLOSED_BODY);
        const { result } = mount(false);
        await advance(0);
        expect(result.current.error).toBe('Unavailable (HTTP 503)');
        expect(result.current.rows).toEqual([]);

        await advance(29_999);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.error).toBeNull();
        expect(result.current.rows).toEqual([CLOSE_ROW]);
        expect(result.current.asOf).toBe(CLOSE_AT);

        // Recovered: nothing more until tomorrow's final fetch.
        await advance(5 * 60_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
      });

      it.each([
        ['plain', undefined],
        ['under StrictMode', StrictMode],
      ])(
        'makes the mount read plus 5 retries, 30 s apart, then stops (%s)',
        async (_name, wrapper) => {
          fakeClock(LATER);
          mockFetchJson.mockResolvedValue(UNAVAILABLE);
          const { result } = mount(false, wrapper);
          await advance(0);
          expect(mockFetchJson).toHaveBeenCalledTimes(1);
          for (let retry = 1; retry <= 5; retry += 1) {
            await advance(30_000);
            expect(mockFetchJson).toHaveBeenCalledTimes(1 + retry);
          }
          await advance(5 * 60_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(6);
          expect(result.current.error).toBe('Unavailable (HTTP 503)');
        },
      );

      it.each([400, 401, 403, 404])(
        'does not retry a refused request (status %i), and shows it',
        async (status) => {
          fakeClock(LATER);
          mockFetchJson.mockResolvedValue({ error: 'Rejected', status });
          const { result } = mount(false);
          await advance(0);
          for (let tick = 0; tick < 6; tick += 1) await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(1);
          expect(result.current.error).toBe(`Rejected (HTTP ${status})`);
        },
      );

      it('keeps held rows when a refused final fetch fails, and does not retry it', async () => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson
          .mockResolvedValueOnce(CLOSED_BODY)
          .mockResolvedValue({ error: 'Forbidden', status: 403 });
        const { result } = mount(false);
        await advance(FINAL_FETCH_IN_MS);
        for (let tick = 0; tick < 6; tick += 1) await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        expect(result.current.rows).toEqual([CLOSE_ROW]);
        expect(result.current.error).toBeNull();
      });

      it.each([
        ['snapshots-latest', null, 3],
        ['expected-move', 'Unavailable (HTTP 503)', 2],
      ] as const)(
        'counts a poll that comes back failed after the close as closed: %s shows %s',
        async (view, error, calls) => {
          fakeClock('2026-11-24T20:59:40Z');
          const poll = deferred();
          mockFetchJson
            .mockResolvedValueOnce(CLOSED_BODY)
            .mockReturnValueOnce(poll.promise)
            .mockResolvedValue(CLOSED_BODY);
          const { result, rerender } = renderHook(
            ({ marketOpen }: { marketOpen: boolean }) =>
              useGexbotData({ view }, marketOpen),
            { initialProps: { marketOpen: true } },
          );
          await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(2);

          // The close lands while the poll is out; it answers after.
          rerender({ marketOpen: false });
          poll.resolve(UNAVAILABLE);
          await advance(0);
          expect(result.current.rows).toEqual([CLOSE_ROW]);
          expect(result.current.error).toBe(error);

          // The four views retry 30 s later; expected-move has no retry.
          await advance(30_000);
          expect(mockFetchJson).toHaveBeenCalledTimes(calls);
        },
      );

      it('keeps counting a retry that a newer read took over, as its own failure', async () => {
        // 09:29:50 ET on the client clock, a few seconds before the open.
        fakeClock('2026-11-25T14:29:50Z');
        const retry = deferred();
        mockFetchJson
          .mockResolvedValueOnce(UNAVAILABLE)
          .mockReturnValueOnce(retry.promise)
          .mockResolvedValue(UNAVAILABLE);
        const { rerender } = mount(false);
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);

        // 09:30:20: the first retry goes out and is still out when the market
        // opens and the open-edge read joins it as the newer read.
        await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
        rerender({ marketOpen: true });
        expect(mockFetchJson).toHaveBeenCalledTimes(2);

        // It comes back failed at 09:30:30. The poll opened at 09:30:20 ticks
        // at 09:30:50 (a third request), and the retry series, which the
        // answer keeps alive, at 09:31:00 (a fourth).
        await advance(10_000);
        retry.resolve(UNAVAILABLE);
        await advance(0);
        await advance(20_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(3);
        await advance(10_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(4);
      });

      it('stops retrying when the hook unmounts', async () => {
        fakeClock(AFTER_CLOSE);
        mockFetchJson.mockResolvedValue(UNAVAILABLE);
        const { unmount } = mount(false);
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
        unmount();
        // Neither the retry series nor the 16:03 final fetch survives.
        await advance(10 * 60_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
      });
    });

    describe('a failed fetch while the market is open', () => {
      it('starts no retry series: the 30 s poll is the only follow-up', async () => {
        fakeClock();
        mockFetchJson.mockResolvedValue(UNAVAILABLE);
        const { result } = mount(true);
        await advance(0);
        expect(mockFetchJson).toHaveBeenCalledTimes(1);
        expect(result.current.error).toBe('Unavailable (HTTP 503)');

        await advance(30_000);
        expect(mockFetchJson).toHaveBeenCalledTimes(2);
      });

      it('keeps the held rows but shows the error', async () => {
        fakeClock();
        const row = { ticker: 'SPX', capturedAt: '2026-11-23T16:00:00Z' };
        mockFetchJson
          .mockResolvedValueOnce({
            data: { rows: [row], asOf: row.capturedAt },
          })
          .mockResolvedValue(UNAVAILABLE);
        const { result } = mount(true);
        await advance(30_000);
        expect(result.current.error).toBe('Unavailable (HTTP 503)');
        expect(result.current.rows).toEqual([row]);
        expect(result.current.asOf).toBe(row.capturedAt);
      });
    });
  });
});
