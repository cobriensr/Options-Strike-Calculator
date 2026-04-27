/**
 * OtmFlowAlerts — dashboard card for far-OTM SPXW heavy-flow alerts.
 *
 * Combines:
 *   - `useOtmFlowSettings` (localStorage-backed user preferences)
 *   - `useOtmFlowAlerts`   (polling + dedupe, returns `newlyArrived` diff)
 *   - `OtmFlowControls`    (sliders, segmented toggles, historical picker)
 *   - `OtmFlowRow`         (per-alert row rendering)
 *
 * Side-effects (toast / audio / browser notification) fire on the
 * `newlyArrived` diff only — never on re-renders of the existing list.
 * Each is independently gated on a user setting so a distracted trader
 * can mute audio without losing the toast, etc.
 *
 * Audio uses a distinct descending A4→F4→D4 chime so it's audibly
 * different from useAlertPolling's ascending C5→E5→G5 — trader can tell
 * "OTM flow alert" from "IV spike alert" by ear.
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import { ToastContext } from '../../hooks/useToast';
import { useOtmFlowAlerts } from '../../hooks/useOtmFlowAlerts';
import type { OtmFlowAlert } from '../../types/otm-flow';
import { getAudioContextCtor } from '../../utils/audio-utils';
import { SectionBox } from '../ui';
import { OtmFlowControls } from './OtmFlowControls';
import { OtmFlowRow } from './OtmFlowRow';
import { useOtmFlowSettings } from './useOtmFlowSettings';

// ── Audio ping ────────────────────────────────────────────────

/**
 * Play a descending A4→F4→D4 chime once. Distinct from
 * `useAlertPolling`'s ascending C5→E5→G5 so the trader can tell the
 * two alert systems apart by ear alone.
 *
 * Known quirk: mobile Safari + Chrome start AudioContext in `suspended`
 * state until a user gesture. The chime fires from a polling effect
 * (no gesture), so the first ping after page load may be swallowed
 * silently. Any subsequent ping after the user has clicked anywhere on
 * the page will work. Acceptable tradeoff for a trading dashboard; a
 * try/catch prevents any crash path regardless.
 */
function playOtmFlowChime(): void {
  try {
    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    // A4 (440), F4 (349.23), D4 (293.66) — descending minor triad.
    const notes = [440, 349.23, 293.66];
    let offset = 0;
    for (const freq of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.gain.setValueAtTime(0.25, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(
        0.01,
        ctx.currentTime + offset + 0.18,
      );
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
      offset += 0.2;
    }

    // Close the audio context after the chime finishes so we don't leak
    // one per alert batch. 500ms trailing buffer for the last ramp.
    setTimeout(() => ctx.close().catch(() => {}), (offset + 0.5) * 1000);
  } catch {
    // Audio not available in this environment — silent.
  }
}

// ── Notification ──────────────────────────────────────────────

function fireBrowserNotification(alerts: OtmFlowAlert[]): void {
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return;
  }
  if (alerts.length === 0) return;

  try {
    const newest = alerts[0]!;
    const extra = alerts.length > 1 ? ` +${alerts.length - 1} more` : '';
    new Notification('SPXW OTM flow alert', {
      body: `${newest.type.toUpperCase()} ${Math.round(newest.strike)} · ${newest.dominant_side.toUpperCase()}-heavy · ${(newest.total_premium / 1000).toFixed(0)}K${extra}`,
      icon: '/icon-192.png',
      tag: `otm-flow-${newest.option_chain}-${newest.created_at}`,
      requireInteraction: false,
    });
  } catch {
    // Notification API unavailable.
  }
}

// ── Component ─────────────────────────────────────────────────

export interface OtmFlowAlertsProps {
  marketOpen: boolean;
}

export default function OtmFlowAlerts({ marketOpen }: OtmFlowAlertsProps) {
  const { settings, updateSettings, resetSettings } = useOtmFlowSettings();
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(
    typeof Notification !== 'undefined'
      ? Notification.permission
      : 'unsupported',
  );

  const { alerts, newlyArrived, loading, error, lastUpdated, mode } =
    useOtmFlowAlerts({ settings, marketOpen });

  // Read ToastContext directly (not via useToast) so the component can
  // render standalone in tests without a ToastProvider.
  const toastCtx = useContext(ToastContext);

  // Fire side-effects when new rows arrive. Each effect is independently
  // gated so muting audio doesn't suppress toasts, etc.
  useEffect(() => {
    if (newlyArrived.length === 0) return;

    if (settings.audioOn && settings.mode === 'live') {
      playOtmFlowChime();
    }
    if (settings.notificationsOn && settings.mode === 'live') {
      fireBrowserNotification(newlyArrived);
    }
    if (toastCtx && settings.mode === 'live') {
      const n = newlyArrived.length;
      toastCtx.show(
        `${n} new OTM flow ${n === 1 ? 'alert' : 'alerts'}`,
        'info',
      );
    }
  }, [
    newlyArrived,
    settings.audioOn,
    settings.notificationsOn,
    settings.mode,
    toastCtx,
  ]);

  // Stable "now" anchor for age calculations — refreshes every 30s so the
  // visible ages move without forcing parent re-renders.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const result = await Notification.requestPermission();
      setNotificationPermission(result);
    } catch {
      // Some browsers restrict the Promise form; tolerate silently.
    }
  };

  const badge = useMemo(() => {
    if (mode === 'historical') return 'HISTORICAL';
    if (!marketOpen) return 'MARKET CLOSED';
    return `${alerts.length}`;
  }, [mode, marketOpen, alerts.length]);

  const badgeColor =
    mode === 'historical'
      ? 'var(--color-amber-500)'
      : !marketOpen
        ? 'var(--color-muted)'
        : undefined;

  const headerRight =
    lastUpdated != null ? (
      <span className="text-muted font-mono text-[11px]">
        updated{' '}
        {new Intl.DateTimeFormat('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'America/Chicago',
        }).format(new Date(lastUpdated))}{' '}
        CT
      </span>
    ) : null;

  return (
    <SectionBox
      label="OTM Flow Alerts"
      badge={badge}
      badgeColor={badgeColor}
      headerRight={headerRight}
      collapsible
    >
      <OtmFlowControls
        settings={settings}
        updateSettings={updateSettings}
        resetSettings={resetSettings}
        notificationPermission={notificationPermission}
        requestNotificationPermission={requestNotificationPermission}
      />

      {error && (
        <div role="alert" className="mt-3 font-mono text-[12px] text-rose-500">
          Error: {error}
        </div>
      )}

      <div
        className="mt-3 flex flex-col overflow-y-auto"
        style={{ maxHeight: '420px' }}
        aria-busy={loading}
      >
        {alerts.length === 0 ? (
          <div className="text-muted py-8 text-center font-mono text-[13px]">
            {loading
              ? 'Loading…'
              : mode === 'historical'
                ? 'No alerts for the selected time window.'
                : marketOpen
                  ? 'No far-OTM heavy flow in the last window. Waiting for prints…'
                  : 'Market closed. Switch to Historical to review past sessions.'}
          </div>
        ) : (
          alerts.map((alert) => {
            const isNew = newlyArrived.some(
              (a) =>
                a.option_chain === alert.option_chain &&
                a.created_at === alert.created_at,
            );
            return (
              <OtmFlowRow
                key={`${alert.option_chain}::${alert.created_at}`}
                alert={alert}
                nowMs={nowMs}
                isNew={isNew}
              />
            );
          })
        )}
      </div>
    </SectionBox>
  );
}
