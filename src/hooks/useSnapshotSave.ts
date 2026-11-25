/**
 * useSnapshotSave — Automatically saves market snapshots to Postgres
 * whenever the calculator produces results.
 *
 * Owner-only: App enables it for the owner alone (a guest or public
 * visitor would draw a 401 per entry time), and the /api/snapshot
 * endpoint rejects non-owners.
 *
 * A row's date must own its data, so the selected date decides the save.
 * "Today" and "past" are meta.etToday's, the clock the selected date follows,
 * so a date that follows today is still today in the moment after ET
 * midnight, before that clock ticks. The wall clock is read for the time of
 * day, and a live row also needs it to call the date today (its quotes are
 * the wall clock's), so in that moment a live row waits for the tick:
 *   - Today (ET) at the current time, on a session day: a live row
 *     (is_backtest false), once the SPX and VIX inputs each match today's
 *     live quote. Today's intraday history is never a source: it stops at
 *     the page load, so a candle from it need not cover the entry time,
 *     and useAutoFill fills the inputs from it only for a replay, or to
 *     display when no quotes exist. A weekend or holiday today saves
 *     nothing: its quotes are the last session's. Nor does an entry time
 *     ahead of the clock (today scrubbed forward): its inputs are now's.
 *     The row carries quotedAt, when those quotes last printed (the older of
 *     the SPX and VIX Schwab tradeTime): a stalled poll or an old Schwab
 *     print leaves inputs that still match the quote state, and only the
 *     quote's time shows it. The server refuses a stale row (422, P0.6;
 *     api/_lib/quote-freshness.ts). A replay sends none.
 *     Only a live-save browser posts it (isLiveSaveDevice: computers by
 *     default, phones and tablets not, and a per-browser switch overrides
 *     either way): the missed-snapshot alert watches the trading computer, and
 *     a phone's one row would make a stall look over. Flipping the switch
 *     takes effect without a reload, and a live row held back by it posts
 *     when the switch flips on. Backtest rows are not affected.
 *   - A past date with its own intraday history, or today scrubbed back
 *     more than 5 minutes (isBacktestMode): a backtest row (is_backtest
 *     true), once the inputs carry that history's SPX and SPY at the entry
 *     time. On today the upsert never lets it replace the live row.
 *   - A past date without its own history, or a future date: no save. The
 *     inputs then hold today's live quotes or another date's history.
 * Nothing saves while a debounced input still lags its raw value, or
 * while the history passed is labelled for another date.
 *
 * The DB upserts on UNIQUE(date, entry_time). Each key posts once per
 * session unless the post fails, and a failing key posts at most
 * MAX_POSTS_PER_KEY times. A replay's signals change identity on every
 * render (its history snapshot is a new object each time), so an uncapped
 * retry would post (and report) on every render, and a POST aborted by a
 * re-render, say on a late answer from another hook, would be lost for
 * good: its key is already marked. Only unmount aborts a POST. A failure:
 *   - a network error, a 5xx, a 429 (rate limited), a 422 (the server found
 *     the live quote stale) or a 401 (a lapsed owner session, which the
 *     auth interceptor clears) releases the key, so the next
 *     change posts it again, up to the cap. A 422 posts the key again only
 *     for a different quote time than the one it refused: while the quote
 *     stays stale every poll re-runs this effect, and re-sending it would
 *     spend the cap before a fresher quote arrived. quotedAt is an effect
 *     dependency, so a fresher quote is such a change;
 *   - a 400 (the body itself) or another 4xx, and a 403 (the endpoint's
 *     botid check; the auth interceptor handles 401s only), keep the key:
 *     the same post would fail the same way.
 * A failure reaches Sentry once per key, a 403 as a warning, except a 429,
 * a 422 and a 401, which are expected (a stale quote is the server's to
 * report). A 200 that saved nothing (a kept live row, a date the server
 * skipped) keeps the key: it was answered, not lost.
 *
 * A row saved without yesterday's fields is marked: its payload has no
 * `clusterMult` or no `rvAnnualized`, the server's own test for a live row
 * saved in that gap (and build-features', for the day's features). A key saved
 * marked is posted once more when its mark clears, while it is still the entry
 * time (the window a refused key's re-post has), so a gap of a few seconds at
 * the start of a slot does not leave the slot's row empty for good. That
 * re-post is armed by the marked POST's 200, not by sending it: yesterday can
 * land while the marked POST is in flight, and a re-post sent then could commit
 * first and be overwritten by the marked insert. If the mark has already
 * cleared when the 200 arrives, the re-post goes out at once. A key whose
 * marked POST was not answered 200 is not armed.
 */

