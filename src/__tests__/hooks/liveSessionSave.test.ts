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
import { useClusterMultiplier } from '../../hooks/useClusterMultiplier';
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
  DaySummary,
  HistoryCandle,
  HistoryResponse,
  QuotesResponse,
} from '../../types/api';
import { isPastETDate } from '../../utils/timezone';
import { resolveYesterday } from '../../utils/yesterday';

// ============================================================
// FIXTURES
// ============================================================

// Today is a Wednesday after the fall DST change: CT is UTC-6, ET is UTC-5.
/** 9:42:10 CT, when the page loads. */
const LOAD = '2026-11-04T15:42:10Z';
/** The Tuesday before: the replay's date. */
const PAST_DATE = '2026-11-03';
/** The date the page opens on: the CT date of LOAD. */
const TODAY = '2026-11-04';
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

/**
 * The day before TODAY, as the live /api/yesterday feed answers it: 170 pts
 * on a 7650 open, 2.22% of it. The live quotes' VIX sits under 18, where that
 * is a hot day: multiplier 1.235. It closed up, so the call side tilts wider.
 */
const LIVE_YESTERDAY: DaySummary = {
  date: '2026-11-03',
  open: 7650,
  high: 7770,
  low: 7600,
  close: 7690,
  rangePct: 2.22,
  rangePts: 170,
};
const LIVE_MULT = 1.235;

/**
 * The day before PAST_DATE, as api/history answers for it: 50 pts on a 7500
 * open, 0.67%. The replay's VIX (18.0 to 18.28) is in the 18-25 regime, where
 * that is a calm day: multiplier 0.956, and flat, so both sides equal. Leaked
 * from the live feed instead, the replay would read 1.203 (hot at 18-25).
 */
const OLDER_DAY: DaySummary = {
  date: '2026-11-02',
  open: 7500,
  high: 7540,
  low: 7490,
  close: 7510,
  rangePct: 0.67,
  rangePts: 50,
};
const REPLAY_MULT = 0.956;
const LEAKED_MULT = 1.203;

/**
 * One day's annualized Parkinson RV, rounded to 4 places as the signals store
 * it (useRangeAnalysis): sqrt(1 / (4 ln 2)) x ln(H / L) x sqrt(252). Written
 * out here so the test does not lean on the code it checks.
 */
const parkinsonRV = (day: DaySummary) =>
  Math.round(
    Math.sqrt(1 / (4 * Math.LN2)) *
      Math.log(day.high / day.low) *
      Math.sqrt(252) *
      10000,
  ) / 10000;

/** api/history's previousDay: today's is the live feed's day. */
const previousDayFor = (date: string): DaySummary =>
  date === TODAY ? LIVE_YESTERDAY : OLDER_DAY;

/** The intraday history api/history answers for `date`: the same candles. */
function historyFor(date: string): HistoryResponse {
  return {
    date,
    spx: {
      candles: candles(7700, 1),
      previousClose: 7690,
      previousDay: previousDayFor(date),
    },
    vix: { candles: candles(18, 0.02), previousClose: 18.4, previousDay: null },
    vix1d: noCandles,
    vix9d: noCandles,
    vvix: noCandles,
    candleCount: CANDLE_COUNT,
    asOf: LOAD,
  };
}

const LOAD_MS = Date.parse(LOAD);
/** runSession polls once a minute: the nth poll lands n minutes after LOAD. */
const POLL_EVERY_MS = 60_000;
/** The SPX print is 2 s old when its poll lands, the VIX print 12 s old. */
const SPX_PRINT_AGE_MS = 2_000;
const VIX_PRINT_AGE_MS = 12_000;

/** The nth poll's Schwab tradeTimes, as /api/quotes passes them on. */
function quoteTimesAt(n: number) {
  const polled = LOAD_MS + n * POLL_EVERY_MS;
  return { spx: polled - SPX_PRINT_AGE_MS, vix: polled - VIX_PRINT_AGE_MS };
}

