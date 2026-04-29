/**
 * FlowChart — small SVG line chart for one cumulative Greek-flow series,
 * color-mapped by sign (red below zero, green above zero).
 *
 * Implementation mirrors the UW chart aesthetic from the Greek Flow
 * dashboard: a single line that flips color at the zero crossing, with
 * an explicit zero baseline drawn for context.
 *
 * Implementation notes:
 *   - Uses a linearGradient + stop offsets to color the path so the
 *     transition lands exactly at the zero crossing — splitting into two
 *     filtered paths visibly seams at the boundary.
 *   - Y-axis auto-scales to the union of (min, max, 0) so the zero line
 *     is always inside the chart even when cumulative is one-sided.
 *   - Width fills the parent via SVG viewBox; height is fixed.
 */

import { memo, useId, useMemo } from 'react';

interface FlowChartProps {
  /** Series of cumulative values, ordered by timestamp ascending. */
  values: number[];
  /** Optional fixed height override (SVG units). Default 60. */
  height?: number;
  /** ARIA label, e.g. "QQQ cumulative Dir Vega flow". */
  ariaLabel: string;
}

const VIEW_W = 200;
const PAD_X = 2;
const PAD_Y = 4;

function FlowChartInner({ values, height = 60, ariaLabel }: FlowChartProps) {
  const gradientId = useId();
  const layout = useMemo(() => {
    if (values.length < 2) return null;

    const minVal = Math.min(0, ...values);
    const maxVal = Math.max(0, ...values);
    const range = maxVal - minVal || 1;

    const innerH = height - PAD_Y * 2;
    const innerW = VIEW_W - PAD_X * 2;

    const xAt = (i: number) =>
      PAD_X + (i / Math.max(values.length - 1, 1)) * innerW;
    const yAt = (v: number) => PAD_Y + (1 - (v - minVal) / range) * innerH;

    // Path of the line itself
    const linePath = values
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`)
      .join(' ');

    // Y position of the zero baseline. Used both for the dashed
    // baseline rule and for the gradient stop offset (so red/green
    // switches exactly at zero rather than at some arbitrary midpoint).
    const yZero = yAt(0);
    // Stop offset for the gradient: 0 = top, 1 = bottom. Above the
    // zero line should be green, below should be red.
    const zeroOffset = (yZero - PAD_Y) / innerH;

    return { linePath, yZero, zeroOffset, minVal, maxVal };
  }, [values, height]);

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

  const { linePath, yZero, zeroOffset, minVal, maxVal } = layout;

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