import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import {
  isLiveSaveDevice,
  subscribeLiveSaveDevice,
} from '../lib/live-save-device';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { isTradingDay } from '../data/marketHours';
import {
  getETDateStr,
  getETTotalMinutes,
  isBacktestMode,
} from '../utils/timezone';
import type { CalculationResults } from '../types';
import type { QuotesResponse } from '../types/api';
import type { ComputedSignals } from './useComputedSignals';
import type { HistorySnapshot } from './useHistoryData';

/** The intraday history the calculator's inputs and signals came from. */
export interface SnapshotHistory {
  /** The date the history is for (api/history echoes the requested date). */
  date: string;
  /** Its SPX at the entry time. */
  spot: number;
  /** Its SPY equivalent, SPX / 10 to the cent (HistorySnapshot.spy). */
  spy: number;
  /** Its VIX at the entry time; null without a VIX candle. */
  vix: number | null;
}

/** Today's live quotes, the other source of a live save's inputs. */
export interface SnapshotLive {
  /** The live SPX. */
  spot: number;
  /** The live VIX. */
  vix: number;
  /**
   * When these quotes last printed (epoch ms): the older of the SPX and VIX
   * quote times, null or absent when either is unknown.
   */
  quotedAt?: number | null;
}

export interface SnapshotMeta {
  selectedDate?: string;
  /**
   * Today's ET date from the clock `selectedDate` follows (useVixData's):
   * what is "today" and what is "past" for the save. The wall clock is read
   * only for the time of day, so in the moment after ET midnight, before that
   * clock ticks, the followed date is still today's.
   */
  etToday: string;
  entryTime?: string;
  /** Null or absent when no intraday history filled the inputs. */
  history?: SnapshotHistory | null;
  /** Null or absent without live SPX and VIX quotes. */
  live?: SnapshotLive | null;
  /** True while a debounced input has not yet caught up with its raw value. */
  inputsPending?: boolean;
  spy?: number;
  vix?: number;
  skewPct?: number;
  /**
   * The cluster multiplier the row stores. Null (or absent, which the server
   * stores as null) when the app had no inputs for it (no current yesterday):
   * the row then stores no multiplier and no tilts, rather than the working
   * value 1.
   */
  clusterMult?: number | null;
}

/** What App knows that the snapshot meta is built from. */
export interface SnapshotMetaSource {
  selectedDate: string;
  /** Today's ET date from the selected date's clock (vix.etToday). */
  etToday: string;
  entryTime: string;
  /** The date of the loaded history (historyData.history?.date). */
  historyDate: string | undefined;
  /** useAutoFill's snapshot at the entry time: the selected date's only. */
  historySnapshot: Pick<HistorySnapshot, 'spot' | 'spy' | 'vix'> | null;
  quotes: Pick<QuotesResponse, 'spx' | 'vix'> | null | undefined;
  /** The debounced SPY and VIX inputs. */
  dSpot: string;
  dVix: string;
  /** Each debounced input the results read, as [raw, debounced]. */
  debounced: ReadonlyArray<readonly [string, string]>;
  skewPct: number;
  /** `clusterMultForSave(cluster.signal)`: null when the signal had no inputs. */
  clusterMult: number | null;
}

/**
 * The older of two quote times, or null when either is unknown: a row is
 * only as fresh as its stalest input, and a missing time can't vouch for it.
 */
function olderQuoteTime(
  spx: number | null | undefined,
  vix: number | null | undefined,
): number | null {
  return spx != null && vix != null ? Math.min(spx, vix) : null;
}

/**
 * The meta App passes to useSnapshotSave: where the inputs could have come
 * from (the history, labelled with its own date, and the live quotes),
 * whether a debounced input is still in flight, and the inputs themselves.
 */
