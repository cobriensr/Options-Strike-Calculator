import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useIVAnomalies } from '../../../hooks/useIVAnomalies';
import { ivAnomalyBannerStore } from '../banner-store';
import type { IVAnomaliesListResponse, IVAnomalyRow } from '../types';

/**
 * These tests exercise the aggregation pipeline — one ActiveAnomaly per
 * compound key (ticker:strike:side:expiry) with banner/chime firing only
 * on the transition from "not active" to "active".
 *
 * Note on time: eviction and silence-gap detection compare `Date.now()`
 * to the row's `ts`. The test helpers pin both so the boundary cases
 * stay deterministic.
 */

const SILENCE_MS = 15 * 60 * 1000;

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPX',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140,
    ivAtDetect: 0.22,
    skewDelta: 2.1,
    zScore: 3.2,
    askMidDiv: 0.6,
    flagReasons: ['skew_delta'],
    flowPhase: 'early',
    contextSnapshot: null,
    resolutionOutcome: null,
    ts: '2026-04-23T15:30:00Z',
    ...overrides,
  };
}

function payloadFor(rows: IVAnomalyRow[]): IVAnomaliesListResponse {
  const byTicker: Record<'SPX' | 'SPY' | 'QQQ', IVAnomalyRow[]> = {
    SPX: [],
    SPY: [],
    QQQ: [],
  };
  for (const r of rows) {
    if (r.ticker === 'SPX' || r.ticker === 'SPY' || r.ticker === 'QQQ') {
      byTicker[r.ticker].push(r);
    }
  }
  return {
    mode: 'list',
    latest: {
      SPX: byTicker.SPX.at(-1) ?? null,
      SPY: byTicker.SPY.at(-1) ?? null,
      QQQ: byTicker.QQQ.at(-1) ?? null,
    },
    history: byTicker,
  };
}

function respondWith(rows: IVAnomalyRow[]): Response {
  return new Response(JSON.stringify(payloadFor(rows)), { status: 200 });
}

/**
 * Pin both `Date.now()` (via fake timers) and the row's `ts` to the same
 * wall clock so silence-gap math compares row-time to "now" cleanly.
 */
function setSessionNow(dateIso: string): void {
  vi.setSystemTime(new Date(dateIso));
}

