/**
 * AlertBanner — fixed-position banner for real-time market alerts.
 *
 * Slides in from the top when unacknowledged alerts are active.
 * Color-coded by severity, shows direction badge and key values.
 * Dismiss button acknowledges the alert via POST /api/alerts-ack.
 */

import type { MarketAlert } from '../hooks/useAlertPolling';

interface AlertBannerProps {
  alerts: MarketAlert[];
  onAcknowledge: (id: number) => Promise<void>;
}

const SEVERITY_STYLES = {
  warning: 'border-yellow-600/60 bg-yellow-950/90 text-yellow-100',
  critical: 'border-red-600/60 bg-red-950/90 text-red-100',
  extreme: 'border-red-500/80 bg-red-900/95 text-red-50 animate-pulse',
} as const;

const DIRECTION_BADGE = {
  BEARISH: 'bg-red-700 text-red-100',
  BULLISH: 'bg-green-700 text-green-100',
  NEUTRAL: 'bg-zinc-700 text-zinc-100',
} as const;

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
      {active.slice(0, 3).map((alert) => (
        <div
          key={alert.id}
          role="alert"
          className={`mx-auto flex max-w-2xl items-start gap-3 rounded-lg border p-3 shadow-lg backdrop-blur-sm ${SEVERITY_STYLES[alert.severity]}`}
        >
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 font-sans text-[10px] font-bold ${DIRECTION_BADGE[alert.direction]}`}
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
      ))}
    </div>
  );
}
