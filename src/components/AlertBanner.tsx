/**
 * AlertBanner — fixed-position banner for real-time market alerts.
 *
 * Slides in from the top when unacknowledged alerts are active.
 * Color-coded by severity, shows direction badge and key values.
 * Dismiss button acknowledges the alert via POST /api/alerts-ack.
 */

import type { MarketAlert } from '../hooks/useAlertPolling';
import { theme } from '../themes';
import { tint } from '../utils/ui-utils';

interface AlertBannerProps {
  alerts: MarketAlert[];
  onAcknowledge: (id: number) => Promise<void>;
}

function severityStyles(severity: MarketAlert['severity']) {
  switch (severity) {
    case 'warning':
      return {
        backgroundColor: tint(theme.caution, 'E6'), // ~90%
        borderColor: tint(theme.caution, '99'), // ~60%
        color: theme.caution,
      };
    case 'critical':
      return {
        backgroundColor: tint(theme.red, 'E6'), // ~90%
        borderColor: tint(theme.red, '99'), // ~60%
        color: theme.red,
      };
    case 'extreme':
      return {
        backgroundColor: tint(theme.red, 'F2'), // ~95%
        borderColor: tint(theme.red, 'CC'), // ~80%
        color: theme.red,
      };
  }
}

function directionStyles(direction: MarketAlert['direction']) {
  switch (direction) {
    case 'BEARISH':
      return {
        backgroundColor: tint(theme.red, 'D9'), // ~85%
        color: theme.red,
      };
    case 'BULLISH':
      return {
        backgroundColor: tint(theme.green, 'D9'), // ~85%
        color: theme.green,
      };
    case 'NEUTRAL':
      return {
        backgroundColor: tint(theme.textMuted, 'D9'), // ~85%
        color: theme.textMuted,
      };
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return '';
  }
}

export default function AlertBanner({
  alerts,
  onAcknowledge,
}: AlertBannerProps) {
  const active = alerts.filter((a) => !a.acknowledged);
  if (active.length === 0) return null;

  return (
    <div className="fixed top-0 right-0 left-0 z-[60] space-y-1 p-2">
      {active.slice(0, 3).map((alert) => {
        const sev = severityStyles(alert.severity);
        const isExtreme = alert.severity === 'extreme';

        return (
          <div
            key={alert.id}
            role="alert"
            className={`mx-auto flex max-w-2xl items-start gap-3 rounded-lg border p-3 shadow-lg backdrop-blur-sm${isExtreme ? 'animate-pulse' : ''}`}
            style={sev}
          >
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 font-sans text-[10px] font-bold"
                  style={directionStyles(alert.direction)}
                >
                  {alert.direction}
                </span>
                <span className="font-sans text-xs font-semibold">
                  {alert.title}
                </span>
                <span className="ml-auto font-sans text-[10px] opacity-60">
                  {formatTime(alert.created_at)}
                </span>
              </div>
              <p className="font-sans text-xs leading-relaxed opacity-80">
                {alert.body}
              </p>
            </div>
            <button
              onClick={() => onAcknowledge(alert.id)}
              aria-label="Dismiss alert"
              className="mt-0.5 shrink-0 cursor-pointer rounded p-1 font-sans text-xs opacity-60 transition-opacity hover:opacity-100"
            >
              &#x2715;
            </button>
          </div>
        );
      })}
    </div>
  );
}
