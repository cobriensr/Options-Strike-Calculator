/**
 * ZeroGammaPanel — Cross-asset zero-gamma regime dashboard.
 *
 * Renders one card per cross-asset ticker (SPX, NDX, SPY, QQQ) showing the
 * current spot, the zero-gamma level (dealer net gamma flip), distance
 * from spot, and a sparkline comparing spot drift vs zero-gamma drift over
 * the most recent 100 snapshots.
 *
 * Date scrubber: a single date input above the cards switches all four
 * tickers between LIVE mode (today, polling every minute during market
 * hours) and HISTORICAL mode (a past calendar date, one-shot fetch of
 * that day's snapshots, no polling).
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
 * exposed via /api/zero-gamma?ticker=X[&date=Y].
 */

import { memo, useState } from 'react';
import { useZeroGamma } from '../../hooks/useZeroGamma';
import { TickerCard } from './TickerCard';
import { SectionBox } from '../ui';
import { DateInputET } from '../ui/DateInputET';
import { getETToday } from '../../utils/timezone';

const TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'] as const;

interface ZeroGammaPanelProps {
  marketOpen: boolean;
}

function ZeroGammaPanelInner({ marketOpen }: ZeroGammaPanelProps) {
  const today = getETToday();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const isLive = selectedDate === today;
  // When scrubbed to a past date, pass null marketOpen so the per-ticker
  // hooks fetch once and don't try to poll a frozen historical snapshot.
  const effectiveMarketOpen = isLive ? marketOpen : false;
  // Pass `null` for live (omits ?date=...), the chosen date otherwise.
  const dateArg = isLive ? null : selectedDate;

  const headerRight = (
    <div className="flex items-center gap-2">
      {!isLive && (
        <button
          type="button"
          onClick={() => setSelectedDate(today)}
          className="text-secondary hover:text-primary border-edge cursor-pointer rounded border bg-transparent px-2 py-0.5 font-mono text-[10px]"
        >
          LIVE
        </button>
      )}
      <DateInputET
        value={selectedDate}
        onChange={setSelectedDate}
        label="Zero gamma date"
        labelVisible={false}
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />
    </div>
  );

  return (
    <SectionBox label="Zero Gamma" headerRight={headerRight} collapsible>
      <p className="text-secondary mb-3 font-sans text-xs">
        Regime boundary across SPX / NDX / SPY / QQQ. Spot above ZG =
        suppression; spot below = acceleration.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {TICKERS.map((ticker) => (
          <TickerCardContainer
            key={ticker}
            ticker={ticker}
            marketOpen={effectiveMarketOpen}
            date={dateArg}
          />
        ))}
      </div>
    </SectionBox>
  );
}

/**
 * Wrapper that owns the per-ticker hook call. Kept inline so the parent
 * stays thin and each card's polling lifecycle is independent.
 */
function TickerCardContainer({
  ticker,
  marketOpen,
  date,
}: {
  ticker: string;
  marketOpen: boolean;
  date: string | null;
}) {
  const { latest, history, loading, error } = useZeroGamma(
    ticker,
    marketOpen,
    date,
  );
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
