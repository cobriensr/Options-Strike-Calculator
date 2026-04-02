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
import { useIsOwner } from './useIsOwner';

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

function playAlertTone(severity: MarketAlert['severity']): void {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    // Severity → loudness + number of tones
    const volume =
      severity === 'extreme' ? 0.7 : severity === 'critical' ? 0.5 : 0.3;
    const repeats = severity === 'extreme' ? 2 : 1;
    const notes = [523.25, 659.25, 783.99]; // C5 → E5 → G5 (major triad)

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
      offset += 0.1; // gap between repeats
    }

    // Close context after tones finish
    setTimeout(() => ctx.close(), (offset + 0.5) * 1000);
  } catch {
    // Audio not available — silent fallback
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
  const isOwner = useIsOwner();
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

      const data = (await res.json()) as { alerts: MarketAlert[] };
      if (!data.alerts || data.alerts.length === 0) return;

      // Track the newest timestamp for incremental polling
      const newest = data.alerts[0]!.created_at;
      lastSeenRef.current = newest;

      // Deduplicate via ref (stable across renders, not called twice)
      const fresh = data.alerts.filter(
        (a) => !seenIdsRef.current.has(a.id) && !a.acknowledged,
      );

      // Mark as seen BEFORE playing sound — prevents duplicates
      for (const a of fresh) seenIdsRef.current.add(a.id);

      // Fire notifications outside state updater (side-effect safe)
      for (const alert of fresh) {
        showBrowserNotification(alert);
        playAlertTone(alert.severity);
      }

      if (fresh.length > 0) {
        setAlerts((prev) => [...fresh, ...prev].slice(0, 50));
      }
    } catch {
      // Network error — silent, retry on next interval
    }
  }, []);

  // Polling interval
  useEffect(() => {
    if (!isOwner || !marketOpen) return;

    // Initial fetch
    fetchAlerts();

    const id = setInterval(fetchAlerts, POLL_INTERVALS.ALERTS);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, fetchAlerts]);

  // Acknowledge an alert
  const acknowledge = useCallback(async (id: number) => {
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
    } catch {
      // Silent failure — user can retry
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
