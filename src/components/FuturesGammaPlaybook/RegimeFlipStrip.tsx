/**
 * RegimeFlipStrip — compact "is the regime flickering?" glyph row.
 *
 * Renders the last N regime classifications from `regimeTimeline` as
 * small colored dots. Green = POSITIVE, amber = NEGATIVE,
 * muted gray = TRANSITIONING. Dots are ordered oldest → newest left-to-
 * right so the right edge of the row is the most recent classification,
 * and the eye naturally tracks the trend.
 *
 * Purpose: during chop days (Apr 21 2026 was the motivating example) the
 * regime may flicker between TRANSITIONING and a brief POSITIVE window.
 * This strip lets the trader see at a glance "regime flipped 3x in the
 * last hour — it's genuinely undecided" without having to read the full
 * RegimeTimeline chart below.
 *
 * Scope:
 *   - Not a trigger source — purely informational.
 *   - No color-blindness alternatives in v1 (noted for future).
 *   - No responsive / mobile-specific adjustments — the row of 12 small
 *     dots fits comfortably on all viewport widths we target.
 */

import { memo, useMemo } from 'react';
import { Tooltip } from '../ui/Tooltip.js';
import { getCTTime } from '../../utils/timezone.js';
import type { RegimeTimelinePoint } from '../../utils/futures-gamma/types.js';

export interface RegimeFlipStripProps {
  /**
   * Full timeline — this component picks the trailing `count` points and
   * renders them. Upstream is the hook's `regimeTimeline`.
   */
  timeline: RegimeTimelinePoint[];
  /** How many trailing dots to render. Defaults to 12 (~60 min at 5-min cadence). */
  count?: number;
}

const DEFAULT_COUNT = 12;

// Semantic colors that mirror `RegimeTimeline.tsx`'s palette — the
// strip is a zoomed-out glyph of that chart's regime band, so they
// should agree on color.
const REGIME_DOT_CLASS: Record<RegimeTimelinePoint['regime'], string> = {
  POSITIVE: 'bg-emerald-400',
  NEGATIVE: 'bg-amber-400',
  TRANSITIONING: 'bg-white/20',
};

const REGIME_LABEL: Record<RegimeTimelinePoint['regime'], string> = {
  POSITIVE: 'POSITIVE',
  NEGATIVE: 'NEGATIVE',
  TRANSITIONING: 'TRANSITIONING',
};

/**
 * Format an ISO instant as `HH:MM CT` for the dot tooltip. Leading zero
 * padding keeps tooltips legible even when hours / minutes are single-
 * digit.
 */
function fmtCt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const { hour, minute } = getCTTime(d);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${hh}:${mm} CT`;
}

export const RegimeFlipStrip = memo(function RegimeFlipStrip({
  timeline,
  count = DEFAULT_COUNT,
}: RegimeFlipStripProps) {
  const tail = useMemo(() => {
    if (timeline.length === 0) return [];
    const start = Math.max(0, timeline.length - count);
    return timeline.slice(start);
  }, [timeline, count]);

  if (tail.length === 0) {
    return (
      <div
        role="group"
        aria-label="Regime flip history"
        className="text-muted mb-2 flex items-center gap-2 font-mono text-[10px]"
      >
        <span className="tracking-wider uppercase">Regime strip</span>
        <span>— no intraday history yet.</span>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Regime flip history"
      className="text-muted mb-2 flex items-center gap-2 font-mono text-[10px]"
    >
      <span className="tracking-wider uppercase">Regime strip</span>
      <div className="flex items-center gap-1">
        {tail.map((point) => (
          <Tooltip
            key={point.ts}
            content={`${fmtCt(point.ts)} · ${REGIME_LABEL[point.regime]}`}
            side="top"
          >
            <span
              aria-label={`${REGIME_LABEL[point.regime]} at ${fmtCt(point.ts)}`}
              className={`inline-block h-[7px] w-[7px] rounded-full ${REGIME_DOT_CLASS[point.regime]}`}
            />
          </Tooltip>
        ))}
      </div>
    </div>
  );
});

export default RegimeFlipStrip;
