/**
 * FlowChart — small SVG line chart for one cumulative Greek-flow series,
 * color-mapped by sign (red below zero, green above zero), with an
 * optional grey underlying-price overlay on a separate y-axis.
 *
 * Mirrors the UW Greek Flow dashboard aesthetic: each panel shows the
 * cumulative greek (sign-colored, axis on right) plus the underlying
 * ETF price (slate grey, independent scale) so flow vs price action are
 * legible at a glance.
 *
 * Implementation notes:
 *   - Uses a linearGradient + stop offsets to color the active path so
 *     the transition lands exactly at the zero crossing.
 *   - Active y-axis is auto-scaled to (min, max, 0) so the zero baseline
 *     is always inside the chart even when cumulative is one-sided.
 *   - Price y-axis is independent: scaled to its own min/max with a
 *     small pad so it doesn't kiss the chart edges. Nullable values are
 *     allowed (path breaks at gaps).
 *   - Width fills the parent via SVG viewBox; height is fixed.
 */

import { memo, useId, useMemo } from 'react';

interface FlowChartProps {
  /** Active series (cumulative, sign-colored). */
  values: number[];
  /**
   * Optional underlying ETF price series. Same length as `values`,
   * timestamp-aligned. Null entries break the line at that gap.
   */
  priceValues?: (number | null)[];
  /** Optional fixed height override (SVG units). Default 60. */
  height?: number;
  /** ARIA label, e.g. "QQQ cumulative OTM Dir Delta". */
  ariaLabel: string;
}

const VIEW_W = 200;
const PAD_X = 2;
const PAD_Y = 4;
// Inset price line a little so it doesn't kiss the top/bottom edges.
const PRICE_PAD_RATIO = 0.08;

function FlowChartInner({
  values,
  priceValues,
  height = 60,
  ariaLabel,
}: FlowChartProps) {
  const gradientId = useId();
  const layout = useMemo(() => {
    if (values.length < 2) return null;

    // Active series y-scale: 0-pinned so the zero baseline is in frame.
    const minVal = Math.min(0, ...values);
    const maxVal = Math.max(0, ...values);
    const range = maxVal - minVal || 1;

    const innerH = height - PAD_Y * 2;
    const innerW = VIEW_W - PAD_X * 2;

    const xAt = (i: number, n: number) =>
      PAD_X + (i / Math.max(n - 1, 1)) * innerW;
    const yAt = (v: number) => PAD_Y + (1 - (v - minVal) / range) * innerH;

    const linePath = values
      .map(
        (v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i, values.length)} ${yAt(v)}`,
      )
      .join(' ');

    // Price series y-scale: independent of the active scale so the price
    // line uses the full vertical real estate. Nullable values break the
    // path with a Move command instead of Line.
    let pricePath: string | null = null;
    if (priceValues && priceValues.length >= 2) {
      const finitePrices = priceValues.filter(
        (p): p is number => p != null && Number.isFinite(p),
      );
      if (finitePrices.length >= 2) {
        const rawMin = Math.min(...finitePrices);
        const rawMax = Math.max(...finitePrices);
        const rawRange = rawMax - rawMin || 1;
        const pad = rawRange * PRICE_PAD_RATIO;
        const minPrice = rawMin - pad;
        const maxPrice = rawMax + pad;
        const priceRange = maxPrice - minPrice || 1;
        const yAtPrice = (p: number) =>
          PAD_Y + (1 - (p - minPrice) / priceRange) * innerH;

        const segs: string[] = [];
        let inSegment = false;
        priceValues.forEach((p, i) => {
          if (p == null || !Number.isFinite(p)) {
            inSegment = false;
            return;
          }
          const cmd = inSegment ? 'L' : 'M';
          segs.push(
            `${cmd} ${xAt(i, priceValues.length).toFixed(2)} ${yAtPrice(p).toFixed(2)}`,
          );
          inSegment = true;
        });
        pricePath = segs.length > 0 ? segs.join(' ') : null;
      }
    }

    const yZero = yAt(0);
    const zeroOffset = (yZero - PAD_Y) / innerH;

    return { linePath, pricePath, yZero, zeroOffset, minVal, maxVal };
  }, [values, priceValues, height]);

  if (layout == null) {
    return (
      <div
        className="text-secondary font-mono text-[9px]"
        aria-label={ariaLabel}
      >
        waiting for ≥2 points
      </div>
    );
  }

  const { linePath, pricePath, yZero, zeroOffset, minVal, maxVal } = layout;

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      className="block w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset={`${(zeroOffset * 100).toFixed(2)}%`}
            stopColor="rgb(52, 211, 153)"
          />
          <stop
            offset={`${(zeroOffset * 100).toFixed(2)}%`}
            stopColor="rgb(248, 113, 113)"
          />
        </linearGradient>
      </defs>
      {/* Zero baseline */}
      <line
        x1={PAD_X}
        x2={VIEW_W - PAD_X}
        y1={yZero}
        y2={yZero}
        stroke="currentColor"
        strokeWidth={0.5}
        strokeDasharray="2 2"
        className="text-secondary opacity-50"
      />
      {pricePath != null && (
        <path
          d={pricePath}
          fill="none"
          stroke="rgb(148, 163, 184)"
          strokeOpacity={0.55}
          strokeWidth={1.0}
        />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={1.25}
      />
      <text
        x={VIEW_W - PAD_X}
        y={PAD_Y + 6}
        textAnchor="end"
        className="fill-current font-mono text-[7px] opacity-60"
      >
        max {fmtCompact(maxVal)}
      </text>
      <text
        x={VIEW_W - PAD_X}
        y={height - 1}
        textAnchor="end"
        className="fill-current font-mono text-[7px] opacity-60"
      >
        min {fmtCompact(minVal)}
      </text>
    </svg>
  );
}

/**
 * Compact number formatter for axis labels. Cumulative Greek flow values
 * range from ~1e2 to ~1e7+ — Intl `compactDisplay` short-form keeps the
 * label legible without per-magnitude branching.
 */
function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
}

export const FlowChart = memo(FlowChartInner);
