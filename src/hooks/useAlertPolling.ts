/**
 * useAlertPolling — polls /api/alerts for real-time market alerts.
 *
 * During market hours, polls every 10 seconds for new alerts from the
 * monitor-iv and monitor-flow-ratio crons. On new alert:
 *   1. Fires a browser Notification (if permission granted)
 *   2. Plays an audio alert via Web Audio API
 *   3. Updates React state for the AlertBanner component
 *
 * Owner-only — skips polling for public visitors.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { checkIsOwner } from '../utils/auth';
import { usePolling } from './usePolling';

// Sample rate for polling-failure capture. Without sampling, a sustained
// outage would flood Sentry with one event per poll tick across every
// open tab. 10% is enough to detect systemic failure within a couple
// minutes while keeping volume bounded.
const POLL_FAILURE_SAMPLE_RATE = 0.1;

// ── Types ──────────────────────────────────────────────────

export interface MarketAlert {
  id: number;
  type: 'iv_spike' | 'ratio_surge' | 'combined';
  severity: 'warning' | 'critical' | 'extreme';
  direction: 'BEARISH' | 'BULLISH' | 'NEUTRAL';
  title: string;
  body: string;
  current_values: Record<string, number>;
  delta_values: Record<string, number>;
  created_at: string;
  acknowledged: boolean;
}

export interface AlertPollingState {
  alerts: MarketAlert[];
  unacknowledgedCount: number;
  acknowledge: (id: number) => Promise<void>;
  notificationPermission: NotificationPermission | 'unsupported';
  requestPermission: () => Promise<void>;
}

// ── Audio alert ────────────────────────────────────────────

/** Play the alert chime once. */
function playChimeOnce(severity: MarketAlert['severity']): void {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const volume =
      severity === 'extreme' ? 0.7 : severity === 'critical' ? 0.5 : 0.3;
    const repeats = severity === 'extreme' ? 2 : 1;
    const notes = [523.25, 659.25, 783.99]; // C5 → E5 → G5

    let offset = 0;
    for (let r = 0; r < repeats; r++) {
      for (const freq of notes) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.gain.setValueAtTime(volume, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(
          0.01,
          ctx.currentTime + offset + 0.15,
        );
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.15);
        offset += 0.18;
      }
      offset += 0.1;
    }

    setTimeout(() => ctx.close(), (offset + 0.5) * 1000);
  } catch {
    // Audio not available
  }
}

/** Repeat interval per severity (ms between chimes). */
const CHIME_INTERVAL: Record<MarketAlert['severity'], number> = {
  warning: 15_000,
  critical: 10_000,
  extreme: 5_000,
};

/** Active chime intervals keyed by alert ID. */
const activeChimes = new Map<number, ReturnType<typeof setInterval>>();

/** Start a repeating chime for an alert. Stops when stopChime is called. */
function startChime(alert: MarketAlert): void {
  if (activeChimes.has(alert.id)) return;
  playChimeOnce(alert.severity);
  const interval = setInterval(
    () => playChimeOnce(alert.severity),
    CHIME_INTERVAL[alert.severity],
  );
  activeChimes.set(alert.id, interval);
}

/** Stop the repeating chime for an alert. */
function stopChime(alertId: number): void {
  const interval = activeChimes.get(alertId);
  if (interval) {
    clearInterval(interval);
    activeChimes.delete(alertId);
  }
}

// ── Browser notification ───────────────────────────────────

function showBrowserNotification(alert: MarketAlert): void {
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return;
  }

  try {
    new Notification(alert.title, {
      body: alert.body,
      icon: '/icon-192.png',
      tag: `${alert.type}-${alert.id}`,
      requireInteraction: alert.severity !== 'warning',
    });
  } catch {
    // Notification API not available in this context
  }
}

// ── Hook ───────────────────────────────────────────────────

export function useAlertPolling(marketOpen: boolean): AlertPollingState {
  const isOwner = checkIsOwner();
  const [alerts, setAlerts] = useState<MarketAlert[]>([]);
  const lastSeenRef = useRef<string | null>(null);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(
    typeof Notification !== 'undefined'
      ? Notification.permission
      : 'unsupported',
  );

  // Fetch new alerts
  const fetchAlerts = useCallback(async () => {
    try {
      const params = lastSeenRef.current
        ? `?since=${encodeURIComponent(lastSeenRef.current)}`
        : '';
      const res = await fetch(`/api/alerts${params}`, {
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
      const alerts = (data as { alerts: MarketAlert[] }).alerts;
      if (alerts.length === 0) return;

      // Track the newest timestamp for incremental polling
      const newest = alerts[0]!.created_at;
      lastSeenRef.current = newest;

      // Deduplicate via ref (stable across renders, not called twice)
      const fresh = alerts.filter(
        (a) => !seenIdsRef.current.has(a.id) && !a.acknowledged,
      );

      // Mark as seen BEFORE playing sound — prevents duplicates
      for (const a of fresh) seenIdsRef.current.add(a.id);

      // Fire notifications outside state updater (side-effect safe)
      for (const alert of fresh) {
        showBrowserNotification(alert);
        startChime(alert);
      }

      if (fresh.length > 0) {
        setAlerts((prev) => [...fresh, ...prev].slice(0, 50));
      }
    } catch (err: unknown) {
      // Sampled capture so a 5-min outage doesn't flood Sentry with one
      // event per poll tick × every open tab; the next interval retries
      // unconditionally regardless of sampling.
      if (Math.random() < POLL_FAILURE_SAMPLE_RATE) {
        captureUnlessAuth(err, {
          level: 'warning',
          tags: { context: 'alerts_poll', sampled: '10%' },
        });
      }
    }
  }, []);

  // Eager fetch on gate-open — usePolling only schedules, never fires
  // immediately, so the initial fetch lives in its own effect.
  useEffect(() => {
    if (!isOwner || !marketOpen) return;
    fetchAlerts();
  }, [isOwner, marketOpen, fetchAlerts]);

  // Recurring poll — gated identically to the eager fetch.
  usePolling(fetchAlerts, POLL_INTERVALS.ALERTS, [isOwner, marketOpen]);

  // Acknowledge an alert — stops the repeating chime
  const acknowledge = useCallback(async (id: number) => {
    stopChime(id);
    try {
      await fetch('/api/alerts-ack', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setAlerts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
      );
    } catch (err: unknown) {
      // User-initiated, low-frequency — capture every time so a broken
      // ack endpoint surfaces immediately rather than waiting for the
      // user to notice the chime won't stop.
      captureUnlessAuth(err, { tags: { context: 'alerts_ack' } });
    }
  }, []);

  // Request notification permission
  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
  }, []);

  const unacknowledgedCount = alerts.filter((a) => !a.acknowledged).length;

  return {
    alerts,
    unacknowledgedCount,
    acknowledge,
    notificationPermission,
    requestPermission,
  };
}
