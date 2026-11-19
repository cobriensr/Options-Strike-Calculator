/**
 * useIntervalBAFeed — fetches the historical-backtest slice of
 * interval_ba_alerts for a CT calendar date + time window.
 *
 * Refetch model:
 *   - Always: re-fetch when date / time / filter inputs change, or
 *     when the caller bumps `refresh()`. The date and the two times are
 *     held until they stop changing (useDebounced's default delay), so a
 *     held arrow key on a time input sends one request, not one per step.
 *     The first fetch on mount and a filter change are not delayed.
 *   - Superseded requests are aborted when the settled params change or
 *     the component unmounts; an aborted request is not an error and its
 *     response is never written to state.
 *   - `loading` is true while the held alerts answer different params than
 *     the ones asked for (a date held by the debounce, a fetch in flight),
 *     and only then: a poll or a refresh of the same params keeps the rows.
 *   - Auto-polling: when `marketOpen` is true AND the settled `date` is
 *     today (the shared ET clock, `useETToday`), the hook bumps
 *     `refreshTick` every POLL_INTERVALS.ALERTS ms so the live feed stays
 *     in lockstep with `useIntervalBAAlerts` — without this the toast
 *     banner would surface a new alert while the history table stayed
 *     stale until the user hit the refresh button. Historical dates never
 *     poll. A poll uses the settled date and times.
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { useDebounced } from './useDebounced.js';
import { useETToday } from './useETToday';
import { usePolling } from './usePolling';

export interface IntervalBAFeedAlert {
  id: number;
  option_chain: string;
  ticker: string;
  option_type: 'C' | 'P';
  strike: number;
  expiry: string;
  bucket_start: string;
  bucket_end: string;
  fired_at: string;
  ratio_pct: number;
  ask_premium: number;
  total_premium: number;
  trade_count: number;
  top_trade_premium: number | null;
  top_trade_size: number | null;
  top_trade_executed_at: string | null;
  top_trade_is_sweep: boolean | null;
  top_trade_is_floor: boolean | null;
  underlying_price: number | null;
  /**
   * Cross-symbol confluence — partner tickers from the SPY/SPXW/QQQ
   * trio that fired same-direction within the configured window.
   * Empty array on solo fires; null on legacy backfilled rows
   * surfaces as []. Phase 5 of interval-ba-confluence spec.
   */
  confluence_tickers: string[];
  severity: 'warning' | 'critical' | 'extreme';
}

export interface IntervalBAFeedSummary {
  count: number;
  total_premium: number;
  extreme: number;
  critical: number;
  warning: number;
}

export interface UseIntervalBAFeedParams {
  date: string;
  startTime: string;
  endTime: string;
  optionType: 'C' | 'P' | null;
  minPremium: number;
  /**
   * When true, only fetch alerts with a non-empty confluence_tickers
   * list (multi-symbol fires). Off by default — the historical feed
   * shows everything so the user can compare solo vs confluence.
   */
  confluenceOnly: boolean;
  /**
   * Moneyness gate computed server-side from the (option_type, strike,
   * spot) triplet after the SPXW→SPX spot fallback. `null` = no filter.
   * ATM rows (within ±0.05% of strike) are excluded from both buckets,
   * matching the pill's classification.
   */
  moneyness: 'ITM' | 'OTM' | null;
}

export interface UseIntervalBAFeedState {
  alerts: IntervalBAFeedAlert[];
  summary: IntervalBAFeedSummary | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  refresh: () => void;
}

function buildUrl(p: UseIntervalBAFeedParams): string {
  const sp = new URLSearchParams({
    date: p.date,
    startTime: p.startTime,
    endTime: p.endTime,
  });
  if (p.optionType) sp.set('optionType', p.optionType);
  if (p.minPremium > 0) sp.set('minPremium', String(p.minPremium));
  // Endpoint parses the literal string "1" (anything else leaves
  // the filter off). Match that contract exactly.
  if (p.confluenceOnly) sp.set('confluenceOnly', '1');
  if (p.moneyness) sp.set('moneyness', p.moneyness);
  return `/api/interval-ba-feed?${sp.toString()}`;
}

/**
 * One string for every field of the params, so two requests are "the same
 * request" exactly when their keys are equal. The tuple is JSON-encoded, so a
 * value holding the separator cannot make two different requests collide.
 */
function paramsKey(p: UseIntervalBAFeedParams): string {
  return JSON.stringify([
    p.date,
    p.startTime,
    p.endTime,
    p.optionType,
    p.minPremium,
    p.confluenceOnly,
    p.moneyness,
  ]);
}

