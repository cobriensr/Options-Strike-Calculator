/**
 * SparklinePanel — Panel 3: 20-minute GEX trajectory sparklines.
 *
 * Shows a GEX trajectory for the top-5 strikes over the last 20 minutes.
 * Points: [prev20m, prev5m, current] — the three 5-minute-grid snapshots
 * we store. Each point is positioned at its correct proportional x-position
 * on a 20-minute time axis so the visual slope matches the actual rate of
 * change. Missing points (null/early-session) are skipped; fewer than 2
 * valid points renders a flat dash.
 */

import { memo, useMemo } from 'react';
import { SectionBox } from '../ui';
import { theme } from '../../themes';
import type { StrikeScore } from '../../utils/gex-target';

// ── Formatters ────────────────────────────────────────────────────────

/**
 * Compact percent formatter for the sparkline row. Drops the decimal
 * once magnitude is >= 100% so big sign-flip deltas (e.g. -876% from a
 * near-zero prior) fit in the cell without pushing the sparkline SVG
 * around. Below 100%, keep one decimal for fine-grained intraday reads.
 */
function formatPct(v: number | null): string {
  if (v === null) return '—';
  const pct = v * 100;
  const abs = Math.abs(pct);
  const sign = pct < 0 ? '-' : '+';
  if (abs >= 1000) {
    // Cap the display at >999% so the cell width never blows out even
    // when the prior was effectively zero and divided into.
    return `${sign}>999%`;
  }
  return abs >= 100 ? `${sign}${abs.toFixed(0)}%` : `${sign}${abs.toFixed(1)}%`;
}

// ── Sparkline ─────────────────────────────────────────────────────────

// SVG_W is the viewBox width (coordinate space). The rendered SVG uses
// width="100%" + preserveAspectRatio="none" so it stretches to fill the
// remaining flex space in the row — keeping the 20-min-wide sparkline
// from forcing the % label off the right edge of the 200px sidebar.
const SVG_W = 88;
const SVG_H = 24;
const PAD_X = 4;
const PAD_Y = 3;
const DOT_R = 1.5;
const WINDOW_MINUTES = 20;

/** A GEX value at a specific time offset from the current snapshot. */
interface SparklinePoint {
  value: number;
  /** Minutes before the current snapshot (0 = current, 5 = prev5m, 20 = prev20m). */
  minutesAgo: number;
}

interface SparklineProps {
  points: SparklinePoint[];
  /** Explicit line color — overrides the internal rising/falling computation.
   * Use when an external signal (e.g. deltaPct_20m sign) is more authoritative
   * than comparing the raw GEX$ values (which may be recalculated via JOIN). */
  colorOverride?: string;
}

