/**
 * DexoflowVelocityTape — per-ticker view of the three flow-rate
 * scalars from the orderflow endpoint:
 *   dexoflow  — dollar-delta flow rate
 *   gexoflow  — dollar-gamma flow rate
 *   cvroflow  — convexity-ratio flow rate
 *
 * These are velocity metrics — rate of change of dealer-attributed
 * flow. Distinct from cumulative flow totals: a high cvroflow means
 * convexity is *accelerating*, not just that it's high. Useful for
 * spotting regime shifts at the moment they happen.
 *
 * Each cell shows the current value with a trend arrow (▲/▼/─)
 * derived from the sign alone (v0). When historical series are
 * captured we can switch to a 5-min slope.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';

interface DexoflowVelocityTapeProps {
  marketOpen: boolean;
}

interface VelocityRow {
  ticker: string;
  dexoflow: number | null;
  gexoflow: number | null;
  cvroflow: number | null;
}

const SPEC = { view: 'snapshots-latest' as const };

function arrow(value: number | null): { glyph: string; cls: string } {
  if (value == null) return { glyph: '·', cls: 'text-tertiary' };
  if (value > 0) return { glyph: '▲', cls: 'text-emerald-300' };
  if (value < 0) return { glyph: '▼', cls: 'text-rose-300' };
  return { glyph: '─', cls: 'text-tertiary' };
}

function formatScalar(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '−';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(4)}`;
}

function magnitude(value: number | null): number {
  // Defensive against NaN: Math.abs(NaN) === NaN, and NaN comparisons
  // return false, which makes Array.prototype.sort non-deterministic.
  if (value == null || Number.isNaN(value)) return 0;
  return Math.abs(value);
}

function DexoflowVelocityTapeInner({ marketOpen }: DexoflowVelocityTapeProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const velocityRows = useMemo<VelocityRow[]>(() => {
    return rows
      .filter(
        (r: SnapshotsLatestRow) =>
          r.dexoflow != null || r.gexoflow != null || r.cvroflow != null,
      )
      .map((r) => ({
        ticker: r.ticker,
        dexoflow: r.dexoflow,
        gexoflow: r.gexoflow,
        cvroflow: r.cvroflow,
      }))
      .sort((a, b) => {
        // Combined velocity magnitude across all three flow scalars.
        // CVR included so a row where only cvroflow fires doesn't sink
        // to the bottom — convexity acceleration is the marquee signal
        // per the JSDoc.
        const aMag =
          magnitude(a.dexoflow) +
          magnitude(a.gexoflow) +
          magnitude(a.cvroflow);
        const bMag =
          magnitude(b.dexoflow) +
          magnitude(b.gexoflow) +
          magnitude(b.cvroflow);
        // Stable tiebreaker on ticker so render order is deterministic
        // when magnitudes match.
        return bMag - aMag || a.ticker.localeCompare(b.ticker);
      });
  }, [rows]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dexoflow-tape-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Dexoflow Velocity — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dexoflow-tape-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Dexoflow Velocity — {error}
      </div>
    );
  }

  if (velocityRows.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="dexoflow-tape-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Dexoflow Velocity — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      data-testid="dexoflow-tape"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] tracking-wide uppercase">
        Dexoflow Velocity — 0DTE flow-rate scalars
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-tertiary text-[10px] tracking-wide uppercase">
          <tr>
            <th className="px-3 py-1.5 font-medium">Ticker</th>
            <th className="px-3 py-1.5 text-right font-medium">DEX flow</th>
            <th className="px-3 py-1.5 text-right font-medium">GEX flow</th>
            <th className="px-3 py-1.5 text-right font-medium">CVR flow</th>
          </tr>
        </thead>
        <tbody>
          {velocityRows.map((row) => (
            <tr key={row.ticker} className="border-t border-white/5">
              <td className="px-3 py-1.5 font-medium">{row.ticker}</td>
              <Cell value={row.dexoflow} />
              <Cell value={row.gexoflow} />
              <Cell value={row.cvroflow} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ value }: { value: number | null }) {
  const { glyph, cls } = arrow(value);
  const verdict =
    value == null
      ? 'no data'
      : value > 0
        ? 'positive'
        : value < 0
          ? 'negative'
          : 'flat';
  const ariaLabel = `${verdict} ${formatScalar(value)}`;
  return (
    <td className="px-3 py-1.5 text-right tabular-nums">
      <span className={cls} aria-label={ariaLabel}>
        <span className="mr-1.5" aria-hidden>
          {glyph}
        </span>
        {formatScalar(value)}
      </span>
    </td>
  );
}

export const DexoflowVelocityTape = memo(DexoflowVelocityTapeInner);