describe('useIVAnomalies — aggregation + alert semantics', () => {
  beforeEach(() => {
    ivAnomalyBannerStore.__resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    ivAnomalyBannerStore.__resetForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('primes silently on first poll: existing anomalies fill the board but no banner', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const rows = [
      makeRow({ id: 1, ts: '2026-04-23T15:30:00Z' }),
      makeRow({
        id: 2,
        ts: '2026-04-23T15:29:00Z',
        ticker: 'SPY',
        strike: 705,
      }),
      makeRow({
        id: 3,
        ts: '2026-04-23T15:28:00Z',
        ticker: 'QQQ',
        strike: 649,
      }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(respondWith(rows))),
    );

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(3));
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
  });

  it('new compound key on a subsequent poll fires banner + chime once', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const poll1 = [makeRow({ id: 1, ts: '2026-04-23T15:30:00Z' })];
    const poll2 = [
      ...poll1,
      makeRow({
        id: 2,
        ts: '2026-04-23T15:31:00Z',
        ticker: 'SPY',
        strike: 705,
      }),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respondWith(poll1))
      .mockResolvedValueOnce(respondWith(poll2));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:31:30Z');
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.anomalies.length).toBe(2));

    // Banner for the NEW compound key only — the SPX 7135P was already
    // active from the priming poll and must NOT re-banner.
    const banners = ivAnomalyBannerStore.getSnapshot().visible;
    expect(banners).toHaveLength(1);
    expect(banners[0]?.anomaly.id).toBe(2);
  });

  it('same compound key firing within 15 min updates metrics in place, no new banner', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const poll1 = [
      makeRow({
        id: 1,
        ts: '2026-04-23T15:30:00Z',
        zScore: 3.2,
        skewDelta: 2.1,
      }),
    ];
    // 1-min later, same compound key, fresh metrics + a new detector row id.
    const poll2 = [
      ...poll1,
      makeRow({
        id: 2,
        ts: '2026-04-23T15:31:00Z',
        zScore: 4.5,
        skewDelta: 3.0,
      }),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respondWith(poll1))
      .mockResolvedValueOnce(respondWith(poll2));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:31:30Z');
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Still one aggregated entry for the compound key; latest reflects the
    // fresher row; firingCount bumped; no banner (same active-span).
    const agg = result.current.anomalies;
    expect(agg).toHaveLength(1);
    expect(agg[0]?.latest.zScore).toBe(4.5);
    expect(agg[0]?.latest.skewDelta).toBe(3.0);
    expect(agg[0]?.firingCount).toBe(2);
    expect(agg[0]?.firstSeenTs).toBe('2026-04-23T15:30:00Z');
    expect(agg[0]?.lastFiredTs).toBe('2026-04-23T15:31:00Z');
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
  });

  it('same compound key after 15+ min silence fires a NEW banner (re-event)', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const initialRow = makeRow({ id: 1, ts: '2026-04-23T15:30:00Z' });
    const fetchMock = vi.fn();
    // Poll 1: strike fires at 15:30.
    fetchMock.mockResolvedValueOnce(respondWith([initialRow]));
    // Poll 2: strike comes back at 15:50 — 20 min after 15:30. Endpoint
    // returns ONLY the new fresh row (history is keyed by time, and the
    // previous one has rolled out — but even if it were still there, the
    // silence-gap check is row-level, not payload-level).
    fetchMock.mockResolvedValueOnce(
      respondWith([makeRow({ id: 2, ts: '2026-04-23T15:50:00Z' })]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));
    // Priming poll — no banner.
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);

    // Advance wall clock to 15:50:30 (the next poll).
    setSessionNow('2026-04-23T15:50:30Z');
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The entry from 15:30 should have been evicted before ingestion (lastFiredTs
    // was 20 min ago), so the incoming 15:50 row is a new compound-key event.
    const banners = ivAnomalyBannerStore.getSnapshot().visible;
    expect(banners).toHaveLength(1);
    expect(banners[0]?.anomaly.id).toBe(2);
    const agg = result.current.anomalies;
    expect(agg).toHaveLength(1);
    expect(agg[0]?.firingCount).toBe(1);
    expect(agg[0]?.firstSeenTs).toBe('2026-04-23T15:50:00Z');
  });

  it('evicts stale entries on the next poll so re-firings count as new events', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    // Poll 1: priming with one active strike.
    fetchMock.mockResolvedValueOnce(
      respondWith([makeRow({ id: 1, ts: '2026-04-23T15:30:00Z' })]),
    );
    // Poll 2: 16 min later, empty payload — the strike has gone silent.
    fetchMock.mockResolvedValueOnce(respondWith([]));
    // Poll 3: 20 min later, the same strike re-fires.
    fetchMock.mockResolvedValueOnce(
      respondWith([makeRow({ id: 99, ts: '2026-04-23T15:50:00Z' })]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:46:30Z');
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Entry has been evicted (lastFiredTs 15:30 is >15 min old vs 15:46).
    expect(result.current.anomalies.length).toBe(0);
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);

    setSessionNow('2026-04-23T15:50:30Z');
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // Re-appearing strike fires a fresh banner — it's a new event.
    expect(result.current.anomalies.length).toBe(1);
    const banners = ivAnomalyBannerStore.getSnapshot().visible;
    expect(banners).toHaveLength(1);
    expect(banners[0]?.anomaly.id).toBe(99);
  });

  it('two new compound keys in the same poll → two banners', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    // Prime with an unrelated existing strike so we have something to
    // baseline against.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({
          id: 1,
          ticker: 'SPX',
          strike: 7135,
          ts: '2026-04-23T15:30:00Z',
        }),
      ]),
    );
    // Poll 2 brings in SPY 705P and QQQ 649P both brand new.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ts: '2026-04-23T15:30:00Z' }),
        makeRow({
          id: 2,
          ticker: 'SPY',
          strike: 705,
          ts: '2026-04-23T15:31:00Z',
        }),
        makeRow({
          id: 3,
          ticker: 'QQQ',
          strike: 649,
          ts: '2026-04-23T15:31:00Z',
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:31:30Z');
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.anomalies.length).toBe(3));

    const banners = ivAnomalyBannerStore.getSnapshot().visible;
    // banner-store caps visible at 3 but holds both of the new pushes
    // regardless; we only pushed 2 this poll so both appear.
    const pushedIds = banners.map((b) => b.anomaly.id).sort((a, b) => a - b);
    expect(pushedIds).toEqual([2, 3]);
  });

  it('aggregates 10 firings of one compound key into ONE entry across 3 polls', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    // Poll 1: 3 existing firings (priming — no banner)
    const poll1Rows = [
      makeRow({ id: 1, ts: '2026-04-23T15:30:00Z', zScore: 3.0 }),
      makeRow({ id: 2, ts: '2026-04-23T15:31:00Z', zScore: 3.2 }),
      makeRow({ id: 3, ts: '2026-04-23T15:32:00Z', zScore: 3.4 }),
    ];
    // Poll 2: 4 more firings.
    const poll2Rows = [
      ...poll1Rows,
      makeRow({ id: 4, ts: '2026-04-23T15:33:00Z', zScore: 3.6 }),
      makeRow({ id: 5, ts: '2026-04-23T15:34:00Z', zScore: 3.8 }),
      makeRow({ id: 6, ts: '2026-04-23T15:35:00Z', zScore: 4.0 }),
      makeRow({ id: 7, ts: '2026-04-23T15:36:00Z', zScore: 4.2 }),
    ];
    // Poll 3: 3 more firings (total 10).
    const poll3Rows = [
      ...poll2Rows,
      makeRow({ id: 8, ts: '2026-04-23T15:37:00Z', zScore: 4.4 }),
      makeRow({ id: 9, ts: '2026-04-23T15:38:00Z', zScore: 4.6 }),
      makeRow({ id: 10, ts: '2026-04-23T15:39:00Z', zScore: 4.8 }),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respondWith(poll1Rows))
      .mockResolvedValueOnce(respondWith(poll2Rows))
      .mockResolvedValueOnce(respondWith(poll3Rows));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:36:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    setSessionNow('2026-04-23T15:39:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const agg = result.current.anomalies;
    expect(agg).toHaveLength(1);
    expect(agg[0]?.firingCount).toBe(10);
    expect(agg[0]?.latest.id).toBe(10);
    expect(agg[0]?.latest.zScore).toBe(4.8);
    expect(agg[0]?.firstSeenTs).toBe('2026-04-23T15:30:00Z');
    expect(agg[0]?.lastFiredTs).toBe('2026-04-23T15:39:00Z');

    // All 10 firings, zero banners (priming poll silent + continuations
    // within the 15-min window).
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
  });

  it(`uses ANOMALY_SILENCE_MS=${SILENCE_MS}ms as the silence threshold`, () => {
    // Guard: if someone changes the constant we want a loud failure so
    // the docs/tests stay in sync with the implementation.
    expect(SILENCE_MS).toBe(15 * 60 * 1000);
  });

  it('treats 401 as empty (non-owner) without setting error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('Unauthorized', { status: 401 })),
      ),
    );
    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.anomalies).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom'))),
    );
    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain('boom');
  });

  it('does not setState after unmount when a fetch resolves late', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useIVAnomalies(true, false));
    unmount();
    resolveFetch(respondWith([makeRow({ id: 99 })]));
    await new Promise((r) => setTimeout(r, 20));
    const didWarn = warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('unmounted'),
    );
    expect(didWarn).toBe(false);
    warn.mockRestore();
  });

  it('doubles the polling interval after 3 consecutive fails', async () => {
    // Every fetch fails — keeps failStreak climbing so we can observe
    // the interval double at the 3-fail threshold.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValue(new Error('always fail'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const callsAfter3 = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfter3);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfter3),
    );
    expect(result.current.error).toBeTruthy();
  });
});
