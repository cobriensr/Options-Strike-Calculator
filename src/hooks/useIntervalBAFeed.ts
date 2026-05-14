/**
 * useIntervalBAFeed — fetches the historical-backtest slice of
 * interval_ba_alerts for a CT calendar date + time window.
 *
 * Distinct from `useIntervalBAAlerts` (live polling at 10s for today's
 * unacknowledged alerts) — this hook fetches on demand whenever the
 * date / time / filter inputs change. No polling.
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md.
 */

import { useCallback, useEffect, useState } from 'react';

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

export function useIntervalBAFeed(
  params: UseIntervalBAFeedParams,
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
        setError(msg);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
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

  return { alerts, summary, loading, error, fetchedAt, refetch };
}
