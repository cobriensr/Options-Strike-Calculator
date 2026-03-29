import { IV_MODES } from './constants';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { theme } from './themes';
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
import { getTopOIStrikes } from './utils/pin-risk';
import { getEarlyCloseHourET } from './data/marketHours';
import DateTimeSection from './components/DateTimeSection';
import SpotPriceSection from './components/SpotPriceSection';
import IVInputSection from './components/IVInputSection';
import AdvancedSection from './components/AdvancedSection';
import PreMarketInput from './components/PreMarketInput';
import MarketRegimeSection from './components/MarketRegimeSection';
import ResultsSection from './components/ResultsSection';
import type { AnalysisContext } from './components/ChartAnalysis';
import AnalysisHistory from './components/ChartAnalysis/AnalysisHistory';
import BacktestDiag from './components/BacktestDiag';
import ErrorBoundary from './components/ErrorBoundary';
import { StatusBadge } from './components/ui';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';

const ChartAnalysis = lazy(() => import('./components/ChartAnalysis'));
const RiskCalculator = lazy(() => import('./components/RiskCalculator'));
const PaperDashboard = lazy(
  () => import('./components/performance/PaperDashboard'),
);

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

  // Apply dark class to <html> so CSS vars resolve correctly everywhere
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', darkMode ? '#121212' : '#f4f1eb');
  }, [darkMode]);

  // Data hooks
  const market = useMarketData();
  const {
    fileInputRef: vixFileInputRef,
    handleFileUpload: vixHandleFileUpload,
    ...vix
  } = useVixData(ivMode, timeHour, timeAmPm, timezone, setVixInput);
  const historyData = useHistoryData(vix.selectedDate);
  const vix1dStatic = useVix1dData();
  const chainData = useChainData(
    market.hasData && !historyData.hasHistory,
    market.data.quotes?.marketOpen ?? false,
  );
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

  // Derive VIX OHLC from history candles when static data and API have no entry
  useEffect(() => {
    if (vix.vixOHLC) return; // already have OHLC from static data or API
    const candles = historyData.history?.vix.candles;
    if (!candles || candles.length === 0) return;
    vix.setVixOHLC({
      open: candles[0]!.open,
      close: candles[candles.length - 1]!.close,
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
    });
  }, [vix.vixOHLC, historyData.history?.vix.candles, vix.setVixOHLC]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track user edits so auto-fill overwrites defaults but not manual input
  const spotEdited = useRef(false);
  const spxEdited = useRef(false);
  const vixEdited = useRef(false);
  const handleSpotChange = useCallback(
    (v: string) => {
      spotEdited.current = true;
      setSpotPrice(v);
    },
    [setSpotPrice],
  );
  const handleSpxChange = useCallback(
    (v: string) => {
      spxEdited.current = true;
      setSpxDirect(v);
    },
    [setSpxDirect],
  );
  const handleVixChange = useCallback(
    (v: string) => {
      vixEdited.current = true;
      setVixInput(v);
    },
    [setVixInput],
  );

  // Auto-fill inputs from live/historical data + compute history snapshot
  const historySnapshot = useAutoFill({
    spotEdited,
    spxEdited,
    vixEdited,
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
    liveEvents: market.data.events?.events,
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

  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const handleAnalysisSaved = useCallback(
    () => setHistoryRefreshKey((k) => k + 1),
    [],
  );

  const handleVixCsvClick = useCallback(
    () => vixFileInputRef.current?.click(),
    [vixFileInputRef],
  );

  const handleDarkModeToggle = useCallback(
    () => setDarkMode(!darkMode),
    [darkMode, setDarkMode],
  );

  const handleToggleIC = useCallback(() => setShowIC((v) => !v), [setShowIC]);

  const handleUseVix1dAsSigma = useCallback(
    (sigma: number) => {
      setIvMode(IV_MODES.DIRECT);
      setDirectIVInput(sigma.toFixed(4));
    },
    [setIvMode, setDirectIVInput],
  );

  const chevronUrl = useMemo(
    () => buildChevronUrl(theme.chevronColor),
    // darkMode triggers recomputation because the CSS variable resolves differently
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [darkMode, theme.chevronColor],
  );

  const analysisContext = useMemo(
    () =>
      ({
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
        openingRangeSignal: signals.openingRangeSignal ?? undefined,
        openingRangeAvailable: signals.openingRangeAvailable,
        openingRangeHigh: signals.openingRangeHigh ?? undefined,
        openingRangeLow: signals.openingRangeLow ?? undefined,
        openingRangePctConsumed: signals.openingRangePctConsumed ?? undefined,
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
          const row = results?.allDeltas.find((r) => !('error' in r));
          return row && !('error' in row) ? row.ivAccelMult : undefined;
        })(),
        prevClose: signals.prevClose ?? undefined,
        overnightGap:
          signals.overnightGap == null
            ? undefined
            : String(signals.overnightGap),
        isBacktest: !!historySnapshot,
        dataNote: signals.dataNote,
        events: (market.data.events?.events ?? [])
          .filter(
            (e) =>
              (e.severity === 'high' || e.severity === 'medium') &&
              e.date === vix.selectedDate,
          )
          .map((e) => ({
            event: e.event,
            time: e.time,
            severity: e.severity,
          })),
        topOIStrikes:
          chainData.chain?.puts && chainData.chain?.calls && results?.spot
            ? getTopOIStrikes(
                chainData.chain.puts,
                chainData.chain.calls,
                results.spot,
                5,
              )
            : undefined,
        skewMetrics: (() => {
          const chain = chainData.chain;
          if (!chain?.puts?.length || !chain?.calls?.length) return undefined;
          // Find ~25-delta put and call, plus ATM
          const put25 = chain.puts.reduce((best, p) =>
            Math.abs(Math.abs(p.delta) - 0.25) <
            Math.abs(Math.abs(best.delta) - 0.25)
              ? p
              : best,
          );
          const call25 = chain.calls.reduce((best, c) =>
            Math.abs(c.delta - 0.25) < Math.abs(best.delta - 0.25) ? c : best,
          );
          const atm = chain.calls.reduce((best, c) =>
            Math.abs(c.delta - 0.5) < Math.abs(best.delta - 0.5) ? c : best,
          );
          if (!put25.iv || !call25.iv || !atm.iv) return undefined;
          const atmIV = atm.iv * 100;
          const put25dIV = put25.iv * 100;
          const call25dIV = call25.iv * 100;
          const putSkew25d = Math.round((put25dIV - atmIV) * 100) / 100;
          const callSkew25d = Math.round((call25dIV - atmIV) * 100) / 100;
          const skewRatio =
            callSkew25d !== 0
              ? Math.round(
                  (Math.abs(putSkew25d) / Math.abs(callSkew25d)) * 100,
                ) / 100
              : 0;
          return {
            put25dIV: Math.round(put25dIV * 100) / 100,
            call25dIV: Math.round(call25dIV * 100) / 100,
            atmIV: Math.round(atmIV * 100) / 100,
            putSkew25d,
            callSkew25d,
            skewRatio,
          };
        })(),
      }) satisfies AnalysisContext,
    [
      vix.selectedDate,
      timeHour,
      timeMinute,
      timeAmPm,
      timezone,
      results,
      dSpot,
      dVix,
      signals,
      clusterMult,
      historySnapshot,
      market.data.events?.events,
      chainData.chain,
    ],
  );

  return (
    <>
      <div
        id="app-shell"
        className="text-primary min-h-screen font-serif transition-[background-color,color] duration-[250ms]"
      >
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

        {/* Sticky header bar */}
        <header
          className="border-edge sticky top-0 z-50 border-b backdrop-blur-md"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--color-page) 85%, transparent)',
          }}
        >
          <div className="mx-auto flex max-w-[660px] items-center justify-between px-5 py-3 lg:max-w-6xl">
            <div>
              <div className="text-accent font-sans text-[10px] font-bold tracking-[0.2em] uppercase">
                0DTE Options
              </div>
              <h1 className="text-primary m-0 font-serif text-[20px] leading-tight font-bold">
                Strike Calculator
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {historySnapshot && (
                <StatusBadge label="BACKTEST" color={theme.backtest} dot />
              )}
              {historyData.loading && (
                <StatusBadge label="Loading…" color={theme.textMuted} />
              )}
              {historyData.error && !historyData.loading && (
                <StatusBadge
                  label="NO INTRADAY"
                  color={theme.red}
                  dot
                  title={historyData.error}
                />
              )}
              {!historySnapshot && !historyData.error && market.hasData && (
                <StatusBadge
                  label={market.data.quotes?.marketOpen ? 'LIVE' : 'CLOSED'}
                  color={
                    market.data.quotes?.marketOpen
                      ? theme.green
                      : theme.textMuted
                  }
                  dot
                />
              )}
              {market.needsAuth && (
                <StatusBadge
                  label="Re-authenticate"
                  color={theme.red}
                  href="/api/auth/init"
                />
              )}
              <input
                ref={vixFileInputRef}
                type="file"
                accept=".csv"
                onChange={vixHandleFileUpload}
                className="hidden"
                aria-label="Upload VIX OHLC CSV file"
              />
              <button
                onClick={handleVixCsvClick}
                className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200"
              >
                <span className="text-[11px] font-semibold">
                  {vix.vixDataLoaded ? vix.vixDataSource : 'Upload VIX CSV'}
                </span>
              </button>
              <button
                onClick={handleDarkModeToggle}
                aria-label={
                  darkMode ? 'Switch to light mode' : 'Switch to dark mode'
                }
                className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200"
              >
                {darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19'}
                <span className="text-[11px] font-semibold">
                  {darkMode ? 'Light' : 'Dark'}
                </span>
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[660px] px-5 pt-6 pb-12 lg:max-w-6xl">
          {/* Subtitle — below sticky header */}
          <p className="text-secondary mb-8 text-[15px] leading-normal">
            Black-Scholes approximation for delta-based strike placement
          </p>

          <main>
            <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 [&>*]:mt-0">
              <DateTimeSection
                chevronUrl={chevronUrl}
                selectedDate={vix.selectedDate}
                onDateChange={vix.setSelectedDate}
                vixDataLoaded={vix.vixDataLoaded}
                liveEvents={market.data.events?.events}
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

              <SpotPriceSection
                spotPrice={spotPrice}
                onSpotChange={handleSpotChange}
                spxDirect={spxDirect}
                onSpxDirectChange={handleSpxChange}
                spxRatio={spxRatio}
                onSpxRatioChange={setSpxRatio}
                dSpot={dSpot}
                effectiveRatio={effectiveRatio}
                spxDirectActive={spxDirectActive}
                derivedRatio={spxDirectActive ? spxVal / spyVal : spxRatio}
                errors={errors}
              />
            </div>

            {market.hasData && (
              <PreMarketInput
                date={vix.selectedDate}
                spxPrice={results?.spot}
                prevClose={market.data.yesterday?.yesterday?.close}
              />
            )}

            <div className="mt-6 grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 [&>*]:mt-0">
              <AdvancedSection
                skewPct={skewPct}
                onSkewChange={setSkewPct}
                showIC={showIC}
                onToggleIC={handleToggleIC}
                wingWidth={wingWidth}
                onWingWidthChange={setWingWidth}
                contracts={contracts}
                onContractsChange={setContracts}
                results={results}
                vixOHLC={vix.vixOHLC}
                vixOHLCField={vix.vixOHLCField}
                onOHLCFieldChange={vix.setVixOHLCField}
                vixDataLoaded={vix.vixDataLoaded}
                selectedDate={vix.selectedDate}
              />

              <IVInputSection
                ivMode={ivMode}
                onIvModeChange={setIvMode}
                vixInput={vixInput}
                onVixChange={handleVixChange}
                multiplier={multiplier}
                onMultiplierChange={setMultiplier}
                directIVInput={directIVInput}
                onDirectIVChange={setDirectIVInput}
                dVix={dVix}
                results={results}
                errors={errors}
                market={market}
                historySnapshot={historySnapshot}
                onUseVix1dAsSigma={handleUseVix1dAsSigma}
                termShape={signals.vixTermShape}
                termShapeAdvice={signals.vixTermShapeAdvice}
              />
            </div>

            <ErrorBoundary label="Risk Calculator">
              <Suspense
                fallback={
                  <div className="text-muted animate-pulse p-4 text-center text-sm">
                    Loading...
                  </div>
                }
              >
                <RiskCalculator />
              </Suspense>
            </ErrorBoundary>

            <ErrorBoundary label="Market Regime">
              <MarketRegimeSection
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
                <Suspense
                  fallback={
                    <div className="text-muted animate-pulse p-4 text-center text-sm">
                      Loading...
                    </div>
                  }
                >
                  <ChartAnalysis
                    results={results}
                    onAnalysisSaved={handleAnalysisSaved}
                    context={analysisContext}
                  />
                </Suspense>
              </ErrorBoundary>
            )}

            <ErrorBoundary label="Analysis History">
              <AnalysisHistory refreshKey={historyRefreshKey} />
            </ErrorBoundary>

            {/* Paper Dashboard — owner-only, lazy-loaded */}
            <ErrorBoundary label="Paper Dashboard">
              <Suspense
                fallback={
                  <div className="text-muted animate-pulse p-4 text-center text-sm">
                    Loading...
                  </div>
                }
              >
                <PaperDashboard
                  spotPrice={results?.spot ?? spxVal ?? 0}
                  sigma={results?.sigma ?? null}
                  T={results?.T ?? null}
                />
              </Suspense>
            </ErrorBoundary>

            <ErrorBoundary label="Results">
              <ResultsSection
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
      <SpeedInsights />
    </>
  );
}
