/**
 * GexMigration — tracks how per-strike 0DTE GEX migrates minute-by-minute
 * to identify where price is being magnetically pulled by dealer hedging.
 *
 * Primary use case: directional-buy signal generation. Find the strike
 * with the fastest-growing positive gamma closest to spot, then buy a
 * cheap OTM option and profit as price drifts toward the magnet.
 *
 * Layout:
 *   - Header with OI/VOL/DIR toggle (mirrors GexPerStrike)
 *   - Target strike tile (big numeric headline + 4-cell grid)
 *   - All-strikes 5-min urgency leaderboard (horizontal bars)
 *   - Migration sparklines (last 20 min) for top 5 movers
 *   - Gamma centroid drift tile (20-min sparkline + pts delta)
 */

import { memo, useMemo, useState } from 'react';
import { theme } from '../../themes';
import { SectionBox } from '../ui';
import {
  computeMigration,
  type GexMode,
  type GexSnapshot,
  type SignalConfidence,
  type StrikeMigration,
  type TargetStrike,
} from '../../utils/gex-migration';

// ── Constants ────────────────────────────────────────────

const URGENCY_LEADERBOARD_SIZE = 5;
const SPARKLINE_LEADERBOARD_SIZE = 5;
const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 28;
const CENTROID_SPARKLINE_WIDTH = 200;
const CENTROID_SPARKLINE_HEIGHT = 36;

/**
 * Short inline descriptions shown as the active-mode caption at the top
 * of the panel. Same text is used for the toggle button `title` tooltips
 * so hover previews for the OTHER modes match what you'd see after clicking.
 *
 * These are the "what is this and when do I use it" reminders — intentionally
 * written for real-time trading recall, not as comprehensive docs.
 */
const MODE_DESCRIPTIONS: Record<GexMode, string> = {
  oi: "standing dealer inventory — slow structural magnet, best for end-of-day pins",
  vol: "today's fresh volume — fast flow view, best for building intraday magnets",
  dir: 'directionalized MM bid/ask split — shows which side is pushing',
};

