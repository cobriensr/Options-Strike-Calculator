import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  buildSnapshotMeta,
  useSnapshotSave,
} from '../../hooks/useSnapshotSave';
import type {
  SnapshotMeta,
  SnapshotMetaSource,
} from '../../hooks/useSnapshotSave';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import type { CalculationResults, DeltaRow } from '../../types';
import type { ComputedSignals } from '../../hooks/useComputedSignals';

// ============================================================
// MOCK DATA
// ============================================================

function makeResults(
  overrides: Partial<CalculationResults> = {},
): CalculationResults {
  return {
    spot: 5500,
    sigma: 0.15,
    T: 0.025,
    hoursRemaining: 6.5,
    marketHours: 6.5,
    allDeltas: [
      {
        delta: 5,
        putSnapped: 5400,
        callSnapped: 5600,
        putPct: '-1.82',
        callPct: '1.82',
      } as DeltaRow,
    ],
    ...overrides,
  };
}

const defaultSignals: ComputedSignals = {
  vix1d: undefined,
  vix9d: undefined,
  vvix: undefined,
  sigmaSource: 'VIX × 1.15',
  // The entry time in ET: NOW's, so a save for TODAY is a live one.
  etHour: 11,
  etMinute: 0,
  regimeZone: null,
  dowLabel: null,
  dowMultHL: null,
  dowMultOC: null,
  icCeiling: null,
  putSpreadCeiling: null,
  callSpreadCeiling: null,
  moderateDelta: null,
  conservativeDelta: null,
  medianOcPct: null,
  medianHlPct: null,
  p90OcPct: null,
  p90HlPct: null,
  p90OcPts: null,
  p90HlPts: null,
  openingRangeAvailable: false,
  openingRangeHigh: null,
  openingRangeLow: null,
  openingRangePctConsumed: null,
  openingRangeSignal: null,
  vixTermSignal: null,
  vixTermShape: null,
  vixTermShapeAdvice: null,
  clusterPutMult: null,
  clusterCallMult: null,
  rvIvRatio: null,
  rvIvLabel: null,
  rvAnnualized: null,
  spxOpen: null,
  spxHigh: null,
  spxLow: null,
  prevClose: null,
  overnightGap: null,
  isEarlyClose: false,
  isEventDay: false,
  eventNames: [],
  dataNote: undefined,
};

vi.mock('../../lib/sentry-helpers', () => ({ captureUnlessAuth: vi.fn() }));

// The clock is pinned (Date only, so promises and waitFor keep real timers)
// to 2026-03-10 11:00 EDT, so TODAY is the ET date the hook compares with.
const NOW = '2026-03-10T15:00:00Z';
const TODAY = '2026-03-10';
const YESTERDAY = '2026-03-09';
const TOMORROW = '2026-03-11';

/** Meta for today, its inputs filled from the live quotes (SPX 5500, VIX 18). */
const baseMeta: SnapshotMeta = {
  selectedDate: TODAY,
  entryTime: '09:35',
  live: { spot: 5500, vix: 18 },
  spy: 550,
  vix: 18,
};

/** A date's intraday history at the entry time: SPX 5500, SPY 550, VIX 18. */
function hist(date: string, spot = 5500) {
  return { date, spot, spy: Math.round((spot / 10) * 100) / 100, vix: 18 };
}

/** Meta for a past date whose own intraday history filled the inputs. */
const backtestMeta: SnapshotMeta = {
  ...baseMeta,
  selectedDate: YESTERDAY,
  history: hist(YESTERDAY),
};

// ============================================================
// FETCH MOCK
// ============================================================

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.mocked(captureUnlessAuth).mockClear();
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ id: 'abc', saved: true }), { status: 200 }),
    );
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
});

/** The JSON body of the nth POST (0-based). */
function body(n = 0): Record<string, unknown> {
  return JSON.parse(fetchSpy.mock.calls[n]![1]!.body as string);
}

// ============================================================
// TESTS
// ============================================================

