/**
 * ZeroGammaPanel — Cross-asset zero-gamma regime dashboard.
 *
 * Renders one card per cross-asset ticker (SPX, NDX, SPY, QQQ) showing the
 * current spot, the zero-gamma level (dealer net gamma flip), distance
 * from spot, and a sparkline comparing spot drift vs zero-gamma drift over
 * the most recent 100 snapshots.
 *
 * Zero-gamma is a regime indicator (not support/resistance):
 *   - spot ABOVE zero-gamma  → dealers net long gamma → SUPPRESSION
 *     (mean-reverting, pinning, dampened volatility)
 *   - spot BELOW zero-gamma  → dealers net short gamma → ACCELERATION
 *     (trend-following, expanding volatility)
 *   - spot WITHIN ~0.3% of ZG → KNIFE EDGE (the eye of the storm)
 *
 * Per the cross-asset zero-gamma spec
 * (docs/superpowers/specs/cross-asset-zero-gamma-2026-04-28.md), all four
 * tickers' data is computed by the same compute-zero-gamma cron and
 * exposed via /api/zero-gamma?ticker=X.
 */

import { memo } from 'react';
import { useZeroGamma } from '../../hooks/useZeroGamma';
import { TickerCard } from './TickerCard';

const TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'] as const;

interface ZeroGammaPanelProps {
  marketOpen: boolean;
}

function ZeroGammaPanelInner({ marketOpen }: ZeroGammaPanelProps) {
  return (
    <section
      className="border-edge bg-surface-alt rounded-lg border p-4"
      aria-labelledby="zero-gamma-heading"
    >
      <header className="mb-3">
        <h2
          id="zero-gamma-heading"
          className="text-primary font-sans text-lg font-semibold"
        >
          Zero Gamma
        </h2>
        <p className="text-secondary mt-1 font-sans text-xs">
          Regime boundary across SPX / NDX / SPY / QQQ. Spot above ZG =
          suppression; spot below ZG = acceleration.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {TICKERS.map((ticker) => (
          <TickerCardContainer
            key={ticker}
            ticker={ticker}
            marketOpen={marketOpen}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Wrapper that owns the per-ticker hook call. Kept inline so the parent
 * stays thin and each card's polling lifecycle is independent.
 */
function TickerCardContainer({
  ticker,
  marketOpen,
}: {
  ticker: string;
  marketOpen: boolean;
}) {
  const { latest, history, loading, error } = useZeroGamma(ticker, marketOpen);
  return (
    <TickerCard
      ticker={ticker}
      latest={latest}
      history={history}
      loading={loading}
      error={error}
    />
  );
}

export const ZeroGammaPanel = memo(ZeroGammaPanelInner);