/** The nth poll's quotes: SPX climbs 4 points a poll, off the history's. */
function quotesAt(n: number): QuotesResponse {
  const spx = 7750 + 4 * n;
  const times = quoteTimesAt(n);
  const quote = (price: number, quotedAt: number) => ({
    price,
    open: price,
    high: price,
    low: price,
    prevClose: price,
    change: 0,
    changePct: 0,
    quotedAt,
  });
  return {
    spy: quote(spx / 10 + 0.037, times.spx),
    spx: quote(spx, times.spx),
    vix: quote(17.5 + n * 0.01, times.vix),
    vix1d: quote(14.2, times.vix),
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
        yesterday: {
          yesterday: LIVE_YESTERDAY,
          twoDaysAgo: null,
          asOf: LOAD,
        },
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
  // App's wiring, argument for argument: yesterday resolved once, then the
  // cluster multiplier from it, with no Market Regime panel mounted.
  const yesterday = resolveYesterday(
    historySnapshot?.yesterday,
    market.data.yesterday?.yesterday,
    isPastETDate(vix.selectedDate),
  );
  const cluster = useClusterMultiplier({
    vix: iv.dVix ? Number.parseFloat(iv.dVix) : null,
    spot: results?.spot,
    yesterday,
    scope: vix.selectedDate,
  });
  const clusterMult = cluster.signal.mult;
  const signals = useComputedSignals({
    vix: Number.parseFloat(iv.dVix) || undefined,
    spot: results?.spot,
    T: results?.T,
    skewPct: 0,
    clusterMult,
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
    liveYesterdayHigh: yesterday?.high,
    liveYesterdayLow: yesterday?.low,
    liveYesterdayOpen: yesterday?.open,
    liveYesterdayClose: yesterday?.close,
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
      clusterMult,
    }),
    true,
  );
  return {
    setQuotes,
    spot,
    iv,
    time,
    vix,
    timeEdited,
    historySnapshot,
    cluster,
  };
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
/** True while the server refuses a snapshot POST as a stale quote (422). */
let refuseStaleQuote: boolean;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(LOAD));
  localStorage.clear();
  posts = [];
  refuseStaleQuote = false;
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
          if (refuseStaleQuote) {
            resolve(
              new Response(
                JSON.stringify({
                  error: 'quote-not-fresh',
                  reason: 'stale-quote',
                  saved: false,
                }),
                { status: 422 },
              ),
            );
            return;
          }
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

/** Answer `date`'s /api/history with `respond`, the rest as usual. */
const overrideHistory = (date: string, respond: () => Promise<Response>) => {
  const base = fetchSpy.getMockImplementation() as typeof fetch;
  fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === `/api/history?date=${date}`
      ? respond()
      : base(input, init),
  );
};

