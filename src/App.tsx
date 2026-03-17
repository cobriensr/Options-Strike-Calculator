import { IV_MODES } from './constants';
import { lightTheme, darkTheme } from './themes';
import { buildChevronUrl } from './utils/ui-utils';
import { useAppState } from './hooks/useAppState';
import { useAutoFill } from './hooks/useAutoFill';
import { useVixData } from './hooks/useVixData';
import { useCalculation } from './hooks/useCalculation';
import { useMarketData } from './hooks/useMarketData';
import { useHistoryData } from './hooks/useHistoryData';
import { useVix1dData } from './hooks/useVix1dData';
import { useSnapshotSave } from './hooks/useSnapshotSave';
import { useComputedSignals } from './hooks/useComputedSignals';
import { useChainData } from './hooks/useChainData';
import { getEarlyCloseHourET } from './data/eventCalendar';
import VixUploadSection from './components/VixUploadSection';
import DateLookupSection from './components/DateLookupSection';
import SpotPriceSection from './components/SpotPriceSection';
import EntryTimeSection from './components/EntryTimeSection';
import IVInputSection from './components/IVInputSection';
import AdvancedSection from './components/AdvancedSection';
import MarketRegimeSection from './components/MarketRegimeSection';
import ResultsSection from './components/ResultsSection';
import ChartAnalysis from './components/ChartAnalysis';
import type { AnalysisContext } from './components/ChartAnalysis';
import BacktestDiag from './components/BacktestDiag';
import ErrorBoundary from './components/ErrorBoundary';
import { Analytics } from '@vercel/analytics/react';

// ============================================================
// SHARED CSS CLASSES (static — no per-render cost)
// ============================================================
const INPUT_CLS =
  'bg-input border-[1.5px] border-edge-strong rounded-lg text-primary p-[11px_14px] text-base font-mono outline-none w-full box-border transition-[border-color] duration-150';
