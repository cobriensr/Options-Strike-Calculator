/**
 * useIntervalBAAlerts — polls /api/interval-ba-alerts for SPXW per-contract
 * 5-min Interval B/A ask-side alert events.
 *
 * During market hours, polls every 10 seconds. On each fresh alert:
 *   1. Fires a browser Notification (if permission granted)
 *   2. Plays the sweep-alarm chime (severity-scaled volume)
 *   3. Updates React state for the IntervalBAAlertBanner
 *
 * Owner-only — guests can still hit GET /api/interval-ba-alerts but the
 * banner + chime UX is gated to the owner here. Acknowledgement POSTs
 * to /api/interval-ba-alerts-ack (owner-only at the API layer).
 *
 * Mirrors `useAlertPolling` structurally; deviates only on payload shape
 * (IntervalBAAlertRow not MarketAlert), endpoint paths, and chime tone
 * (playSweepAlarm instead of playChimeOnce).
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { checkIsOwner } from '../utils/auth';
import { playSweepAlarm } from '../utils/anomaly-sound';

// ── Types ──────────────────────────────────────────────────

export interface IntervalBAAlert {
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
  acknowledged: boolean;
  severity: 'warning' | 'critical' | 'extreme';
}

export interface IntervalBAAlertPollingState {
  alerts: IntervalBAAlert[];
  unacknowledgedCount: number;
  acknowledge: (id: number) => Promise<void>;
}

// ── Audio repeat cadence ───────────────────────────────────

const CHIME_INTERVAL_MS: Record<IntervalBAAlert['severity'], number> = {
  warning: 15_000,
  critical: 10_000,
  extreme: 5_000,
};

const activeChimes = new Map<number, ReturnType<typeof setInterval>>();

function startChime(alert: IntervalBAAlert): void {
  if (activeChimes.has(alert.id)) return;
  playSweepAlarm(alert.severity);
  const interval = setInterval(
    () => playSweepAlarm(alert.severity),
    CHIME_INTERVAL_MS[alert.severity],
  );
  activeChimes.set(alert.id, interval);
}

function stopChime(alertId: number): void {
  const interval = activeChimes.get(alertId);
  if (interval !== undefined) {
    clearInterval(interval);
    activeChimes.delete(alertId);
  }
}

/**
 * Reset the module-level chime state. Test-only — production code
 * should never need this. Without it, a chime started in one test
 * leaks across to subsequent tests (the dedupe map is module-scope so
 * the in-app component can survive remounts without re-chiming).
 */
export function __resetChimesForTests(): void {
  for (const interval of activeChimes.values()) {
    clearInterval(interval);
  }
  activeChimes.clear();
}

// ── Display helpers (exported for the banner component) ────

/** Short alert title — e.g. "SPXW 7360C 71% ASK". */
export function formatIntervalBATitle(alert: IntervalBAAlert): string {
  const strike = Number.isInteger(alert.strike)
    ? alert.strike.toString()
    : alert.strike.toFixed(0);
  return `${alert.ticker} ${strike}${alert.option_type} ${alert.ratio_pct.toFixed(0)}% ASK`;
}

/** Sentence-form alert body — e.g. "$1.33M premium / 5 trades — top: $408K sweep". */
export function formatIntervalBABody(alert: IntervalBAAlert): string {
  const premiumK = Math.round(alert.total_premium / 1000);
  const premiumStr =
    premiumK >= 1000 ? `$${(premiumK / 1000).toFixed(2)}M` : `$${premiumK}K`;
  const tradeNoun = alert.trade_count === 1 ? 'trade' : 'trades';
  let body = `${premiumStr} premium / ${alert.trade_count} ${tradeNoun}`;
  if (alert.top_trade_premium != null && alert.top_trade_size != null) {
    const topK = Math.round(alert.top_trade_premium / 1000);
    const topStr = topK >= 1000 ? `$${(topK / 1000).toFixed(2)}M` : `$${topK}K`;
    const flags: string[] = [];
    if (alert.top_trade_is_sweep) flags.push('sweep');
    if (alert.top_trade_is_floor) flags.push('floor');
    const flagStr = flags.length > 0 ? ` ${flags.join(' ')}` : '';
    body += ` — top: ${topStr}${flagStr}`;
  }
  return body;
}

// ── Browser notification ───────────────────────────────────

function showBrowserNotification(alert: IntervalBAAlert): void {
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return;
  }
  try {
    new Notification(formatIntervalBATitle(alert), {
      body: formatIntervalBABody(alert),
      icon: '/icon-192.png',
      tag: `interval-ba-${alert.id}`,
      requireInteraction: alert.severity !== 'warning',
    });
  } catch {
    // Notification API blocked in this context.
  }
}

// ── Hook ───────────────────────────────────────────────────

export function useIntervalBAAlerts(
  marketOpen: boolean,
): IntervalBAAlertPollingState {
  const isOwner = checkIsOwner();
  const [alerts, setAlerts] = useState<IntervalBAAlert[]>([]);
  const lastSeenRef = useRef<string | null>(null);
  const seenIdsRef = useRef<Set<number>>(new Set());

  const fetchAlerts = useCallback(async () => {
    try {
      const params = lastSeenRef.current
        ? `?since=${encodeURIComponent(lastSeenRef.current)}`
        : '';
      const res = await fetch(`/api/interval-ba-alerts${params}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return;

      const data: unknown = await res.json();
      if (
        typeof data !== 'object' ||
        data === null ||
        !('alerts' in data) ||
        !Array.isArray((data as { alerts: unknown }).alerts)
      ) {
        return;
      }
      const incoming = (data as { alerts: IntervalBAAlert[] }).alerts;
      if (incoming.length === 0) return;

      // Track newest fired_at for incremental polling. /since/ uses
      // strictly greater-than so the same alert never reappears.
      const newest = incoming[0]!.fired_at;
      lastSeenRef.current = newest;

      const fresh = incoming.filter(
        (a) => !seenIdsRef.current.has(a.id) && !a.acknowledged,
      );

      for (const a of fresh) seenIdsRef.current.add(a.id);

      for (const alert of fresh) {
        showBrowserNotification(alert);
        startChime(alert);
      }

      if (fresh.length > 0) {
        setAlerts((prev) => [...fresh, ...prev].slice(0, 50));
      }
    } catch {
      // Network / abort error — retry next interval.
    }
  }, []);

  useEffect(() => {
    if (!isOwner || !marketOpen) return;
    fetchAlerts();
    const id = setInterval(fetchAlerts, POLL_INTERVALS.ALERTS);
    const seen = seenIdsRef.current;
    return () => {
      clearInterval(id);
      // Stop any chimes this hook started. Without this, a chime that
      // started during market hours would keep firing every 5-15s after
      // marketOpen flips false (4:01 PM ET close, or any tab close /
      // hook unmount). stopChime is idempotent so iterating the full
      // seen-IDs set is safe even for already-acknowledged alerts.
      for (const alertId of seen) stopChime(alertId);
    };
  }, [isOwner, marketOpen, fetchAlerts]);

  const acknowledge = useCallback(async (id: number) => {
    stopChime(id);
    try {
      await fetch('/api/interval-ba-alerts-ack', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setAlerts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
      );
    } catch {
      // Best-effort — user can retry.
    }
  }, []);

  const unacknowledgedCount = alerts.filter((a) => !a.acknowledged).length;

  return { alerts, unacknowledgedCount, acknowledge };
}
