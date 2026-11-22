import { useState } from 'react';
import type { CalculationResults } from '../types';
import { SectionBox } from './ui';
import { findBucket } from '../data/vixRangeStats';
import { theme } from '../themes';
import VIXRangeAnalysis from './VIXRangeAnalysis';
import VolatilityCluster from './VolatilityCluster';
import DeltaRegimeGuide from './DeltaRegimeGuide';
import OpeningRangeCheck from './OpeningRangeCheck';
import PreTradeSignals from './PreTradeSignals';
import FlowRegimeBadge from './FlowRegimeBadge';
import SettlementCheck from './SettlementCheck';
import RvIvCard from './RvIvCard';
import PinRiskAnalysis from './PinRiskAnalysis';
import type { MarketDataState } from '../hooks/useMarketData';
import type { ClusterMultiplier } from '../hooks/useClusterMultiplier';
import type { HistorySnapshot } from '../hooks/useHistoryData';
import type { ChainResponse, HistoryCandle } from '../types/api';
import type { ComputedSignals } from '../hooks/useComputedSignals';
import { isPastETDate } from '../utils/timezone';

interface Props {
  dVix: string;
  results: CalculationResults | null;
  errors: Record<string, string>;
  skewPct: number;
  selectedDate: string;
  /**
   * Today's ET date from the clock `selectedDate` follows (useVixData's), so
   * "past" turns in the render the date moves, not before it.
   */
  etToday: string;
  market: MarketDataState;
  /**
   * Whether the flow-regime badge may poll: App's clock AND owner-or-guest flag
   * (`liveMarketOpen`), not `market.marketOpen`. /api/flow-regime is
   * owner-or-guest, and this card renders for public visitors too.
   */
  marketOpen: boolean;
  /**
   * Whether to show the flow-regime badge: App passes `isAuthenticated`.
   * /api/flow-regime is owner-or-guest, so a public visitor's badge could only
   * read "No flow regime read yet", which is not true. Past dates
   * (`historySnapshot`) never show it.
   */
  showFlowRegime: boolean;
  /** App's cluster multiplier (useClusterMultiplier): the panel shows it, and
   * DeltaRegimeGuide applies it. App computes it whether or not this card is
   * open. */
  cluster: ClusterMultiplier;
  historySnapshot?: HistorySnapshot | null;
  historyCandles?: readonly HistoryCandle[];
  entryTimeLabel?: string;
  signals: ComputedSignals;
  chain: ChainResponse | null;
  defaultCollapsed?: boolean;
}

export default function MarketRegimeSection({
  dVix,
  results,
  errors,
  skewPct,
  selectedDate,
  etToday,
  market,
  marketOpen,
  showFlowRegime,
  cluster,
  historySnapshot,
  historyCandles,
  entryTimeLabel,
  signals,
  chain,
  defaultCollapsed,
}: Readonly<Props>) {
  const [showRegime, setShowRegime] = useState(true);
  const vixNum = dVix ? Number.parseFloat(dVix) : null;

  const bucket = vixNum != null ? findBucket(vixNum) : null;
  const vixBadgeColor = bucket
    ? bucket.zone === 'go'
      ? theme.green
      : bucket.zone === 'caution'
        ? theme.caution
        : theme.red
    : undefined;

  // An owner edit of yesterday's range overrides the cluster multiplier even
  // with this card closed, so the header says so.
  const regimeBadge =
    bucket?.label ?? (results ? 'VIX ' + (vixNum || '\u2014') : null);
  const badge = cluster.isEdited
    ? [regimeBadge, 'cluster edited'].filter(Boolean).join(' \u00b7 ')
    : regimeBadge;

  // The live feed (quotes, movers, yesterday, the intraday range) is today's.
  // A history snapshot carries its own values for the selected date, and a
  // past date with no snapshot (a weekend, a holiday, a failed history fetch,
  // a date older than the history reaches) has none to show: neither may fall
  // back to today's. "Past" is judged against etToday, the clock the selected
  // date follows, as IVInputSection does.
  const pastDate = isPastETDate(selectedDate, etToday);
  const liveData = historySnapshot || pastDate ? null : market.data;

  // What an edit in the opening-range card is tied to, so it resets at the
  // next slot and on the next date. The slot label tells slots apart exactly.
  // The candle does not: under the as-of rule it is the same first bar at 8:30
  // and 8:35 CT, and the same last ended bar either side of a missing SPX bar.
  // The date separates two dates read at the same label. Without a label, the
  // candle and its index are the best identity there is. A past date with no
  // snapshot is keyed on the date alone.
  const historySlotKey = historySnapshot
    ? (entryTimeLabel ??
      `${historySnapshot.candle.datetime}:${historySnapshot.candleIndex}`)
    : null;
  let openingRangeKey = 'live-or';
  if (historySlotKey != null) {
    openingRangeKey = `hist-or-${selectedDate}-${historySlotKey}`;
  } else if (pastDate) {
    openingRangeKey = `past-or-${selectedDate}`;
  }

  return (
    <SectionBox
      label="Market Regime"
      badge={badge}
      badgeColor={bucket ? vixBadgeColor : undefined}
      collapsible
      defaultCollapsed={defaultCollapsed}
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
          <VIXRangeAnalysis vix={vixNum} spot={results?.spot ?? null} />
          {showFlowRegime && !historySnapshot && (
            <div className="mt-4">
              <FlowRegimeBadge marketOpen={marketOpen} />
            </div>
          )}
          {results &&
            dVix &&
            !errors['vix'] &&
            vixNum != null &&
            vixNum > 0 && (
              <>
                <div className="mt-5">
                  <VolatilityCluster
                    vix={vixNum ?? 0}
                    spot={results.spot}
                    inputs={cluster.inputs}
                    signal={cluster.signal}
                    onInputChange={cluster.setInput}
                    isEdited={cluster.isEdited}
                    onReset={cluster.reset}
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
                  clusterMult={cluster.signal.mult}
                />
                <div className="mt-5">
                  <OpeningRangeCheck
                    key={openingRangeKey}
                    vix={vixNum ?? 0}
                    spot={results.spot}
                    selectedDate={selectedDate}
                    initialRange={
                      historySnapshot?.openingRange ??
                      liveData?.intraday?.openingRange ??
                      undefined
                    }
                  />
                </div>
                <div className="mt-5">
                  <PreTradeSignals
                    quotes={liveData?.quotes ?? null}
                    yesterday={
                      historySnapshot
                        ? historySnapshot.yesterday
                          ? {
                              yesterday: historySnapshot.yesterday,
                              twoDaysAgo: null,
                              asOf: '',
                            }
                          : null
                        : (liveData?.yesterday ?? null)
                    }
                    movers={liveData?.movers ?? null}
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
