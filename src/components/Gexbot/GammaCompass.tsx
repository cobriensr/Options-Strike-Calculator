/**
 * GammaCompass — multi-ticker visual showing the asymmetric long/short
 * gamma exposure strikes per ticker. Long-gamma strike (z_mlgamma) is
 * the floor (dealers stabilize price near it via mean-reverting hedges);
 * short-gamma strike (z_msgamma) is the danger zone (dealers destabilize
 * via procyclical hedges).
 *
 * For each ticker we render spot in the center, floor on the left with
 * distance + percent, danger zone on the right with distance + percent.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';

interface GammaCompassProps {
  marketOpen: boolean;
}

interface CompassRow {
  ticker: string;
  spot: number;
  floor: number | null;
  danger: number | null;
}

const SPEC = { view: 'snapshots-latest' as const };

function signed(n: number, digits = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

function formatDistance(level: number | null, spot: number): string {
  if (level == null) return '—';
  const delta = level - spot;
  const pct = spot === 0 ? 0 : (delta / spot) * 100;
  return `${level.toFixed(2)} (${signed(delta)}, ${signed(pct)}%)`;
}

function GammaCompassInner({ marketOpen }: GammaCompassProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const compassRows = useMemo<CompassRow[]>(() => {
    return rows
      .filter(
        (r): r is SnapshotsLatestRow & { spot: number } =>
          r.spot != null && (r.zMlgamma != null || r.zMsgamma != null),
      )
      .map((r) => ({
        ticker: r.ticker,
        spot: r.spot,
        floor: r.zMlgamma,
        danger: r.zMsgamma,
      }));
  }, [rows]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="gamma-compass-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Gamma Compass — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="gamma-compass-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Gamma Compass — {error}
      </div>
    );
  }

  if (compassRows.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="gamma-compass-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Gamma Compass — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      data-testid="gamma-compass"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] tracking-wide uppercase">
        Long/Short Gamma Compass — 0DTE peak strikes (typical regime: long γ
        below spot = floor, short γ above = ceiling/danger)
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-tertiary text-[10px] tracking-wide uppercase">
          <tr>
            <th className="px-3 py-1.5 font-medium">Ticker</th>
            <th className="px-3 py-1.5 text-right font-medium">
              Long γ strike
            </th>
            <th className="px-3 py-1.5 text-right font-medium">Spot</th>
            <th className="px-3 py-1.5 text-right font-medium">
              Short γ strike
            </th>
            <th className="px-3 py-1.5 text-right font-medium">Regime</th>
          </tr>
        </thead>
        <tbody>
          {compassRows.map((row) => {
            // Inverted regime: long γ strike above spot OR short γ strike
            // below spot inverts the usual floor/ceiling intuition.
            const inverted =
              (row.floor != null && row.floor > row.spot) ||
              (row.danger != null && row.danger < row.spot);
            return (
              <tr key={row.ticker} className="border-t border-white/5">
                <td className="px-3 py-1.5 font-medium">{row.ticker}</td>
                <td className="px-3 py-1.5 text-right text-emerald-300 tabular-nums">
                  {formatDistance(row.floor, row.spot)}
                </td>
                <td className="text-secondary px-3 py-1.5 text-right tabular-nums">
                  {row.spot.toFixed(2)}
                </td>
                <td className="px-3 py-1.5 text-right text-rose-300 tabular-nums">
                  {formatDistance(row.danger, row.spot)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {inverted ? (
                    <span
                      data-testid={`gamma-compass-inverted-${row.ticker}`}
                      className="inline-block rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] tracking-wide text-amber-300 uppercase"
                      title="Floor above spot OR ceiling below spot — typical floor/danger intuition does not apply"
                    >
                      inverted
                    </span>
                  ) : (
                    <span className="text-tertiary text-[10px]">typical</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const GammaCompass = memo(GammaCompassInner);
