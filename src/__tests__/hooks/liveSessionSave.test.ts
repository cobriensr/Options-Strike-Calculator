/**
 * A session, end to end through the hooks App wires together: the live
 * quotes poll, the time step, the history that loaded with the page, the
 * calculation and the snapshot save. Only the network and the market-data
 * hook's state are stubbed.
 *
 * The page loads at 9:42 CT with today's candles up to 9:40 CT. Those
 * candles never refresh, so every live moment after load must still take its
 * SPX, VIX and σ from the quotes, and every 5-minute slot, the top of the
 * hour included, must reach /api/snapshot as a live row and stay posted.
 * A step into a new hour refetches /api/vix-ohlc (useVixData keys on the
 * hour), and its late answer re-renders App while that slot's POST is in
 * flight; a replay of a past date must not lose its top-of-hour slot to the
 * same re-render.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMemo, useRef, useState } from 'react';
import { IV_MODES } from '../../constants';
import { getEarlyCloseHourET } from '../../data/marketHours';
import { useAutoFill } from '../../hooks/useAutoFill';
import { useCalculation } from '../../hooks/useCalculation';
import { useComputedSignals } from '../../hooks/useComputedSignals';
import {
  useHistoryData,
  useHistoryVixOHLCFallback,
} from '../../hooks/useHistoryData';
import { useIvInputs } from '../../hooks/useIvInputs';
import type { MarketDataState } from '../../hooks/useMarketData';
import {
  buildSnapshotMeta,
  useSnapshotSave,
} from '../../hooks/useSnapshotSave';
import { useSpotInputs } from '../../hooks/useSpotInputs';
import { useTimeInputs } from '../../hooks/useTimeInputs';
import { useVix1dData } from '../../hooks/useVix1dData';
import { useVixData } from '../../hooks/useVixData';
import type {
  HistoryCandle,
  HistoryResponse,
  QuotesResponse,
} from '../../types/api';

// ============================================================
// FIXTURES
// ============================================================

// Today is a Wednesday after the fall DST change: CT is UTC-6, ET is UTC-5.
/** 9:42:10 CT, when the page loads. */
const LOAD = '2026-11-04T15:42:10Z';
/** The Tuesday before: the replay's date. */
const PAST_DATE = '2026-11-03';
/** 9:30 ET, the first candle. */
const OPEN_MS = Date.parse('2026-11-04T14:30:00Z');
const FIVE_MIN_MS = 5 * 60_000;
/** Candles 9:30..10:40 ET (8:30..9:40 CT): the last one is 15 candles in. */
const CANDLE_COUNT = 15;
const LAST_CANDLE_SPX = 7700 + CANDLE_COUNT - 1;
const LAST_CANDLE_VIX = 18 + (CANDLE_COUNT - 1) * 0.02;

function candles(base: number, step: number): HistoryCandle[] {
  return Array.from({ length: CANDLE_COUNT }, (_, i) => {
    const close = base + i * step;
    return {
      datetime: OPEN_MS + i * FIVE_MIN_MS,
      time: `${i}`,
      open: close - step,
      high: close + 1,
      low: close - 1,
      close,
    };
  });
}

const noCandles = { candles: [], previousClose: 0, previousDay: null };

/** The intraday history api/history answers for `date`: the same candles. */
function historyFor(date: string): HistoryResponse {
  return {
    date,
    spx: {
      candles: candles(7700, 1),
      previousClose: 7690,
      previousDay: null,
    },
    vix: { candles: candles(18, 0.02), previousClose: 18.4, previousDay: null },
    vix1d: noCandles,
    vix9d: noCandles,
    vvix: noCandles,
    candleCount: CANDLE_COUNT,
    asOf: LOAD,
  };
}

/** The nth poll's quotes: SPX climbs 4 points a poll, off the history's. */
function quotesAt(n: number): QuotesResponse {
  const spx = 7750 + 4 * n;
  const quote = (price: number) => ({
    price,
    open: price,
    high: price,
    low: price,
    prevClose: price,
    change: 0,
    changePct: 0,
  });
  return {
    spy: quote(spx / 10 + 0.037),
    spx: quote(spx),
    vix: quote(17.5 + n * 0.01),
    vix1d: quote(14.2),
    vix9d: null,
    vvix: null,
    marketOpen: true,
    asOf: LOAD,
  };
}

// ============================================================
// HARNESS
// ============================================================