describe('useSnapshotSave', () => {
  it('does not fire when results is null', () => {
    renderHook(() => useSnapshotSave(null, defaultSignals, baseMeta, true));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire when isOwner is false', () => {
    renderHook(() =>
      useSnapshotSave(makeResults(), defaultSignals, baseMeta, false),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire when selectedDate is missing', () => {
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...baseMeta, selectedDate: undefined },
        true,
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire when entryTime is missing', () => {
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...baseMeta, entryTime: undefined },
        true,
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires POST to /api/snapshot with correct payload', () => {
    renderHook(() =>
      useSnapshotSave(makeResults(), defaultSignals, baseMeta, true),
    );

    expect(fetchSpy).toHaveBeenCalledWith('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
      signal: expect.any(AbortSignal),
    });

    const sent = body() as {
      strikes: Record<string, unknown>;
    } & Record<string, unknown>;
    expect(sent.date).toBe('2026-03-10');
    expect(sent.entryTime).toBe('09:35');
    expect(sent.spx).toBe(5500);
    expect(sent.spy).toBe(550);
    expect(sent.vix).toBe(18);
    expect(sent.strikes).toBeDefined();
    expect(sent.strikes['5']).toEqual({
      put: 5400,
      call: 5600,
      putPct: -1.82,
      callPct: 1.82,
    });
  });

  it('does not fire duplicate requests for same date+time', () => {
    const results = makeResults();
    const { rerender } = renderHook(() =>
      useSnapshotSave(results, defaultSignals, baseMeta, true),
    );

    rerender();
    rerender();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fires again for a different date+time combination', () => {
    const results = makeResults();
    const { rerender } = renderHook(
      ({ meta }) => useSnapshotSave(results, defaultSignals, meta, true),
      { initialProps: { meta: baseMeta } },
    );

    rerender({ meta: { ...baseMeta, entryTime: '10:00' } });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not remove key from saved set when fetch rejects with AbortError', async () => {
    // AbortError means the component unmounted (a dependency change no longer
    // aborts) — the key should remain in the saved set (no retry desired)
    const abortError = new DOMException('signal was aborted', 'AbortError');
    fetchSpy.mockRejectedValueOnce(abortError);

    const results = makeResults();
    renderHook(() => useSnapshotSave(results, defaultSignals, baseMeta, true));

    // Wait for the rejected promise to settle
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // Re-rendering should NOT trigger another fetch because key is still in savedRef
    // (AbortError path returns early without deleting the key)
    // A second hook with different time will fire normally to confirm fetch is still working
    renderHook(() =>
      useSnapshotSave(
        results,
        defaultSignals,
        { ...baseMeta, entryTime: '10:30' },
        true,
      ),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps an in-flight save running when a dependency changes', () => {
    // Once a replay holds a history snapshot, App's signals change identity
    // on every render (a late /api/vix-ohlc answer is enough). The key is
    // already marked saved, so an aborted POST would never be posted again.
    let signal: AbortSignal | null | undefined;
    fetchSpy.mockImplementationOnce((_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const results = makeResults();
    const { rerender } = renderHook(
      ({ signals }) => useSnapshotSave(results, signals, baseMeta, true),
      { initialProps: { signals: defaultSignals } },
    );

    rerender({ signals: { ...defaultSignals } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
  });

  it('aborts the saves still in flight when the hook unmounts, without reporting or retrying them', async () => {
    const signals: AbortSignal[] = [];
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init!.signal!;
      signals.push(signal);
      // As fetch does: reject with an AbortError once the signal aborts.
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const results = makeResults();
    const { rerender, unmount } = renderHook(
      ({ meta }) => useSnapshotSave(results, defaultSignals, meta, true),
      { initialProps: { meta: baseMeta } },
    );
    rerender({ meta: { ...baseMeta, entryTime: '09:40' } });
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);

    unmount();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    // Let the AbortError rejections reach their handlers (only Date is faked).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(captureUnlessAuth).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('posts again after StrictMode’s simulated unmount aborted the mount pass’s POST', () => {
    // StrictMode mounts, cleans up and mounts again. That cleanup aborts the
    // first pass's POST, so its key must be released for the re-run to post.
    const signals: AbortSignal[] = [];
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => {});
    });
    const results = makeResults();

    renderHook(() => useSnapshotSave(results, defaultSignals, baseMeta, true), {
      reactStrictMode: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  });

  it('skips allDeltas entries with errors', () => {
    const results = makeResults({
      allDeltas: [
        { delta: 5, error: 'No solution' } as never,
        {
          delta: 10,
          putSnapped: 5350,
          callSnapped: 5650,
          putPct: '-2.73',
          callPct: '2.73',
        } as DeltaRow,
      ],
    });

    renderHook(() => useSnapshotSave(results, defaultSignals, baseMeta, true));

    const { strikes } = body() as { strikes: Record<string, unknown> };
    expect(strikes['5']).toBeUndefined();
    expect(strikes['10']).toEqual({
      put: 5350,
      call: 5650,
      putPct: -2.73,
      callPct: 2.73,
    });
  });
});

// ============================================================
// WHICH DATES SAVE, AND WITH WHICH FLAG
// ============================================================

describe('useSnapshotSave — which dates save', () => {
  it('saves today with is_backtest false', () => {
    renderHook(() =>
      useSnapshotSave(makeResults(), defaultSignals, baseMeta, true),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().date).toBe(TODAY);
    expect(body().isBacktest).toBe(false);
  });

  it('saves today with is_backtest false when today has its own intraday history', () => {
    // Today's history exists once its first candle does; its saves are
    // still today's live rows.
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...baseMeta, history: hist(TODAY) },
        true,
      ),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().isBacktest).toBe(false);
  });

  it('saves a past date with its own intraday history with is_backtest true', () => {
    renderHook(() =>
      useSnapshotSave(makeResults(), defaultSignals, backtestMeta, true),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().date).toBe(YESTERDAY);
    expect(body().spx).toBe(5500);
    expect(body().isBacktest).toBe(true);
  });

  it('makes no save call for a past date without intraday history', () => {
    // The inputs then hold today's live quotes, not that date's prices.
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...baseMeta, selectedDate: YESTERDAY, history: null },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['today', TODAY],
    ['an older date', '2026-03-06'],
  ])(
    "makes no save call for a past date holding another date's stale history (%s)",
    (_label, staleDate) => {
      // useHistoryData keeps the last date's history while the new date's
      // loads; saving it would file that date's prices under this one.
      renderHook(() =>
        useSnapshotSave(
          makeResults(),
          defaultSignals,
          { ...backtestMeta, history: hist(staleDate) },
          true,
        ),
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['without history', null],
    ['even with history labelled for it', hist(TOMORROW)],
  ])('makes no save call for a future date (%s)', (_label, history) => {
    // The date input has no max, and the live quotes fill a future date.
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...baseMeta, selectedDate: TOMORROW, history },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("waits to save a past date until its inputs carry the history's SPX", () => {
    // The history arrives a render before its prices reach the inputs
    // (useAutoFill writes them in an effect, then the 250 ms debounce):
    // until then the calculator still shows the live SPX.
    const { rerender } = renderHook(
      ({ results }) =>
        useSnapshotSave(results, defaultSignals, backtestMeta, true),
      { initialProps: { results: makeResults({ spot: 6812.4 }) } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // The SPX input is the history's spot rounded to a whole point.
    rerender({ results: makeResults({ spot: 5500.4 }) });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().spx).toBe(5500.4);
    expect(body().isBacktest).toBe(true);
  });

  it('treats the date as today up to ET midnight and as past after it', () => {
    // 23:59 EDT on 03-10, with the entry time synced to it.
    vi.setSystemTime(new Date('2026-03-11T03:59:00Z'));
    const lateSignals = { ...defaultSignals, etHour: 23, etMinute: 59 };
    const { rerender } = renderHook(
      ({ meta }) => useSnapshotSave(makeResults(), lateSignals, meta, true),
      { initialProps: { meta: { ...baseMeta, entryTime: '10:59 PM CT' } } },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().isBacktest).toBe(false);

    // 00:00 EDT on 03-11: 03-10 is now a past date, and without its own
    // history it no longer saves.
    vi.setSystemTime(new Date('2026-03-11T04:00:00Z'));
    rerender({ meta: { ...baseMeta, entryTime: '11:00 PM CT' } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // With its own history it saves, as a backtest row.
    rerender({
      meta: {
        ...baseMeta,
        entryTime: '11:00 PM CT',
        history: hist(TODAY),
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(body(1).isBacktest).toBe(true);
  });
});

// ============================================================
// TODAY SCRUBBED FORWARD (a future entry time)
// ============================================================

describe('useSnapshotSave — today scrubbed forward', () => {
  it('makes no save call for an entry time ahead of the clock', () => {
    // NOW is 11:00 ET; the inputs are still now's live quotes, which would
    // be filed under 11:30.
    const ahead = { ...defaultSignals, etHour: 11, etMinute: 30 };
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        ahead,
        { ...baseMeta, entryTime: '10:30 AM CT' },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['2 minutes ahead', 2, 0],
    ['the current minute', 0, 1],
    ['1 minute ahead (clock slack)', 1, 1],
  ])('at %s (minute %i) makes %i live save call(s)', (_label, ahead, posts) => {
    const signals = { ...defaultSignals, etHour: 11, etMinute: ahead };
    renderHook(() => useSnapshotSave(makeResults(), signals, baseMeta, true));

    expect(fetchSpy).toHaveBeenCalledTimes(posts);
    if (posts > 0) expect(body().isBacktest).toBe(false);
  });
});

// ============================================================
// A "TODAY" WITH NO SESSION (weekend, holiday)
// ============================================================

describe('useSnapshotSave — a today without a session', () => {
  it.each([
    ['a Saturday', '2026-03-14T15:00:00Z', '2026-03-14'],
    ['a Sunday', '2026-03-15T15:00:00Z', '2026-03-15'],
    ['a market holiday (Good Friday)', '2026-04-03T15:00:00Z', '2026-04-03'],
  ])('makes no live save call on %s', (_label, clock, date) => {
    // The quotes then hold the last session's closing prints: saving them
    // would file Friday's close as live data under this date.
    vi.setSystemTime(new Date(clock));
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...baseMeta, selectedDate: date },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still saves live on an early-close session day', () => {
    // Black Friday 2026: a 1 PM ET close, still a session.
    vi.setSystemTime(new Date('2026-11-27T16:00:00Z'));
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...baseMeta, selectedDate: '2026-11-27' },
        true,
      ),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().isBacktest).toBe(false);
  });
});

// ============================================================
// TODAY SCRUBBED BACK (a replay of today's history)
// ============================================================

describe('useSnapshotSave — today scrubbed back more than 5 minutes', () => {
  /** The entry time 10:30 ET, half an hour before NOW (11:00 ET). */
  const scrubbed = { ...defaultSignals, etHour: 10, etMinute: 30 };
  /** Today's history at 10:30: SPX 5490, SPY 549, VIX 18.2. */
  const todayAt1030 = { date: TODAY, spot: 5490, spy: 549, vix: 18.2 };
  const replayMeta: SnapshotMeta = {
    ...baseMeta,
    entryTime: '9:30 AM CT',
    history: todayAt1030,
    spy: 549,
    vix: 18.2,
  };

  it('saves as a backtest row once the inputs carry today’s history at that time', () => {
    // useAutoFill fills a scrubbed-back today from its 5-minute history,
    // not from the live quotes.
    renderHook(() =>
      useSnapshotSave(makeResults({ spot: 5490 }), scrubbed, replayMeta, true),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().date).toBe(TODAY);
    expect(body().spx).toBe(5490);
    expect(body().isBacktest).toBe(true);
  });

  it('makes no save call while the inputs still hold the live quotes', () => {
    // Inputs that match the live quote are not that time's data.
    renderHook(() =>
      useSnapshotSave(
        makeResults({ spot: 5500 }),
        scrubbed,
        { ...replayMeta, spy: 550, vix: 18 },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes no save call without today’s history', () => {
    renderHook(() =>
      useSnapshotSave(
        makeResults({ spot: 5500 }),
        scrubbed,
        { ...baseMeta, entryTime: '9:30 AM CT', history: null },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes no save call when only the SPX matches today’s history', () => {
    // The live SPY is never SPX / 10 to the cent.
    renderHook(() =>
      useSnapshotSave(
        makeResults({ spot: 5490 }),
        scrubbed,
        { ...replayMeta, spy: 547.83 },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still saves the time within 5 minutes of now as live', () => {
    // The live time sync snaps the entry time down to 5 minutes.
    const synced = { ...defaultSignals, etHour: 10, etMinute: 55 };
    renderHook(() => useSnapshotSave(makeResults(), synced, baseMeta, true));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().isBacktest).toBe(false);
  });
});

// ============================================================
// WHERE THE INPUTS CAME FROM (input identity)
// ============================================================

describe('useSnapshotSave — a save carries its own date’s inputs', () => {
  /** Today's live quotes in these tests: SPX 6800, VIX 20 (SPY 678.15). */
  const LIVE = { spot: 6800, vix: 20 };
  const liveMeta: SnapshotMeta = {
    selectedDate: TODAY,
    entryTime: '10:00 AM CT',
    live: LIVE,
    spy: 678.15,
    vix: 20,
  };

  it('makes no save call for today while the inputs still hold a past date’s history', () => {
    // On the render that switches from past date B (with history) to today,
    // the debounced inputs still hold B's SPX, SPY and VIX, and today's
    // history has not loaded (B's is kept, so App passes none).
    const { rerender } = renderHook(
      ({ results, meta }) =>
        useSnapshotSave(results, defaultSignals, meta, true),
      {
        initialProps: {
          results: makeResults({ spot: 5500 }),
          meta: { ...liveMeta, spy: 550, vix: 18 } as SnapshotMeta,
        },
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // The live quotes reach the inputs: exactly one save, as live.
    rerender({ results: makeResults({ spot: 6800 }), meta: liveMeta });
    rerender({ results: makeResults({ spot: 6800 }), meta: liveMeta });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().date).toBe(TODAY);
    expect(body().spx).toBe(6800);
    expect(body().vix).toBe(20);
    expect(body().isBacktest).toBe(false);
  });

  it('makes no save call for today while a past date’s daily VIX is still in the VIX field', () => {
    // A past date without history already priced off today's live SPX, but
    // its VIX field held that date's daily VIX (useVixData).
    const { rerender } = renderHook(
      ({ meta }) =>
        useSnapshotSave(
          makeResults({ spot: 6800 }),
          defaultSignals,
          meta,
          true,
        ),
      { initialProps: { meta: { ...liveMeta, vix: 25.4 } as SnapshotMeta } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender({ meta: liveMeta });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().vix).toBe(20);
  });

  it('makes no save call for the default 572 / 5720 inputs on the first render with data', () => {
    // useSpotInputs seeds SPY 572 and SPX 5720, useIvInputs VIX 19; the live
    // quotes arrive a render before useAutoFill writes them.
    renderHook(() =>
      useSnapshotSave(
        makeResults({ spot: 5720 }),
        defaultSignals,
        { ...liveMeta, spy: 572, vix: 19 },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes no save call for today without live quotes or today’s own history', () => {
    renderHook(() =>
      useSnapshotSave(
        makeResults({ spot: 6800 }),
        defaultSignals,
        { ...liveMeta, live: null, history: null },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts the SPX input rounded to a whole point, and no further', () => {
    // useAutoFill writes the live SPX rounded to a whole point.
    const { rerender } = renderHook(
      ({ spot }) =>
        useSnapshotSave(makeResults({ spot }), defaultSignals, liveMeta, true),
      { initialProps: { spot: 6801.5 } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender({ spot: 6800.6 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts the VIX input to the cent of its source, and no further', () => {
    const { rerender } = renderHook(
      ({ vix }) =>
        useSnapshotSave(
          makeResults({ spot: 6800 }),
          defaultSignals,
          { ...liveMeta, vix },
          true,
        ),
      { initialProps: { vix: 20.02 } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender({ vix: 20.01 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['live quotes that differ from it', LIVE],
    ['no live quotes', null],
  ])(
    'makes no save call for today when the inputs hold its history candle and there are %s',
    (_label, live) => {
      // Today's history stops at the page load, so its candle need not cover
      // this entry time: filed as a live row, it would freeze the row's SPX
      // and VIX at the load. useAutoFill fills the inputs from it only for a
      // replay, or to display with no quotes at all.
      renderHook(() =>
        useSnapshotSave(
          makeResults({ spot: 6790 }),
          defaultSignals,
          {
            ...liveMeta,
            live,
            history: { date: TODAY, spot: 6790.2, spy: 679.02, vix: 19.4 },
            spy: 679.02,
            vix: 19.4,
          },
          true,
        ),
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('makes no save call for today while it holds another date’s history', () => {
    // Inputs that match the live quotes still don't save under a history
    // labelled for another date.
    renderHook(() =>
      useSnapshotSave(
        makeResults({ spot: 6800 }),
        defaultSignals,
        { ...liveMeta, history: hist(YESTERDAY, 6800) },
        true,
      ),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes no save call while a debounced input has not caught up', () => {
    // The debounced inputs reach the results one at a time; until the last
    // one lands, the results mix the old and new values (σ last).
    const { rerender } = renderHook(
      ({ meta }) =>
        useSnapshotSave(
          makeResults({ spot: 6800 }),
          defaultSignals,
          meta,
          true,
        ),
      { initialProps: { meta: { ...liveMeta, inputsPending: true } } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender({ meta: { ...liveMeta, inputsPending: false } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('makes no save call for a past date while the inputs hold a live SPX near its own', () => {
    // Today → past date B: B's history has loaded, but the inputs are still
    // today's live quotes, and the live SPX happens to be within a point of
    // B's SPX at the entry time. The live SPY is never B's SPX / 10.
    const pastMeta: SnapshotMeta = {
      ...liveMeta,
      selectedDate: YESTERDAY,
      history: { date: YESTERDAY, spot: 6800.4, spy: 680.04, vix: 18 },
    };
    const { rerender } = renderHook(
      ({ meta }) =>
        useSnapshotSave(
          makeResults({ spot: 6800 }),
          defaultSignals,
          meta,
          true,
        ),
      { initialProps: { meta: pastMeta } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // B's history reaches the inputs.
    rerender({ meta: { ...pastMeta, spy: 680.04, vix: 18 } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().date).toBe(YESTERDAY);
    expect(body().spy).toBe(680.04);
    expect(body().isBacktest).toBe(true);
  });
});

// ============================================================
// THE QUOTE TIME A LIVE SAVE CARRIES
// ============================================================

describe('useSnapshotSave — the quote time a live save carries', () => {
  const QUOTED_AT = Date.parse(NOW) - 30_000;
  const liveMeta = (quotedAt?: number | null): SnapshotMeta => ({
    ...baseMeta,
    live: { spot: 5500, vix: 18, quotedAt },
  });

  it('sends the live quotes’ quotedAt on a live save', () => {
    renderHook(() =>
      useSnapshotSave(makeResults(), defaultSignals, liveMeta(QUOTED_AT), true),
    );

    expect(body().isBacktest).toBe(false);
    expect(body().quotedAt).toBe(QUOTED_AT);
  });

  it.each([
    ['null', null],
    ['absent', undefined],
  ])(
    'sends null on a live save when the live quotes’ time is %s',
    (_label, quotedAt) => {
      renderHook(() =>
        useSnapshotSave(
          makeResults(),
          defaultSignals,
          liveMeta(quotedAt),
          true,
        ),
      );

      expect(body().isBacktest).toBe(false);
      expect(body().quotedAt).toBeNull();
    },
  );

  it('omits quotedAt on a backtest save, whatever the live quotes carry', () => {
    renderHook(() =>
      useSnapshotSave(
        makeResults(),
        defaultSignals,
        { ...backtestMeta, live: { spot: 5500, vix: 18, quotedAt: QUOTED_AT } },
        true,
      ),
    );

    expect(body().isBacktest).toBe(true);
    expect(body()).not.toHaveProperty('quotedAt');
  });
});

// ============================================================
// THE META APP PASSES (wiring)
// ============================================================

describe('buildSnapshotMeta', () => {
  const quotes = {
    spx: { price: 6800.37 },
    vix: { price: 20.114 },
  } as SnapshotMetaSource['quotes'];
  const snapshot = { spot: 6790.2, spy: 679.02, vix: 19.4 };
  const source: SnapshotMetaSource = {
    selectedDate: TODAY,
    entryTime: '10:00 AM CT',
    historyDate: TODAY,
    historySnapshot: snapshot,
    quotes,
    dSpot: '679.02',
    dVix: '19.40',
    debounced: [
      ['679.02', '679.02'],
      ['6790', '6790'],
    ],
    skewPct: 3,
    clusterMult: 1.1,
  };

  it('carries the date, entry time, parsed SPY and VIX, and the other inputs', () => {
    expect(buildSnapshotMeta(source)).toEqual({
      selectedDate: TODAY,
      entryTime: '10:00 AM CT',
      history: { date: TODAY, spot: 6790.2, spy: 679.02, vix: 19.4 },
      // The fixture quotes carry no quote time.
      live: { spot: 6800.37, vix: 20.114, quotedAt: null },
      inputsPending: false,
      spy: 679.02,
      vix: 19.4,
      skewPct: 3,
      clusterMult: 1.1,
    });
  });

  it('labels the history with the date api/history answered for', () => {
    // useAutoFill's snapshot is the selected date's only; the label is what
    // the save checks it against.
    expect(
      buildSnapshotMeta({ ...source, historyDate: YESTERDAY }).history?.date,
    ).toBe(YESTERDAY);
  });

  it.each([
    ['no snapshot', { historySnapshot: null }],
    ['no history date', { historyDate: undefined }],
  ])('passes no history with %s', (_label, patch) => {
    expect(buildSnapshotMeta({ ...source, ...patch }).history).toBeNull();
  });

  it.each([
    ['no quotes', { quotes: null }],
    ['no SPX quote', { quotes: { spx: null, vix: { price: 20 } } }],
    ['no VIX quote', { quotes: { spx: { price: 6800 }, vix: null } }],
  ])('passes no live source with %s', (_label, patch) => {
    expect(
      buildSnapshotMeta({
        ...source,
        ...(patch as Partial<SnapshotMetaSource>),
      }).live,
    ).toBeNull();
  });

  describe('the live source’s quote time', () => {
    const withTimes = (
      spxAt: number | null | undefined,
      vixAt?: number | null,
    ) =>
      buildSnapshotMeta({
        ...source,
        quotes: {
          spx: { price: 6800, quotedAt: spxAt },
          vix: { price: 20, quotedAt: vixAt },
        } as SnapshotMetaSource['quotes'],
      }).live?.quotedAt;

    it.each([
      ['VIX the older', 2_000, 1_000, 1_000],
      ['SPX the older', 1_000, 2_000, 1_000],
      ['both the same', 1_500, 1_500, 1_500],
    ])(
      'is the older of the SPX and VIX quote times, %s',
      (_l, spx, vix, at) => {
        expect(withTimes(spx, vix)).toBe(at);
      },
    );

    it.each([
      ['no SPX time', undefined, 1_000],
      ['a null SPX time', null, 1_000],
      ['no VIX time', 1_000, undefined],
      ['a null VIX time', 1_000, null],
      ['neither time', undefined, undefined],
    ])('is null with %s: the older one is unknown', (_label, spx, vix) => {
      expect(withTimes(spx, vix)).toBeNull();
    });
  });

  it('marks the inputs pending while any debounced copy lags its raw value', () => {
    expect(
      buildSnapshotMeta({
        ...source,
        debounced: [
          ['679.02', '679.02'],
          ['0.1934', '0.2210'],
        ],
      }).inputsPending,
    ).toBe(true);
  });

  it('passes a blank or non-numeric SPY / VIX input as undefined', () => {
    const meta = buildSnapshotMeta({ ...source, dSpot: '', dVix: 'abc' });
    expect(meta.spy).toBeUndefined();
    expect(meta.vix).toBeUndefined();
  });
});

// ============================================================
// FAILED SAVES (R4)
// ============================================================

describe('useSnapshotSave — a failed save', () => {
  it.each([
    ['today', baseMeta, false],
    ['a past date with its own history', backtestMeta, true],
  ])(
    'surfaces a rejected save for %s to Sentry and retries it on the next change',
    async (_label, meta, isBacktest) => {
      const err = new Error('Network error');
      fetchSpy.mockRejectedValueOnce(err);

      const { rerender } = renderHook(
        ({ results }) => useSnapshotSave(results, defaultSignals, meta, true),
        { initialProps: { results: makeResults() } },
      );

      await vi.waitFor(() => {
        expect(captureUnlessAuth).toHaveBeenCalledWith(err, {
          tags: { context: 'snapshot_save' },
        });
      });

      // The key was released, so the next change re-posts it.
      rerender({ results: makeResults() });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(body(1).isBacktest).toBe(isBacktest);
    },
  );

  /** Let a POST's answer reach its handler (only Date is faked here). */
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  /** Every POST answers `status`. */
  function answerAlways(status: number) {
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ error: 'nope' }), { status }),
    );
  }

  /**
   * Render, then re-render `renders` more times with fresh results, letting
   * each answer land first. Once a history snapshot exists App's signals
   * change identity on every render, so a released key posts again on
   * each one.
   */
  async function renderAndChurn(renders: number) {
    const { rerender } = renderHook(
      ({ results }) => useSnapshotSave(results, defaultSignals, baseMeta, true),
      { initialProps: { results: makeResults() } },
    );
    await settle();
    for (let i = 0; i < renders; i++) {
      rerender({ results: makeResults() });
      await settle();
    }
  }

  /**
   * Render for baseMeta, and return churn(meta): five re-renders of `meta`
   * with fresh results, each answer landed first.
   */
  function renderForChurn() {
    const { rerender } = renderHook(
      ({ meta, results }) =>
        useSnapshotSave(results, defaultSignals, meta, true),
      { initialProps: { meta: baseMeta, results: makeResults() } },
    );
    return async (meta: SnapshotMeta) => {
      for (let i = 0; i < 5; i++) {
        await settle();
        rerender({ meta, results: makeResults() });
      }
      await settle();
    };
  }

  const TAGS = { tags: { context: 'snapshot_save' } };

  it.each([500, 502])(
    'retries a persistent %i at most 3 posts and reports it once',
    async (status) => {
      answerAlways(status);
      await renderAndChurn(8);

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
      expect(captureUnlessAuth).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
        TAGS,
      );
    },
  );

  it('retries a 429 (rate limited) without reporting it, up to the cap', async () => {
    answerAlways(429);
    await renderAndChurn(8);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('never retries a 400 (the body itself would fail again) and reports it once', async () => {
    answerAlways(400);
    await renderAndChurn(8);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400 }),
      TAGS,
    );
  });

  it('keeps the key on a 403 (botid rejected it) and reports it once as a warning', async () => {
    // The auth interceptor handles 401s only; a 403 is guardOwnerEndpoint's
    // bot check, which the same post would hit again.
    answerAlways(403);
    await renderAndChurn(8);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
      { level: 'warning', ...TAGS },
    );
  });

  it('retries a 401 (a lapsed session) without reporting it, up to the cap', async () => {
    answerAlways(401);
    await renderAndChurn(8);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  describe('a 422 (the server found the quote stale)', () => {
    const REFUSED = JSON.stringify({
      error: 'quote-not-fresh',
      reason: 'stale-quote',
      saved: false,
    });
    const STALE_AT = Date.parse(NOW) - 20 * 60_000;
    const MINUTE = 60_000;
    const liveAt = (
      quotedAt: number | null,
      entryTime = '09:35',
    ): SnapshotMeta => ({
      ...baseMeta,
      entryTime,
      live: { spot: 5500, vix: 18, quotedAt },
    });

    /**
     * Render live at `firstQuotedAt`, let its answer land, and return poll():
     * a re-render as a quote poll causes one, with fresh results and signals
     * (App's signals change identity on every render) and the quote's time.
     */
    async function renderLive(firstQuotedAt: number | null) {
      const { rerender } = renderHook(
        ({ meta, results, signals }) =>
          useSnapshotSave(results, signals, meta, true),
        {
          initialProps: {
            meta: liveAt(firstQuotedAt),
            results: makeResults(),
            signals: { ...defaultSignals },
          },
        },
      );
      await settle();
      return async (quotedAt: number | null, entryTime?: string) => {
        rerender({
          meta: liveAt(quotedAt, entryTime),
          results: makeResults(),
          signals: { ...defaultSignals },
        });
        await settle();
      };
    }

    it('retries each fresher quote without reporting it, up to the cap', async () => {
      answerAlways(422);
      const poll = await renderLive(STALE_AT);
      for (let i = 1; i <= 6; i++) await poll(STALE_AT + i * MINUTE);

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(body(1).quotedAt).toBe(STALE_AT + MINUTE);
      expect(body(2).quotedAt).toBe(STALE_AT + 2 * MINUTE);
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    });

    it('does not post a slot again for the quote time the server just refused', async () => {
      answerAlways(422);
      const poll = await renderLive(STALE_AT);
      // Three polls, the same stale quote, new signals each time.
      await poll(STALE_AT);
      await poll(STALE_AT);
      await poll(STALE_AT);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    });

    it('still saves the slot when a fresher quote lands after several polls of the refused one', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(REFUSED, { status: 422 }));
      const poll = await renderLive(STALE_AT);
      await poll(STALE_AT);
      await poll(STALE_AT);
      await poll(STALE_AT);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Minute 4: the quote moves. The refused polls did not use the budget.
      const freshAt = STALE_AT + 15 * MINUTE;
      await poll(freshAt);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(body(1).quotedAt).toBe(freshAt);

      // That one was answered 200: the slot is saved, a newer quote adds none.
      await poll(freshAt + MINUTE);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('holds a missing quote time to the same rule: no repost until one arrives', async () => {
      answerAlways(422);
      const poll = await renderLive(null);
      await poll(null);
      await poll(null);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(body(0).quotedAt).toBeNull();

      await poll(STALE_AT);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(body(1).quotedAt).toBe(STALE_AT);
    });

    it('posts the released key again when a fresher quote arrives, with the new quote time', async () => {
      const staleAt = Date.parse(NOW) - 20 * 60_000;
      const freshAt = Date.parse(NOW) - 30_000;
      fetchSpy.mockResolvedValueOnce(new Response(REFUSED, { status: 422 }));
      const results = makeResults();
      const { rerender } = renderHook(
        ({ meta }) => useSnapshotSave(results, defaultSignals, meta, true),
        { initialProps: { meta: liveAt(staleAt) } },
      );
      await settle();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(body(0).quotedAt).toBe(staleAt);

      // Only the quote time changes: same results, same signals, same inputs.
      rerender({ meta: liveAt(freshAt) });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(body(1).quotedAt).toBe(freshAt);
      expect(body(1).entryTime).toBe(body(0).entryTime);
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    });

    it('does not post an answered key again when a fresher quote arrives', async () => {
      const results = makeResults();
      const { rerender } = renderHook(
        ({ meta }) => useSnapshotSave(results, defaultSignals, meta, true),
        { initialProps: { meta: liveAt(Date.parse(NOW) - 60_000) } },
      );
      await settle();

      rerender({ meta: liveAt(Date.parse(NOW) - 30_000) });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('gives each entry time its own attempts and its own refused quote, without reporting any', async () => {
      answerAlways(422);
      const poll = await renderLive(STALE_AT);
      for (let i = 1; i <= 5; i++) await poll(STALE_AT + i * MINUTE);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // The next slot posts at once, even for a quote time the first slot was
      // just refused for, and then has its own three.
      await poll(STALE_AT + 5 * MINUTE, '09:40');
      for (let i = 6; i <= 10; i++) await poll(STALE_AT + i * MINUTE, '09:40');
      expect(fetchSpy).toHaveBeenCalledTimes(6);
      expect(body(3).entryTime).toBe('09:40');
      expect(body(3).quotedAt).toBe(STALE_AT + 5 * MINUTE);
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    });
  });

  it('caps a persistent network error at 3 posts and reports it once', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));
    await renderAndChurn(8);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('saves on the retry after a transient 5xx, then stops posting', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await renderAndChurn(6);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  /** fetch that stays pending until the test answers each POST in turn. */
  function deferredPosts() {
    const pending: ((res: Response) => void)[] = [];
    fetchSpy.mockImplementation(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );
    return pending;
  }

  it('reports a 503 that lands after a dependency re-run, and posts again on the next change', async () => {
    const pending = deferredPosts();
    const { rerender } = renderHook(
      ({ results }) => useSnapshotSave(results, defaultSignals, baseMeta, true),
      { initialProps: { results: makeResults() } },
    );
    // A re-run while the POST is in flight: the key is marked, so no second.
    rerender({ results: makeResults() });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    pending[0]!(new Response('{}', { status: 503 }));
    await settle();

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      TAGS,
    );
    rerender({ results: makeResults() });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('posts a key again after its POST fails mid-flight while another entry time posted', async () => {
    const pending = deferredPosts();
    const { rerender } = renderHook(
      ({ meta }) => useSnapshotSave(makeResults(), defaultSignals, meta, true),
      { initialProps: { meta: baseMeta } },
    );
    rerender({ meta: { ...baseMeta, entryTime: '09:40' } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    pending[0]!(new Response('{}', { status: 500 }));
    pending[1]!(new Response(JSON.stringify({ id: 'row', saved: true })));
    await settle();
    rerender({ meta: baseMeta });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(body(2).entryTime).toBe('09:35');
  });

  it('gives each entry time its own attempts and its own report', async () => {
    answerAlways(500);
    const churn = renderForChurn();
    await churn(baseMeta);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    await churn({ ...baseMeta, entryTime: '09:40' });
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('keeps the key on a 200 the server skipped, without reporting it', async () => {
    // A kept live row, or a server-side date skip: answered, not failed.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: null, saved: false, skipped: 'live-row' }),
        { status: 200 },
      ),
    );

    const { rerender } = renderHook(
      ({ results }) => useSnapshotSave(results, defaultSignals, baseMeta, true),
      { initialProps: { results: makeResults() } },
    );
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    // Give the answer's handler a turn before re-rendering.
    await Promise.resolve();
    await Promise.resolve();

    rerender({ results: makeResults() });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });
});
