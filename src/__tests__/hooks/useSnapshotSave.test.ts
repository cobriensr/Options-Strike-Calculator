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
    // AbortError means the component unmounted or deps changed — the key should
    // remain in the saved set (no retry desired)
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

  it('saves today as live from today’s own history when it differs from the live quote', () => {
    // Today with its own history: useAutoFill fills the inputs from the
    // 5-minute snapshot at the entry time, over the live quotes.
    renderHook(() =>
      useSnapshotSave(
        makeResults({ spot: 6790 }),
        defaultSignals,
        {
          ...liveMeta,
          history: { date: TODAY, spot: 6790.2, spy: 679.02, vix: 19.4 },
          spy: 679.02,
          vix: 19.4,
        },
        true,
      ),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body().spx).toBe(6790);
    expect(body().isBacktest).toBe(false);
  });

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
      live: { spot: 6800.37, vix: 20.114 },
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

  it.each([500, 502, 429, 400])(
    'surfaces a %i answer to Sentry and retries it on the next change',
    async (status) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'nope' }), { status }),
      );

      const { rerender } = renderHook(
        ({ results }) =>
          useSnapshotSave(results, defaultSignals, baseMeta, true),
        { initialProps: { results: makeResults() } },
      );

      await vi.waitFor(() => {
        expect(captureUnlessAuth).toHaveBeenCalledWith(
          expect.objectContaining({ status }),
          { tags: { context: 'snapshot_save' } },
        );
      });

      // A non-2xx saved nothing, so the key was released.
      rerender({ results: makeResults() });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 403])(
    'retries a %i answer on the next change without reporting it',
    async (status) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Not authenticated' }), {
          status,
        }),
      );

      const { rerender } = renderHook(
        ({ results }) =>
          useSnapshotSave(results, defaultSignals, baseMeta, true),
        { initialProps: { results: makeResults() } },
      );

      // Let the answer settle, then show the key was released.
      await vi.waitFor(() => {
        rerender({ results: makeResults() });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      });
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    },
  );

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
