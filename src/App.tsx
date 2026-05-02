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
import MarketFlow from './components/MarketFlow';
import { useAlertPolling } from './hooks/useAlertPolling';
import { useMarketInternals } from './hooks/useMarketInternals';
import { classifyRegime } from './utils/market-regime';
import { useDarkPoolLevels } from './hooks/useDarkPoolLevels';
import { useGexPerStrike } from './hooks/useGexPerStrike';
import { useGexTarget } from './hooks/useGexTarget';
import { useAccessSession } from './hooks/useAccessSession';
import AccessKeyButton from './components/AccessKey/AccessKeyButton';
import { useAnalysisContext } from './hooks/useAnalysisContext';
import { getEarlyCloseHourET } from './data/marketHours';
import { toETTime } from './utils/time';
import { getCTTime, getETTotalMinutes } from './utils/timezone';
import DateTimeSection from './components/DateTimeSection';
import EventDayWarning from './components/EventDayWarning';
import SpotPriceSection from './components/SpotPriceSection';
import IVInputSection from './components/IVInputSection';
import AdvancedSection from './components/AdvancedSection';
import PreMarketInput from './components/PreMarketInput';
import MarketRegimeSection from './components/MarketRegimeSection';
import ResultsSection from './components/ResultsSection';
import AnalysisHistory from './components/ChartAnalysis/AnalysisHistory';
import TradingScheduleSection from './components/TradingScheduleSection';
import BacktestDiag from './components/BacktestDiag';
import ErrorBoundary from './components/ErrorBoundary';
import GatedSection from './components/GatedSection';
import AppHeader from './components/AppHeader';
import AlertBanner from './components/AlertBanner';
import DarkPoolLevels from './components/DarkPoolLevels';
import TRACELiveDashboard from './components/TRACELive';
import { MarketInternalsPanel } from './components/MarketInternals/MarketInternalsPanel';
import VegaSpikeFeed from './components/VegaSpikeFeed/VegaSpikeFeed';
import NotificationPermission from './components/NotificationPermission';
import { CollapseAllContext } from './components/collapse-context';
import type { AmPm, Timezone } from './types';
import type { CollapseSignal } from './components/collapse-context';
import type { PlaybookBias } from './utils/futures-gamma/types';
import { useToast } from './hooks/useToast';
import SectionNav from './components/SectionNav';
import type { NavSection } from './components/SectionNav';
import BackToTop from './components/BackToTop';
import SkeletonSection from './components/SkeletonSection';
import UpdateAvailableBanner from './components/UpdateAvailable/UpdateAvailableBanner';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';

// Wrap lazy dynamic imports so that a stale SW-cached chunk after a deploy
// prompts the user to reload instead of silently failing inside Suspense.
// Matches the pattern in BWBSection/IronCondorSection export buttons.
function handleStaleChunk(err: unknown): never {
  const isChunkError =
    err instanceof TypeError &&
    /dynamically imported module|fetch/i.test(err.message);
  if (isChunkError) {
    if (confirm('A new version is available. Reload now?')) {
      globalThis.location.reload();
    }
  }
  throw err;
}

