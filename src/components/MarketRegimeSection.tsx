import { useState } from 'react';
import type { Theme } from '../themes';
import type { CalculationResults } from '../types';
import { SectionBox } from './ui';
import VIXRangeAnalysis from './VIXRangeAnalysis';
import VolatilityCluster from './VolatilityCluster';
import DeltaRegimeGuide from './DeltaRegimeGuide';
import OpeningRangeCheck from './OpeningRangeCheck';
import PreTradeSignals from './PreTradeSignals';
import type { MarketDataState } from '../hooks/useMarketData';
import type { HistorySnapshot } from '../hooks/useHistoryData';

interface Props {
  th: Theme;
  dVix: string;
  results: CalculationResults | null;
  errors: Record<string, string>;
  skewPct: number;
  selectedDate: string;
  market: MarketDataState;
  onClusterMultChange: (v: number) => void;
  clusterMult: number;
  historySnapshot?: HistorySnapshot | null;
}

export default function MarketRegimeSection({
  th,
  dVix,
  results,
  errors,
  skewPct,
  selectedDate,
  market,
  onClusterMultChange,
  clusterMult,
  historySnapshot,
}: Props) {
  const [showRegime, setShowRegime] = useState(true);

  return (
    <SectionBox
      th={th}
      label="Market Regime"
      badge={results ? 'VIX ' + (Number.parseFloat(dVix) || '\u2014') : null}
      headerRight={
        <button
          onClick={() => setShowRegime(!showRegime)}
          className={
            'cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold ' +
            (showRegime
              ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
              : 'border-chip-border bg-chip-bg text-chip-text')
          }
        >
          {showRegime ? 'Hide' : 'Show'} Analysis
        </button>
      }
    >
      <p className="text-secondary m-0 text-[13px] leading-relaxed">
        Historical VIX-to-SPX range correlation from 9,102 trading days
        (1990–2026). Expected daily ranges and IC survival rates at each VIX
        level.
      </p>
      {showRegime && (
        <div className="mt-4">
          <VIXRangeAnalysis
            th={th}
            vix={dVix ? Number.parseFloat(dVix) : null}
            spot={results?.spot ?? null}
          />
          {results && dVix && !errors['vix'] && Number.parseFloat(dVix) > 0 && (
            <>
              <div className="mt-5">
                <VolatilityCluster
                  th={th}
                  vix={Number.parseFloat(dVix)}
                  spot={results.spot}
                  onMultiplierChange={onClusterMultChange}
                  initialYesterday={
                    historySnapshot?.yesterday ??
                    market.data.yesterday?.yesterday ??
                    undefined
                  }
                />
              </div>
              <DeltaRegimeGuide
                th={th}
                vix={Number.parseFloat(dVix)}
                spot={results.spot}
                T={results.T}
                skew={skewPct / 100}
                allDeltas={results.allDeltas}
                selectedDate={selectedDate}
                clusterMult={clusterMult}
              />
              <div className="mt-5">
                <OpeningRangeCheck
                  th={th}
                  vix={Number.parseFloat(dVix)}
                  spot={results.spot}
                  selectedDate={selectedDate}
                  initialRange={
                    historySnapshot?.openingRange ??
                    market.data.intraday?.openingRange ??
                    undefined
                  }
                />
              </div>
              <div className="mt-5">
                <PreTradeSignals
                  th={th}
                  quotes={historySnapshot ? null : market.data.quotes}
                  yesterday={
                    historySnapshot
                      ? {
                          yesterday: historySnapshot.yesterday,
                          twoDaysAgo: null,
                          asOf: '',
                        }
                      : market.data.yesterday
                  }
                  movers={historySnapshot ? null : market.data.movers}
                />
              </div>
            </>
          )}
        </div>
      )}
    </SectionBox>
  );
}