export function buildSnapshotMeta(src: SnapshotMetaSource): SnapshotMeta {
  const snap = src.historySnapshot;
  const spx = src.quotes?.spx;
  const vix = src.quotes?.vix;
  return {
    selectedDate: src.selectedDate,
    etToday: src.etToday,
    entryTime: src.entryTime,
    history:
      snap && src.historyDate
        ? {
            date: src.historyDate,
            spot: snap.spot,
            spy: snap.spy,
            vix: snap.vix,
          }
        : null,
    live:
      spx && vix
        ? {
            spot: spx.price,
            vix: vix.price,
            quotedAt: olderQuoteTime(spx.quotedAt, vix.quotedAt),
          }
        : null,
    inputsPending: src.debounced.some(([raw, value]) => raw !== value),
    spy: Number.parseFloat(src.dSpot) || undefined,
    vix: Number.parseFloat(src.dVix) || undefined,
    skewPct: src.skewPct,
    clusterMult: src.clusterMult,
  };
}

/**
 * How far the save's SPX may sit from its source's SPX, in points.
 * useAutoFill writes the live or history SPX, rounded to a whole point,
 * into the SPX input: 0.5 apart at most, plus float error. Until that
 * write reaches the results (an effect, then the input debounce), the
 * results still price off the previous inputs: today's live SPX on a past
 * date, or a past date's SPX on today.
 */
const SPX_TOLERANCE = 1;

/**
 * How far the VIX input may sit from its source's VIX. useAutoFill writes
 * it to the cent, so this is one cent: a rounding, not another date's VIX.
 */
const VIX_TOLERANCE = 0.01;

/**
 * How far the SPY input may sit from the history's SPY (SPX / 10 to the
 * cent), which useAutoFill writes as is. The live SPY is never SPX / 10 to
 * the cent, so a live SPX that happens to sit within SPX_TOLERANCE of the
 * history's can't pass as that history.
 */
const SPY_TOLERANCE = 0.005;

/** Float slack for the tolerance comparisons. */
const EPSILON = 1e-9;

/** How far ahead of the ET clock today's entry time may sit and save live. */
const FUTURE_ENTRY_SLACK_MINUTES = 1;

/**
 * Posts per key before a failing key stops retrying and stays marked
 * saved for the session.
 */
const MAX_POSTS_PER_KEY = 3;

/**
 * One key's failed posts so far, whether one reached Sentry, and the quote
 * time the server last refused it for (null while none has been).
 */
interface KeyAttempts {
  posts: number;
  reported: boolean;
  refused: { quotedAt: number | null } | null;
}

function near(
  value: number | undefined,
  source: number | null | undefined,
  tolerance: number,
): boolean {
  return (
    value != null &&
    source != null &&
    Math.abs(value - source) <= tolerance + EPSILON
  );
}

/**
 * Which row a save for `date` at `etMinutes` (the entry time, minutes past
 * ET midnight) writes: 'backtest' for a past date, or today scrubbed back
 * more than 5 minutes, whose own history the inputs already carry; 'live'
 * for today at the current time once its inputs match the live quotes;
 * else null (none).
 */
