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
import { useAlertPolling } from './hooks/useAlertPolling';
import { useDarkPoolLevels } from './hooks/useDarkPoolLevels';
import { useGexPerStrike } from './hooks/useGexPerStrike';
import { useIsOwner } from './hooks/useIsOwner';
import { useAnalysisContext } from './hooks/useAnalysisContext';
import { getEarlyCloseHourET } from './data/marketHours';
import DateTimeSection from './components/DateTimeSection';
import EventDayWarning from './components/EventDayWarning';
import SpotPriceSection from './components/SpotPriceSection';
import IVInputSection from './components/IVInputSection';
import AdvancedSection from './components/AdvancedSection';
import PreMarketInput from './components/PreMarketInput';
import MarketRegimeSection from './components/MarketRegimeSection';
import ResultsSection from './components/ResultsSection';
import AnalysisHistory from './components/ChartAnalysis/AnalysisHistory';
import BWBCalculator from './components/BWBCalculator';
import TradingScheduleSection from './components/TradingScheduleSection';
import BacktestDiag from './components/BacktestDiag';
import ErrorBoundary from './components/ErrorBoundary';
import AlertBanner from './components/AlertBanner';
import DarkPoolLevels from './components/DarkPoolLevels';
import GexPerStrike from './components/GexPerStrike';
import { GexTarget } from './components/GexTarget';
import GexLandscape from './components/GexLandscape';
import NotificationPermission from './components/NotificationPermission';
import { StatusBadge } from './components/ui';
import { CollapseAllContext } from './components/collapse-context';
import type { CollapseSignal } from './components/collapse-context';
import { useToast } from './hooks/useToast';
import SectionNav from './components/SectionNav';
import type { NavSection } from './components/SectionNav';
import BackToTop from './components/BackToTop';
import SkeletonSection from './components/SkeletonSection';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';

const ChartAnalysis = lazy(() => import('./components/ChartAnalysis'));
const RiskCalculator = lazy(() => import('./components/RiskCalculator'));
const PositionMonitor = lazy(() => import('./components/PositionMonitor'));
const MLInsights = lazy(() => import('./components/MLInsights'));
const FuturesPanel = lazy(
  () => import('./components/FuturesCalculator/FuturesPanel'),
);

