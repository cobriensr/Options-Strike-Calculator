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

import { useGexbotData, type SnapshotsLatestRow } from '../../hooks/useGexbotData';

interface CrossAssetSkewDashboardProps {
  marketOpen: boolean;
}

interface SkewBar {
  ticker: string;
  value: number;
}

const SPEC = { view: 'snapshots-latest' as const };
const TICKER_ORDER = [
  'SPX', 'ES_SPX', 'NDX', 'NQ_NDX', 'RUT', 'VIX',
  'SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'USO',
  'TQQQ', 'UVXY', 'HYG', 'SLV',
] as const;

const CHART_HEIGHT = 96;
const ZERO_PADDING = 6;

function CrossAssetSkewDashboardInner({ marketOpen }: CrossAssetSkewDashboardProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);

  const bars = useMemo<SkewBar[]>(() => {
    const byTicker = new Map(
      rows.map((r: SnapshotsLatestRow) => [r.ticker, r] as const),
    );
    return TICKER_ORDER.map((ticker) => ({
      ticker,
      value: byTicker.get(ticker)?.deltaRiskReversal ?? 0,
    }));
  }, [rows]);

  const hasData = bars.some((b) => b.value !== 0);
  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.value)), 0.0001);

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
      <div className="text-tertiary border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-wide">
        Cross-Asset Delta Risk Reversal — green = call-skewed (greed), red = put-skewed (fear)
      </div>
      <div className="px-3 py-2">
        <div className="flex items-end gap-1.5" style={{ height: CHART_HEIGHT }}>
          {bars.map((bar) => {
            const heightPct =
              (Math.abs(bar.value) / maxAbs) * (CHART_HEIGHT / 2 - ZERO_PADDING);
            const isPositive = bar.value > 0;
            const isZero = bar.value === 0;
            const barClass = isZero
              ? 'bg-white/10'
              : isPositive
                ? 'bg-emerald-400/70'
                : 'bg-rose-400/70';
            return (
              <div
                key={bar.ticker}
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
                      title={`${bar.ticker}: ${bar.value.toFixed(4)}`}
                    />
                  )}
                </div>
                <div className="w-full border-t border-white/20" />
                <div
                  className="flex w-full flex-col items-center"
                  style={{ height: CHART_HEIGHT / 2 }}
                >
                  {!isPositive && !isZero && (
                    <div
                      className={`w-full rounded-b-sm ${barClass}`}
                      style={{ height: Math.max(1, heightPct) }}
                      title={`${bar.ticker}: ${bar.value.toFixed(4)}`}
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