function useLiveSession() {
  const [quotes, setQuotes] = useState<QuotesResponse>(quotesAt(0));
  const market = useMemo<MarketDataState>(
    () => ({
      data: {
        quotes,
        intraday: null,
        yesterday: null,
        events: null,
        movers: null,
      },
      loading: false,
      hasData: true,
      needsAuth: false,
      fetchedAt: null,
      quotesFetchedAt: null,
      session: 'regular',
      marketOpen: true,
    }),
    [quotes],
  );
  const spot = useSpotInputs();
  const iv = useIvInputs();
  const time = useTimeInputs();
  const vix = useVixData(
    iv.ivMode,
    time.timeHour,
    time.timeAmPm,
    time.timezone,
    iv.setVixInput,
  );
  const historyData = useHistoryData(vix.selectedDate);
  const vix1dStatic = useVix1dData();
  const { results } = useCalculation(
    spot.dSpot,
    spot.dSpx,
    iv.dVix,
    iv.dIV,
    iv.dMult,
    iv.ivMode,
    time.timeHour,
    time.timeMinute,
    time.timeAmPm,
    time.timezone,
    spot.spxRatio,
    0,
    getEarlyCloseHourET(vix.selectedDate),
  );
  useHistoryVixOHLCFallback(
    historyData.history,
    vix.selectedDate,
    vix.vixOHLC,
    vix.setVixOHLC,
    vix.vixData,
  );
  const spotEdited = useRef(false);
  const spxEdited = useRef(false);
  const vixEdited = useRef(false);
  const timeEdited = useRef(false);
  const ivModeEdited = useRef(false);
  const historySnapshot = useAutoFill({
    spotEdited,
    spxEdited,
    vixEdited,
    timeEdited,
    ivModeEdited,
    timeHour: time.timeHour,
    timeMinute: time.timeMinute,
    timeAmPm: time.timeAmPm,
    timezone: time.timezone,
    setSpotPrice: spot.setSpotPrice,
    setSpxDirect: spot.setSpxDirect,
    setVixInput: iv.setVixInput,
    setIvMode: iv.setIvMode,
    setDirectIVInput: iv.setDirectIVInput,
    setTimeHour: time.setTimeHour,
    setTimeMinute: time.setTimeMinute,
    setTimeAmPm: time.setTimeAmPm,
    setTimezone: time.setTimezone,
    market,
    vix,
    historyData,
    vix1dStatic,
  });
  const signals = useComputedSignals({
    vix: Number.parseFloat(iv.dVix) || undefined,
    spot: results?.spot,
    T: results?.T,
    skewPct: 0,
    clusterMult: 1,
    selectedDate: vix.selectedDate,
    timeHour: time.timeHour,
    timeMinute: time.timeMinute,
    timeAmPm: time.timeAmPm,
    timezone: time.timezone,
    ivMode: iv.ivMode,
    ivModeVix: IV_MODES.VIX,
    liveVix1d: quotes.vix1d?.price,
    liveVix9d: undefined,
    liveVvix: undefined,
    liveOpeningRange: undefined,
    historySnapshot,
    isBacktest: false,
  });
  useSnapshotSave(
    results,
    signals,
    buildSnapshotMeta({
      selectedDate: vix.selectedDate,
      entryTime: `${time.timeHour}:${time.timeMinute} ${time.timeAmPm} ${time.timezone}`,
      historyDate: historyData.history?.date,
      historySnapshot,
      quotes,
      dSpot: spot.dSpot,
      dVix: iv.dVix,
      debounced: [
        [spot.spotPrice, spot.dSpot],
        [spot.spxDirect, spot.dSpx],
        [iv.vixInput, iv.dVix],
        [iv.directIVInput, iv.dIV],
        [iv.multiplier, iv.dMult],
      ],
      skewPct: 0,
      clusterMult: 1,
    }),
    true,
  );
  return { setQuotes, spot, iv, time, vix, timeEdited, historySnapshot };
}

// ============================================================
// NETWORK
// ============================================================

/** How long a snapshot POST takes to answer. */
const POST_LATENCY_MS = 300;

/**
 * How long /api/vix-ohlc takes. The debounced inputs settle 250 ms after a
 * poll and the snapshot POST goes out then, so this answer lands while that
 * POST is still in flight.
 */
const VIX_OHLC_LATENCY_MS = 400;

/** What /api/vix-ohlc answers: OHLC over the snapshots saved that day. */
const SNAPSHOT_VIX_OHLC = { open: 18, high: 18.6, low: 17.4, close: 18.1 };

interface Post {
  body: Record<string, unknown>;
  signal: AbortSignal;
  /** True once the server answered it: the row is saved. */
  answered: boolean;
}

