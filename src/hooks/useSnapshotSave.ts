/**
 * useSnapshotSave — Automatically saves market snapshots to Postgres
 * whenever the calculator produces results.
 *
 * Owner-only: App enables it for the owner alone (a guest or public
 * visitor would draw a 401 per entry time), and the /api/snapshot
 * endpoint rejects non-owners.
 *
 * A row's date must own its data, so the selected date decides the save:
 *   - Today (ET) at the current time, on a session day: a live row
 *     (is_backtest false), with or without today's intraday history, once
 *     the inputs carry today's data: the SPX and VIX inputs each match the
 *     live quote or today's history at the entry time. A weekend or
 *     holiday today saves nothing: its quotes are the last session's.
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
 * session unless the post fails: a network error or a non-2xx answer
 * releases the key, so the next change posts it again. Those reach Sentry,
 * except a 401 / 403 (a lapsed or missing owner session, which the auth
 * interceptor clears). A 200 that saved nothing (a kept live row, a date
 * the server skipped) keeps the key: it was answered, not lost.
 */

import { useEffect, useRef } from 'react';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { isTradingDay } from '../data/marketHours';
import { getETDateStr, isBacktestMode } from '../utils/timezone';
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
}

export interface SnapshotMeta {
  selectedDate?: string;
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
  clusterMult?: number;
}

/** What App knows that the snapshot meta is built from. */
export interface SnapshotMetaSource {
  selectedDate: string;
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
  clusterMult: number;
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
    live: spx && vix ? { spot: spx.price, vix: vix.price } : null,
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
 * for today at the current time once its inputs carry today's data; else
 * null (none).
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

  const now = new Date();
  if (isBacktestMode(date, etMinutes, now)) {
    // A replay: useAutoFill fills the inputs from the date's history at the
    // entry time. On today the upsert keeps a live row at that time.
    if (history == null) return null;
    return near(spot, history.spot, SPX_TOLERANCE) &&
      near(meta.spy, history.spy, SPY_TOLERANCE)
      ? 'backtest'
      : null;
  }

  if (date !== getETDateStr(now)) return null;
  // No session today (a weekend or holiday): the quotes are the last
  // session's closing prints, not this date's.
  if (!isTradingDay(date)) return null;
  const live = meta.live ?? null;
  const spotIsToday =
    near(spot, live?.spot, SPX_TOLERANCE) ||
    near(spot, history?.spot, SPX_TOLERANCE);
  const vixIsToday =
    near(meta.vix, live?.vix, VIX_TOLERANCE) ||
    near(meta.vix, history?.vix, VIX_TOLERANCE);
  return spotIsToday && vixIsToday ? 'live' : null;
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
  // Primitives, so the effect keys on values: App builds the meta afresh
  // every render.
  const historyDate = meta.history?.date;
  const historySpot = meta.history?.spot;
  const historySpy = meta.history?.spy;
  const historyVix = meta.history?.vix;
  const liveSpot = meta.live?.spot;
  const liveVix = meta.live?.vix;
  const inputsPending = meta.inputsPending === true;

  useEffect(() => {
    if (!results || !enabled) return;
    if (!meta.selectedDate || !meta.entryTime) return;
    if (inputsPending) return;
    const etMinutes = signals.etHour * 60 + signals.etMinute;
    const kind = rowKind(meta.selectedDate, etMinutes, results.spot, {
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

    const key = `${meta.selectedDate}|${meta.entryTime}`;
    if (savedRef.current.has(key)) return;
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
      clusterPutMult: signals.clusterPutMult,
      clusterCallMult: signals.clusterCallMult,
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

    // Fire-and-forget — don't block the UI
    const controller = new AbortController();

    fetch('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then((res) => {
        if (res.ok) return;
        // Nothing saved: release the key so the next change posts it again.
        savedRef.current.delete(key);
        if (res.status === 401 || res.status === 403) return;
        const err = new Error(
          `Snapshot save failed: HTTP ${res.status}`,
        ) as Error & { status?: number };
        err.status = res.status;
        captureUnlessAuth(err, { tags: { context: 'snapshot_save' } });
      })
      .catch((err: unknown) => {
        // Don't retry on abort — component unmounted or deps changed
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Network error — capture so persistent snapshot-save failures
        // are visible (the next-render retry hides the symptom from the
        // UI), then remove from saved set so it retries.
        captureUnlessAuth(err, {
          tags: { context: 'snapshot_save' },
        });
        savedRef.current.delete(key);
      });

    return () => controller.abort();
  }, [
    results,
    signals,
    meta.selectedDate,
    meta.entryTime,
    inputsPending,
    historyDate,
    historySpot,
    historySpy,
    historyVix,
    liveSpot,
    liveVix,
    meta.spy,
    meta.vix,
    meta.skewPct,
    meta.clusterMult,
    enabled,
  ]);
}