function SchwabAuthLink({
  ariaLabel,
  text,
  color,
}: {
  ariaLabel: string;
  text: string;
  color?: string;
}) {
  return (
    <a
      href="/api/auth/init"
      className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base no-underline transition-all duration-200"
      style={color ? { color } : undefined}
      aria-label={ariaLabel}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="3"
          y="7"
          width="10"
          height="8"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5.5 7V5a2.5 2.5 0 015 0v2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[11px] font-semibold">{text}</span>
    </a>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function StrikeCalculator() {
  // Consolidated UI state (inputs, debounced values, derived ratio)
  const toast = useToast();
  const isOwner = useIsOwner();
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
    breakevenTarget,
    setBreakevenTarget,
    showBWB,
    setShowBWB,
    bwbNarrowWidth,
    setBwbNarrowWidth,
    bwbWideMultiplier,
    setBwbWideMultiplier,
    portfolioRiskThresholdPct,
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
    handleFileUpload: vixRawUpload,
    ...vix
  } = useVixData(ivMode, timeHour, timeAmPm, timezone, setVixInput);

  const vixHandleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      await vixRawUpload(e);
      if (e.target.files?.[0]) {
        toast.show('VIX CSV loaded', 'success');
      }
    },
    [vixRawUpload, toast],
  );
  const historyData = useHistoryData(vix.selectedDate);
  const vix1dStatic = useVix1dData();
  const chainData = useChainData(
    market.hasData && !historyData.hasHistory,
    market.data.quotes?.marketOpen ?? false,
  );
  const alertState = useAlertPolling(market.data.quotes?.marketOpen ?? false);

  const darkPool = useDarkPoolLevels(market.data.quotes?.marketOpen ?? false);
  // GEX Per Strike owns its own date state, decoupled from the calculator's
  // vix.selectedDate. Picking a past date here is a backtest browsing
  // action and must not re-anchor the Black-Scholes math elsewhere.
  const gexStrike = useGexPerStrike(market.data.quotes?.marketOpen ?? false);
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
      close: candles.at(-1)!.close,
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
  const [csvPositionSummary, setCsvPositionSummary] = useState<string | null>(
    null,
  );
  const handleAnalysisSaved = useCallback(() => {
    setHistoryRefreshKey((k) => k + 1);
    toast.show('Analysis saved', 'success');
  }, [toast]);

  const handleVixCsvClick = useCallback(
    () => vixFileInputRef.current?.click(),
    [vixFileInputRef],
  );

  const [collapseSignal, setCollapseSignal] = useState<CollapseSignal>({
    version: 0,
    collapsed: false,
  });
  const handleCollapseAll = useCallback(() => {
    setCollapseSignal((s) => ({
      version: s.version + 1,
      collapsed: !s.collapsed,
    }));
  }, []);

  const [migrateRunning, setMigrateRunning] = useState(false);
  const handleRunMigrations = useCallback(async () => {
    if (migrateRunning) return;
    setMigrateRunning(true);
    try {
      const res = await fetch('/api/journal/init', { method: 'POST' });
      const body = (await res.json()) as {
        migrated?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const count = body.migrated?.length ?? 0;
      toast.show(
        count === 0 ? 'DB up to date' : `${count} migration(s) applied`,
        'success',
      );
    } catch (err) {
      toast.show(
        err instanceof Error ? err.message : 'Migration failed',
        'error',
      );
    } finally {
      setMigrateRunning(false);
    }
  }, [migrateRunning, toast]);

  const handleDarkModeToggle = useCallback(
    () => setDarkMode(!darkMode),
    [darkMode, setDarkMode],
  );

  const handleToggleIC = useCallback(() => setShowIC((v) => !v), [setShowIC]);
  const handleToggleBWB = useCallback(
    () => setShowBWB((v) => !v),
    [setShowBWB],
  );

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

  const navSections = useMemo<NavSection[]>(() => {
    const hasMarketOrSnapshot = market.hasData || !!historySnapshot;
    return [
      { id: 'sec-inputs', label: 'Inputs' },
      { id: 'sec-settings', label: 'Settings' },
      { id: 'sec-trading-schedule', label: 'Schedule' },
      { id: 'sec-risk', label: 'Risk' },
      { id: 'sec-regime', label: 'Regime' },
      ...(isOwner && hasMarketOrSnapshot
        ? [
            { id: 'sec-darkpool', label: 'Dark Pool' },
            { id: 'sec-gex', label: 'GEX' },
            { id: 'sec-gex-target', label: 'GEX Target' },
            { id: 'sec-gex-landscape', label: 'GEX Map' },
          ]
        : []),
      ...(isOwner
        ? [
            { id: 'sec-futures', label: 'Futures' },
            { id: 'sec-futures-calc', label: 'Futures Calc' },
          ]
        : []),
      ...(hasMarketOrSnapshot ? [{ id: 'sec-charts', label: 'Charts' }] : []),
      { id: 'sec-history', label: 'History' },
      ...(isOwner ? [{ id: 'sec-ml-insights', label: 'ML Insights' }] : []),
      { id: 'sec-positions', label: 'Positions' },
      ...(isOwner ? [{ id: 'sec-bwb', label: 'Settlement Pin' }] : []),
      { id: 'results', label: 'Results' },
    ];
  }, [isOwner, market.hasData, historySnapshot]);

  const analysisContext = useAnalysisContext({
    selectedDate: vix.selectedDate,
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
    events: market.data.events?.events,
    chain: chainData.chain,
  });

  return (
    <CollapseAllContext.Provider value={collapseSignal}>
      <AlertBanner
        alerts={alertState.alerts}
        onAcknowledge={alertState.acknowledge}
      />
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
          <div className="mx-auto flex max-w-[660px] items-center justify-between px-5 py-2 sm:py-3 lg:max-w-6xl">
            <div>
              <div className="text-accent hidden font-sans text-[10px] font-bold tracking-[0.2em] uppercase sm:block">
                0DTE Options
              </div>
              <h1 className="text-primary m-0 font-serif text-[18px] leading-tight font-bold sm:text-[20px]">
                Strike Calculator
              </h1>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
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
                  // FE-STATE-001: three-state live badge.
                  //   Market closed             → CLOSED (muted)
                  //   Market open, fresh        → LIVE   (green)
                  //   Market open, stale  >=90s → STALE  (caution/yellow)
                  //   Market open, stale >=180s → STALE  (red)
                  // isVeryStale implies isStale, so the severity check
                  // cascades from most-severe to least-severe.
                  label={
                    market.data.quotes?.marketOpen
                      ? market.isStale
                        ? 'STALE'
                        : 'LIVE'
                      : 'CLOSED'
                  }
                  color={
                    market.data.quotes?.marketOpen
                      ? market.isVeryStale
                        ? theme.red
                        : market.isStale
                          ? theme.caution
                          : theme.green
                      : theme.textMuted
                  }
                  dot
                  title={
                    market.isStale && market.staleAgeSec != null
                      ? `Quotes ${market.staleAgeSec}s old${market.isVeryStale ? ' — 3+ missed polls' : ''}`
                      : undefined
                  }
                />
              )}
              {!isOwner && (
                <SchwabAuthLink
                  ariaLabel="Authenticate with Schwab"
                  text="Sign in"
                />
              )}
              {market.needsAuth && isOwner && (
                <SchwabAuthLink
                  ariaLabel="Re-authenticate with Schwab"
                  text="Re-auth"
                  color={theme.red}
                />
              )}
              <button
                onClick={handleCollapseAll}
                aria-label={
                  collapseSignal.collapsed
                    ? 'Expand all sections'
                    : 'Collapse all sections'
                }
                title={
                  collapseSignal.collapsed
                    ? 'Expand all sections'
                    : 'Collapse all sections'
                }
                className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200"
              >
                <span className="text-[11px] font-semibold">
                  {collapseSignal.collapsed ? '⊞ Expand' : '⊟ Collapse'}
                </span>
              </button>
              {isOwner && (
                <button
                  onClick={handleRunMigrations}
                  disabled={migrateRunning}
                  aria-label="Run database migrations"
                  title="Run DB migrations"
                  className="border-edge-strong bg-surface hover:bg-surface-alt hover:border-edge-heavy text-primary flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] p-[6px_10px] font-sans text-base transition-all duration-200 disabled:cursor-wait disabled:opacity-50"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <ellipse
                      cx="8"
                      cy="4"
                      rx="5"
                      ry="2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M3 4v4c0 1.1 2.24 2 5 2s5-.9 5-2V4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M3 8v4c0 1.1 2.24 2 5 2s5-.9 5-2V8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                  </svg>
                  <span className="text-[11px] font-semibold">
                    {migrateRunning ? 'Running…' : 'Migrate DB'}
                  </span>
                </button>
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

        <SectionNav sections={navSections} />

        {market.hasData && (
          <NotificationPermission
            permission={alertState.notificationPermission}
            onRequest={alertState.requestPermission}
          />
        )}

        <div className="mx-auto max-w-[660px] px-5 pt-6 pb-12 lg:max-w-6xl">
          {/* Subtitle — below sticky header */}
          <p className="text-secondary mb-1 text-[15px] leading-normal">
            Black-Scholes approximation for delta-based strike placement
          </p>
          <p className="text-tertiary mb-8 text-xs italic">
            Per Unusual Whales data policy, no market data, raw or derived, is
            publicly available on this site.
          </p>

          <main>
            <div
              id="sec-inputs"
              className="grid scroll-mt-28 grid-cols-1 items-stretch gap-4 sm:grid-cols-2 [&>*]:mt-0"
            >
              <DateTimeSection
                chevronUrl={chevronUrl}
                selectedDate={vix.selectedDate}
                onDateChange={vix.setSelectedDate}
                vixDataLoaded={vix.vixDataLoaded}
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

            <EventDayWarning
              selectedDate={vix.selectedDate}
              liveEvents={market.data.events?.events}
            />

            {market.hasData && (
              <PreMarketInput
                date={vix.selectedDate}
                spxPrice={results?.spot}
                prevClose={market.data.yesterday?.yesterday?.close}
              />
            )}

            <div
              id="sec-settings"
              className="mt-6 grid scroll-mt-28 grid-cols-1 items-stretch gap-4 [&>*]:mt-0"
            >
              <AdvancedSection
                skewPct={skewPct}
                onSkewChange={setSkewPct}
                showIC={showIC}
                onToggleIC={handleToggleIC}
                wingWidth={wingWidth}
                onWingWidthChange={setWingWidth}
                contracts={contracts}
                onContractsChange={setContracts}
                showBWB={showBWB}
                onToggleBWB={handleToggleBWB}
                bwbNarrowWidth={bwbNarrowWidth}
                onBwbNarrowWidthChange={setBwbNarrowWidth}
                bwbWideMultiplier={bwbWideMultiplier}
                onBwbWideMultiplierChange={setBwbWideMultiplier}
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

            <span id="sec-trading-schedule" className="block scroll-mt-28" />
            <TradingScheduleSection
              selectedDate={vix.selectedDate}
              timeHour={timeHour}
              timeMinute={timeMinute}
              timeAmPm={timeAmPm}
              timezone={timezone}
            />

            <span id="sec-risk" className="block scroll-mt-28" />
            <ErrorBoundary label="Risk Calculator">
              <Suspense fallback={<SkeletonSection lines={5} />}>
                <RiskCalculator />
              </Suspense>
            </ErrorBoundary>

            <span id="sec-regime" className="block scroll-mt-28" />
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

            {isOwner && (market.hasData || !!historySnapshot) && (
              <>
                <span id="sec-darkpool" className="block scroll-mt-28" />
                <ErrorBoundary label="Dark Pool Levels">
                  <DarkPoolLevels
                    levels={darkPool.levels}
                    loading={darkPool.loading}
                    error={darkPool.error}
                    updatedAt={darkPool.updatedAt}
                    spxPrice={results?.spot ?? spxVal ?? null}
                    onRefresh={darkPool.refresh}
                    selectedDate={darkPool.selectedDate}
                    onDateChange={darkPool.setSelectedDate}
                    scrubTime={darkPool.scrubTime}
                    isLive={darkPool.isLive}
                    isScrubbed={darkPool.isScrubbed}
                    canScrubPrev={darkPool.canScrubPrev}
                    canScrubNext={darkPool.canScrubNext}
                    onScrubPrev={darkPool.scrubPrev}
                    onScrubNext={darkPool.scrubNext}
                    onScrubLive={darkPool.scrubLive}
                  />
                </ErrorBoundary>
              </>
            )}

            {isOwner && (market.hasData || !!historySnapshot) && (
              <>
                <span id="sec-gex" className="block scroll-mt-28" />
                <ErrorBoundary label="0DTE GEX Per Strike">
                  <GexPerStrike
                    strikes={gexStrike.strikes}
                    loading={gexStrike.loading}
                    error={gexStrike.error}
                    timestamp={gexStrike.timestamp}
                    onRefresh={gexStrike.refresh}
                    selectedDate={gexStrike.selectedDate}
                    onDateChange={gexStrike.setSelectedDate}
                    isLive={gexStrike.isLive}
                    isToday={gexStrike.isToday}
                    isScrubbed={gexStrike.isScrubbed}
                    canScrubPrev={gexStrike.canScrubPrev}
                    canScrubNext={gexStrike.canScrubNext}
                    onScrubPrev={gexStrike.scrubPrev}
                    onScrubNext={gexStrike.scrubNext}
                    onScrubLive={gexStrike.scrubLive}
                  />
                </ErrorBoundary>
              </>
            )}

            {isOwner && (market.hasData || !!historySnapshot) && (
              <>
                <span id="sec-gex-target" className="block scroll-mt-28" />
                <ErrorBoundary label="GEX Target">
                  <GexTarget
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </ErrorBoundary>
              </>
            )}

            {isOwner && (market.hasData || !!historySnapshot) && (
              <>
                <span id="sec-gex-landscape" className="block scroll-mt-28" />
                <ErrorBoundary label="GEX Landscape">
                  <GexLandscape
                    strikes={gexStrike.strikes}
                    loading={gexStrike.loading}
                    error={gexStrike.error}
                    timestamp={gexStrike.timestamp}
                    onRefresh={gexStrike.refresh}
                    selectedDate={gexStrike.selectedDate}
                    onDateChange={gexStrike.setSelectedDate}
                    isLive={gexStrike.isLive}
                    isToday={gexStrike.isToday}
                    isScrubbed={gexStrike.isScrubbed}
                    canScrubPrev={gexStrike.canScrubPrev}
                    canScrubNext={gexStrike.canScrubNext}
                    onScrubPrev={gexStrike.scrubPrev}
                    onScrubNext={gexStrike.scrubNext}
                    onScrubLive={gexStrike.scrubLive}
                  />
                </ErrorBoundary>
              </>
            )}

            {isOwner && (
              <>
                <span id="sec-futures" className="block scroll-mt-28" />
                <ErrorBoundary label="Futures">
                  <Suspense fallback={<SkeletonSection lines={5} />}>
                    <FuturesPanel />
                  </Suspense>
                </ErrorBoundary>
              </>
            )}

            {/* Chart Analysis — requires auth session or backtest with results */}
            {(market.hasData || !!historySnapshot) && (
              <>
                <span id="sec-charts" className="block scroll-mt-28" />
                <ErrorBoundary label="Chart Analysis">
                  <Suspense fallback={<SkeletonSection lines={6} tall />}>
                    <ChartAnalysis
                      results={results}
                      onAnalysisSaved={handleAnalysisSaved}
                      context={analysisContext}
                      csvPositionSummary={csvPositionSummary}
                    />
                  </Suspense>
                </ErrorBoundary>
              </>
            )}

            <span id="sec-history" className="block scroll-mt-28" />
            <ErrorBoundary label="Analysis History">
              <AnalysisHistory refreshKey={historyRefreshKey} />
            </ErrorBoundary>

            {isOwner && (
              <>
                <span id="sec-ml-insights" className="block scroll-mt-28" />
                <ErrorBoundary label="ML Insights">
                  <Suspense fallback={<SkeletonSection lines={6} tall />}>
                    <MLInsights />
                  </Suspense>
                </ErrorBoundary>
              </>
            )}

            {/* Paper Dashboard — lazy-loaded */}
            <span id="sec-positions" className="block scroll-mt-28" />
            <ErrorBoundary label="Paper Dashboard">
              <Suspense fallback={<SkeletonSection lines={5} tall />}>
                <PositionMonitor
                  spotPrice={results?.spot ?? spxVal ?? 0}
                  onPositionSummaryChange={setCsvPositionSummary}
                  portfolioRiskThresholdPct={portfolioRiskThresholdPct}
                />
              </Suspense>
            </ErrorBoundary>

            {isOwner && (
              <>
                <span id="sec-bwb" className="block scroll-mt-28" />
                <ErrorBoundary label="BWB Calculator">
                  <BWBCalculator selectedDate={vix.selectedDate} />
                </ErrorBoundary>
              </>
            )}

            <ErrorBoundary label="Results">
              <ResultsSection
                results={results}
                effectiveRatio={effectiveRatio}
                spxDirectActive={spxDirectActive}
                showIC={showIC}
                wingWidth={wingWidth}
                contracts={contracts}
                skewPct={skewPct}
                breakevenTarget={breakevenTarget}
                setBreakevenTarget={setBreakevenTarget}
                showBWB={showBWB}
                bwbNarrowWidth={bwbNarrowWidth}
                bwbWideMultiplier={bwbWideMultiplier}
              />
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <BackToTop />
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
    </CollapseAllContext.Provider>
  );
}
