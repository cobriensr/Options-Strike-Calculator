/**
 * CrossAssetSkewDashboard — bar chart of the latest
 * delta_risk_reversal (25Δ call IV minus 25Δ put IV) for each ticker.
 *
 * Positive bars above the zero line = call-skewed (greed); negative
 * bars below = put-skewed (fear). Comparing across the 16 tickers
 * gives a one-glance macro fear/greed gauge that spans index, vol,
 * bonds, metals, and energy.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo, useMemo } from 'react';

import {
  useGexbotData,
  type SnapshotsLatestRow,
} from '../../hooks/useGexbotData';
import { GEXBOT_TICKER_ORDER } from './ticker-order';

interface CrossAssetSkewDashboardProps {
  marketOpen: boolean;
}

interface SkewBar {
  ticker: string;
  /** null = no GEXBot data for this ticker yet (renders neutral tick).
   *  0    = ticker has data but RR is exactly 0 (rare; renders normally). */
  value: number | null;
}

const SPEC = { view: 'snapshots-latest' as const };

const CHART_HEIGHT = 96;
const ZERO_PADDING = 6;

function CrossAssetSkewDashboardInner({
  marketOpen,
}: CrossAssetSkewDashboardProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const bars = useMemo<SkewBar[]>(() => {
    const byTicker = new Map(
      rows.map((r: SnapshotsLatestRow) => [r.ticker, r] as const),
    );
    return GEXBOT_TICKER_ORDER.map((ticker) => ({
      ticker,
      value: byTicker.get(ticker)?.deltaRiskReversal ?? null,
    }));
  }, [rows]);

  // hasData = at least one ticker has any value (including 0, which is
  // a valid — if rare — RR). Distinguishing "no row" from "RR exactly 0"
  // matters here so the empty-state doesn't suppress legit data.
  const hasData = bars.some((b) => b.value != null);
  const maxAbs = Math.max(
    ...bars.map((b) => Math.abs(b.value ?? 0)),
    0.0001,
  );

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="skew-dashboard-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Cross-Asset Skew — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="skew-dashboard-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Cross-Asset Skew — {error}
      </div>
    );
  }

  if (!hasData) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="skew-dashboard-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Cross-Asset Skew — awaiting first GEXBot tick
      </div>
    );
  }

  return (
    <div
      data-testid="skew-dashboard"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] tracking-wide uppercase">
        Cross-Asset Delta Risk Reversal — green = call-skewed (greed), red =
        put-skewed (fear)
      </div>
      <div className="px-3 py-2">
        <div
          className="flex items-end gap-1.5"
          style={{ height: CHART_HEIGHT }}
        >
          {bars.map((bar) => {
            const value = bar.value;
            const hasValue = value != null;
            const heightPct = hasValue
              ? (Math.abs(value) / maxAbs) * (CHART_HEIGHT / 2 - ZERO_PADDING)
              : 0;
            const isPositive = hasValue && value > 0;
            const isZero = hasValue && value === 0;
            const barClass = !hasValue
              ? 'bg-white/10'
              : isZero
                ? 'bg-white/20'
                : isPositive
                  ? 'bg-emerald-400/70'
                  : 'bg-rose-400/70';
            const ariaLabel = hasValue
              ? `${bar.ticker} risk reversal ${value.toFixed(4)}`
              : `${bar.ticker} no data`;
            const tooltip = hasValue
              ? `${bar.ticker}: ${value.toFixed(4)}`
              : `${bar.ticker}: no data`;
            return (
              <div
                key={bar.ticker}
                role="img"
                aria-label={ariaLabel}
                data-testid={`skew-bar-${bar.ticker}`}
                className="flex flex-1 flex-col items-center"
                style={{ height: CHART_HEIGHT }}
              >
                <div
                  className="flex w-full flex-col items-center justify-end"
                  style={{ height: CHART_HEIGHT / 2 }}
                >
                  {isPositive && (
                    <div
                      className={`w-full rounded-t-sm ${barClass}`}
                      style={{ height: Math.max(1, heightPct) }}
                      title={tooltip}
                    />
                  )}
                </div>
                <div className="w-full border-t border-white/20" />
                <div
                  className="flex w-full flex-col items-center"
                  style={{ height: CHART_HEIGHT / 2 }}
                >
                  {hasValue && !isPositive && !isZero && (
                    <div
                      className={`w-full rounded-b-sm ${barClass}`}
                      style={{ height: Math.max(1, heightPct) }}
                      title={tooltip}
                    />
                  )}
                  {(!hasValue || isZero) && (
                    <div
                      className={`w-full ${barClass}`}
                      style={{ height: 1 }}
                      title={tooltip}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex gap-1.5">
          {bars.map((bar) => (
            <div
              key={`${bar.ticker}-label`}
              className="text-tertiary flex-1 text-center text-[9px] uppercase"
            >
              {bar.ticker}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const CrossAssetSkewDashboard = memo(CrossAssetSkewDashboardInner);
