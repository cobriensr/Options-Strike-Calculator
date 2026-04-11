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

function formatPct(v: number | null): string {
  if (v === null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

// ── Sparkline ─────────────────────────────────────────────────────────

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
}

const Sparkline = memo(function Sparkline({ points }: SparklineProps) {
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
        width={SVG_W}
        height={SVG_H}
        aria-hidden="true"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <line
          x1={PAD_X}
          y1={midY}
          x2={SVG_W - PAD_X}
          y2={midY}
          stroke={theme.textMuted}
          strokeWidth={1}
          strokeDasharray="3 3"
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
  const lineColor = flat ? theme.textMuted : rising ? theme.green : theme.red;

  return (
    <svg
      width={SVG_W}
      height={SVG_H}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={lineColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {valid.map((p, i) => (
        <circle
          key={i}
          cx={toX(p.minutesAgo)}
          cy={toY(p.value)}
          r={DOT_R}
          fill={lineColor}
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
  // Sort the shared strike universe by |20m % change| descending so the
  // highest-momentum strikes appear first.
  const top5 = useMemo(
    () =>
      [...leaderboard].sort(
        (a, b) =>
          Math.abs(b.features.deltaPct_20m ?? 0) -
          Math.abs(a.features.deltaPct_20m ?? 0),
      ),
    [leaderboard],
  );

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
            // Only the three 5-minute-grid snapshots within the 20-min window.
            // Null entries (early session, data unavailable) are filtered out
            // so the sparkline always draws between real measurements.
            const pts: SparklinePoint[] = (
              [
                { value: features.prevGexDollars_20m, minutesAgo: 20 },
                { value: features.prevGexDollars_5m, minutesAgo: 5 },
                { value: features.gexDollars, minutesAgo: 0 },
              ] as { value: number | null; minutesAgo: number }[]
            ).filter((p): p is SparklinePoint => p.value !== null);

            const pct20m = features.deltaPct_20m;
            const pctColor =
              pct20m === null
                ? theme.textMuted
                : pct20m >= 0
                  ? theme.green
                  : theme.red;

            return (
              <div
                key={s.strike}
                className="flex items-center gap-2"
                aria-label={`Strike ${s.strike}`}
              >
                {/* Strike label */}
                <span
                  className="w-[36px] shrink-0 font-mono text-[11px]"
                  style={{ color: theme.textSecondary }}
                >
                  {s.strike}
                </span>

                {/* Sparkline */}
                <Sparkline points={pts} />

                {/* 20m % change */}
                <span
                  className="ml-auto font-mono text-[10px]"
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