function rowKind(
  date: string,
  etMinutes: number,
  spot: number,
  meta: SnapshotMeta,
): 'live' | 'backtest' | null {
  const history = meta.history ?? null;
  // A history labelled for another date (the last date's, kept while the
  // new one loads) means the inputs may still be that date's.
  if (history != null && history.date !== date) return null;

  // "Past" and "today" are the date clock's (meta.etToday), so a followed date
  // is still today in the moment after ET midnight. Only the time of day is
  // the wall clock's.
  const now = new Date();
  if (isBacktestMode(date, etMinutes, now, meta.etToday)) {
    // A replay: useAutoFill fills the inputs from the date's history at the
    // entry time. On today the upsert keeps a live row at that time.
    if (history == null) return null;
    return near(spot, history.spot, SPX_TOLERANCE) &&
      near(meta.spy, history.spy, SPY_TOLERANCE)
      ? 'backtest'
      : null;
  }

  // A live row needs both clocks to call the date today: the date's (what the
  // calculator is on) and the wall's, because live quotes belong to the wall
  // clock's day. In the moment after ET midnight, before the date's clock
  // ticks, they differ and nothing posts.
  if (date !== meta.etToday || date !== getETDateStr(now)) return null;
  // An entry time ahead of the clock (today scrubbed forward): the inputs
  // are now's, not that time's. One minute of slack for the clock.
  if (etMinutes > getETTotalMinutes(now) + FUTURE_ENTRY_SLACK_MINUTES) {
    return null;
  }
  // No session today (a weekend or holiday): the quotes are the last
  // session's closing prints, not this date's.
  if (!isTradingDay(date)) return null;
  // Only the live quotes: today's history is frozen at the page load, so
  // matching its candle says nothing about this entry time.
  const live = meta.live ?? null;
  return near(spot, live?.spot, SPX_TOLERANCE) &&
    near(meta.vix, live?.vix, VIX_TOLERANCE)
    ? 'live'
    : null;
}

/**
 * Call this hook in App.tsx. It fires a POST to /api/snapshot
 * whenever results change with a new date+time combination.
 *
 * `enabled` is true for the owner once there is data to save (live quotes
 * or the date's own history); the endpoint enforces ownership too.
 */