export function useIntervalBAFeed(
  params: UseIntervalBAFeedParams,
  marketOpen: boolean = false,
): UseIntervalBAFeedState {
  const [alerts, setAlerts] = useState<IntervalBAFeedAlert[]>([]);
  const [summary, setSummary] = useState<IntervalBAFeedSummary | null>(null);
  // The key of the params the held `alerts` were last fetched for, or null
  // before the first response. `loading` is derived from it (below), not set
  // by each fetch, so it stays false across a poll or a refresh of the same
  // params and the rows are not unmounted every ten seconds.
  const [responseKey, setResponseKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Bumping ``refreshTick`` re-runs the fetch effect without changing
  // any of the user-facing params — that's the manual-refresh path.
  // Same effect handles param-driven refetches AND manual ones, so
  // the in-flight cancellation logic doesn't have to be duplicated.
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  // The date and time inputs step (a held arrow key sends ~30 changes a
  // second), so settle them before they drive a fetch. One memoized object
  // keeps the three fields on one timer: a change to several at once is one
  // refetch, and the object stays stable between renders so it can't loop.
  const selection = useMemo(
    () => ({
      date: params.date,
      startTime: params.startTime,
      endTime: params.endTime,
    }),
    [params.date, params.startTime, params.endTime],
  );
  const settled = useDebounced(selection);

  // Loading is a comparison of keys: the params asked for now (the raw date and
  // times, not the settled ones) against the params the held alerts answer.
  // The feed hands each row the date it asked for, so a row must never render
  // with a date its alerts were not fetched for: while a changed date waits out
  // the debounce, or its fetch is in flight, the two keys differ and the feed
  // is loading.
  const requestKey = paramsKey(params);
  const loading = responseKey !== requestKey;

  useEffect(() => {
    // Aborted when the settled params change, on a refresh or poll tick, and
    // on unmount, so a superseded response never reaches state.
    const ctrl = new AbortController();
    const fetchParams = { ...params, ...settled };
    const url = buildUrl(fetchParams);
    const fetchKey = paramsKey(fetchParams);
    setError(null);

    fetch(url, {
      credentials: 'same-origin',
      signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(15_000)]),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          const error = new Error(
            body.error ?? `${res.status} ${res.statusText}`,
          ) as Error & { status?: number };
          error.status = res.status;
          throw error;
        }
        return res.json();
      })
      .then((data: unknown) => {
        if (ctrl.signal.aborted) return;
        if (
          typeof data !== 'object' ||
          data === null ||
          !('alerts' in data) ||
          !('summary' in data) ||
          !Array.isArray((data as { alerts: unknown }).alerts)
        ) {
          throw new Error('malformed response');
        }
        const typed = data as {
          alerts: IntervalBAFeedAlert[];
          summary: IntervalBAFeedSummary;
        };
        setAlerts(typed.alerts);
        setSummary(typed.summary);
        setFetchedAt(Date.now());
        setResponseKey(fetchKey);
      })
      .catch((err: unknown) => {
        // Only our own abort is skipped. The 15 s timeout also aborts the
        // request, but through the combined signal, so it still surfaces.
        if (ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        captureUnlessAuth(err, {
          tags: { context: 'interval_ba_feed' },
        });
        setError(msg);
        // A failed fetch has answered too: the feed shows the error, not a
        // spinner for ever.
        setResponseKey(fetchKey);
      });

    return () => ctrl.abort();
    // Intentionally enumerate each `params` field (the date and times
    // arrive through `settled`) rather than depend on the `params` object
    // itself — the parent re-creates the object every render, which would
    // re-fire the fetch on unrelated parent updates. Each access here is
    // listed individually so a new field added to `params` would surface
    // as a TS error before becoming a missed dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settled,
    params.optionType,
    params.minPremium,
    params.confluenceOnly,
    params.moneyness,
    refreshTick,
  ]);

  // Auto-poll the live feed when the user is looking at today's date
  // during market hours. Cadence matches useIntervalBAAlerts so the
  // banner and the history table stay in lockstep; historical dates and
  // closed-market sessions skip polling entirely (no new rows arrive).
  // The fetch effect above handles cancellation, so a slow request that
  // overlaps with the next tick is harmlessly aborted on the next
  // refreshTick bump.
  //
  // The gate reads the settled date, the one the fetch effect uses, so a poll
  // never refetches a date that is not shown yet. "Today" is the shared ET
  // clock, subscribed to (`useETToday`), so the gate flips in the commit at ET
  // midnight (23:00:01 CT): it stops polling a feed left on the prior date and
  // starts polling one on the new day. A following feed's settled date lags
  // the roll by the debounce, so it polls the new day from then. The feed's
  // date is the CT date of the SPXW expiry, but nothing fires or polls from
  // 23:00 to 24:00 CT, the only hour the two dates differ.
  const today = useETToday();
  usePolling(
    () => {
      setRefreshTick((n) => n + 1);
    },
    POLL_INTERVALS.ALERTS,
    [marketOpen, settled.date === today],
  );

  return { alerts, summary, loading, error, fetchedAt, refresh };
}