const Sparkline = memo(function Sparkline({
  points,
  colorOverride,
}: SparklineProps) {
  // Only keep points with real values; sort oldest-first for correct drawing order.
  const valid = useMemo(
    () => [...points].sort((a, b) => b.minutesAgo - a.minutesAgo),
    [points],
  );

  if (valid.length < 2) {
    // Not enough data — flat dash
    const midY = SVG_H / 2;
    return (
      <svg
        width="100%"
        height={SVG_H}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ display: 'block' }}
      >
        <line
          x1={PAD_X}
          y1={midY}
          x2={SVG_W - PAD_X}
          y2={midY}
          stroke={theme.textMuted}
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  const values = valid.map((p) => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1; // avoid div/0 for flat lines

  const drawW = SVG_W - PAD_X * 2;
  const drawH = SVG_H - PAD_Y * 2;

  // Time-proportional x: oldest point (minutesAgo=WINDOW_MINUTES) at left edge,
  // current (minutesAgo=0) at right edge.
  const toX = (minutesAgo: number) =>
    PAD_X + ((WINDOW_MINUTES - minutesAgo) / WINDOW_MINUTES) * drawW;
  const toY = (v: number) => PAD_Y + drawH - ((v - minVal) / range) * drawH;

  const pts = valid
    .map((p) => `${toX(p.minutesAgo).toFixed(1)},${toY(p.value).toFixed(1)}`)
    .join(' ');

  const first = valid[0]!.value;
  const last = valid.at(-1)!.value;
  const rising = last > first;
  const flat = last === first;
  const computedColor = flat
    ? theme.textMuted
    : rising
      ? theme.green
      : theme.red;
  // colorOverride wins when provided — callers should pass the deltaPct sign
  // so the line color always agrees with the % label, even when the current
  // gexDollars value has been recalculated via a JOIN and drifted from what
  // deltaPct_20m was computed against.
  const lineColor = colorOverride ?? computedColor;

  return (
    <svg
      width="100%"
      height={SVG_H}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={lineColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {valid.map((p, i) => (
        <circle
          key={i}
          cx={toX(p.minutesAgo)}
          cy={toY(p.value)}
          r={DOT_R}
          fill={lineColor}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
});

// ── SparklinePanel ────────────────────────────────────────────────────

export interface SparklinePanelProps {
  leaderboard: StrikeScore[];
}

export const SparklinePanel = memo(function SparklinePanel({
  leaderboard,
}: SparklinePanelProps) {
  // Sort ascending by strike so the panel reads like a price ladder,
  // consistent with UrgencyPanel: lowest strike at top, highest at bottom.
  const top5 = useMemo(
    () => [...leaderboard].sort((a, b) => a.strike - b.strike),
    [leaderboard],
  );

  const spot = leaderboard[0]?.features.spot ?? 0;
  const atmStrike = useMemo(() => {
    if (!top5.length || spot === 0) return null;
    return top5.reduce((best, s) =>
      Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best,
    ).strike;
  }, [top5, spot]);

  return (
    <SectionBox label="20-MIN SPARKLINES">
      {top5.length === 0 ? (
        <p className="font-mono text-[11px]" style={{ color: theme.textMuted }}>
          No data
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {top5.map((s) => {
            const { features } = s;
            // All five 5-minute-grid snapshots within the 20-min window.
            // Null entries (early session, data unavailable) are filtered out
            // so the sparkline always draws between real measurements.
            //
            // The "current" point is reconstructed from the stored delta
            // (prevGexDollars_5m + deltaGex_5m) rather than reading
            // gexDollars directly. The API recalculates gexDollars via a
            // JOIN against current OI, which can drift from the scale used
            // when prevGexDollars_* were stored — making the visual slope
            // wrong. The stored delta is always on the same scale as the
            // prior values, so the reconstructed current is correct.
            const reconstructedCurrent =
              features.prevGexDollars_5m !== null &&
              features.deltaGex_5m !== null
                ? features.prevGexDollars_5m + features.deltaGex_5m
                : features.gexDollars;
            const pts: SparklinePoint[] = (
              [
                { value: features.prevGexDollars_20m, minutesAgo: 20 },
                { value: features.prevGexDollars_15m, minutesAgo: 15 },
                { value: features.prevGexDollars_10m, minutesAgo: 10 },
                { value: features.prevGexDollars_5m, minutesAgo: 5 },
                { value: reconstructedCurrent, minutesAgo: 0 },
              ] as { value: number | null; minutesAgo: number }[]
            ).filter((p): p is SparklinePoint => p.value !== null);

            const pct20m = features.deltaPct_20m;
            const pctColor =
              pct20m === null
                ? theme.textMuted
                : pct20m >= 0
                  ? theme.green
                  : theme.red;

            const isAtm = s.strike === atmStrike;
            return (
              <div
                key={s.strike}
                className={`-mx-1 flex items-center gap-2 rounded px-1 ${isAtm ? 'bg-sky-500/10' : ''}`}
                aria-label={`Strike ${s.strike}`}
              >
                {/* Strike label */}
                <span
                  className="w-[36px] shrink-0 font-mono text-[11px]"
                  style={{ color: isAtm ? '#7dd3fc' : theme.textSecondary }}
                >
                  {s.strike}
                </span>

                {/* Sparkline — pass pct20m color so line direction agrees with
                    the % label even when gexDollars has drifted from the value
                    that deltaPct_20m was computed against (JOIN recalculation).
                    Wrapped in a min-w-0 flex-1 container so the SVG stretches
                    to fill leftover row width instead of overflowing the 200px
                    sidebar. */}
                <div className="min-w-0 flex-1">
                  <Sparkline
                    points={pts}
                    colorOverride={pct20m !== null ? pctColor : undefined}
                  />
                </div>

                {/* 20m % change. Fixed-width + right-aligned so long
                    values (e.g. -876%, >999% cap) don't push the
                    sparkline left and shift the column layout across
                    rows. min-w sized to fit the widest realistic
                    label without truncation. */}
                <span
                  className="min-w-[48px] shrink-0 text-right font-mono text-[10px] tabular-nums"
                  style={{ color: pctColor }}
                >
                  {formatPct(pct20m)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </SectionBox>
  );
});
