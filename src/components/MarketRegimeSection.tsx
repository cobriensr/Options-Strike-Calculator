import { useState } from 'react';
import type { CalculationResults } from '../types';
import { SectionBox } from './ui';
import VIXRangeAnalysis from './VIXRangeAnalysis';
import VolatilityCluster from './VolatilityCluster';
import DeltaRegimeGuide from './DeltaRegimeGuide';
import OpeningRangeCheck from './OpeningRangeCheck';
import PreTradeSignals from './PreTradeSignals';
import SettlementCheck from './SettlementCheck';
import RvIvCard from './RvIvCard';
import PinRiskAnalysis from './PinRiskAnalysis';
import type { MarketDataState } from '../hooks/useMarketData';
import type { HistorySnapshot } from '../hooks/useHistoryData';
import type { ChainResponse, HistoryCandle } from '../types/api';
import type { ComputedSignals } from '../hooks/useComputedSignals';

interface Props {
  dVix: string;
  results: CalculationResults | null;
  errors: Record<string, string>;
  skewPct: number;
  selectedDate: string;
  market: MarketDataState;
  onClusterMultChange: (v: number) => void;
  clusterMult: number;
  historySnapshot?: HistorySnapshot | null;
  historyCandles?: readonly HistoryCandle[];
  entryTimeLabel?: string;
  signals: ComputedSignals;
  chain: ChainResponse | null;
}

export default function MarketRegimeSection({
  dVix,
  results,
  errors,
  skewPct,
  selectedDate,
  market,
  onClusterMultChange,
  clusterMult,
  historySnapshot,
  historyCandles,
  entryTimeLabel,
  signals,
  chain,
}: Props) {
  const [showRegime, setShowRegime] = useState(true);
  const vixNum = dVix ? Number.parseFloat(dVix) : null;

  return (
    <SectionBox
      label="Market Regime"
      badge={results ? 'VIX ' + (vixNum || '\u2014') : null}
      headerRight={
        <button
          type="button"
          onClick={() => setShowRegime(!showRegime)}
          className={
            'cursor-pointer rounded-md border-[1.5px] p-[5px_12px] font-sans text-xs font-semibold transition-colors duration-100 ' +
            (showRegime
              ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
              : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
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
           
            vix={vixNum}
            spot={results?.spot ?? null}
          />
          {results && dVix && !errors['vix'] && vixNum != null && vixNum > 0 && (
            <>
              <div className="mt-5">
                <VolatilityCluster
                  key={
                    historySnapshot
                      ? `hist-vc-${historySnapshot.candle.datetime}`
                      : 'live-vc'
                  }
                 
                  vix={vixNum ?? 0}
                  spot={results.spot}
                  onMultiplierChange={onClusterMultChange}
                  initialYesterday={
                    historySnapshot?.yesterday ??
                    market.data.yesterday?.yesterday ??
                    undefined
                  }
                  clusterPutMult={signals.clusterPutMult}
                  clusterCallMult={signals.clusterCallMult}
                />
              </div>
              <DeltaRegimeGuide
               
                vix={vixNum ?? 0}
                spot={results.spot}
                T={results.T}
                skew={skewPct / 100}
                allDeltas={results.allDeltas}
                selectedDate={selectedDate}
                clusterMult={clusterMult}
              />
              <div className="mt-5">
                <OpeningRangeCheck
                  key={
                    historySnapshot
                      ? `hist-or-${historySnapshot.candle.datetime}`
                      : 'live-or'
                  }
                 
                  vix={vixNum ?? 0}
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
                 
                  quotes={historySnapshot ? null : market.data.quotes}
                  yesterday={
                    historySnapshot?.yesterday
                      ? {
                          yesterday: historySnapshot.yesterday,
                          twoDaysAgo: null,
                          asOf: '',
                        }
                      : market.data.yesterday
                  }
                  movers={historySnapshot ? null : market.data.movers}
                  vixPrevClose={historySnapshot?.vixPrevClose ?? undefined}
                  spxOpen={historySnapshot?.runningOHLC.open ?? undefined}
                  spxPrevClose={historySnapshot?.previousClose ?? undefined}
                />
              </div>
              {/* RV/IV Ratio */}
              {signals.rvIvRatio != null &&
                signals.rvIvLabel != null &&
                signals.rvAnnualized != null && (
                  <div className="mt-5">
                    <div className="text-tertiary mb-2 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
                      Realized vs Implied Volatility
                    </div>
                    <RvIvCard
                     
                      ratio={signals.rvIvRatio}
                      label={signals.rvIvLabel}
                      rvAnnualized={signals.rvAnnualized}
                      iv={
                        signals.vix1d
                          ? signals.vix1d / 100
                          : ((vixNum ?? 0) * 1.15) / 100
                      }
                    />
                  </div>
                )}

              {/* Pin Risk / OI Analysis (live chain only) */}
              {chain && chain.puts.length > 0 && (
                <div className="mt-5">
                  <div className="text-tertiary mb-2 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
                    Settlement Pin Risk
                  </div>
                  <PinRiskAnalysis chain={chain} spot={results.spot} />
                </div>
              )}

              {historySnapshot &&
                historyCandles &&
                historyCandles.length > 0 &&
                results.allDeltas && (
                  <div className="mt-5">
                    <SettlementCheck
                     
                      snapshot={historySnapshot}
                      allCandles={historyCandles}
                      allDeltas={results.allDeltas}
                      entryTimeLabel={entryTimeLabel}
                    />
                  </div>
                )}
            </>
          )}
        </div>
      )}
    </SectionBox>
  );
}