let posts: Post[];
let fetchSpy: ReturnType<typeof vi.spyOn>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(LOAD));
  localStorage.clear();
  posts = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.startsWith('/api/history?date=')) {
      return Promise.resolve(json(historyFor(url.split('=')[1]!)));
    }
    if (url === '/vix-data.json') {
      // The static table ends months before today, as in production.
      return Promise.resolve(
        json({ '2026-03-06': { open: 20, high: 21, low: 19, close: 20.5 } }),
      );
    }
    if (url.startsWith('/api/vix-ohlc')) {
      return new Promise<Response>((resolve) => {
        setTimeout(
          () => resolve(json({ ...SNAPSHOT_VIX_OHLC, count: 40 })),
          VIX_OHLC_LATENCY_MS,
        );
      });
    }
    if (url === '/api/vix1d-daily') return Promise.resolve(json({}));
    if (url === '/api/snapshot') {
      const signal = init!.signal!;
      const post: Post = {
        body: JSON.parse(init!.body as string),
        signal,
        answered: false,
      };
      posts.push(post);
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          post.answered = true;
          resolve(json({ id: 'row', saved: true }));
        }, POST_LATENCY_MS);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** How often React renders while the clock runs in `settle`. */
const SETTLE_STEP_MS = 50;

/**
 * Run the clock `ms` forward, one act per step. Inside a single act React
 * holds its renders until the act ends, which would fold a debounce, a
 * response and a POST into one flush; a browser renders between them.
 */
async function settle(ms: number) {
  for (let t = 0; t < ms; t += SETTLE_STEP_MS) await advance(SETTLE_STEP_MS);
}

/** The saved rows, by entry time. */
function savedRows(): Map<string, Record<string, unknown>> {
  return new Map(
    posts
      .filter((p) => p.answered)
      .map((p) => [String(p.body.entryTime), p.body]),
  );
}

/** Load the page, then poll every minute until `minutes` after the load. */
async function runSession(minutes: number) {
  const hook = renderHook(() => useLiveSession());
  await settle(2000);
  for (let n = 1; n <= minutes; n += 1) {
    await advance(58_000);
    act(() => hook.result.current.setQuotes(quotesAt(n)));
    await settle(2000);
  }
  return hook;
}

// ============================================================
// TESTS
// ============================================================

describe('a live session after the page loaded', () => {
  it('keeps the SPX, SPY and VIX inputs on the live quotes through polls and time steps', async () => {
    const { result } = await runSession(12);

    // 9:54 CT, the 13th poll's quotes: not the 9:40 candle's.
    expect(result.current.time.timeHour).toBe('9');
    expect(result.current.time.timeMinute).toBe('50');
    const live = quotesAt(12);
    expect(result.current.spot.spxDirect).toBe(live.spx!.price.toFixed(0));
    expect(result.current.spot.spotPrice).toBe(live.spy!.price.toFixed(2));
    expect(result.current.iv.vixInput).toBe(live.vix!.price.toFixed(2));
    expect(result.current.spot.spxDirect).not.toBe(String(LAST_CANDLE_SPX));
    expect(result.current.iv.vixInput).not.toBe(LAST_CANDLE_VIX.toFixed(2));
  });

  it('saves each slot as a live row with its own live SPX, SPY and VIX', async () => {
    await runSession(12);

    // The slot the page loaded in, then the first two time steps.
    const slots = ['9:40 AM CT', '9:45 AM CT', '9:50 AM CT'];
    const rows = savedRows();
    for (const slot of slots) {
      const row = rows.get(slot);
      expect(row, slot).toBeDefined();
      expect(row!.isBacktest, slot).toBe(false);
      // Not the 9:40 candle's SPX, nor its SPX / 10 to the cent.
      expect(row!.spx, slot).not.toBe(LAST_CANDLE_SPX);
      expect(row!.spy, slot).not.toBe(LAST_CANDLE_SPX / 10);
      expect(row!.vix, slot).not.toBe(Number(LAST_CANDLE_VIX.toFixed(2)));
    }
    // Each slot carries its own poll's SPX.
    expect(new Set(slots.map((s) => rows.get(s)!.spx)).size).toBe(slots.length);
  });

  it('keeps the last live quote through a quotes outage, not the page-load candle', async () => {
    const hook = await runSession(3);
    const lastQuote = quotesAt(3);

    // Schwab stops answering: no new quotes, so no time sync either. The
    // clock runs 8 minutes past the 9:45 slot, and other hooks keep App
    // rendering, so the time reads as more than 5 minutes behind.
    for (let minute = 0; minute < 7; minute += 1) {
      await advance(60_000);
      hook.rerender();
    }
    await settle(2000);

    expect(hook.result.current.time.timeMinute).toBe('45');
    expect(hook.result.current.spot.spxDirect).toBe(
      lastQuote.spx!.price.toFixed(0),
    );
    expect(hook.result.current.spot.spotPrice).toBe(
      lastQuote.spy!.price.toFixed(2),
    );
    expect(hook.result.current.historySnapshot).toBeNull();
    expect(posts.filter((p) => p.body.isBacktest === true)).toEqual([]);
  });

  it('saves the top-of-hour slot, which a step into a new hour must not lose', async () => {
    await runSession(24);

    expect([...savedRows().keys()]).toEqual([
      '9:40 AM CT',
      '9:45 AM CT',
      '9:50 AM CT',
      '9:55 AM CT',
      '10:00 AM CT',
      '10:05 AM CT',
    ]);
    expect(savedRows().get('10:00 AM CT')!.isBacktest).toBe(false);
  });
});

