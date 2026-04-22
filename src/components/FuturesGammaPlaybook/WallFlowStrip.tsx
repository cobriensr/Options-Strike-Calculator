/**
 * WallFlowStrip — compact display of 5m GEX Δ% above and below spot.
 *
 * Pure presentational. Classifies each trend against a dead-band and
 * emits a strengthening / eroding / flat label. No side effects, no
 * hooks — just takes two nullable numbers and renders three tokens.
 *
 * Dead-band: ±WALL_FLOW_STRENGTHENING_THRESHOLD_PCT. Trends smaller
 * than the threshold in magnitude collapse to `flat` to avoid jitter
 * driven by per-snapshot noise.
 */

import { memo } from 'react';

/** Δ% threshold (positive) above which we label a side "strengthening". */
export const WALL_FLOW_STRENGTHENING_THRESHOLD_PCT = 2;
/** Δ% threshold (negative) below which we label a side "eroding". */
export const WALL_FLOW_ERODING_THRESHOLD_PCT = -2;

export interface WallFlowStripProps {
  /** Avg 5m Δ% across strikes above spot. Null = insufficient history. */
  ceilingTrend5m: number | null;
  /** Avg 5m Δ% across strikes below spot. Null = insufficient history. */
  floorTrend5m: number | null;
}

type Trend = 'strengthening' | 'eroding' | 'flat';

function classifyTrend(pct: number | null): Trend | null {
  if (pct === null) return null;
  if (pct >= WALL_FLOW_STRENGTHENING_THRESHOLD_PCT) return 'strengthening';
  if (pct <= WALL_FLOW_ERODING_THRESHOLD_PCT) return 'eroding';
  return 'flat';
}

const TREND_META: Record<
  Trend,
  { icon: string; label: string; className: string }
> = {
  strengthening: {
    icon: '▲',
    label: 'strengthening',
    className: 'text-emerald-400',
  },
  eroding: {
    icon: '▼',
    label: 'eroding',
    className: 'text-red-400',
  },
  flat: {
    icon: '·',
    label: 'flat',
    className: 'text-muted',
  },
};

function fmtPct(pct: number | null): string {
  if (pct === null) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

interface SideProps {
  label: string;
  pct: number | null;
  trend: Trend | null;
}

function Side({ label, pct, trend }: SideProps) {
  const tm = trend ? TREND_META[trend] : null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px]">
      <span className="uppercase tracking-wider" style={{ color: 'var(--color-tertiary)' }}>
        {label} (5m):
      </span>
      <span
        className="tabular-nums"
        style={{ color: 'var(--color-primary)' }}
      >
        {fmtPct(pct)}
      </span>
      {tm && (
        <span className={`${tm.className} inline-flex items-center gap-0.5`}>
          <span aria-hidden="true">{tm.icon}</span>
          <span>{tm.label}</span>
        </span>
      )}
    </span>
  );
}

export const WallFlowStrip = memo(function WallFlowStrip({
  ceilingTrend5m,
  floorTrend5m,
}: WallFlowStripProps) {
  const ceilingTrend = classifyTrend(ceilingTrend5m);
  const floorTrend = classifyTrend(floorTrend5m);
  const bothNull = ceilingTrend5m === null && floorTrend5m === null;

  return (
    <div
      className="border-edge bg-surface-alt flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-1.5"
      aria-label="Wall flow 5-minute trend"
    >
      {bothNull ? (
        <span
          className="font-mono text-[11px]"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Wall flow (5m): awaiting snapshots…
        </span>
      ) : (
        <>
          <Side label="Ceiling" pct={ceilingTrend5m} trend={ceilingTrend} />
          <span aria-hidden="true" style={{ color: 'var(--color-tertiary)' }}>
            ·
          </span>
          <Side label="Floor" pct={floorTrend5m} trend={floorTrend} />
        </>
      )}
    </div>
  );
});

export default WallFlowStrip;
