/**
 * useHistoryData — React hook for historical backtesting.
 *
 * Fetches 5-min candles for SPX, VIX, VIX1D, VIX9D, and VVIX for the
 * selected date. All time navigation is client-side after the initial fetch.
 *
 * Today's date fetches too, once, when it is selected: the candles up to
 * that moment, never refreshed. useAutoFill uses them for a scrubbed-back
 * time they cover. It does not use them for today at the current time while
 * live quotes exist (without them it shows them, as the only source), nor
 * for a today time after the last candle, where live Schwab data stands.
 *
 * Access: /api/history is owner-or-guest. For a public visitor
 * (`getAccessMode() === 'public'`, read at every render) there is no history:
 * the hook makes no request for any date, and returns `history` null and
 * `error` null, so AppHeader shows no "NO INTRADAY / Not authenticated" badge
 * for a past date the visitor picks. The mode sits in the effect's deps, so
 * signing in without a reload fetches the selected date.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { z } from 'zod';
import type { VIXDataMap, VIXDayData } from '../types';
import type { HistoryResponse } from '../types/api';
import {
  INVALID_SHAPE_ERROR,
  NOT_JSON_ERROR,
  summarizeZodIssues,
} from '../lib/response-guard';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getAccessMode } from '../utils/auth';
import { ET_AHEAD_OF_CT_MIN } from '../utils/entry-time';
import { getErrorMessage } from '../utils/error';
import {
  historySnapshotAt,
  type HistorySnapshot,
} from '../utils/snapshot-slot';
import { getETToday } from '../utils/timezone';
import { getMarketCloseHourET } from '../data/marketHours';

// ============================================================
// TYPES
// ============================================================

// The snapshot's shape and assembly live in `utils/snapshot-slot`, which the
// server builder shares; the type stays importable from here.
export type { HistorySnapshot };

export interface UseHistoryDataReturn {
  history: HistoryResponse | null;
  loading: boolean;
  error: string | null;
  getStateAtTime: (hourET: number, minuteET: number) => HistorySnapshot | null;
  hasHistory: boolean;
}

// ============================================================
// RESPONSE SCHEMA
// ============================================================

// Runtime schema for the /api/history response (api/history.ts). A 200
// whose body doesn't match is handled like a failed fetch: every reader of
// `history` (App's Market Regime props, getStateAtTime, hasHistory) assumes
// the five symbols and their candles exist, and one missing would throw
// during render. Annotated with the shared HistoryResponse type from
// src/types/api.ts instead of deriving it via z.infer, because that type
// is imported across the app; the annotation keeps the two in step.
const historyCandleSchema = z.object({
  datetime: z.number(),
  time: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
});

const historyDaySummarySchema = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  rangePct: z.number(),
  rangePts: z.number(),
});

// SPX's previousClose feeds the gap and snapshot math, so it's required.
const spxDayDataSchema = z.object({
  candles: z.array(historyCandleSchema),
  previousClose: z.number(),
  previousDay: historyDaySummarySchema.nullable(),
});

// api/history.ts sends previousClose 0 for a failed symbol and for an unknown
// previous session, and the VIX reads already treat 0 as "unknown". The VIX
// family keeps `.default(0)` so a missing key reads the same: an old
// `history:v3` entry, or a response the browser cached before the endpoint
// took previousDay.close, can lack the key (Schwab left its previousClose out
// on an empty day, and JSON drops undefined). SPX stays strict.
const vixFamilyDayDataSchema = spxDayDataSchema.extend({
  previousClose: z.number().default(0),
});

const historyResponseSchema: z.ZodType<HistoryResponse> = z.object({
  date: z.string(),
  spx: spxDayDataSchema,
  vix: vixFamilyDayDataSchema,
  vix1d: vixFamilyDayDataSchema,
  vix9d: vixFamilyDayDataSchema,
  vvix: vixFamilyDayDataSchema,
  candleCount: z.number(),
  asOf: z.string(),
});

// ============================================================
// FETCH
// ============================================================

async function fetchHistory(
  date: string,
  signal?: AbortSignal,
): Promise<{ data: HistoryResponse } | { error: string }> {
  try {
    const res = await fetch(`/api/history?date=${date}`, {
      credentials: 'same-origin',
      signal,
    });
    if (!res.ok) {
      const body = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      return { error: body.error || `HTTP ${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      if (isAbortError(err)) throw err;
      // A 2xx that isn't JSON (an HTML error page, a truncated body).
      captureUnlessAuth(new Error('history response was not JSON'), {
        contexts: { history: { date, detail: getErrorMessage(err) } },
      });
      return { error: NOT_JSON_ERROR };
    }
    const parsed = historyResponseSchema.safeParse(json);
    if (!parsed.success) {
      // Backend contract drift: report the Zod issues with the date, then
      // reject the whole payload so nothing malformed is stored.
      captureUnlessAuth(
        new Error('history response failed schema validation'),
        {
          contexts: {
            history: { date, ...summarizeZodIssues(parsed.error.issues) },
          },
        },
      );
      return { error: INVALID_SHAPE_ERROR };
    }
    return { data: parsed.data };
  } catch (err) {
    if (isAbortError(err)) return { error: 'AbortError' };
    return { error: getErrorMessage(err) };
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

// ============================================================
// DAILY VIX OHLC FROM THE CANDLES
// ============================================================

/**
 * The day's VIX OHLC from `history`'s 5-min VIX candles. Null when
 * `history` is another date's (useHistoryData keeps the last date's while
 * the next one loads, so its OHLC would land on the new date) or has no
 * VIX candles.
 */
