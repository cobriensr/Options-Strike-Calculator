/**
 * IntervalBAAlertBanner — fixed bottom-right toast for SPXW Interval B/A
 * ask-side alerts.
 *
 * Separate from {@link AlertBanner} (which lives at top-0 for market
 * IV/flow-ratio alerts) so the two alert streams don't visually collide
 * and a user can tell at a glance which signal class fired.
 *
 * Hooked up via {@link useIntervalBAAlerts}. Severity drives both the
 * tint and the chime cadence (cadence handled inside the hook). The
 * dismiss button calls the hook's `acknowledge(id)` which POSTs to
 * `/api/interval-ba-alerts-ack` AND stops the repeating chime.
 */

import type { IntervalBAAlert } from '../hooks/useIntervalBAAlerts';
import {
  formatIntervalBABody,
  formatIntervalBATitle,
} from '../hooks/useIntervalBAAlerts';
import { theme } from '../themes';
import { formatTimeCT } from '../utils/component-formatters';
import { tintedSurface } from '../utils/ui-utils';

interface IntervalBAAlertBannerProps {
  alerts: IntervalBAAlert[];
  onAcknowledge: (id: number) => Promise<void>;
}

function severityStyles(severity: IntervalBAAlert['severity']) {
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
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}

function sideBadgeStyles(optionType: IntervalBAAlert['option_type']) {
  // Calls = bullish-leaning ask-side flow → green. Puts = bearish-leaning
  // ask-side flow → red. theme.bg inverts vs theme.text so the pill
  // remains legible in both light and dark themes.
  return optionType === 'C'
    ? { backgroundColor: theme.green, color: theme.bg }
    : { backgroundColor: theme.red, color: theme.bg };
}

export default function IntervalBAAlertBanner({
  alerts,
  onAcknowledge,
}: Readonly<IntervalBAAlertBannerProps>) {
  const active = alerts.filter((a) => !a.acknowledged);
  if (active.length === 0) return null;

  // Bottom-right cluster invariants:
  //   - Toast lives at right-4 bottom-4 z-[70]
  //   - BackToTop lives at right-4 bottom-16 z-[65]
  // We sit above both (bottom-24 + z-[80]) so Interval B/A alerts stay
  // visible even when a Toast or the BackToTop pip is rendered.
  const visible = active.slice(0, 3);
  const overflow = active.length - visible.length;
  return (
    <div className="fixed right-4 bottom-24 z-[80] flex w-full max-w-sm flex-col gap-1">
      {visible.map((alert) => {
        const sev = severityStyles(alert.severity);
        const sideBadge = sideBadgeStyles(alert.option_type);
        const isExtreme = alert.severity === 'extreme';

        return (
          <div
            key={alert.id}
            role="alert"
            className={`flex items-start gap-3 rounded-lg border p-3 shadow-lg ${isExtreme ? 'animate-pulse' : ''}`}
            style={sev}
          >
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span
                  title={
                    alert.option_type === 'C'
                      ? 'CALL — ask-side buyers paid up for upside calls. Bullish directional bet.'
                      : 'PUT — ask-side buyers paid up for downside puts. Bearish directional bet.'
                  }
                  className="cursor-help rounded px-1.5 py-0.5 font-sans text-[10px] font-bold"
                  style={sideBadge}
                >
                  {alert.option_type === 'C' ? 'CALL' : 'PUT'}
                </span>
                <span className="font-sans text-xs font-semibold">
                  {formatIntervalBATitle(alert)}
                </span>
                <span className="ml-auto font-sans text-[10px] opacity-60">
                  {formatTimeCT(alert.fired_at)}
                </span>
              </div>
              <p className="font-sans text-xs leading-relaxed">
                {formatIntervalBABody(alert)}
              </p>
            </div>
            <button
              onClick={() => {
                void onAcknowledge(alert.id);
              }}
              aria-label="Dismiss alert"
              className="mt-0.5 shrink-0 cursor-pointer rounded p-1 font-sans text-xs opacity-60 transition-opacity hover:opacity-100"
            >
              &#x2715;
            </button>
          </div>
        );
      })}
      {overflow > 0 && (
        <div
          aria-live="polite"
          className="self-end rounded-full px-2 py-0.5 font-sans text-[10px] font-semibold opacity-70"
          style={{
            backgroundColor: theme.surface,
            color: theme.text,
            border: `1px solid ${theme.textMuted}`,
          }}
        >
          +{overflow} more
        </div>
      )}
    </div>
  );
}
