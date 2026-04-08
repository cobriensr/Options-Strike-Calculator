/**
 * AlertBanner — fixed-position banner for real-time market alerts.
 *
 * Slides in from the top when unacknowledged alerts are active.
 * Color-coded by severity, shows direction badge and key values.
 * Dismiss button acknowledges the alert via POST /api/alerts-ack.
 */

import type { MarketAlert } from '../hooks/useAlertPolling';
import { theme } from '../themes';
import { tintedSurface } from '../utils/ui-utils';

interface AlertBannerProps {
  alerts: MarketAlert[];
  onAcknowledge: (id: number) => Promise<void>;
}

function severityStyles(severity: MarketAlert['severity']) {
  switch (severity) {
    case 'warning':
      return {
        backgroundColor: tintedSurface(theme.caution, 16, theme.surface),
        borderColor: tintedSurface(theme.caution, 70, theme.surface),
        color: theme.text,
      };
    case 'critical':
      return {
        backgroundColor: tintedSurface(theme.red, 16, theme.surface),
        borderColor: tintedSurface(theme.red, 70, theme.surface),
        color: theme.text,
      };
    case 'extreme':
      return {
        backgroundColor: tintedSurface(theme.red, 28, theme.surface),
        borderColor: theme.red,
        color: theme.text,
      };
  }
}

function directionStyles(direction: MarketAlert['direction']) {
  // Solid accent pill with opposite-polarity text (theme.bg is always the
  // inverse of theme.text, so this reads in both light and dark themes).
  switch (direction) {
    case 'BEARISH':
      return { backgroundColor: theme.red, color: theme.bg };
    case 'BULLISH':
      return { backgroundColor: theme.green, color: theme.bg };
    case 'NEUTRAL':
      return { backgroundColor: theme.textMuted, color: theme.bg };
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
}: Readonly<AlertBannerProps>) {
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
            className={`mx-auto flex max-w-2xl items-start gap-3 rounded-lg border p-3 shadow-lg ${isExtreme ? 'animate-pulse' : ''}`}
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
              <p className="font-sans text-xs leading-relaxed">{alert.body}</p>
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
