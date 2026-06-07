/**
 * FlowRegimeBadge — small live "flow regime" recognition pill for the
 * Market Regime section. Phase 3 of
 * docs/superpowers/specs/flow-regime-badge-2026-06-06.md.
 *
 * RECOGNITION ONLY — surfaces "today's options flow is abnormal for this
 * time of day, as it forms" (useful for sizing / not fighting the tape).
 * It does NOT forecast direction: the 106-day point-in-time backtest
 * found options flow has no forward edge. The copy + aria-description say
 * so explicitly — no predictive language anywhere in this component.
 *
 * Self-fetching tile (mirrors PinSetupTile): consumes useFlowRegime and
 * renders the `latest` slot snapshot. Handles every state gracefully —
 * loading, error, no-data/pre-open (latest === null), normal/gray
 * (muted/neutral), and insufficient-baseline (null percentiles → the
 * metric is shown without a percentile claim).
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { useFlowRegime } from '../../hooks/useFlowRegime';
import {
  COLOR_MAP,
  REGIME_LABEL,
  RECOGNITION_NOTE,
  describeRegime,
} from './classify';

interface Props {
  readonly marketOpen: boolean;
}

export default memo(function FlowRegimeBadge({ marketOpen }: Props) {
  const { latest, loading, error } = useFlowRegime({ marketOpen });

  // ── Loading (nothing yet) ─────────────────────────────────────────────
  if (loading && latest == null) {
    return (
      <div
        className="text-tertiary py-2 font-sans text-[11px] italic"
        data-testid="flow-regime-loading"
      >
        Loading flow regime…
      </div>
    );
  }

  // ── Error (nothing to show) ──────────────────────────────────────────
  if (error && latest == null) {
    return (
      <div
        className="font-sans text-[11px]"
        style={{ color: theme.red }}
        role="alert"
      >
        {error}
      </div>
    );
  }

  // ── No data yet / pre-open ───────────────────────────────────────────
  if (latest == null) {
    return (
      <div
        className="text-muted font-sans text-[11px] italic"
        data-testid="flow-regime-empty"
      >
        No flow regime read yet — the first 30-min slot is captured after the
        open.
      </div>
    );
  }

  const color = COLOR_MAP[latest.color];
  const label = REGIME_LABEL[latest.regime];
  const detail = describeRegime(latest);
  // Screen-reader sentence carries color-independent meaning + the
  // recognition-not-forecast disclaimer, satisfying "color is never the
  // only signal".
  const ariaLabel = `Flow regime: ${label.toLowerCase()}. ${detail} ${RECOGNITION_NOTE}`;

  return (
    <div
      role="status"
      aria-label={ariaLabel}
      title={RECOGNITION_NOTE}
      data-testid="flow-regime-badge"
      className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5"
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            Flow Regime
          </div>
          <div className="text-muted font-sans text-[10px]">
            Recognition · not a forecast
          </div>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold tracking-[0.06em] whitespace-nowrap uppercase"
          style={{ backgroundColor: tint(color, '18'), color }}
          data-testid="flow-regime-pill"
        >
          {label}
        </span>
      </div>
      <p
        className="text-secondary m-0 font-sans text-[11px] leading-normal"
        data-testid="flow-regime-detail"
      >
        {detail}
      </p>
    </div>
  );
});