export function historyVixOHLC(
  history: HistoryResponse | null,
  date: string,
): VIXDayData | null {
  if (!history || history.date !== date) return null;
  const candles = history.vix.candles;
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last) return null;
  return {
    open: first.open,
    close: last.close,
    high: Math.max(...candles.map((c) => c.high)),
    low: Math.min(...candles.map((c) => c.low)),
  };
}

/**
 * App's source for the date's daily VIX OHLC from its own history
 * (historyVixOHLC), never the last date's while the new one loads. Its 5-min
 * candles cover the session, where /api/vix-ohlc is OHLC over only the
 * snapshots saved that day. So the static table's entry stands, otherwise the
 * candles win, replacing what the API wrote; the API's answer fills `vixOHLC`
 * only for a date with neither. The derivation is a memo and the write an
 * effect, so the effect's deps stay exhaustive.
 */
export function useHistoryVixOHLCFallback(
  history: HistoryResponse | null,
  selectedDate: string,
  vixOHLC: VIXDayData | null,
  setVixOHLC: (v: VIXDayData | null) => void,
  vixData: VIXDataMap,
): void {
  const fromHistory = useMemo(
    () => historyVixOHLC(history, selectedDate),
    [history, selectedDate],
  );
  const hasTableEntry = !!vixData[selectedDate];
  useEffect(() => {
    if (hasTableEntry || !fromHistory || vixOHLC === fromHistory) return;
    setVixOHLC(fromHistory);
  }, [hasTableEntry, fromHistory, vixOHLC, setVixOHLC]);
}

// ============================================================
// HOOK
// ============================================================

export function useHistoryData(selectedDate: string): UseHistoryDataReturn {
  // /api/history is owner-or-guest. Read at render, never frozen in a ref, so
  // signing in with a guest key (no reload) starts the fetch and dropping to
  // public stops it.
  const isPublic = getAccessMode() === 'public';

  const [heldHistory, setHistory] = useState<HistoryResponse | null>(null);
  const [heldLoading, setLoading] = useState(false);
  const [heldError, setError] = useState<string | null>(null);

  useEffect(() => {
    // Every run supersedes the one before it, whose request its cleanup
    // aborted, and an aborted request never reaches the `setLoading(false)`
    // after its reply. So the flag is cleared here, for the public branch and
    // each skipped date below; the fetch path's `setLoading(true)` follows in
    // the same effect and React batches the two, so there's no flicker.
    setLoading(false);

    // The one request gate. A request from before the visitor dropped to
    // public was aborted by the cleanup of the effect run that started it, so
    // its late reply can't write state; what the hook held is cleared here,
    // so a visitor who signs back in doesn't start from the earlier session's.
    if (isPublic) {
      setHistory(null);
      setError(null);
      return;
    }

    if (!selectedDate) {
      setHistory(null);
      setError(null);
      return;
    }

    if (selectedDate > getETToday()) {
      setHistory(null);
      setError(null);
      return;
    }

    // Skip weekends and market holidays — no trading data exists
    const dow = new Date(selectedDate + 'T12:00:00Z').getDay();
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend || getMarketCloseHourET(selectedDate) === null) {
      setHistory(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchHistory(selectedDate, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if ('error' in result) {
        setError(result.error);
        setHistory(null);
      } else if (result.data.candleCount === 0) {
        setError(
          `No intraday data available for ${selectedDate}. Schwab keeps ~60 days of 5-min candles. Older dates can use daily OHLC from the VIX/SPX CSV data.`,
        );
        setHistory(null);
      } else {
        setHistory(result.data);
        setError(null);
      }
      setLoading(false);
    });

    return () => controller.abort();
  }, [selectedDate, isPublic]);

  // A public visitor is shown nothing: not history or an error left in memory
  // from before they dropped to public (the first render after the drop
  // commits before the effect above clears them), and not the loading flag of
  // a request that was aborted.
  const history = isPublic ? null : heldHistory;
  const loading = !isPublic && heldLoading;
  const error = isPublic ? null : heldError;

  // The page's ET time, as the as-of slot the shared module takes (CT minutes
  // since midnight). Every value comes from bars that have ended by it.
  const getStateAtTime = useCallback(
    (hourET: number, minuteET: number): HistorySnapshot | null =>
      history
        ? historySnapshotAt(
            history,
            hourET * 60 + minuteET - ET_AHEAD_OF_CT_MIN,
          )
        : null,
    [history],
  );

  return {
    history,
    loading,
    error,
    getStateAtTime,
    hasHistory: history != null && history.spx.candles.length > 0,
  };
}