interface Props {
  snapshots: GexSnapshot[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

// ── Formatters ───────────────────────────────────────────

function formatPct(pct: number | null): string {
  if (pct == null) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}%`;
}

function formatDistance(dist: number): string {
  if (Math.abs(dist) < 0.5) return '0pts';
  const sign = dist > 0 ? '+' : '';
  return `${sign}${dist.toFixed(0)}pts`;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return '';
  }
}

function confidenceColor(conf: SignalConfidence): string {
  if (conf === 'HIGH') return theme.green;
  if (conf === 'MEDIUM') return theme.caution;
  if (conf === 'LOW') return theme.textMuted;
  return theme.textMuted;
}

function confidenceArrow(conf: SignalConfidence): string {
  if (conf === 'HIGH') return '\u2191\u2191';
  if (conf === 'MEDIUM') return '\u2191';
  if (conf === 'LOW') return '\u2192';
  return '';
}

function signColor(pct: number | null): string {
  if (pct == null || pct === 0) return theme.textMuted;
  return pct > 0 ? theme.green : theme.red;
}

// ── Sub-components ───────────────────────────────────────

/**
 * Simple inline-SVG sparkline. Accepts an array of numeric values and
 * draws a normalized line. Uses the raw value range so the shape faithfully
 * represents the series regardless of magnitude.
 */
function Sparkline({
  values,
  width = SPARKLINE_WIDTH,
  height = SPARKLINE_HEIGHT,
  color,
}: {
  values: number[];
  width?: number;
  height?: number;
  color: string;
}) {
  if (values.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const lastX = (values.length - 1) * stepX;
  const lastY = height - (((values.at(-1) ?? 0) - min) / range) * height;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Sparkline"
      className="overflow-visible"
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      <circle cx={lastX} cy={lastY} r="2.5" fill={color} />
    </svg>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: GexMode;
  onChange: (m: GexMode) => void;
}) {
  const options: Array<{ mode: GexMode; label: string }> = [
    { mode: 'oi', label: 'OI' },
    { mode: 'vol', label: 'VOL' },
    { mode: 'dir', label: 'DIR' },
  ];

  return (
    <div className="flex gap-1" role="radiogroup" aria-label="GEX mode">
      {options.map((opt) => (
        <button
          key={opt.mode}
          type="button"
          onClick={() => onChange(opt.mode)}
          title={`${opt.label} — ${MODE_DESCRIPTIONS[opt.mode]}`}
          aria-pressed={mode === opt.mode}
          className="cursor-pointer rounded px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide"
          style={{
            background:
              mode === opt.mode ? 'rgba(255,255,255,0.06)' : 'transparent',
            border: `1px solid ${mode === opt.mode ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)'}`,
            color: mode === opt.mode ? theme.text : theme.textMuted,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Always-visible single-line caption describing the currently-active mode.
 * Sits at the top of the panel body so it's impossible to miss — no hover
 * needed. Updates live as the toggle changes.
 */
function ActiveModeCaption({ mode }: { mode: GexMode }) {
  return (
    <div
      className="flex items-center gap-2 font-mono text-[10px]"
      data-testid="gex-migration-mode-caption"
    >
      <span
        className="rounded border px-1.5 py-0.5 font-semibold tracking-wide"
        style={{
          color: theme.text,
          borderColor: 'rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.04)',
        }}
      >
        {mode.toUpperCase()}
      </span>
      <span style={{ color: theme.textMuted }}>{MODE_DESCRIPTIONS[mode]}</span>
    </div>
  );
}

function TargetStrikeTile({ target }: { target: TargetStrike | null }) {
  if (!target) {
    return (
      <div
        className="rounded-lg border p-4 text-center"
        style={{
          background: 'rgba(255,255,255,0.02)',
          borderColor: 'rgba(255,255,255,0.04)',
        }}
      >
        <div
          className="font-mono text-[10px] tracking-wider"
          style={{ color: theme.textMuted }}
        >
          TARGET STRIKE
        </div>
        <div className="mt-2 text-sm" style={{ color: theme.textMuted }}>
          No qualifying magnet
        </div>
        <div
          className="mt-1 font-mono text-[9px]"
          style={{ color: theme.textTertiary }}
        >
          no positive-gamma strike with trend-confirmed growth
        </div>
      </div>
    );
  }

  const confColor = confidenceColor(target.signalConf);

  return (
    <div
      className="rounded-lg border p-4"
      style={{
        background: 'rgba(255,255,255,0.02)',
        borderColor: target.critical
          ? 'rgba(239, 68, 68, 0.4)'
          : 'rgba(255,255,255,0.06)',
      }}
    >
      <div className="flex items-center justify-between">
        <div
          className="font-mono text-[10px] tracking-wider"
          style={{ color: theme.textMuted }}
        >
          TARGET STRIKE
        </div>
        {target.critical && (
          <span
            className="rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wide"
            style={{
              color: theme.red,
              borderColor: theme.red,
            }}
          >
            CRITICAL
          </span>
        )}
      </div>

      <div
        className="mt-2 text-center font-mono text-3xl font-bold"
        style={{ color: confColor }}
      >
        {target.strike}
      </div>
      <div
        className="mt-1 text-center font-mono text-[10px] tracking-wider"
        style={{ color: theme.textSecondary }}
      >
        {target.label}
      </div>

      {target.critical && (
        <div
          className="mt-2 rounded text-center font-mono text-[9px] tracking-wide"
          style={{
            background: 'rgba(239, 68, 68, 0.1)',
            color: theme.red,
            padding: '2px 6px',
          }}
        >
          CRITICAL · {target.signalConf}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px]">
        <div>
          <div style={{ color: theme.textMuted }}>5-MIN Δ (NOW)</div>
          <div
            className="mt-0.5 text-base font-bold"
            style={{ color: signColor(target.fiveMinPctDelta) }}
          >
            {formatPct(target.fiveMinPctDelta)}
          </div>
        </div>
        <div>
          <div style={{ color: theme.textMuted }}>20-MIN TREND</div>
          <div
            className="mt-0.5 text-base font-bold"
            style={{ color: signColor(target.twentyMinPctDelta) }}
          >
            {formatPct(target.twentyMinPctDelta)}
          </div>
        </div>
        <div>
          <div style={{ color: theme.textMuted }}>DIST FROM SPOT</div>
          <div
            className="mt-0.5 text-base font-bold"
            style={{ color: theme.text }}
          >
            {formatDistance(target.distFromSpot)}
          </div>
        </div>
        <div>
          <div style={{ color: theme.textMuted }}>SIGNAL CONF</div>
          <div
            className="mt-0.5 text-base font-bold"
            style={{ color: confColor }}
          >
            {target.signalConf} {confidenceArrow(target.signalConf)}
          </div>
        </div>
      </div>
    </div>
  );
}

function UrgencyLeaderboard({ strikes }: { strikes: StrikeMigration[] }) {
  const top = strikes.slice(0, URGENCY_LEADERBOARD_SIZE);
  if (top.length === 0) {
    return (
      <div
        className="py-4 text-center font-mono text-[10px]"
        style={{ color: theme.textMuted }}
      >
        No migration data
      </div>
    );
  }

  const maxAbs = Math.max(
    ...top.map((s) => Math.abs(s.fiveMinPctDelta ?? 0)),
    1,
  );

  return (
    <div className="flex flex-col gap-1.5">
      {top.map((s) => {
        const pct = s.fiveMinPctDelta ?? 0;
        const widthPct = (Math.abs(pct) / maxAbs) * 100;
        const color = signColor(pct);
        return (
          <div
            key={s.strike}
            className="grid grid-cols-[48px_1fr_52px] items-center gap-2 font-mono text-[10px]"
          >
            <span style={{ color: theme.textSecondary }}>{s.strike}</span>
            <div className="relative h-2 overflow-hidden rounded-sm bg-white/[0.03]">
              <div
                className="absolute top-0 left-0 h-full rounded-sm"
                style={{ width: `${widthPct}%`, background: color }}
              />
            </div>
            <span className="text-right font-semibold" style={{ color }}>
              {formatPct(pct)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MigrationSparklines({ strikes }: { strikes: StrikeMigration[] }) {
  const top = strikes.slice(0, SPARKLINE_LEADERBOARD_SIZE);
  if (top.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {top.map((s, i) => {
        const pct = s.twentyMinPctDelta ?? 0;
        const color = signColor(pct);
        return (
          <div
            key={s.strike}
            className="grid grid-cols-[56px_1fr_56px] items-center gap-2 font-mono text-[10px]"
          >
            <span style={{ color: theme.textMuted }}>
              #{i + 1}{' '}
              <span style={{ color: theme.textSecondary }}>{s.strike}</span>
            </span>
            <Sparkline values={s.sparkline} color={color} />
            <span className="text-right font-semibold" style={{ color }}>
              {formatPct(pct)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CentroidTile({
  series,
  spot,
}: {
  series: Array<{ timestamp: string; value: number }>;
  spot: number;
}) {
  if (series.length < 2) return null;

  const first = series[0]!.value;
  const last = series.at(-1)!.value;
  const drift = last - first;
  const driftColor = signColor(drift);
  const values = series.map((p) => p.value);

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        background: 'rgba(255,255,255,0.02)',
        borderColor: 'rgba(255,255,255,0.04)',
      }}
    >
      <div
        className="mb-2 font-mono text-[10px] tracking-wider"
        style={{ color: theme.textMuted }}
      >
        GAMMA CENTROID · 20MIN
      </div>
      <div className="flex items-center gap-3">
        <Sparkline
          values={values}
          color={driftColor}
          width={CENTROID_SPARKLINE_WIDTH}
          height={CENTROID_SPARKLINE_HEIGHT}
        />
        <div className="font-mono text-[10px]">
          <div style={{ color: theme.textSecondary }}>
            {first.toFixed(0)} → {last.toFixed(0)}
          </div>
          <div
            className="mt-0.5 text-sm font-bold"
            style={{ color: driftColor }}
          >
            {drift > 0 ? '+' : ''}
            {drift.toFixed(1)} pts
          </div>
          <div style={{ color: theme.textMuted }}>spot {spot.toFixed(0)}</div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────

export const GexMigration = memo(function GexMigration({
  snapshots,
  loading,
  error,
  onRefresh,
}: Props) {
  const [mode, setMode] = useState<GexMode>('oi');

  const result = useMemo(
    () => computeMigration(snapshots, mode),
    [snapshots, mode],
  );

  const snapshotCount = snapshots.length;
  const subtitle = `${snapshotCount}/21`;
  const asOfTime = result.asOf ? formatTime(result.asOf) : '';

  return (
    <SectionBox
      label="0DTE GEX Migration"
      badge={asOfTime || null}
      headerRight={
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[10px]"
            style={{ color: theme.textMuted }}
          >
            {subtitle}
          </span>
          <ModeToggle mode={mode} onChange={setMode} />
          <button
            type="button"
            onClick={onRefresh}
            className="cursor-pointer rounded px-1.5 py-1 font-mono text-[10px]"
            style={{ color: theme.textMuted }}
            title="Refresh"
            aria-label="Refresh migration data"
          >
            \u21bb
          </button>
        </div>
      }
    >
      {error && (
        <div
          className="mb-3 rounded border p-2 font-mono text-[10px]"
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            borderColor: 'rgba(239, 68, 68, 0.3)',
            color: theme.red,
          }}
        >
          {error}
        </div>
      )}

      {loading && snapshots.length === 0 ? (
        <div
          className="py-8 text-center font-mono text-[10px]"
          style={{ color: theme.textMuted }}
        >
          Loading migration data...
        </div>
      ) : snapshots.length === 0 ? (
        <div
          className="py-8 text-center font-mono text-[10px]"
          style={{ color: theme.textMuted }}
        >
          No migration data available
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <ActiveModeCaption mode={mode} />
          <TargetStrikeTile target={result.targetStrike} />

          <div>
            <div
              className="mb-2 font-mono text-[10px] tracking-wider"
              style={{ color: theme.textMuted }}
            >
              ALL STRIKES · 5-MIN URGENCY
            </div>
            <UrgencyLeaderboard strikes={result.allStrikes} />
          </div>

          <div>
            <div
              className="mb-2 font-mono text-[10px] tracking-wider"
              style={{ color: theme.textMuted }}
            >
              GEX MIGRATION · 20MIN
            </div>
            <MigrationSparklines strikes={result.allStrikes} />
          </div>

          <CentroidTile series={result.centroidSeries} spot={result.spot} />
        </div>
      )}
    </SectionBox>
  );
});
