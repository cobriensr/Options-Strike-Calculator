/**
 * TickerNetFlowChart — small SVG chart for one ticker's cumulative
 * net call premium (green) + net put premium (red) over the trading
 * day, with a CT time axis at the bottom and an optional vertical
 * fire-time marker.
 *
 * Mirrors the FlowChart pattern (hand-rolled SVG, viewBox-driven).
 * The two cumulative lines share a common 0-pinned y-axis so the
 * relative call-vs-put balance is legible at a glance — call line
 * climbing while put line stays flat = bullish flow regime; both
 * climbing = balanced; both flat ≈ the plateau pattern the spec
 * Phase 3 detector watches for.
 */

import { memo, useMemo } from 'react';
import type { NetFlowTick } from './types.js';

interface TickerNetFlowChartProps {
  /** Per-tick rows with cumNcp / cumNpp populated. */
  series: NetFlowTick[];
  /** Optional fire-time marker (UTC ISO). Renders a vertical purple line. */
  markerTs?: string;
  /** Fixed height override (SVG units). Default 110. */
  height?: number;
  ariaLabel: string;
}

const VIEW_W = 200;
const PAD_X = 4;
const PAD_Y = 4;
/** Bottom band reserved for CT time labels (SVG units). */
const AXIS_H = 12;

const formatHM = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

const formatPremiumShort = (n: number): string => {
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

function TickerNetFlowChartInner({
  series,
  markerTs,
  height = 110,
  ariaLabel,
}: TickerNetFlowChartProps) {
  const layout = useMemo(() => {
    if (series.length < 2) return null;

    const tsMs = series.map((r) => Date.parse(r.ts));
    const tsMin = tsMs[0]!;
    const tsMax = tsMs[tsMs.length - 1]!;
    const tsRange = tsMax - tsMin || 1;

    // Y-scale: pinned to 0 so both signs of net flow are visible.
    const allCums = series.flatMap((r) => [r.cumNcp, r.cumNpp]);
    const minVal = Math.min(0, ...allCums);
    const maxVal = Math.max(0, ...allCums);
    const range = maxVal - minVal || 1;

    const innerH = height - PAD_Y * 2 - AXIS_H;
    const innerW = VIEW_W - PAD_X * 2;

    const xAt = (ms: number) => PAD_X + ((ms - tsMin) / tsRange) * innerW;
    const yAt = (v: number) => PAD_Y + (1 - (v - minVal) / range) * innerH;

    const ncpPath = series
      .map((r, i) => {
        const cmd = i === 0 ? 'M' : 'L';
        return `${cmd} ${xAt(tsMs[i]!).toFixed(2)} ${yAt(r.cumNcp).toFixed(2)}`;
      })
      .join(' ');

    const nppPath = series
      .map((r, i) => {
        const cmd = i === 0 ? 'M' : 'L';
        return `${cmd} ${xAt(tsMs[i]!).toFixed(2)} ${yAt(r.cumNpp).toFixed(2)}`;
      })
      .join(' ');

    const markerX =
      markerTs != null
        ? (() => {
            const m = Date.parse(markerTs);
            // Clamp into the chart so an out-of-window marker doesn't
            // disappear silently.
            const clamped = Math.max(tsMin, Math.min(tsMax, m));
            return xAt(clamped);
          })()
        : null;

    const yZero = yAt(0);

    const axisLabels = [
      { x: PAD_X, anchor: 'start' as const, text: formatHM(tsMin) },
      {
        x: VIEW_W / 2,
        anchor: 'middle' as const,
        text: formatHM((tsMin + tsMax) / 2),
      },
      { x: VIEW_W - PAD_X, anchor: 'end' as const, text: formatHM(tsMax) },
    ];
    const axisLabelY = PAD_Y + innerH + AXIS_H * 0.75;

    return {
      ncpPath,
      nppPath,
      markerX,
      yZero,
      minVal,
      maxVal,
      axisLabels,
      axisLabelY,
      plotBottom: PAD_Y + innerH,
    };
  }, [series, markerTs, height]);

  if (layout == null) {
    return (
      <div
        className="font-mono text-[9px] text-neutral-500"
        aria-label={ariaLabel}
      >
        waiting for ≥2 net-flow ticks
      </div>
    );
  }

  const {
    ncpPath,
    nppPath,
    markerX,
    yZero,
    minVal,
    maxVal,
    axisLabels,
    axisLabelY,
    plotBottom,
  } = layout;

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      className="block w-full"
      role="img"
      aria-label={ariaLabel}
    >
      {/* Zero baseline. */}
      <line
        x1={PAD_X}
        x2={VIEW_W - PAD_X}
        y1={yZero}
        y2={yZero}
        stroke="rgb(64, 64, 64)"
        strokeWidth={0.5}
        strokeDasharray="2 2"
      />

      {/* Plot baseline (bottom of plot area, above axis labels). */}
      <line
        x1={PAD_X}
        x2={VIEW_W - PAD_X}
        y1={plotBottom}
        y2={plotBottom}
        stroke="rgb(38, 38, 38)"
        strokeWidth={0.5}
      />

      {/* Net Put Premium — red. */}
      <path
        d={nppPath}
        fill="none"
        stroke="rgb(248, 113, 113)"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />

      {/* Net Call Premium — green. */}
      <path
        d={ncpPath}
        fill="none"
        stroke="rgb(52, 211, 153)"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />

      {/* Right-edge corner labels for the y-range. Each side is
          suppressed at zero so we don't show "+$0" floating in a
          corner on a flow-quiet day. */}
      {maxVal > 0 && (
        <text
          x={VIEW_W - PAD_X}
          y={PAD_Y + 5}
          textAnchor="end"
          fill="rgb(115, 115, 115)"
          fontSize={6}
          fontFamily="ui-monospace, monospace"
        >
          {formatPremiumShort(maxVal)}
        </text>
      )}
      {minVal < 0 && (
        <text
          x={VIEW_W - PAD_X}
          y={plotBottom - 1}
          textAnchor="end"
          fill="rgb(115, 115, 115)"
          fontSize={6}
          fontFamily="ui-monospace, monospace"
        >
          {formatPremiumShort(minVal)}
        </text>
      )}

      {/* Fire-time vertical marker — purple, dashed. */}
      {markerX != null && (
        <line
          x1={markerX}
          x2={markerX}
          y1={PAD_Y}
          y2={plotBottom}
          stroke="rgb(196, 181, 253)"
          strokeWidth={0.8}
          strokeDasharray="3 2"
        />
      )}

      {/* CT time axis. */}
      {axisLabels.map((l) => (
        <text
          key={l.text}
          x={l.x}
          y={axisLabelY}
          textAnchor={l.anchor}
          fill="rgb(115, 115, 115)"
          fontSize={6}
          fontFamily="ui-monospace, monospace"
        >
          {l.text}
        </text>
      ))}
    </svg>
  );
}

export const TickerNetFlowChart = memo(TickerNetFlowChartInner);
