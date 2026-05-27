/**
 * useIntervalBAAlerts — polls /api/interval-ba-alerts for SPXW per-contract
 * 5-min Interval B/A ask-side alert events.
 *
 * During market hours, polls every 10 seconds. On each fresh alert:
 *   1. Fires a browser Notification (if permission granted)
 *   2. Plays the sweep-alarm chime (severity-scaled volume)
 *   3. Updates React state for the IntervalBAAlertBanner
 *
 * Owner-or-guest — both surfaces (banner + chime + browser notification)
 * fire for any authenticated session. Public (signed-out) visitors get
 * neither the polling nor the banner. Acknowledgement POSTs to
 * /api/interval-ba-alerts-ack which is also owner-or-guest, so guest
 * dismissals persist to the DB the same as the owner's.
 *
 * Mirrors `useAlertPolling` structurally; deviates only on payload shape
 * (IntervalBAAlertRow not MarketAlert), endpoint paths, and chime tone
 * (playSweepAlarm instead of playChimeOnce).
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getAccessMode } from '../utils/auth';
import { playSweepAlarm } from '../utils/anomaly-sound';
import { usePolling } from './usePolling';

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
  /**
   * Cross-symbol confluence partners (Phase 5 of interval-ba-confluence
   * spec). Empty list for solo fires; populated when SPY/SPXW/QQQ
   * partners fired same-direction within ~90s. Used by the banner pill
   * + by formatIntervalBATitle to suffix +TICKER on the notification.
   */
  confluence_tickers: string[];
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

/** Short alert title — e.g. "SPXW 7360C 71% ASK".
 *
 * Does NOT include the confluence-partner suffix — the in-app banner
 * renders a separate "+SPY" pill so the title-and-pill combo would
 * duplicate the info. The OS Notification path adds the suffix on its
 * own (no pill there) so the phone glance still carries the signal.
 */
export function formatIntervalBATitle(alert: IntervalBAAlert): string {
  const strike = Number.isInteger(alert.strike)
    ? alert.strike.toString()
    : alert.strike.toFixed(0);
  return `${alert.ticker} ${strike}${alert.option_type} ${alert.ratio_pct.toFixed(0)}% ASK`;
}

/** OS-notification title — base title + sorted "+TICKER" partner suffix.
 *
 * Mirrors notify.build_payload (Phase 4 push title decoration) so the
 * desktop / mobile system notification renders the same way as the
 * Web Push fan-out from uw-stream. Banner UI uses the base title plus
 * a separate visual pill — don't use this formatter there.
 */
export function formatIntervalBANotificationTitle(
  alert: IntervalBAAlert,
): string {
  const base = formatIntervalBATitle(alert);
  if (alert.confluence_tickers.length === 0) return base;
  const partners = [...alert.confluence_tickers].sort();
  const suffix = partners.map((t) => '+' + t).join(' ');
  return `${base} ${suffix}`;
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
    new Notification(formatIntervalBANotificationTitle(alert), {
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
  muted: boolean = false,
): IntervalBAAlertPollingState {
  // Owner-or-guest: any authenticated session gets the banner + chime.
  // Public visitors (no cookie) skip the poll loop entirely so we don't
  // hammer the endpoint with 401s for signed-out browser tabs.
  const hasSession = getAccessMode() !== 'public';
  const [alerts, setAlerts] = useState<IntervalBAAlert[]>([]);
  const lastSeenRef = useRef<string | null>(null);
  const seenIdsRef = useRef<Set<number>>(new Set());
  // Held in a ref so changing `muted` doesn't bust fetchAlerts identity
  // and re-trigger the eager-fetch effect (which would re-chime queued
  // alerts on every mute toggle).
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
    // Mute flip → silence any chimes already in flight. Without this,
    // an "extreme" alert that started a 5s repeating chime would keep
    // ringing for the whole interval after the user hit mute.
    if (muted) {
      for (const alertId of seenIdsRef.current) stopChime(alertId);
    }
  }, [muted]);

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

      // When muted, surface the alert in state (so the count badge and
      // the restored stack are accurate) but skip the audible chime
      // and the system notification — those are what's actually
      // intrusive. Polling itself keeps running so re-enabling shows
      // the real backlog, not a stale snapshot.
      if (!mutedRef.current) {
        for (const alert of fresh) {
          showBrowserNotification(alert);
          startChime(alert);
        }
      }

      if (fresh.length > 0) {
        setAlerts((prev) => [...fresh, ...prev].slice(0, 50));
      }
    } catch {
      // Network / abort error — retry next interval.
    }
  }, []);

  // Eager fetch + chime-stop-on-gate-flip. usePolling owns the recurring
  // setInterval, but the cleanup contract here is broader: when the
  // gate flips closed (marketOpen → false, session lost, unmount), any
  // chime this hook started must stop. Without this, a chime that fired
  // during market hours would keep ringing every 5–15s after 4:01 PM
  // ET. stopChime is idempotent so iterating the full seen-IDs set is
  // safe even for already-acknowledged alerts.
  useEffect(() => {
    if (!hasSession || !marketOpen) return;
    fetchAlerts();
    const seen = seenIdsRef.current;
    return () => {
      for (const alertId of seen) stopChime(alertId);
    };
  }, [hasSession, marketOpen, fetchAlerts]);

  // Recurring poll — gated identically to the eager fetch above.
  usePolling(fetchAlerts, POLL_INTERVALS.ALERTS, [hasSession, marketOpen]);

  const acknowledge = useCallback(async (id: number) => {
    stopChime(id);
    try {
      const res = await fetch('/api/interval-ba-alerts-ack', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      // Without this guard a 401/403/500 resolves silently — the local
      // state was being marked acknowledged while the DB row still had
      // acknowledged=FALSE, so dismissed alerts reappeared on refresh.
      if (!res.ok) {
        throw new Error(`ack failed: ${res.status}`);
      }
      setAlerts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
      );
    } catch {
      // Best-effort — the alert stays visible so the user notices the
      // dismiss didn't stick and can retry (or sign back in).
    }
  }, []);

  const unacknowledgedCount = alerts.filter((a) => !a.acknowledged).length;

  return { alerts, unacknowledgedCount, acknowledge };
}