const ChartAnalysis = lazy(() =>
  import('./components/ChartAnalysis').catch(handleStaleChunk),
);
const RiskCalculator = lazy(() =>
  import('./components/RiskCalculator').catch(handleStaleChunk),
);
const PositionMonitor = lazy(() =>
  import('./components/PositionMonitor').catch(handleStaleChunk),
);
const MLInsights = lazy(() =>
  import('./components/MLInsights').catch(handleStaleChunk),
);
const PeriscopeChat = lazy(() =>
  import('./components/PeriscopeChat/PeriscopeChat.tsx').catch(
    handleStaleChunk,
  ),
);
const PeriscopeChatHistory = lazy(() =>
  import('./components/PeriscopeChat/PeriscopeChatHistory.tsx').catch(
    handleStaleChunk,
  ),
);
const FuturesPanel = lazy(() =>
  import('./components/FuturesCalculator/FuturesPanel').catch(handleStaleChunk),
);
const GexPerStrike = lazy(() =>
  import('./components/GexPerStrike').catch(handleStaleChunk),
);
const GexTarget = lazy(() =>
  import('./components/GexTarget')
    .then((m) => ({ default: m.GexTarget }))
    .catch(handleStaleChunk),
);
const GexLandscape = lazy(() =>
  import('./components/GexLandscape').catch(handleStaleChunk),
);
const FuturesGammaPlaybook = lazy(() =>
  import('./components/FuturesGammaPlaybook').catch(handleStaleChunk),
);
const ZeroGammaPanel = lazy(() =>
  import('./components/ZeroGammaPanel')
    .then((m) => ({ default: m.ZeroGammaPanel }))
    .catch(handleStaleChunk),
);
const GreekFlowPanel = lazy(() =>
  import('./components/GreekFlowPanel')
    .then((m) => ({ default: m.GreekFlowPanel }))
    .catch(handleStaleChunk),
);
const BWBCalculator = lazy(() =>
  import('./components/BWBCalculator').catch(handleStaleChunk),
);
const OtmFlowAlerts = lazy(() =>
  import('./components/OtmFlowAlerts/OtmFlowAlerts').catch(handleStaleChunk),
);
const InstitutionalProgramSection = lazy(() =>
  import('./components/InstitutionalProgram/InstitutionalProgramSection')
    .then((m) => ({ default: m.InstitutionalProgramSection }))
    .catch(handleStaleChunk),
);
const WhaleAnomaliesSection = lazy(() =>
  import('./components/WhaleAnomalies/WhaleAnomaliesSection')
    .then((m) => ({ default: m.WhaleAnomaliesSection }))
    .catch(handleStaleChunk),
);
const GammaSqueezeFeed = lazy(() =>
  import('./components/GammaSqueezes/GammaSqueezeFeed')
    .then((m) => ({ default: m.GammaSqueezeFeed }))
    .catch(handleStaleChunk),
);
const WhaleBanner = lazy(() =>
  import('./components/WhaleAnomalies/WhaleBanner')
    .then((m) => ({ default: m.WhaleBanner }))
    .catch(handleStaleChunk),
);

// ============================================================
// ADMIN ENDPOINT RESPONSE SHAPES
// ============================================================
// Inline types for owner-only admin POSTs invoked from this file. Both
// endpoints return either a success-shaped body or `{ error: string }`
// — `error` is the only field that's always meaningful on a !res.ok
// response.

interface BackfillFeaturesResponse {
  dates?: number;
  featuresBuilt?: number;
  errors?: number;
  error?: string;
}

