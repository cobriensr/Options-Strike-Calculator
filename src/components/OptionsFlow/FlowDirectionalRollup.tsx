/**
 * FlowDirectionalRollup — one-row summary of bull/bear flow within the
 * options-flow window. Sits directly above `OptionsFlowTable`.
 *
 * Shows:
 *   - A large lean badge (BULLISH / BEARISH / NEUTRAL) color-coded green /
 *     red / slate with a confidence percentage.
 *   - Side-by-side bullish vs bearish counts and premium totals.
 *   - Top bullish and bearish strike references (mono text) when present.
 *
 * Edge cases:
 *   - `spot === null`          → "No spot data" muted message
 *   - `alertCount === 0`       → "No alerts in window" muted message
 *
 * Pure presentational, no hooks, no fetch.
 */

import type { DirectionalRollup } from '../../hooks/useOptionsFlow';

// ============================================================
// TYPES
// ============================================================

export interface FlowDirectionalRollupProps {
  rollup: DirectionalRollup;
  spot: number | null;
  alertCount: number;
  className?: string;
}

// ============================================================
// FORMATTERS
// ============================================================

function formatPremium(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

// ============================================================
// MAIN
// ============================================================

export function FlowDirectionalRollup({
  rollup,
  spot,
  alertCount,
  className,
}: FlowDirectionalRollupProps) {
  const hasAlerts = alertCount > 0;
  const hasSpot = spot !== null;

  const leanMeta =
    rollup.lean === 'bullish'
      ? {
          label: 'BULLISH',
          icon: '▲',
          badgeClass:
            'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
        }
      : rollup.lean === 'bearish'
        ? {
            label: 'BEARISH',
            icon: '▼',
            badgeClass: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
          }
        : {
            label: 'NEUTRAL',
            icon: '●',
            badgeClass: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
          };

  const confidencePct = Math.round(
    Math.max(0, Math.min(1, rollup.confidence)) * 100,
  );

  return (
    <div
      className={`border-edge bg-surface flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${className ?? ''}`}
      role="status"
      aria-label="Options flow directional rollup"
    >
      {/* Lean badge */}
      <div
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11px] font-bold tracking-wider ${leanMeta.badgeClass}`}
      >
        <span aria-hidden="true" className="font-mono text-[11px]">
          {leanMeta.icon}
        </span>
        <span>{leanMeta.label}</span>
        <span
          className="text-muted/80 ml-1 font-mono text-[10px]"
          aria-label={`Confidence ${confidencePct}%`}
        >
          {confidencePct}%
        </span>
      </div>

      {!hasSpot && (
        <span className="text-muted font-sans text-[11px] italic">
          No spot data
        </span>
      )}

      {hasSpot && !hasAlerts && (
        <span className="text-muted font-sans text-[11px] italic">
          No alerts in window
        </span>
      )}

      {hasSpot && hasAlerts && (
        <>
          <div className="flex items-center gap-1.5 font-mono text-[11px]">
            <span className="text-emerald-400">
              {rollup.bullish_count} bullish
            </span>
            <span className="text-muted">
              ({formatPremium(rollup.bullish_premium)})
            </span>
          </div>

          <span className="text-edge" aria-hidden="true">
            │
          </span>

          <div className="flex items-center gap-1.5 font-mono text-[11px]">
            <span className="text-rose-400">
              {rollup.bearish_count} bearish
            </span>
            <span className="text-muted">
              ({formatPremium(rollup.bearish_premium)})
            </span>
          </div>

          {(rollup.top_bullish_strike !== null ||
            rollup.top_bearish_strike !== null) && (
            <div className="ml-auto flex items-center gap-2 font-mono text-[10px]">
              <span className="text-muted">top:</span>
              {rollup.top_bullish_strike !== null && (
                <span className="text-emerald-400">
                  {rollup.top_bullish_strike.toLocaleString()}C
                </span>
              )}
              {rollup.top_bullish_strike !== null &&
                rollup.top_bearish_strike !== null && (
                  <span className="text-edge" aria-hidden="true">
                    │
                  </span>
                )}
              {rollup.top_bearish_strike !== null && (
                <span className="text-rose-400">
                  {rollup.top_bearish_strike.toLocaleString()}P
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
