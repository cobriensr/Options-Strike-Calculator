/**
 * GammaCompass — multi-ticker table of the taker major long-gamma strike
 * (z_mlgamma) and taker major short-gamma strike (z_msgamma) per ticker.
 * GEXBot values are taker-side, so the strikes carry no dealer meaning and
 * no assumed geometry: the long-γ strike can sit on either side of spot.
 *
 * Vendor guidance (unvalidated here, shown as a tooltip): taker-long
 * strikes tend to hold price in falling vol and let it through in rising
 * vol; into the close the nearest-expiry taker-short strike tends to
 * attract price.
 *
 * For each ticker we render the long-γ strike, spot and the short-γ strike
 * with distance + percent, plus the ticker's own DTE from `min_dte`.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';
import { formatDte } from './types';

interface GammaCompassProps {
  marketOpen: boolean;
}

interface CompassRow {
  ticker: string;
  spot: number;
  minDte: number | null;
  longStrike: number | null;
  shortStrike: number | null;
}

const SPEC = { view: 'snapshots-latest' as const };

const LONG_STRIKE_TIP =
  'Vendor guidance, unvalidated: taker-long strikes tend to hold price in falling vol and let it through in rising vol.';
const SHORT_STRIKE_TIP =
  'Vendor guidance, unvalidated: into the close, the nearest-expiry taker-short strike tends to attract price.';

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
        minDte: r.minDte,
        longStrike: r.zMlgamma,
        shortStrike: r.zMsgamma,
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
        Taker Long/Short Gamma Compass — peak strikes per ticker, DTE shown per
        ticker
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-tertiary text-[10px] tracking-wide uppercase">
          <tr>
            <th className="px-3 py-1.5 font-medium">Ticker</th>
            <th
              className="px-3 py-1.5 text-right font-medium"
              title={LONG_STRIKE_TIP}
            >
              Taker long-γ strike
            </th>
            <th className="px-3 py-1.5 text-right font-medium">Spot</th>
            <th
              className="px-3 py-1.5 text-right font-medium"
              title={SHORT_STRIKE_TIP}
            >
              Taker short-γ strike
            </th>
          </tr>
        </thead>
        <tbody>
          {compassRows.map((row) => (
            <tr key={row.ticker} className="border-t border-white/5">
              <td className="px-3 py-1.5 font-medium">
                {row.ticker}
                <span className="text-tertiary ml-1.5 text-[10px] font-normal">
                  {formatDte(row.minDte)}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right text-emerald-300 tabular-nums">
                {formatDistance(row.longStrike, row.spot)}
              </td>
              <td className="text-secondary px-3 py-1.5 text-right tabular-nums">
                {row.spot.toFixed(2)}
              </td>
              <td className="px-3 py-1.5 text-right text-rose-300 tabular-nums">
                {formatDistance(row.shortStrike, row.spot)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const GammaCompass = memo(GammaCompassInner);