/** History that lands `ms` after it is asked for. */
const historyAfter = (date: string, ms: number) => () =>
  new Promise<Response>((resolve) => {
    setTimeout(() => resolve(json(historyFor(date))), ms);
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

  it('stamps each live row with the older of its poll’s SPX and VIX quote times', async () => {
    await runSession(12);

    const live = posts.filter((p) => p.body.isBacktest === false);
    expect(live.length).toBeGreaterThan(0);
    for (const post of live) {
      // The row's SPX names its poll: 7750 + 4n.
      const n = ((post.body.spx as number) - 7750) / 4;
      const times = quoteTimesAt(n);
      expect(times.vix, String(post.body.entryTime)).toBeLessThan(times.spx);
      expect(post.body.quotedAt, String(post.body.entryTime)).toBe(times.vix);
    }
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

// F11: a poll that stalls leaves the inputs on the last quotes, and a manual
// time step or Resume live then moves the slot to now over them. The row
// still matches the quote state, so only its quote time shows it is old. The
// server will refuse such a row (422, P0.6 Phase 3; refuseStaleQuote stands in
// for it here); a poll that recovers must save the slot.
describe('a stalled quote poll', () => {
  const STALL_MINUTES = 16;
  const SLOT = '10:00 AM CT';
  const NEXT_SLOT = '10:05 AM CT';
  /** How far behind a lagging Schwab feed's prints run: past the 10 min limit. */
  const FEED_LAG_MS = 12 * 60_000;

  /** The nth poll's quotes with both prints `lagMs` older than usual. */
  function laggingQuotesAt(n: number, lagMs: number): QuotesResponse {
    const quotes = quotesAt(n);
    const older = (quote: NonNullable<QuotesResponse['spx']>) => ({
      ...quote,
      quotedAt: (quote.quotedAt ?? 0) - lagMs,
    });
    return {
      ...quotes,
      spx: older(quotes.spx!),
      vix: older(quotes.vix!),
    };
  }

  async function stallThenResumeLive() {
    const hook = await runSession(3);
    // Schwab stops answering: no new quotes, so no time sync. Other hooks
    // keep App rendering. 9:45:12 CT + 16 min is 10:01:12, in the 10:00 slot.
    for (let minute = 0; minute < STALL_MINUTES; minute += 1) {
      await advance(60_000);
      hook.rerender();
    }
    // App.handleResumeLive: clear the edit flag, set the time to now's slot.
    refuseStaleQuote = true;
    act(() => {
      hook.result.current.timeEdited.current = false;
      hook.result.current.time.setTimeHour('10');
      hook.result.current.time.setTimeMinute('00');
      hook.result.current.time.setTimeAmPm('AM');
      hook.result.current.time.setTimezone('CT');
    });
    await settle(2000);
    return hook;
  }

  const slotPosts = () => posts.filter((p) => p.body.entryTime === SLOT);

  it('posts the slot with the stale quote time, which the server refuses', async () => {
    await stallThenResumeLive();

    expect(slotPosts().length).toBeGreaterThan(0);
    for (const post of slotPosts()) {
      expect(post.body.isBacktest).toBe(false);
      // The third poll's VIX print, 16 minutes old by now.
      expect(post.body.quotedAt).toBe(quoteTimesAt(3).vix);
      expect(post.answered).toBe(false);
    }
    expect(savedRows().has(SLOT)).toBe(false);
  });

  it('still saves the stale slot when a quote lands minutes after the refusal', async () => {
    const hook = await stallThenResumeLive();
    // Three more minutes with no quote while other hooks keep App rendering.
    // (useSnapshotSave.test.ts pins that a refused quote time is not posted
    // again however often the save re-runs; here the harness has no such
    // re-run, so this checks the recovery end to end.)
    for (let minute = 0; minute < 3; minute += 1) {
      await advance(60_000);
      hook.rerender();
    }
    await settle(2000);
    expect(slotPosts()).toHaveLength(1);

    refuseStaleQuote = false;
    act(() => hook.result.current.setQuotes(quotesAt(19)));
    await settle(2000);

    expect(slotPosts().at(-1)!.answered).toBe(true);
    expect(savedRows().get(SLOT)!.quotedAt).toBe(quoteTimesAt(19).vix);
  });

  it('stops retrying the stale slot at the post cap while a lagging feed keeps moving', async () => {
    const hook = await stallThenResumeLive();
    // The poll recovers but Schwab's prints run 12 minutes behind, so every
    // poll brings a new quote time that the server refuses again.
    for (let poll = 0; poll < 3; poll += 1) {
      await advance(58_000);
      act(() =>
        hook.result.current.setQuotes(laggingQuotesAt(20 + poll, FEED_LAG_MS)),
      );
      await settle(2000);
    }

    // MAX_POSTS_PER_KEY is 3: a 422 is a quiet retry, not a storm.
    expect(slotPosts()).toHaveLength(3);
    expect(slotPosts().every((p) => !p.answered)).toBe(true);
    expect(new Set(slotPosts().map((p) => p.body.quotedAt)).size).toBe(3);

    // The next slot has its own attempts: the capped key doesn't poison it.
    await advance(58_000);
    act(() => hook.result.current.setQuotes(laggingQuotesAt(23, FEED_LAG_MS)));
    await settle(2000);
    expect(
      posts.filter((p) => p.body.entryTime === NEXT_SLOT).length,
    ).toBeGreaterThan(0);
  });

  it('saves the slot with the new quote time once a poll lands a fresher quote', async () => {
    const hook = await stallThenResumeLive();
    const refused = slotPosts().length;

    refuseStaleQuote = false;
    act(() => hook.result.current.setQuotes(quotesAt(19)));
    await settle(2000);

    const fresh = slotPosts().slice(refused);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.at(-1)!.answered).toBe(true);
    expect(fresh.at(-1)!.body.quotedAt).toBe(quoteTimesAt(19).vix);
    expect(fresh.at(-1)!.body.spx).toBeCloseTo(quotesAt(19).spx!.price, 6);
    expect(savedRows().get(SLOT)!.quotedAt).toBe(quoteTimesAt(19).vix);
    expect(quoteTimesAt(19).vix).toBeGreaterThan(quoteTimesAt(3).vix);
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
      // A replay has no live quote to date: the server's guard skips it.
      expect(rows.get(slot)!, slot).not.toHaveProperty('quotedAt');
    }
  });
});

// F24: the cluster multiplier was reported only by the Volatility Clustering
// panel, which sits in the Market Regime card, closed on every page load, so
// every saved row carried 1. The harness mounts no panel at all.
describe('the saved cluster multiplier, with no Market Regime panel mounted', () => {
  const postsFor = (date: string) => posts.filter((p) => p.body.date === date);

  /** Pick the past date, then scrub to each (hour, minute): no time sync. */
  async function replay(
    hook: { result: { current: ReturnType<typeof useLiveSession> } },
    slots: ReadonlyArray<readonly [string, string]>,
  ) {
    act(() => hook.result.current.vix.setSelectedDate(PAST_DATE));
    await settle(2000);
    hook.result.current.timeEdited.current = true;
    for (const [hour, minute] of slots) {
      act(() => {
        hook.result.current.time.setTimeHour(hour);
        hook.result.current.time.setTimeMinute(minute);
      });
      await settle(2000);
    }
  }

  it('saves the computed multiplier on every live slot, the top of the hour included', async () => {
    await runSession(24);

    const live = postsFor(TODAY);
    expect(live.length).toBeGreaterThan(0);
    for (const post of live) {
      expect(post.body.clusterMult, String(post.body.entryTime)).toBe(
        LIVE_MULT,
      );
      // An up day with clustering: the call side widens past the put side.
      expect(post.body.clusterCallMult).toBeGreaterThan(
        post.body.clusterPutMult as number,
      );
      expect(post.body.clusterPutMult).toBeGreaterThan(1);
      // RV/IV reads the same day: the live feed's, on today.
      expect(post.body.rvAnnualized).toBe(parkinsonRV(LIVE_YESTERDAY));
    }
    expect(live.map((p) => p.body.entryTime)).toContain('10:00 AM CT');
    expect(posts.some((p) => p.body.clusterMult === 1)).toBe(false);
  });

  it("saves the past date's own multiplier through a date change and the top of the hour", async () => {
    const hook = renderHook(() => useLiveSession());
    await settle(2000);
    await replay(hook, [
      ['9', '55'],
      ['10', '00'],
    ]);

    // Rows saved before the date change are today's, the rest the past date's.
    const today = postsFor(TODAY);
    const past = postsFor(PAST_DATE);
    expect(today.length).toBeGreaterThan(0);
    expect(past.length).toBeGreaterThan(0);
    for (const post of today) {
      expect(post.body.clusterMult, String(post.body.entryTime)).toBe(
        LIVE_MULT,
      );
    }
    for (const post of past) {
      const slot = String(post.body.entryTime);
      expect(post.body.clusterMult, slot).toBe(REPLAY_MULT);
      // A flat day: no direction, so both sides carry the multiplier itself.
      expect(post.body.clusterPutMult, slot).toBe(REPLAY_MULT);
      expect(post.body.clusterCallMult, slot).toBe(REPLAY_MULT);
      // RV/IV reads the same day: the past date's previous day, not the live
      // feed's.
      expect(post.body.rvAnnualized, slot).toBe(parkinsonRV(OLDER_DAY));
      expect(post.body.rvAnnualized, slot).not.toBe(
        parkinsonRV(LIVE_YESTERDAY),
      );
      expect(post.body.rvIvRatio, slot).not.toBeNull();
    }
    expect(past.map((p) => p.body.entryTime)).toEqual(
      expect.arrayContaining(['9:55 AM CT', '10:00 AM CT']),
    );
    expect(posts.some((p) => p.body.clusterMult === 1)).toBe(false);
  });

  it("saves 1, not today's yesterday, when the past date's history has no previous day", async () => {
    const withoutPreviousDay = () => {
      const history = historyFor(PAST_DATE);
      return Promise.resolve(
        json({ ...history, spx: { ...history.spx, previousDay: null } }),
      );
    };
    overrideHistory(PAST_DATE, withoutPreviousDay);
    const hook = renderHook(() => useLiveSession());
    await settle(2000);
    await replay(hook, [
      ['9', '55'],
      ['10', '00'],
    ]);

    const past = postsFor(PAST_DATE);
    expect(past.length).toBeGreaterThan(0);
    for (const post of past) {
      const slot = String(post.body.entryTime);
      // The live feed's day would give 1.203 here, with a call-side tilt.
      expect(post.body.clusterMult, slot).toBe(1);
      expect(post.body.clusterPutMult, slot).toBe(1);
      expect(post.body.clusterCallMult, slot).toBe(1);
      // No previous day, so no RV/IV: NULL, not the live feed's day's values.
      expect(post.body.rvAnnualized, slot).toBeNull();
      expect(post.body.rvIvRatio, slot).toBeNull();
      expect(post.body.rvIvLabel, slot).toBeNull();
    }
    expect(hook.result.current.cluster.signal.rangePct).toBeNull();
    expect(posts.some((p) => p.body.clusterMult === LEAKED_MULT)).toBe(false);
  });

  it("is 1, not today's yesterday, while a past date's history loads", async () => {
    overrideHistory(PAST_DATE, historyAfter(PAST_DATE, 1500));
    const hook = renderHook(() => useLiveSession());
    await settle(2000);
    act(() => hook.result.current.vix.setSelectedDate(PAST_DATE));
    await settle(500);

    // The history is still on its way: no snapshot, so no yesterday.
    expect(hook.result.current.historySnapshot).toBeNull();
    expect(hook.result.current.cluster.signal.mult).toBe(1);
    expect(postsFor(PAST_DATE)).toEqual([]);

    await settle(3000);
    expect(hook.result.current.historySnapshot).not.toBeNull();
    expect(hook.result.current.cluster.signal.mult).toBe(REPLAY_MULT);
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

  const overridePastHistory = (respond: () => Promise<Response>) =>
    overrideHistory(PAST_DATE, respond);

  /**
   * A past date with history ends on its snapshot's VIX at the selected
   * time, not on the daily OHLC value written on the way there.
   */
  const expectPastVixInput = (hook: {
    result: { current: ReturnType<typeof useLiveSession> };
  }) => {
    const { iv, historySnapshot } = hook.result.current;
    expect(historySnapshot).not.toBeNull();
    expect(iv.vixInput).toBe(historySnapshot!.vix!.toFixed(2));
    expect(iv.vixInput).toBe(LAST_CANDLE_VIX.toFixed(2));
    expect(iv.vixInput).not.toBe(candleVixOHLC().open.toFixed(2));
    expect(iv.vixInput).not.toBe(SNAPSHOT_VIX_OHLC.open.toFixed(2));
  };

  /** Today's VIX input stays the live quote, whatever the OHLC says. */
  const expectLiveVixInput = (hook: {
    result: { current: ReturnType<typeof useLiveSession> };
  }) => {
    expect(hook.result.current.iv.vixInput).toBe(
      quotesAt(0).vix!.price.toFixed(2),
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
    expectPastVixInput(hook);
  });

  it("is a past date's own candles, though /api/vix-ohlc answers before them", async () => {
    overridePastHistory(historyAfter(PAST_DATE, 1500));
    const hook = await selectPastDate();

    // The API's answer (400 ms) is in, the history's (1500 ms) is not.
    await settle(1000);
    expect(hook.result.current.vix.vixOHLC).toEqual(SNAPSHOT_VIX_OHLC);

    await settle(2000);
    expect(hook.result.current.vix.vixOHLC).toEqual(candleVixOHLC());
    expectPastVixInput(hook);
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
    // No snapshot VIX either, so the API's open (Auto, 9:40 CT) is the input.
    expect(hook.result.current.iv.vixInput).toBe(
      SNAPSHOT_VIX_OHLC.open.toFixed(2),
    );
  });

  // Today's candles run to the page load, and /api/vix-ohlc samples the
  // snapshots saved so far: the candles win there too.
  it("is today's own candles, though /api/vix-ohlc answers after them", async () => {
    const hook = renderHook(() => useLiveSession());
    await settle(2000);

    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/vix-ohlc?date=${TODAY}`,
      expect.anything(),
    );
    expect(hook.result.current.vix.vixOHLC).toEqual(candleVixOHLC());
    expectLiveVixInput(hook);
  });

  it("is today's own candles, though /api/vix-ohlc answers before them", async () => {
    overrideHistory(TODAY, historyAfter(TODAY, 1500));
    const hook = renderHook(() => useLiveSession());

    // The API's answer (400 ms) is in, the history's (1500 ms) is not.
    await settle(1000);
    expect(hook.result.current.vix.vixOHLC).toEqual(SNAPSHOT_VIX_OHLC);
    expectLiveVixInput(hook);

    await settle(2000);
    expect(hook.result.current.vix.vixOHLC).toEqual(candleVixOHLC());
    expectLiveVixInput(hook);
  });

  it("is /api/vix-ohlc's answer for today when it has no VIX candles", async () => {
    overrideHistory(TODAY, () =>
      Promise.resolve(json({ ...historyFor(TODAY), vix: noCandles })),
    );
    const hook = renderHook(() => useLiveSession());
    await settle(2000);

    expect(hook.result.current.vix.vixOHLC).toEqual(SNAPSHOT_VIX_OHLC);
    expectLiveVixInput(hook);
  });
});
