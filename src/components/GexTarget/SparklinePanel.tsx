/**
 * SparklinePanel — Panel 3: 20-minute GEX trajectory sparklines.
 *
 * Shows a 5-point GEX trajectory for the top-5 strikes on the leaderboard.
 * Points: [prev60m, prev20m, prev5m, prev1m, current]. Earlier points are
 * dropped if null (early-session). At least [prev1m, current] must be
 * non-null to show a sparkline; otherwise renders a flat dash.
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

interface SparklineProps {
  points: (number | null)[];
}

const Sparkline = memo(function Sparkline({ points }: SparklineProps) {
  // Filter to longest non-null suffix
  const suffix = useMemo(() => {
    let start = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i] !== null) {
        start = i;
        break;
      }
    }
    return points.slice(start).filter((p): p is number => p !== null);
  }, [points]);

  if (suffix.length < 2) {
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

  const minVal = Math.min(...suffix);
  const maxVal = Math.max(...suffix);
  const range = maxVal - minVal || 1; // avoid div/0 for flat lines

  const drawW = SVG_W - PAD_X * 2;
  const drawH = SVG_H - PAD_Y * 2;

  const toX = (i: number) => PAD_X + (i / (suffix.length - 1)) * drawW;
  const toY = (v: number) => PAD_Y + drawH - ((v - minVal) / range) * drawH;

  const pts = suffix
    .map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(' ');

  const first = suffix[0] ?? 0;
  const last = suffix.at(-1) ?? 0;
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
      {suffix.map((v, i) => (
        <circle key={i} cx={toX(i)} cy={toY(v)} r={DOT_R} fill={lineColor} />
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
  const top5 = leaderboard.slice(0, 5);

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
            const pts: (number | null)[] = [
              features.prevGexDollars_60m,
              features.prevGexDollars_20m,
              features.prevGexDollars_5m,
              features.prevGexDollars_1m,
              features.gexDollars,
            ];

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
