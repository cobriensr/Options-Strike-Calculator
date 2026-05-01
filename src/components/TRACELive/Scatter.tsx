/**
 * Scatter — predicted-vs-actual close scatterplot for the TRACE Live
 * calibration panel.
 *
 * Both axes share the same [lo, hi] range so the dashed y=x diagonal
 * remains a valid "perfect prediction" reference. Do NOT split sx/sy
 * ranges without revisiting the diagonal.
 *
 * Pure presentational component: takes the resolved scatter points and
 * the regime → color mapping; emits SVG. No data fetching, no state.
 */

import { theme } from '../../themes';
import { niceTicks } from '../../utils/calibration-stats';

export interface ScatterPoint {
  id: number;
  capturedAt: string;
  regime: string;
  predicted: number;
  actual: number;
  residual: number;
}

interface ScatterProps {
  scatter: ScatterPoint[];
  regimeColors: Record<string, string>;
  formatRegime: (r: string) => string;
  formatNum: (n: number | null, digits?: number) => string;
}

export function Scatter({
  scatter,
  regimeColors,
  formatRegime,
  formatNum,
}: ScatterProps) {
  const xs = scatter.flatMap((p) => [p.predicted, p.actual]);
  const minV = Math.min(...xs);
  const maxV = Math.max(...xs);
  const margin = maxV > minV ? (maxV - minV) * 0.05 : 10;
  const lo = minV - margin;
  const hi = maxV + margin;
  const w = 800;
  const h = 360;
  const padL = 56;
  const padB = 36;
  const padT = 12;
  const padR = 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const sx = (v: number) => padL + ((v - lo) / (hi - lo)) * plotW;
  const sy = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  const ticks = niceTicks(lo, hi, 6);
  const residuals = scatter.map((p) => p.actual - p.predicted);
  const minRes = Math.min(...residuals);
  const maxRes = Math.max(...residuals);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-labelledby="cal-title cal-desc"
    >
      <title id="cal-title">Predicted vs actual close scatter</title>
      <desc id="cal-desc">
        {scatter.length} resolved capture{scatter.length === 1 ? '' : 's'};
        residuals range from {minRes.toFixed(1)} to {maxRes.toFixed(1)} points.
        Diagonal indicates perfect prediction; points colored by regime.
      </desc>
      {/* Gridlines at tick positions */}
      {ticks.map((t) => (
        <g key={`grid-${t}`}>
          <line
            x1={sx(t)}
            y1={padT}
            x2={sx(t)}
            y2={padT + plotH}
            stroke={theme.border}
            strokeWidth={0.5}
            opacity={0.4}
          />
          <line
            x1={padL}
            y1={sy(t)}
            x2={padL + plotW}
            y2={sy(t)}
            stroke={theme.border}
            strokeWidth={0.5}
            opacity={0.4}
          />
        </g>
      ))}
      {/* Plot box */}
      <rect
        x={padL}
        y={padT}
        width={plotW}
        height={plotH}
        fill="none"
        stroke={theme.border}
        strokeWidth={0.75}
      />
      {/* Diagonal y=x (perfect prediction) */}
      <line
        x1={sx(lo)}
        y1={sy(lo)}
        x2={sx(hi)}
        y2={sy(hi)}
        stroke={theme.textTertiary}
        strokeDasharray="4 4"
        strokeWidth={1}
      />
      {/* X-axis tick labels */}
      {ticks.map((t) => (
        <text
          key={`xt-${t}`}
          x={sx(t)}
          y={padT + plotH + 14}
          textAnchor="middle"
          fontSize="10"
          fill={theme.textMuted}
          fontFamily="ui-monospace, monospace"
        >
          {Math.round(t)}
        </text>
      ))}
      {/* Y-axis tick labels */}
      {ticks.map((t) => (
        <text
          key={`yt-${t}`}
          x={padL - 6}
          y={sy(t) + 3}
          textAnchor="end"
          fontSize="10"
          fill={theme.textMuted}
          fontFamily="ui-monospace, monospace"
        >
          {Math.round(t)}
        </text>
      ))}
      {/* Axis titles */}
      <text
        x={padL + plotW / 2}
        y={h - 6}
        textAnchor="middle"
        fontSize="11"
        fill={theme.textMuted}
      >
        predicted close
      </text>
      <text
        x={14}
        y={padT + plotH / 2}
        textAnchor="middle"
        fontSize="11"
        fill={theme.textMuted}
        transform={`rotate(-90 14 ${padT + plotH / 2})`}
      >
        actual close
      </text>
      {/* Data points */}
      {scatter.map((p) => (
        <circle
          key={p.id}
          cx={sx(p.predicted)}
          cy={sy(p.actual)}
          r={3.5}
          fill={regimeColors[p.regime] ?? theme.textTertiary}
          opacity={0.85}
          stroke={theme.bg}
          strokeWidth={0.5}
        >
          <title>
            {formatRegime(p.regime)} — predicted {p.predicted.toFixed(2)},
            actual {p.actual.toFixed(2)} (residual{' '}
            {formatNum(p.actual - p.predicted, 2)})
          </title>
        </circle>
      ))}
    </svg>
  );
}