interface RunMigrationsResponse {
  migrated?: string[];
  error?: string;
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function StrikeCalculator() {
  // Consolidated UI state (inputs, debounced values, derived ratio)
  const toast = useToast();
  const { mode: accessMode } = useAccessSession();
  // `isOwner` is the strict check — admin buttons (Migrate / Backfill / Re-auth)
  // and the public Sign-in CTA only key off this. `isAuthenticated` is the
  // visibility gate for owner-or-guest sections; a guest in read-only mode
  // sees the gated UI but can't trigger admin actions.
  const isOwner = accessMode === 'owner';
  const isAuthenticated = accessMode !== 'public';
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
  // Single hook call for market internals — shared by MarketInternalsPanel
  // and FlowConfluencePanel to avoid duplicate 60-second polling loops.
  const internals = useMarketInternals({
    marketOpen: market.data.quotes?.marketOpen ?? false,
  });
  // Single regime classification — consumed by MarketInternalsPanel (badge)
  // and FlowConfluencePanel (annotation) to avoid redundant computation.
  const regime = useMemo(
    () => classifyRegime(internals.bars),
    [internals.bars],
  );
  // Single source of truth for GEX target data. Drives both the GexTarget
  // panel AND the OptionsFlowTable's Net GEX column so flow-vs-GEX confluence
  // is visible at a glance (strong flow into a positive-GEX magnet reads
  // differently than flow into a negative-GEX wall). Calling the hook once
  // here prevents dual polling intervals and divergent state trees.
  const gexTarget = useGexTarget(market.data.quotes?.marketOpen ?? false);
  const gexByStrikeForFlow = useMemo(() => {
    const map = new Map<number, number>();
    gexTarget.oi?.leaderboard.forEach((s) => {
      map.set(s.strike, s.features.gexDollars);
    });
    return map;
  }, [gexTarget.oi]);
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
  // timeEdited freezes the live time-sync until the user changes the date
  // or clicks "Resume live". Mirrored as state so the Resume-live chip
  // re-renders when the flag flips (refs alone don't trigger renders).
  const timeEdited = useRef(false);
  const [timeEditedForDisplay, setTimeEditedForDisplay] = useState(false);
  const markTimeEdited = useCallback(() => {
    if (!timeEdited.current) {
      timeEdited.current = true;
      setTimeEditedForDisplay(true);
    }
  }, []);
  const clearTimeEdited = useCallback(() => {
    if (timeEdited.current) {
      timeEdited.current = false;
      setTimeEditedForDisplay(false);
    }
  }, []);
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
  const handleTimeHourChange = useCallback(
    (v: string) => {
      markTimeEdited();
      setTimeHour(v);
    },
    [markTimeEdited, setTimeHour],
  );
  const handleTimeMinuteChange = useCallback(
    (v: string) => {
      markTimeEdited();
      setTimeMinute(v);
    },
    [markTimeEdited, setTimeMinute],
  );
  const handleTimeAmPmChange = useCallback(
    (v: AmPm) => {
      markTimeEdited();
      setTimeAmPm(v);
    },
    [markTimeEdited, setTimeAmPm],
  );
  const handleTimezoneChange = useCallback(
    (v: Timezone) => {
      markTimeEdited();
      setTimezone(v);
    },
    [markTimeEdited, setTimezone],
  );
  const { setSelectedDate: setVixSelectedDate } = vix;
  const handleDateChange = useCallback(
    (date: string) => {
      // Changing the date implies a fresh intent — release the time lock
      // so the new date inherits live-sync behavior.
      clearTimeEdited();
      setVixSelectedDate(date);
    },
    [clearTimeEdited, setVixSelectedDate],
  );
  const handleResumeLive = useCallback(() => {
    clearTimeEdited();
    const now = new Date();
    const ct = getCTTime(now);
    let h = ct.hour;
    const snappedMin = Math.floor(ct.minute / 5) * 5;
    const ampm: AmPm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    setTimeHour(String(h));
    setTimeMinute(String(snappedMin).padStart(2, '0'));
    setTimeAmPm(ampm);
    setTimezone('CT');
  }, [clearTimeEdited, setTimeHour, setTimeMinute, setTimeAmPm, setTimezone]);

  // Auto-fill inputs from live/historical data + compute history snapshot
  const historySnapshot = useAutoFill({
    spotEdited,
    spxEdited,
    vixEdited,
    timeEdited,
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

  // True whenever the selected date+time is in the past — drives BACKTEST
  // badge independently of whether candle data is available. This decouples
  // "are we viewing a historical moment?" (UI state) from "do we have price
  // data for it?" (data state).
  const isBacktestMode = useMemo(() => {
    if (!vix.selectedDate) return false;
    const todayET = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    if (vix.selectedDate < todayET) return true;
    if (vix.selectedDate > todayET) return false;
    // Today: backtest when selected time is more than 5 min in the past
    const { etHour, etMinute } = toETTime(
      timeHour,
      timeMinute,
      timeAmPm,
      timezone,
    );
    const selectedMin = etHour * 60 + etMinute;
    const currentMin = getETTotalMinutes(new Date());
    return selectedMin < currentMin - 5;
  }, [vix.selectedDate, timeHour, timeMinute, timeAmPm, timezone]);

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
  const [gexBiasContext, setGexBiasContext] = useState<string | null>(null);
  const [playbookBiasContext, setPlaybookBiasContext] =
    useState<PlaybookBias | null>(null);
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
  const [backfillRunning, setBackfillRunning] = useState(false);
  const handleBackfillFeatures = useCallback(async () => {
    if (backfillRunning) return;
    setBackfillRunning(true);
    try {
      const res = await fetch('/api/journal/backfill-features', {
        method: 'POST',
      });
      const body: BackfillFeaturesResponse = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.show(
        `Built features for ${body.featuresBuilt ?? 0} of ${body.dates ?? 0} dates` +
          (body.errors ? ` (${body.errors} errors)` : ''),
        body.errors && body.errors > 0 ? 'info' : 'success',
      );
    } catch (err) {
      toast.show(
        `Backfill failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setBackfillRunning(false);
    }
  }, [backfillRunning, toast]);
  const handleRunMigrations = useCallback(async () => {
    if (migrateRunning) return;
    setMigrateRunning(true);
    try {
      const res = await fetch('/api/journal/init', { method: 'POST' });
      const body: RunMigrationsResponse = await res.json();
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

  // Owner/guest data sections need EITHER live market context OR a backtest
  // snapshot to render meaningfully. Hoisted so the JSX gate is a single
  // boolean and `<GatedSection gate={...}>` can read it directly.
  const hasMarketOrSnapshot = market.hasData || !!historySnapshot;
  const hasMarketContext = isAuthenticated && hasMarketOrSnapshot;

  const navSections = useMemo<NavSection[]>(() => {
    return [
      { id: 'sec-inputs', label: 'Inputs' },
      { id: 'sec-trading-schedule', label: 'Trading Schedule' },
      { id: 'sec-settings', label: 'Settings' },
      { id: 'sec-risk', label: 'Risk Calculator' },
      { id: 'sec-regime', label: 'Market Regime' },
      ...(isAuthenticated && hasMarketOrSnapshot
        ? [
            { id: 'sec-darkpool', label: 'Dark Pool Levels' },
            { id: 'sec-trace-live', label: 'TRACE Live' },
            { id: 'sec-gex', label: 'GEX Per Strike' },
            { id: 'sec-gex-target', label: 'GEX Target' },
            { id: 'sec-gex-landscape', label: 'GEX Landscape' },
            {
              id: 'sec-futures-gamma-playbook',
              label: 'Futures Gamma Playbook',
            },
            { id: 'sec-zero-gamma', label: 'Zero Gamma' },
            { id: 'sec-market-internals', label: 'Breadth & TICK' },
            { id: 'sec-vega-spikes', label: 'Dir Vega Spikes' },
            { id: 'sec-greek-flow', label: 'Greek Flow' },
            { id: 'sec-market-flow', label: 'Market Flow' },
            { id: 'sec-otm-flow', label: 'OTM Flow Alerts' },
            { id: 'sec-institutional-program', label: 'Institutional Program' },
            { id: 'sec-whale-anomalies', label: 'Whale Anomalies' },
            { id: 'sec-gamma-squeezes', label: 'Gamma Squeezes' },
          ]
        : []),
      ...(isAuthenticated
        ? [{ id: 'sec-futures', label: 'Futures Calculator' }]
        : []),
      ...(hasMarketOrSnapshot
        ? [{ id: 'sec-charts', label: 'Chart Analysis' }]
        : []),
      { id: 'sec-history', label: 'Analysis History' },
      ...(isAuthenticated
        ? [{ id: 'sec-ml-insights', label: 'ML Insights' }]
        : []),
      ...(isAuthenticated
        ? [{ id: 'sec-periscope-chat', label: 'Periscope Chat' }]
        : []),
      ...(isAuthenticated
        ? [{ id: 'sec-periscope-history', label: 'Periscope History' }]
        : []),
      { id: 'sec-positions', label: 'Position Monitor' },
      ...(isAuthenticated ? [{ id: 'sec-bwb', label: 'BWB Calculator' }] : []),
      { id: 'results', label: 'Results' },
    ];
  }, [isAuthenticated, hasMarketOrSnapshot]);

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
    gexLandscapeBias: gexBiasContext,
    playbookBias: playbookBiasContext
      ? JSON.stringify(playbookBiasContext)
      : null,
  });

  return (
    <CollapseAllContext.Provider value={collapseSignal}>
      <AlertBanner
        alerts={alertState.alerts}
        onAcknowledge={alertState.acknowledge}
      />
      <div
        id="app-shell"
        className="text-primary min-h-dvh font-serif transition-[background-color,color] duration-[250ms]"
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

        <AppHeader
          accessMode={accessMode}
          isOwner={isOwner}
          isBacktestMode={isBacktestMode}
          market={market}
          historyData={historyData}
          vix={vix}
          vixFileInputRef={vixFileInputRef}
          vixHandleFileUpload={vixHandleFileUpload}
          onVixCsvClick={handleVixCsvClick}
          collapseSignal={collapseSignal}
          onCollapseAll={handleCollapseAll}
          onRunMigrations={handleRunMigrations}
          migrateRunning={migrateRunning}
          onBackfillFeatures={handleBackfillFeatures}
          backfillRunning={backfillRunning}
          darkMode={darkMode}
          onDarkModeToggle={handleDarkModeToggle}
        />

        <div className="lg:flex lg:items-start">
          <SectionNav
            sections={navSections}
            orientation="vertical"
            bottomSlot={<AccessKeyButton />}
          />

          <div className="lg:min-w-0 lg:flex-1">
            <SectionNav sections={navSections} orientation="horizontal" />

            {market.hasData && (
              <NotificationPermission
                permission={alertState.notificationPermission}
                onRequest={alertState.requestPermission}
              />
            )}

            {isAuthenticated && (
              <Suspense fallback={null}>
                <WhaleBanner />
              </Suspense>
            )}

            <div className="mx-auto max-w-[660px] px-5 pt-6 pb-12 lg:max-w-6xl">
              {/* Subtitle — below sticky header */}
              <p className="text-secondary mb-1 text-[15px] leading-normal">
                Black-Scholes approximation for delta-based strike placement
              </p>
              <p className="text-tertiary mb-8 text-xs italic">
                Per Unusual Whales data policy, no market data, raw or derived,
                is publicly available on this site.
              </p>

              <main>
                <div
                  id="sec-inputs"
                  className="grid scroll-mt-28 grid-cols-1 items-stretch gap-4 sm:grid-cols-2 [&>*]:mt-0"
                >
                  <DateTimeSection
                    chevronUrl={chevronUrl}
                    selectedDate={vix.selectedDate}
                    onDateChange={handleDateChange}
                    vixDataLoaded={vix.vixDataLoaded}
                    timeHour={timeHour}
                    onHourChange={handleTimeHourChange}
                    timeMinute={timeMinute}
                    onMinuteChange={handleTimeMinuteChange}
                    timeAmPm={timeAmPm}
                    onAmPmChange={handleTimeAmPmChange}
                    timezone={timezone}
                    onTimezoneChange={handleTimezoneChange}
                    timeEdited={timeEditedForDisplay}
                    onResumeLive={handleResumeLive}
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

                <span
                  id="sec-trading-schedule"
                  className="block scroll-mt-28"
                />
                <TradingScheduleSection
                  selectedDate={vix.selectedDate}
                  timeHour={timeHour}
                  timeMinute={timeMinute}
                  timeAmPm={timeAmPm}
                  timezone={timezone}
                />

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

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-darkpool"
                  label="Dark Pool Levels"
                >
                  <DarkPoolLevels
                    levels={darkPool.levels}
                    loading={darkPool.loading}
                    error={darkPool.error}
                    updatedAt={darkPool.updatedAt}
                    spxPrice={
                      darkPool.isLive
                        ? (market.data.quotes?.spx?.price ??
                          results?.spot ??
                          spxVal ??
                          null)
                        : (results?.spot ?? spxVal ?? null)
                    }
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
                    onScrubTo={darkPool.scrubTo}
                    timeGrid={darkPool.timeGrid}
                    onScrubLive={darkPool.scrubLive}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-trace-live"
                  label="TRACE Live"
                >
                  <TRACELiveDashboard
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-gex"
                  label="0DTE GEX Per Strike"
                  fallback={<SkeletonSection lines={6} tall />}
                >
                  <GexPerStrike
                    strikes={gexStrike.strikes}
                    loading={gexStrike.loading}
                    error={gexStrike.error}
                    timestamp={gexStrike.timestamp}
                    timestamps={gexStrike.timestamps}
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
                    onScrubTo={gexStrike.scrubTo}
                    onScrubLive={gexStrike.scrubLive}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-gex-target"
                  label="GEX Target"
                  fallback={<SkeletonSection lines={6} tall />}
                >
                  <GexTarget
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                    gexTarget={gexTarget}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-gex-landscape"
                  label="GEX Landscape"
                  fallback={<SkeletonSection lines={6} tall />}
                >
                  <GexLandscape
                    strikes={gexStrike.strikes}
                    loading={gexStrike.loading}
                    error={gexStrike.error}
                    timestamp={gexStrike.timestamp}
                    timestamps={gexStrike.timestamps}
                    onRefresh={gexStrike.refresh}
                    selectedDate={gexStrike.selectedDate}
                    onDateChange={gexStrike.setSelectedDate}
                    isLive={gexStrike.isLive}
                    isScrubbed={gexStrike.isScrubbed}
                    canScrubPrev={gexStrike.canScrubPrev}
                    canScrubNext={gexStrike.canScrubNext}
                    onScrubPrev={gexStrike.scrubPrev}
                    onScrubNext={gexStrike.scrubNext}
                    onScrubTo={gexStrike.scrubTo}
                    onScrubLive={gexStrike.scrubLive}
                    onBiasChange={setGexBiasContext}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-futures-gamma-playbook"
                  label="Futures Gamma Playbook"
                  fallback={<SkeletonSection lines={6} tall />}
                >
                  <FuturesGammaPlaybook
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                    onBiasChange={setPlaybookBiasContext}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-zero-gamma"
                  label="Zero Gamma"
                  fallback={<SkeletonSection lines={4} />}
                >
                  <ZeroGammaPanel
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-market-internals"
                  label="Breadth & TICK"
                >
                  <MarketInternalsPanel
                    {...internals}
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                    regime={regime}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-vega-spikes"
                  label="Dir Vega Spikes"
                >
                  <VegaSpikeFeed
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-greek-flow"
                  label="Greek Flow"
                  fallback={<SkeletonSection lines={5} />}
                >
                  <GreekFlowPanel
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-market-flow"
                  label="Market Flow"
                >
                  <MarketFlow
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                    regime={regime}
                    gexByStrike={gexByStrikeForFlow}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-otm-flow"
                  label="OTM Flow Alerts"
                  fallback={<SkeletonSection lines={5} />}
                >
                  <OtmFlowAlerts
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-institutional-program"
                  label="Institutional Program"
                  fallback={<SkeletonSection lines={6} />}
                >
                  <InstitutionalProgramSection />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-whale-anomalies"
                  label="Whale Anomalies"
                  fallback={<SkeletonSection lines={5} />}
                >
                  <WhaleAnomaliesSection
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </GatedSection>

                <GatedSection
                  gate={hasMarketContext}
                  id="sec-gamma-squeezes"
                  label="Gamma Squeezes"
                  fallback={<SkeletonSection lines={5} />}
                >
                  <GammaSqueezeFeed
                    marketOpen={market.data.quotes?.marketOpen ?? false}
                  />
                </GatedSection>

                {isAuthenticated && (
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

                {isAuthenticated && (
                  <>
                    <span id="sec-ml-insights" className="block scroll-mt-28" />
                    <ErrorBoundary label="ML Insights">
                      <Suspense fallback={<SkeletonSection lines={6} tall />}>
                        <MLInsights />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}

                {isAuthenticated && (
                  <>
                    <span
                      id="sec-periscope-chat"
                      className="block scroll-mt-28"
                    />
                    <ErrorBoundary label="Periscope Chat">
                      <Suspense fallback={<SkeletonSection lines={4} tall />}>
                        <PeriscopeChat />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}

                {isAuthenticated && (
                  <>
                    <span
                      id="sec-periscope-history"
                      className="block scroll-mt-28"
                    />
                    <ErrorBoundary label="Periscope History">
                      <Suspense fallback={<SkeletonSection lines={4} tall />}>
                        <PeriscopeChatHistory />
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

                {isAuthenticated && (
                  <>
                    <span id="sec-bwb" className="block scroll-mt-28" />
                    <ErrorBoundary label="BWB Calculator">
                      <Suspense fallback={<SkeletonSection lines={5} tall />}>
                        <BWBCalculator
                          selectedDate={vix.selectedDate}
                          vix={vixInput}
                        />
                      </Suspense>
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
        </div>
      </div>
      <BackToTop />
      <UpdateAvailableBanner pushedUp={historySnapshot != null} />
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
