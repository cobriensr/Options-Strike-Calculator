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

import { useEffect, useState } from 'react';

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
}

export interface UseIntervalBAFeedState {
  alerts: IntervalBAFeedAlert[];
  summary: IntervalBAFeedSummary | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

function buildUrl(p: UseIntervalBAFeedParams): string {
  const sp = new URLSearchParams({
    date: p.date,
    startTime: p.startTime,
    endTime: p.endTime,
  });
  if (p.optionType) sp.set('optionType', p.optionType);
  if (p.minPremium > 0) sp.set('minPremium', String(p.minPremium));
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
  ]);

  return { alerts, summary, loading, error, fetchedAt };
}