export function useSnapshotSave(
  results: CalculationResults | null,
  signals: ComputedSignals,
  meta: SnapshotMeta,
  enabled: boolean,
) {
  // Track what we've already saved to avoid redundant requests
  const savedRef = useRef<Set<string>>(new Set());
  // Per key: posts so far and whether its failure was reported. An entry
  // is dropped when the key saves, so it holds failing keys only.
  const attemptsRef = useRef<Map<string, KeyAttempts>>(new Map());
  // The POSTs in flight, each with its key. The effect below re-runs on any
  // dependency change and must not abort them (see the header); unmount does,
  // and releases their keys. That is a no-op on a real unmount; it matters
  // under StrictMode, whose simulated unmount aborts the mount pass's POST
  // and re-runs the effect, which must then post that key again.
  const inFlightRef = useRef<Map<AbortController, string>>(new Map());
  // Keys whose marked POST was answered 200: each is posted once more when the
  // mark clears, and dropped as it is posted. A key whose slot moved on before
  // its mark cleared stays until the session ends, bounded by the session's
  // keys like savedRef, and posts if it becomes the entry time again.
  const armedRef = useRef<Set<string>>(new Set());
  // Re-runs the effect below when a marked POST is answered: the mark can have
  // cleared while the POST was in flight, and no dependency change need follow.
  const [repostTick, armedAnswer] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const inFlight = inFlightRef.current;
    const saved = savedRef.current;
    return () => {
      for (const [controller, key] of inFlight) {
        controller.abort();
        saved.delete(key);
      }
      inFlight.clear();
    };
  }, []);
  // Primitives, so the effect keys on values: App builds the meta afresh
  // every render.
  const historyDate = meta.history?.date;
  const historySpot = meta.history?.spot;
  const historySpy = meta.history?.spy;
  const historyVix = meta.history?.vix;
  const liveSpot = meta.live?.spot;
  const liveVix = meta.live?.vix;
  const liveQuotedAt = meta.live?.quotedAt;
  const inputsPending = meta.inputsPending === true;
  // Whether this browser saves live rows. Through the store, so a flip in this
  // tab re-runs the effect without a remount. A flip in another tab is never
  // announced here, but every render re-reads it and the quote polls render
  // all session, so the next render sees it.
  const liveSaveDevice = useSyncExternalStore(
    subscribeLiveSaveDevice,
    isLiveSaveDevice,
  );
  // Whether a row saved now would be marked: the server's own predicate
  // (api/snapshot.ts) and build-features'. The meta's multiplier is null with
  // no cluster inputs, and RV is null without yesterday's high and low.
  const markedNow = meta.clusterMult == null || signals.rvAnnualized == null;

  useEffect(() => {
    if (!results || !enabled) return;
    if (!meta.selectedDate || !meta.entryTime) return;
    if (inputsPending) return;
    const etMinutes = signals.etHour * 60 + signals.etMinute;
    const kind = rowKind(meta.selectedDate, etMinutes, results.spot, {
      etToday: meta.etToday,
      history:
        historyDate == null || historySpot == null || historySpy == null
          ? null
          : {
              date: historyDate,
              spot: historySpot,
              spy: historySpy,
              vix: historyVix ?? null,
            },
      live:
        liveSpot == null || liveVix == null
          ? null
          : { spot: liveSpot, vix: liveVix },
      spy: meta.spy,
      vix: meta.vix,
    });
    if (kind == null) return;
    // Before the key is marked saved, so the live row posts when the switch
    // flips on.
    if (kind === 'live' && !liveSaveDevice) return;

    const key = `${meta.selectedDate}|${meta.entryTime}`;
    if (savedRef.current.has(key)) {
      // Saved. A key saved marked is posted once more when its mark clears,
      // and only once its marked POST was answered 200 (see the header).
      if (!armedRef.current.has(key) || markedNow) return;
      armedRef.current.delete(key);
    }
    // Live rows carry their quote time; a replay's is undefined and is never
    // refused for it.
    const quotedAt = kind === 'live' ? (liveQuotedAt ?? null) : undefined;
    // The server refused this slot for this very quote time (422). Posting it
    // again would be refused again, and during a stall every poll re-runs this
    // effect with new signals, so the post budget would drain on one stale
    // quote before a fresher one arrived. Wait for a different quote time.
    // That includes a quote-from-future refusal, which also reads the
    // server's clock and so could pass later for the same time: a quote still
    // carrying that time once the clock has caught up has not printed since.
    const refused = attemptsRef.current.get(key)?.refused;
    if (refused != null && refused.quotedAt === quotedAt) return;
    savedRef.current.add(key);

    // Build the strikes JSONB from allDeltas
    // putPct/callPct are formatted strings (e.g. "2.15%") — parse to numbers
    const strikes: Record<string, Record<string, unknown>> = {};
    for (const d of results.allDeltas) {
      if ('error' in d) continue;
      strikes[String(d.delta)] = {
        put: d.putSnapped,
        call: d.callSnapped,
        putPct: Number.parseFloat(d.putPct) || 0,
        callPct: Number.parseFloat(d.callPct) || 0,
      };
    }

    // Derive ivAccelMult from first valid delta row
    const firstRow = results.allDeltas.find((r) => !('error' in r));
    const ivAccelMult =
      firstRow && !('error' in firstRow) ? firstRow.ivAccelMult : undefined;

    const payload = {
      date: meta.selectedDate,
      entryTime: meta.entryTime,

      // From results
      spx: results.spot,
      sigma: results.sigma,
      tYears: results.T,
      hoursRemaining: results.hoursRemaining,

      // From meta (App-level state not in signals)
      spy: meta.spy,
      vix: meta.vix,
      skewPct: meta.skewPct,
      clusterMult: meta.clusterMult,
      isBacktest: kind === 'backtest',
      // A live row's quotes' age; the server refuses a stale one. A replay
      // has no quote to date, so it sends none (undefined drops from JSON).
      quotedAt,

      // From signals (all computed trading signals)
      spxOpen: signals.spxOpen,
      spxHigh: signals.spxHigh,
      spxLow: signals.spxLow,
      prevClose: signals.prevClose,
      vix1d: signals.vix1d,
      vix9d: signals.vix9d,
      vvix: signals.vvix,
      sigmaSource: signals.sigmaSource,
      regimeZone: signals.regimeZone,
      dowLabel: signals.dowLabel,
      dowMultHL: signals.dowMultHL,
      dowMultOC: signals.dowMultOC,
      icCeiling: signals.icCeiling,
      putSpreadCeiling: signals.putSpreadCeiling,
      callSpreadCeiling: signals.callSpreadCeiling,
      moderateDelta: signals.moderateDelta,
      conservativeDelta: signals.conservativeDelta,
      medianOcPct: signals.medianOcPct,
      medianHlPct: signals.medianHlPct,
      p90OcPct: signals.p90OcPct,
      p90HlPct: signals.p90HlPct,
      p90OcPts: signals.p90OcPts,
      p90HlPts: signals.p90HlPts,
      openingRangeAvailable: signals.openingRangeAvailable,
      openingRangeHigh: signals.openingRangeHigh,
      openingRangeLow: signals.openingRangeLow,
      openingRangePctConsumed: signals.openingRangePctConsumed,
      openingRangeSignal: signals.openingRangeSignal,
      vixTermSignal: signals.vixTermSignal,
      vixTermShape: signals.vixTermShape,
      // The tilts come from the same working multiplier, so a row with no
      // multiplier has no tilts either: a flat 1 here would pass for data.
      clusterPutMult: meta.clusterMult == null ? null : signals.clusterPutMult,
      clusterCallMult:
        meta.clusterMult == null ? null : signals.clusterCallMult,
      rvIvRatio: signals.rvIvRatio,
      rvIvLabel: signals.rvIvLabel,
      rvAnnualized: signals.rvAnnualized,
      ivAccelMult,
      overnightGap: signals.overnightGap,
      isEarlyClose: signals.isEarlyClose,
      isEventDay: signals.isEventDay,
      eventNames: signals.eventNames,

      strikes,
    };
    // This row is marked: no multiplier, or no RV.
    const marked = payload.clusterMult == null || payload.rvAnnualized == null;

    const attempt: KeyAttempts = attemptsRef.current.get(key) ?? {
      posts: 0,
      reported: false,
      refused: null,
    };
    attempt.posts += 1;
    attemptsRef.current.set(key, attempt);
    // Post the key again on the next change, unless it has used its posts.
    const retry = () => {
      if (attempt.posts < MAX_POSTS_PER_KEY) savedRef.current.delete(key);
    };
    // One Sentry event per key, however many times it fails.
    const reportOnce = (err: unknown, level?: 'warning') => {
      if (attempt.reported) return;
      attempt.reported = true;
      captureUnlessAuth(
        err,
        level
          ? { level, tags: { context: 'snapshot_save' } }
          : { tags: { context: 'snapshot_save' } },
      );
    };

    // Fire-and-forget — don't block the UI
    const controller = new AbortController();
    inFlightRef.current.set(controller, key);

    fetch('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then((res) => {
        if (res.ok) {
          attemptsRef.current.delete(key);
          if (marked) {
            armedRef.current.add(key);
            // Yesterday may have landed while this POST was in flight, and
            // nothing else would run the effect for it: run it now, and it
            // posts the key again if the mark has cleared and the key is
            // still the entry time.
            armedAnswer();
          }
          return;
        }
        const { status } = res;
        // A 422 is the server finding the live quote stale (the poll
        // stalled, or Schwab served an old print). Quiet: a stale quote is
        // the server's to report. Remember the quote time it refused: only a
        // different one posts the key again.
        if (status === 422) {
          attempt.refused = { quotedAt: quotedAt ?? null };
          retry();
          return;
        }
        // Expected and transient: retry quietly.
        if (status === 401 || status === 429) {
          retry();
          return;
        }
        const err = new Error(
          `Snapshot save failed: HTTP ${status}`,
        ) as Error & { status?: number };
        err.status = status;
        if (status >= 500) {
          reportOnce(err);
          retry();
          return;
        }
        // A 403 (botid) or a 400 / other 4xx: the same post would fail the
        // same way, so the key stays marked.
        reportOnce(err, status === 403 ? 'warning' : undefined);
      })
      .catch((err: unknown) => {
        // Don't retry on abort — the component unmounted
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Network error — report it (the retry hides the symptom from the
        // UI), and post again up to the cap.
        reportOnce(err);
        retry();
      })
      .finally(() => inFlightRef.current.delete(controller));
  }, [
    results,
    signals,
    meta.selectedDate,
    meta.etToday,
    meta.entryTime,
    inputsPending,
    historyDate,
    historySpot,
    historySpy,
    historyVix,
    liveSpot,
    liveVix,
    liveQuotedAt,
    meta.spy,
    meta.vix,
    meta.skewPct,
    meta.clusterMult,
    enabled,
    liveSaveDevice,
    markedNow,
    repostTick,
  ]);
}