const SELECT_CLS =
  INPUT_CLS +
  ' cursor-pointer appearance-none bg-no-repeat bg-[length:14px_14px] bg-[position:right_12px_center] pr-[34px]';

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function StrikeCalculator() {
  // Consolidated UI state (inputs, debounced values, derived ratio)
  const state = useAppState();
  const {
    darkMode,
    setDarkMode,
    spotPrice,
    setSpotPrice,
    spxDirect,
    setSpxDirect,
    spxRatio,
    setSpxRatio,
    ivMode,
    setIvMode,
    vixInput,
    setVixInput,
    multiplier,
    setMultiplier,
    directIVInput,
    setDirectIVInput,
    timeHour,
    setTimeHour,
    timeMinute,
    setTimeMinute,
    timeAmPm,
    setTimeAmPm,
    timezone,
    setTimezone,
    wingWidth,
    setWingWidth,
    showIC,
    setShowIC,
    contracts,
    setContracts,
    skewPct,
    setSkewPct,
    clusterMult,
    setClusterMult,
    dSpot,
    dSpx,
    dVix,
    dIV,
    dMult,
    spyVal,
    spxVal,
    spxDirectActive,
    effectiveRatio,
  } = state;
  const th = darkMode ? darkTheme : lightTheme;

  // Data hooks
  const market = useMarketData();
  const vix = useVixData(ivMode, timeHour, timeAmPm, timezone, setVixInput);
  const historyData = useHistoryData(vix.selectedDate);
  const vix1dStatic = useVix1dData();
  const chainData = useChainData(market.hasData && !historyData.hasHistory);
  const { results, errors } = useCalculation(
    dSpot,
    dSpx,
    dVix,
    dIV,
    dMult,
    ivMode,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    spxRatio,
    skewPct,
    getEarlyCloseHourET(vix.selectedDate),
  );

  // Auto-fill inputs from live/historical data + compute history snapshot
  const historySnapshot = useAutoFill({
    spotPrice,
    spxDirect,
    vixInput,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    setSpotPrice,
    setSpxDirect,
    setVixInput,
    setIvMode,
    setDirectIVInput,
    setTimeHour,
    setTimeMinute,
    setTimeAmPm,
    setTimezone,
    market,
    vix,
    historyData,
    vix1dStatic,
  });

  // Auto-save market snapshot for authenticated owner (fire-and-forget)
  const signals = useComputedSignals({
    vix: Number.parseFloat(dVix) || undefined,
    spot: results?.spot,
    T: results?.T,
    skewPct,
    clusterMult,
    selectedDate: vix.selectedDate,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    ivMode,
    ivModeVix: IV_MODES.VIX,
    liveVix1d: market.data.quotes?.vix1d?.price ?? undefined,
    liveVix9d: market.data.quotes?.vix9d?.price ?? undefined,
    liveVvix: market.data.quotes?.vvix?.price ?? undefined,
    liveOpeningRange: market.data.intraday?.openingRange ?? undefined,
    liveYesterdayHigh: market.data.yesterday?.yesterday?.high ?? undefined,
    liveYesterdayLow: market.data.yesterday?.yesterday?.low ?? undefined,
    liveYesterdayOpen: market.data.yesterday?.yesterday?.open ?? undefined,
    liveYesterdayClose: market.data.yesterday?.yesterday?.close ?? undefined,
    historySnapshot,
  });

  useSnapshotSave(
    results,
    signals,
    {
      selectedDate: vix.selectedDate,
      entryTime: `${timeHour}:${timeMinute} ${timeAmPm} ${timezone}`,
      isBacktest: !!historySnapshot,
      spy: Number.parseFloat(dSpot) || undefined,
      vix: Number.parseFloat(dVix) || undefined,
      skewPct,
      clusterMult,
    },
    market.hasData || !!historySnapshot,
  );

  const chevronUrl = buildChevronUrl(th.chevronColor);

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="bg-page text-primary min-h-screen font-serif transition-[background-color,color] duration-[250ms]">
        <a
          href="#results"
          className="bg-accent absolute top-0 -left-[9999px] z-[100] p-[8px_16px] font-sans text-sm text-white"
          onFocus={(e) => {
            (e.target as HTMLElement).style.left = '0';
          }}
          onBlur={(e) => {
            (e.target as HTMLElement).style.left = '-9999px';
          }}
        >
          Skip to results
        </a>

        <div className="mx-auto max-w-[660px] px-5 pt-9 pb-12">
          {/* Header */}
          <header className="border-edge-heavy mb-8 border-b-[2.5px] pb-[18px]">
            <div className="flex flex-col items-start justify-between md:flex-row">
              <div>
                <div className="text-accent mb-1.5 font-sans text-[11px] font-bold tracking-[0.2em] uppercase">
                  0DTE Options
                </div>
                <h1 className="text-primary m-0 text-[30px] leading-[1.15] font-bold">
                  Strike Calculator
                </h1>
                <p className="text-secondary mt-2 mb-0 text-[15px] leading-normal">
                  Black-Scholes approximation for delta-based strike placement
                </p>
              </div>
              <div className="flex items-center gap-2">
                {historySnapshot && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: '#7C3AED18',
                      color: '#7C3AED',
                    }}
                  >
                    ● BACKTEST
                  </span>
                )}
                {historyData.loading && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: th.surfaceAlt,
                      color: th.textMuted,
                    }}
                  >
                    Loading…
                  </span>
                )}
                {historyData.error && !historyData.loading && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: th.red + '18',
                      color: th.red,
                    }}
                    title={historyData.error}
                  >
                    ● NO INTRADAY
                  </span>
                )}
                {!historySnapshot && !historyData.error && market.hasData && (
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold"
                    style={{
                      backgroundColor: market.data.quotes?.marketOpen
                        ? th.green + '18'
                        : th.surfaceAlt,
                      color: market.data.quotes?.marketOpen
                        ? th.green
                        : th.textMuted,
                    }}
                  >
                    {market.data.quotes?.marketOpen ? '● LIVE' : '● CLOSED'}
                  </span>
                )}
                {market.needsAuth && (
                  <a
                    href="/api/auth/init"
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold no-underline"
                    style={{ backgroundColor: th.red + '18', color: th.red }}
                  >
                    Re-authenticate
                  </a>
                )}
                <button
                  onClick={() => setDarkMode(!darkMode)}
                  aria-label={
                    darkMode ? 'Switch to light mode' : 'Switch to dark mode'
                  }
                  className="border-edge-strong bg-surface text-primary mt-1 flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[8px_12px] font-sans text-lg transition-all duration-200"
                >
                  {darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19'}
                  <span className="text-xs font-semibold">
                    {darkMode ? 'Light' : 'Dark'}
                  </span>
                </button>
              </div>
            </div>
          </header>

          <main>
            <VixUploadSection
              th={th}
              vixDataLoaded={vix.vixDataLoaded}
              vixDataSource={vix.vixDataSource}
              fileInputRef={vix.fileInputRef}
              onFileUpload={vix.handleFileUpload}
            />

            {vix.vixDataLoaded && (
              <DateLookupSection
                th={th}
                inputCls={INPUT_CLS}
                selectedDate={vix.selectedDate}
                onDateChange={vix.setSelectedDate}
                vixOHLC={vix.vixOHLC}
                vixOHLCField={vix.vixOHLCField}
                onOHLCFieldChange={vix.setVixOHLCField}
                liveEvents={market.data.events?.events}
              />
            )}

            <SpotPriceSection
              th={th}
              inputCls={INPUT_CLS}
              spotPrice={spotPrice}
              onSpotChange={setSpotPrice}
              spxDirect={spxDirect}
              onSpxDirectChange={setSpxDirect}
              spxRatio={spxRatio}
              onSpxRatioChange={setSpxRatio}
              dSpot={dSpot}
              effectiveRatio={effectiveRatio}
              spxDirectActive={spxDirectActive}
              derivedRatio={spxDirectActive ? spxVal / spyVal : spxRatio}
              errors={errors}
            />

            <EntryTimeSection
              th={th}
              selectCls={SELECT_CLS}
              chevronUrl={chevronUrl}
              timeHour={timeHour}
              onHourChange={setTimeHour}
              timeMinute={timeMinute}
              onMinuteChange={setTimeMinute}
              timeAmPm={timeAmPm}
              onAmPmChange={setTimeAmPm}
              timezone={timezone}
              onTimezoneChange={setTimezone}
              errors={errors}
            />

            <IVInputSection
              th={th}
              inputCls={INPUT_CLS}
              ivMode={ivMode}
              onIvModeChange={setIvMode}
              vixInput={vixInput}
              onVixChange={setVixInput}
              multiplier={multiplier}
              onMultiplierChange={setMultiplier}
              directIVInput={directIVInput}
              onDirectIVChange={setDirectIVInput}
              dVix={dVix}
              results={results}
              errors={errors}
              market={market}
              historySnapshot={historySnapshot}
              onUseVix1dAsSigma={(sigma) => {
                setIvMode(IV_MODES.DIRECT);
                setDirectIVInput(sigma.toFixed(4));
              }}
              termShape={signals.vixTermShape}
              termShapeAdvice={signals.vixTermShapeAdvice}
            />

            <AdvancedSection
              th={th}
              skewPct={skewPct}
              onSkewChange={setSkewPct}
              showIC={showIC}
              onToggleIC={() => setShowIC(!showIC)}
              wingWidth={wingWidth}
              onWingWidthChange={setWingWidth}
              contracts={contracts}
              onContractsChange={setContracts}
            />

            <ErrorBoundary label="Market Regime">
              <MarketRegimeSection
                th={th}
                dVix={dVix}
                results={results}
                errors={errors}
                skewPct={skewPct}
                selectedDate={vix.selectedDate}
                market={market}
                onClusterMultChange={setClusterMult}
                clusterMult={clusterMult}
                historySnapshot={historySnapshot}
                historyCandles={historyData.history?.spx.candles}
                entryTimeLabel={
                  historySnapshot
                    ? `${timeHour}:${timeMinute} ${timeAmPm} ${timezone}`
                    : undefined
                }
                signals={signals}
                chain={chainData.chain}
              />
            </ErrorBoundary>

            {/* Chart Analysis — owner-only (requires auth session or backtest with results) */}
            {(market.hasData || !!historySnapshot) && (
              <ErrorBoundary label="Chart Analysis">
                <ChartAnalysis
                  th={th}
                  results={results}
                  context={
                    {
                      selectedDate: vix.selectedDate,
                      entryTime: `${timeHour}:${timeMinute} ${timeAmPm} ${timezone}`,
                      spx: results?.spot,
                      spy: Number.parseFloat(dSpot) || undefined,
                      vix: Number.parseFloat(dVix) || undefined,
                      vix1d: signals.vix1d,
                      vix9d: signals.vix9d,
                      vvix: signals.vvix,
                      sigma: results?.sigma,
                      sigmaSource: signals.sigmaSource,
                      T: results?.T,
                      hoursRemaining: results?.hoursRemaining,
                      deltaCeiling: signals.icCeiling ?? undefined,
                      putSpreadCeiling: signals.putSpreadCeiling ?? undefined,
                      callSpreadCeiling: signals.callSpreadCeiling ?? undefined,
                      regimeZone: signals.regimeZone ?? undefined,
                      clusterMult,
                      dowLabel: signals.dowLabel ?? undefined,
                      openingRangeSignal:
                        signals.openingRangeSignal ?? undefined,
                      openingRangeAvailable: signals.openingRangeAvailable,
                      vixTermSignal: signals.vixTermSignal ?? undefined,
                      vixTermShape: signals.vixTermShape ?? undefined,
                      clusterPutMult: signals.clusterPutMult ?? undefined,
                      clusterCallMult: signals.clusterCallMult ?? undefined,
                      rvIvRatio:
                        signals.rvIvRatio == null
                          ? undefined
                          : `${signals.rvIvRatio.toFixed(2)} (${signals.rvIvLabel})`,
                      rvAnnualized: signals.rvAnnualized ?? undefined,
                      ivAccelMult: (() => {
                        const row = results?.allDeltas.find(
                          (r) => !('error' in r),
                        );
                        return row && !('error' in row)
                          ? row.ivAccelMult
                          : undefined;
                      })(),
                      overnightGap:
                        signals.overnightGap == null
                          ? undefined
                          : String(signals.overnightGap),
                      isBacktest: !!historySnapshot,
                      dataNote: signals.dataNote,
                    } satisfies AnalysisContext
                  }
                />
              </ErrorBoundary>
            )}

            <ErrorBoundary label="Results">
              <ResultsSection
                th={th}
                results={results}
                effectiveRatio={effectiveRatio}
                spxDirectActive={spxDirectActive}
                showIC={showIC}
                wingWidth={wingWidth}
                contracts={contracts}
                skewPct={skewPct}
              />
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <BacktestDiag
        snapshot={historySnapshot}
        history={historyData}
        timeHour={timeHour}
        timeMinute={timeMinute}
        timeAmPm={timeAmPm}
        timezone={timezone}
      />
      <Analytics />
    </div>
  );
}
