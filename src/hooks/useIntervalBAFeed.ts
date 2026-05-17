/**
 * useIntervalBAFeed — fetches the historical-backtest slice of
 * interval_ba_alerts for a CT calendar date + time window.
 *
 * Refetch model:
 *   - Always: re-fetch when date / time / filter inputs change, or
 *     when the caller bumps `refetch()`.
 *   - Auto-polling: when `marketOpen` is true AND the selected `date`
 *     is today (CT calendar), the hook bumps `refreshTick` every
 *     POLL_INTERVALS.ALERTS ms so the live feed stays in lockstep with
 *     `useIntervalBAAlerts` — without this the toast banner would surface
 *     a new alert while the history table stayed stale until the user
 *     hit the refresh button. Historical dates never poll.
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md.
 */

import { useCallback, useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { POLL_INTERVALS } from '../constants';

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
  refetch: () => void;
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
 * CT calendar date in YYYY-MM-DD form. Duplicated here (rather than
 * imported from the IntervalBAFeed component) to keep the hook
 * self-contained — multiple call sites compute "today" the same way
 * already.
 */
function todayCt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function useIntervalBAFeed(
  params: UseIntervalBAFeedParams,
  marketOpen: boolean = false,
): UseIntervalBAFeedState {
  const [alerts, setAlerts] = useState<IntervalBAFeedAlert[]>([]);
  const [summary, setSummary] = useState<IntervalBAFeedSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Bumping ``refreshTick`` re-runs the fetch effect without changing
  // any of the user-facing params — that's the manual-refresh path.
  // Same effect handles param-driven refetches AND manual ones, so
  // the in-flight cancellation logic doesn't have to be duplicated.
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const url = buildUrl(params);
    setLoading(true);
    setError(null);

    fetch(url, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        }
        return res.json();
      })
      .then((data: unknown) => {
        if (cancelled) return;
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
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'The operation was aborted') return;
        Sentry.captureException(err, {
          tags: { context: 'interval_ba_feed' },
        });
        setError(msg);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Intentionally enumerate each `params` field rather than depend on
    // the `params` object itself — the parent re-creates the object
    // every render, which would re-fire the fetch on unrelated parent
    // updates. Each access here is listed individually so a new field
    // added to `params` would surface as a TS error before becoming a
    // missed dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    params.date,
    params.startTime,
    params.endTime,
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
  useEffect(() => {
    if (!marketOpen) return;
    if (params.date !== todayCt()) return;
    const id = setInterval(() => {
      setRefreshTick((n) => n + 1);
    }, POLL_INTERVALS.ALERTS);
    return () => clearInterval(id);
  }, [marketOpen, params.date]);

  return { alerts, summary, loading, error, fetchedAt, refetch };
}