describe('a replay of a past date', () => {
  it('saves the top-of-hour slot when the hour change refetches the date’s VIX OHLC', async () => {
    const hook = renderHook(() => useLiveSession());
    await settle(2000);
    // The user picks the date, then scrubs the time: no time sync after that.
    act(() => hook.result.current.vix.setSelectedDate(PAST_DATE));
    await settle(2000);
    hook.result.current.timeEdited.current = true;
    const scrubTo = async (hour: string, minute: string) => {
      act(() => {
        hook.result.current.time.setTimeHour(hour);
        hook.result.current.time.setTimeMinute(minute);
      });
      await settle(2000);
    };
    await scrubTo('9', '55');
    await scrubTo('10', '00');

    const rows = savedRows();
    expect([...rows.keys()]).toEqual(
      expect.arrayContaining(['9:55 AM CT', '10:00 AM CT']),
    );
    for (const slot of ['9:55 AM CT', '10:00 AM CT']) {
      expect(rows.get(slot)!.date, slot).toBe(PAST_DATE);
      expect(rows.get(slot)!.isBacktest, slot).toBe(true);
      expect(rows.get(slot)!.spx, slot).toBe(LAST_CANDLE_SPX);
    }
  });
});

describe("the selected date's daily VIX OHLC", () => {
  /** The OHLC historyFor's 5-minute VIX candles give: the whole session. */
  const candleVixOHLC = () => {
    const vix = historyFor(PAST_DATE).vix.candles;
    return {
      open: vix[0]!.open,
      high: Math.max(...vix.map((c) => c.high)),
      low: Math.min(...vix.map((c) => c.low)),
      close: vix.at(-1)!.close,
    };
  };

  /** Answer `PAST_DATE`'s /api/history with `respond`, the rest as usual. */
  const overridePastHistory = (respond: () => Promise<Response>) => {
    const base = fetchSpy.getMockImplementation() as typeof fetch;
    fetchSpy.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === `/api/history?date=${PAST_DATE}`
          ? respond()
          : base(input, init),
    );
  };

  const selectPastDate = async () => {
    const hook = renderHook(() => useLiveSession());
    await settle(2000);
    act(() => hook.result.current.vix.setSelectedDate(PAST_DATE));
    return hook;
  };

  it("is a past date's own candles, though /api/vix-ohlc answers after them", async () => {
    const hook = await selectPastDate();
    await settle(2000);

    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/vix-ohlc?date=${PAST_DATE}`,
      expect.anything(),
    );
    expect(hook.result.current.vix.vixOHLC).toEqual(candleVixOHLC());
  });

  it("is a past date's own candles, though /api/vix-ohlc answers before them", async () => {
    overridePastHistory(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(json(historyFor(PAST_DATE))), 1500);
        }),
    );
    const hook = await selectPastDate();

    // The API's answer (400 ms) is in, the history's (1500 ms) is not.
    await settle(1000);
    expect(hook.result.current.vix.vixOHLC).toEqual(SNAPSHOT_VIX_OHLC);

    await settle(2000);
    expect(hook.result.current.vix.vixOHLC).toEqual(candleVixOHLC());
  });

  it("stays a past date's candles when an hour step refetches /api/vix-ohlc", async () => {
    const hook = await selectPastDate();
    await settle(2000);
    hook.result.current.timeEdited.current = true;
    act(() => {
      hook.result.current.time.setTimeHour('10');
      hook.result.current.time.setTimeMinute('00');
    });
    await settle(2000);

    // The date's first look, then the hour step's.
    const ohlcCalls = fetchSpy.mock.calls.filter(([url]: unknown[]) =>
      String(url).startsWith(`/api/vix-ohlc?date=${PAST_DATE}`),
    );
    expect(ohlcCalls).toHaveLength(2);
    expect(hook.result.current.vix.vixOHLC).toEqual(candleVixOHLC());
  });

  it("is /api/vix-ohlc's answer for a past date with no VIX candles", async () => {
    overridePastHistory(() =>
      Promise.resolve(json({ ...historyFor(PAST_DATE), vix: noCandles })),
    );
    const hook = await selectPastDate();
    await settle(2000);

    expect(hook.result.current.vix.vixOHLC).toEqual(SNAPSHOT_VIX_OHLC);
  });

  it("is /api/vix-ohlc's answer for today, whose candles stop at the page load", async () => {
    const hook = renderHook(() => useLiveSession());
    await settle(2000);

    expect(hook.result.current.vix.vixOHLC).toEqual(SNAPSHOT_VIX_OHLC);
  });
});
