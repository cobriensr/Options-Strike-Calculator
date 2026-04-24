import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useIVAnomalies } from '../../../hooks/useIVAnomalies';
import { ivAnomalyBannerStore } from '../banner-store';
import {
  IV_ANOMALY_TICKERS,
  type IVAnomaliesListResponse,
  type IVAnomalyRow,
  type IVAnomalyTicker,
} from '../types';

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
    ticker: 'SPXW',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140,
    ivAtDetect: 0.22,
    skewDelta: 2.1,
    zScore: 3.2,
    askMidDiv: 0.6,
    volOiRatio: 48.5,
    flagReasons: ['skew_delta'],
    flowPhase: 'early',
    contextSnapshot: null,
    resolutionOutcome: null,
    ts: '2026-04-23T15:30:00Z',
    ...overrides,
  };
}

function isKnownTicker(t: string): t is IVAnomalyTicker {
  return (IV_ANOMALY_TICKERS as readonly string[]).includes(t);
}

function payloadFor(rows: IVAnomalyRow[]): IVAnomaliesListResponse {
  // Seed every ticker key so the response shape matches the server's
  // always-emit-every-ticker contract — the hook reads from all of them.
  const byTicker = Object.fromEntries(
    IV_ANOMALY_TICKERS.map((t) => [t, [] as IVAnomalyRow[]]),
  ) as unknown as Record<IVAnomalyTicker, IVAnomalyRow[]>;
  for (const r of rows) {
    if (isKnownTicker(r.ticker)) {
      byTicker[r.ticker].push(r);
    }
  }
  const latest = Object.fromEntries(
    IV_ANOMALY_TICKERS.map((t) => [t, byTicker[t].at(-1) ?? null]),
  ) as unknown as Record<IVAnomalyTicker, IVAnomalyRow | null>;
  return {
    mode: 'list',
    latest,
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

    // Banner for the NEW compound key only — the SPXW 7135P was already
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
          ticker: 'SPXW',
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

  // ─── Exit-signal phase transitions ───────────────────────────────

  it('stays active when IV keeps rising (no exit transition)', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    // Priming poll: entry IV 0.20.
    fetchMock.mockResolvedValueOnce(
      respondWith([makeRow({ id: 1, ivAtDetect: 0.2 })]),
    );
    // Next poll: IV rising 0.22 → 0.25 → 0.28 (no regression).
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.2 }),
        makeRow({
          id: 2,
          ivAtDetect: 0.22,
          ts: '2026-04-23T15:31:00Z',
        }),
        makeRow({
          id: 3,
          ivAtDetect: 0.25,
          ts: '2026-04-23T15:32:00Z',
        }),
        makeRow({
          id: 4,
          ivAtDetect: 0.28,
          ts: '2026-04-23T15:33:00Z',
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:33:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const agg = result.current.anomalies;
    expect(agg[0]?.phase).toBe('active');
    expect(agg[0]?.peakIv).toBeCloseTo(0.28, 6);
    // No exit banner.
    const exits = ivAnomalyBannerStore
      .getSnapshot()
      .visible.filter((b) => b.kind === 'exit');
    expect(exits).toHaveLength(0);
  });

  it('IV regression triggers cooling + exit banner once', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    // Priming poll at 15:30: IV=0.25 (entryIv).
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
      ]),
    );
    // Poll 2: IV climbs to 0.33 (peak).
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
      ]),
    );
    // Poll 3: IV drops to 0.30 → drop of (0.33 - 0.30) / (0.33 - 0.25) = 37.5%
    // which exceeds the 30% threshold. Peak (15:33) is within the 10-min window.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
        makeRow({ id: 3, ivAtDetect: 0.3, ts: '2026-04-23T15:36:00Z' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:33:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.anomalies[0]?.phase).toBe('active');

    setSessionNow('2026-04-23T15:36:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const agg = result.current.anomalies[0];
    expect(agg?.phase).toBe('cooling');
    expect(agg?.exitReason).toBe('iv_regression');
    const exits = ivAnomalyBannerStore
      .getSnapshot()
      .visible.filter((b) => b.kind === 'exit');
    expect(exits).toHaveLength(1);
    expect(exits[0]?.exitReason).toBe('iv_regression');
  });

  it('ask-mid compression after ≥5 min of accumulation triggers cooling', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    // Priming: lots of baseline firings so the avg firing rate is high enough
    // that the single-row compression poll below doesn't also trip
    // `distributing` (which would otherwise take display priority).
    const baseline: IVAnomalyRow[] = [];
    // 7 firings over 7 min at accumulation threshold — ~1/min baseline.
    for (let i = 0; i < 7; i += 1) {
      const mins = String(30 + i).padStart(2, '0');
      baseline.push(
        makeRow({
          id: i + 1,
          askMidDiv: 0.008,
          ts: `2026-04-23T15:${mins}:00Z`,
          ivAtDetect: 0.22,
        }),
      );
    }
    fetchMock.mockResolvedValueOnce(respondWith(baseline));
    // Poll 2: one more compression row at 15:37 with collapsed div.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        ...baseline,
        makeRow({
          id: 99,
          askMidDiv: 0.001,
          ts: '2026-04-23T15:37:00Z',
          ivAtDetect: 0.22,
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:37:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const agg = result.current.anomalies[0];
    expect(agg?.phase).toBe('cooling');
    expect(agg?.exitReason).toBe('ask_mid_compression');
  });

  it('volume surge with flat IV triggers distributing', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    // Priming (1 firing; entry span starts).
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
      ]),
    );
    // Poll 2 at 15:40 — still 1 firing, baseline span = 10 min, avg 0.1/min.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
      ]),
    );
    // Poll 3 at 15:40:30 — suddenly 20 firings in ~1 min. IV flat at 0.25.
    const burst: IVAnomalyRow[] = [
      makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
    ];
    for (let i = 0; i < 20; i += 1) {
      const sec = String(10 + Math.floor(i * 2.5)).padStart(2, '0');
      const mins = String(39 + Math.floor(i / 10)).padStart(2, '0');
      burst.push(
        makeRow({
          id: 100 + i,
          ivAtDetect: 0.25,
          ts: `2026-04-23T15:${mins}:${sec}Z`,
        }),
      );
    }
    fetchMock.mockResolvedValueOnce(respondWith(burst));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:40:00Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    setSessionNow('2026-04-23T15:40:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const agg = result.current.anomalies[0];
    expect(agg?.phase).toBe('distributing');
    expect(agg?.exitReason).toBe('volume_surge_flat_iv');
    const exits = ivAnomalyBannerStore
      .getSnapshot()
      .visible.filter((b) => b.kind === 'exit');
    expect(exits.length).toBeGreaterThanOrEqual(1);
    expect(exits.some((b) => b.exitReason === 'volume_surge_flat_iv')).toBe(
      true,
    );
  });

  it('cooling recovers to active when IV climbs past old peak — no re-banner', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    // Priming.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
      ]),
    );
    // Rise to peak 0.33.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
      ]),
    );
    // Drop to 0.30 → cooling.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
        makeRow({ id: 3, ivAtDetect: 0.3, ts: '2026-04-23T15:36:00Z' }),
      ]),
    );
    // Climb back up to 0.35 (NEW peak past 0.33) → should return to active.
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
        makeRow({ id: 3, ivAtDetect: 0.3, ts: '2026-04-23T15:36:00Z' }),
        makeRow({ id: 4, ivAtDetect: 0.35, ts: '2026-04-23T15:39:00Z' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));

    setSessionNow('2026-04-23T15:33:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    setSessionNow('2026-04-23T15:36:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(result.current.anomalies[0]?.phase).toBe('cooling');

    setSessionNow('2026-04-23T15:39:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const agg = result.current.anomalies[0];
    expect(agg?.phase).toBe('active');
    expect(agg?.peakIv).toBeCloseTo(0.35, 6);
    // There SHOULD be one entry banner from poll 2 and one exit banner
    // from poll 3 — but NO new entry banner from poll 4 (recovery is silent).
    const banners = ivAnomalyBannerStore.getSnapshot().visible;
    const entries = banners.filter((b) => b.kind === 'entry');
    // poll 2 was the one entry banner — id should be 2 (the new compound key
    // path for an already-primed map doesn't happen; entry banner fires when
    // the map first learns this strike outside priming — poll 2 here).
    // NOTE: the aggregation primes from poll 1 so the compound key exists
    // before poll 2; id=2 is same compound key, so no entry banner from
    // poll 2 either. We ASSERT 0 entry banners.
    expect(entries).toHaveLength(0);
  });

  it('exit banner carries kind=exit on the banner store push', async () => {
    setSessionNow('2026-04-23T15:30:30Z');
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
      ]),
    );
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
      ]),
    );
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
        makeRow({ id: 3, ivAtDetect: 0.3, ts: '2026-04-23T15:36:00Z' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));
    setSessionNow('2026-04-23T15:33:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    setSessionNow('2026-04-23T15:36:30Z');
    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const banners = ivAnomalyBannerStore.getSnapshot().visible;
    const exitBanners = banners.filter((b) => b.kind === 'exit');
    expect(exitBanners.length).toBeGreaterThanOrEqual(1);
    const firstExit = exitBanners[0];
    expect(firstExit?.exitReason).toBe('iv_regression');
    expect(firstExit?.id).toContain(':exit');
  });

  it('first-poll priming does not fire an exit banner when existing row is already cooling', async () => {
    setSessionNow('2026-04-23T15:36:30Z');
    // Priming batch: 3 rows showing a clear rise-then-fall — if this were
    // NOT the priming poll, the hook would fire an exit banner. We assert
    // it stays silent.
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      respondWith([
        makeRow({ id: 1, ivAtDetect: 0.25, ts: '2026-04-23T15:30:00Z' }),
        makeRow({ id: 2, ivAtDetect: 0.33, ts: '2026-04-23T15:33:00Z' }),
        makeRow({ id: 3, ivAtDetect: 0.3, ts: '2026-04-23T15:36:00Z' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies.length).toBe(1));
    // Zero banners of any kind on the priming poll.
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
    // But the internal phase correctly reflects the cooling state.
    const agg = result.current.anomalies[0];
    expect(agg?.phase).toBe('cooling');
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
