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
import { useIntervalBAAlerts } from './hooks/useIntervalBAAlerts';
import { usePushSubscription } from './hooks/usePushSubscription';
import { useDarkPoolLevels } from './hooks/useDarkPoolLevels';
import { useGexTarget } from './hooks/useGexTarget';
import {
  usePeriscopeExposure,
  type PeriscopeSelectedSlot,
} from './hooks/usePeriscopeExposure';
import { usePeriscopePlaybook } from './hooks/usePeriscopePlaybook';
import { useAccessSession } from './hooks/useAccessSession';
import { usePanelPrefs } from './hooks/usePanelPrefs';
import { getPanelRegistry } from './constants/panel-registry';
import { PanelPrefsModal } from './components/PanelPrefsModal/PanelPrefsModal';
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
import BacktestDiag from './components/BacktestDiag';
import ErrorBoundary from './components/ErrorBoundary';
import GatedSection from './components/GatedSection';
import AppHeader from './components/AppHeader';
import AlertBanner from './components/AlertBanner';
import IntervalBAAlertBanner from './components/IntervalBAAlertBanner';
import { IntervalBAFeed } from './components/IntervalBAFeed/IntervalBAFeed';
import DarkPoolLevels from './components/DarkPoolLevels';
import { PeriscopePanel } from './components/Periscope/PeriscopePanel';
import { OpeningFlowSignal } from './components/OpeningFlowSignal';
import PinSetupTile from './components/PinSetupTile';
import { SectionBox } from './components/ui';
import VegaSpikeFeed from './components/VegaSpikeFeed/VegaSpikeFeed';
import NotificationPermission from './components/NotificationPermission';
import { CollapseAllContext } from './components/collapse-context';
import type { AmPm, Timezone } from './types';
import type { CollapseSignal } from './components/collapse-context';
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
const PeriscopeChatHistory = lazy(() =>
  import('./components/PeriscopeChat/PeriscopeChatHistory.tsx').catch(
    handleStaleChunk,
  ),
);
const LessonLibrary = lazy(() =>
  import('./components/PeriscopeChat/LessonLibrary.tsx').catch(
    handleStaleChunk,
  ),
);
const FuturesPanel = lazy(() =>
  import('./components/FuturesCalculator/FuturesPanel').catch(handleStaleChunk),
);
const GexTarget = lazy(() =>
  import('./components/GexTarget')
    .then((m) => ({ default: m.GexTarget }))
    .catch(handleStaleChunk),
);
const GexLandscape = lazy(() =>
  import('./components/GexLandscape').catch(handleStaleChunk),
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
const StrikeBattleMap = lazy(() =>
  import('./components/StrikeBattleMap')
    .then((m) => ({ default: m.StrikeBattleMap }))
    .catch(handleStaleChunk),
);
const DealerRegimeTile = lazy(() =>
  import('./components/DealerRegimeTile')
    .then((m) => ({ default: m.DealerRegimeTile }))
    .catch(handleStaleChunk),
);
const BWBCalculator = lazy(() =>
  import('./components/BWBCalculator').catch(handleStaleChunk),
);
const LotteryFinderSection = lazy(() =>
  import('./components/LotteryFinder/LotteryFinderSection')
    .then((m) => ({ default: m.LotteryFinderSection }))
    .catch(handleStaleChunk),
);
const GreekHeatmapSection = lazy(() =>
  import('./components/GreekHeatmap/GreekHeatmapSection')
    .then((m) => ({ default: m.GreekHeatmapSection }))
    .catch(handleStaleChunk),
);
const GexbotSection = lazy(() =>
  import('./components/Gexbot/GexbotSection')
    .then((m) => ({ default: m.GexbotSection }))
    .catch(handleStaleChunk),
);
const SilentBoomSection = lazy(() =>
  import('./components/SilentBoom/SilentBoomSection')
    .then((m) => ({ default: m.SilentBoomSection }))
    .catch(handleStaleChunk),
);
const TrackerSection = lazy(() =>
  import('./components/Tracker/TrackerSection')
    .then((m) => ({ default: m.TrackerSection }))
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
  const panelPrefs = usePanelPrefs();
  const [panelPrefsOpen, setPanelPrefsOpen] = useState(false);
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
  const intervalBAAlertState = useIntervalBAAlerts(
    market.data.quotes?.marketOpen ?? false,
  );
  // Web Push v2 (interval-ba-push-v2-2026-05-12.md): subscribe() runs
  // the full grant + register + POST /api/push/subscribe flow. No-op
  // when VITE_VAPID_PUBLIC_KEY is unset, so the existing in-tab
  // Notification permission CTA stays functional in v2-dormant mode.
  const pushSub = usePushSubscription();

  const darkPool = useDarkPoolLevels(market.data.quotes?.marketOpen ?? false);
  // Periscope panel time-travel: null = follow live (latest slot,
  // polling on); set = view a historical slot, polling paused.
  const [periscopeSlot, setPeriscopeSlot] =
    useState<PeriscopeSelectedSlot | null>(null);
  const periscope = usePeriscopeExposure({
    marketOpen: market.data.quotes?.marketOpen ?? false,
    spotHint: market.data.quotes?.spx?.price ?? null,
    selectedSlot: periscopeSlot,
  });
  // Phase 4c: parallel hook for Claude's auto-playbook. When a complete
  // panel_payload exists for the selected date, the panel renders it
  // above (and instead of) the deterministic TradePlanSection. When
  // viewing a historical slot, pass its date so the playbook lookup
  // mirrors the time-travel selection. Also pin to the rendered exposure
  // view's `capturedAt` so prev/next on the time picker refetches the
  // matching playbook (otherwise the API returns the latest debrief row
  // regardless of which slot the panel is showing).
  const periscopePlaybook = usePeriscopePlaybook({
    marketOpen: market.data.quotes?.marketOpen ?? false,
    selectedDate: periscopeSlot?.date ?? null,
    selectedSlotCapturedAt:
      periscopeSlot != null ? (periscope.view?.capturedAt ?? null) : null,
  });
  // GEX Landscape owns its own date / scrub state internally and pulls
  // MM-attributed per-strike data via `useGexLandscapeData` →
  // `/api/periscope-strikes` (with a WS side channel for vol
  // reinforcement). SPX-only since Phase 3 of the MM swap, so App.tsx
  // no longer threads ticker or per-strike props through.
  const gexTarget = useGexTarget(market.data.quotes?.marketOpen ?? false);
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

  // Single source of truth: getPanelRegistry. The same registry feeds
  // the section-nav menu AND the show/hide-panels modal. Adding a new
  // panel is a one-line edit in src/constants/panel-registry.ts.
  // Filter out hidden panels so the nav menu doesn't list jump targets
  // for sections the user has chosen to hide. Depending on the `hidden`
  // Set (not the whole `panelPrefs` object, which is fresh every render)
  // keeps the memo from invalidating on unrelated re-renders.
  const hiddenPanels = panelPrefs.hidden;
  const navSections = useMemo<NavSection[]>(
    () =>
      getPanelRegistry({ isAuthenticated, hasMarketOrSnapshot })
        .filter(({ id }) => id === 'results' || !hiddenPanels.has(id))
        .map(({ id, label }) => ({ id, label })),
    [isAuthenticated, hasMarketOrSnapshot, hiddenPanels],
  );

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
  });

  return (
    <CollapseAllContext.Provider value={collapseSignal}>
      <AlertBanner
        alerts={alertState.alerts}
        onAcknowledge={alertState.acknowledge}
      />
      <IntervalBAAlertBanner
        alerts={intervalBAAlertState.alerts}
        onAcknowledge={intervalBAAlertState.acknowledge}
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
          onOpenPanelPrefs={() => setPanelPrefsOpen(true)}
        />

        <PanelPrefsModal
          isOpen={panelPrefsOpen}
          onClose={() => setPanelPrefsOpen(false)}
          panelPrefs={panelPrefs}
          isAuthenticated={isAuthenticated}
          hasMarketOrSnapshot={hasMarketOrSnapshot}
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
                onRequest={async () => {
                  // Phase 3 path: bump Notification.permission so the
                  // in-tab notifications fire from the polling hooks.
                  await alertState.requestPermission();
                  // v2 path: also register a Web Push subscription so
                  // alerts can fire with the tab closed / minimized /
                  // mobile PWA backgrounded. Silent no-op when
                  // VITE_VAPID_PUBLIC_KEY is unset (v2 dormant).
                  await pushSub.subscribe();
                }}
              />
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
                <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 [&>*]:mt-0">
                  {!panelPrefs.isHidden('sec-datetime') && (
                    <div id="sec-datetime" className="scroll-mt-28">
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
                    </div>
                  )}

                  {!panelPrefs.isHidden('sec-spot-price') && (
                    <div id="sec-spot-price" className="scroll-mt-28">
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
                        derivedRatio={
                          spxDirectActive ? spxVal / spyVal : spxRatio
                        }
                        errors={errors}
                      />
                    </div>
                  )}
                </div>

                <EventDayWarning
                  selectedDate={vix.selectedDate}
                  liveEvents={market.data.events?.events}
                />

                {!panelPrefs.isHidden('sec-premarket') && (
                  <div id="sec-premarket" className="mt-6 scroll-mt-28">
                    <SectionBox label="Pre-Market Signals">
                      <OpeningFlowSignal />
                      <hr className="border-edge my-4" />
                      <PinSetupTile
                        marketOpen={market.data.quotes?.marketOpen ?? false}
                      />
                    </SectionBox>
                    {market.hasData && (
                      <PreMarketInput
                        date={vix.selectedDate}
                        spxPrice={results?.spot}
                        prevClose={market.data.yesterday?.yesterday?.close}
                      />
                    )}
                  </div>
                )}

                <div className="mt-6 grid grid-cols-1 items-stretch gap-4 [&>*]:mt-0">
                  {!panelPrefs.isHidden('sec-advanced') && (
                    <div id="sec-advanced" className="scroll-mt-28">
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
                        defaultCollapsed
                      />
                    </div>
                  )}

                  {!panelPrefs.isHidden('sec-iv') && (
                    <div id="sec-iv" className="scroll-mt-28">
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
                        defaultCollapsed
                      />
                    </div>
                  )}
                </div>

                {!panelPrefs.isHidden('sec-risk') && (
                  <>
                    <span id="sec-risk" className="block scroll-mt-28" />
                    <ErrorBoundary label="Risk Calculator">
                      <Suspense fallback={<SkeletonSection lines={5} />}>
                        <RiskCalculator defaultCollapsed />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}

                {!panelPrefs.isHidden('sec-regime') && (
                  <>
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
                        defaultCollapsed
                      />
                    </ErrorBoundary>
                  </>
                )}

                {!panelPrefs.isHidden('sec-darkpool') && (
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
                        // SPX selector is the only one with a wired
                        // reference price; pass null for NDX/SPY/QQQ so
                        // the distance column hides cleanly until those
                        // price sources are added in a follow-up.
                        darkPool.selectedSymbol !== 'SPX'
                          ? null
                          : darkPool.isLive
                            ? (market.data.quotes?.spx?.price ??
                              results?.spot ??
                              spxVal ??
                              null)
                            : (results?.spot ?? spxVal ?? null)
                      }
                      onRefresh={darkPool.refresh}
                      selectedSymbol={darkPool.selectedSymbol}
                      onSymbolChange={darkPool.setSelectedSymbol}
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
                )}

                {!panelPrefs.isHidden('sec-gex-target') && (
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
                )}

                {!panelPrefs.isHidden('sec-gex-landscape') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-gex-landscape"
                    label="GEX Landscape"
                    fallback={<SkeletonSection lines={6} tall />}
                  >
                    <GexLandscape
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                      onBiasChange={setGexBiasContext}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-zero-gamma') && (
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
                )}

                {!panelPrefs.isHidden('sec-vega-spikes') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-vega-spikes"
                    label="Dir Vega Spikes"
                  >
                    <VegaSpikeFeed
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-interval-ba-history') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-interval-ba-history"
                    label="Interval B/A History"
                  >
                    <IntervalBAFeed
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-greek-flow') && (
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
                )}

                {!panelPrefs.isHidden('sec-dealer-regime') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-dealer-regime"
                    label="Dealer Regime"
                    fallback={<SkeletonSection lines={2} />}
                  >
                    <DealerRegimeTile
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-strike-battle-map') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-strike-battle-map"
                    label="Strike Battle Map"
                    fallback={<SkeletonSection lines={5} />}
                  >
                    <StrikeBattleMap
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-lottery-finder') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-lottery-finder"
                    label="Lottery Finder"
                    fallback={<SkeletonSection lines={5} />}
                  >
                    <LotteryFinderSection
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-greek-heatmap') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-greek-heatmap"
                    label="0DTE Greek Heatmap"
                    fallback={<SkeletonSection lines={5} />}
                  >
                    <GreekHeatmapSection
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-silent-boom') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-silent-boom"
                    label="Silent Boom"
                    fallback={<SkeletonSection lines={5} />}
                  >
                    <SilentBoomSection
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {!panelPrefs.isHidden('sec-gexbot') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-gexbot"
                    label="GEXBot Dealer State"
                    fallback={<SkeletonSection lines={3} />}
                  >
                    <GexbotSection
                      marketOpen={market.data.quotes?.marketOpen ?? false}
                    />
                  </GatedSection>
                )}

                {isAuthenticated && !panelPrefs.isHidden('sec-futures') && (
                  <>
                    <span id="sec-futures" className="block scroll-mt-28" />
                    <ErrorBoundary label="Futures">
                      <Suspense fallback={<SkeletonSection lines={5} />}>
                        <FuturesPanel defaultCollapsed />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}

                {/* Chart Analysis — requires auth session or backtest with results */}
                {(market.hasData || !!historySnapshot) &&
                  !panelPrefs.isHidden('sec-charts') && (
                    <>
                      <span id="sec-charts" className="block scroll-mt-28" />
                      <ErrorBoundary label="Chart Analysis">
                        <Suspense fallback={<SkeletonSection lines={6} tall />}>
                          <ChartAnalysis
                            results={results}
                            onAnalysisSaved={handleAnalysisSaved}
                            context={analysisContext}
                            csvPositionSummary={csvPositionSummary}
                            defaultCollapsed
                          />
                        </Suspense>
                      </ErrorBoundary>
                    </>
                  )}

                {!panelPrefs.isHidden('sec-history') && (
                  <>
                    <span id="sec-history" className="block scroll-mt-28" />
                    <ErrorBoundary label="Analysis History">
                      <AnalysisHistory
                        refreshKey={historyRefreshKey}
                        defaultCollapsed
                      />
                    </ErrorBoundary>
                  </>
                )}

                {isAuthenticated && !panelPrefs.isHidden('sec-ml-insights') && (
                  <>
                    <span id="sec-ml-insights" className="block scroll-mt-28" />
                    <ErrorBoundary label="ML Insights">
                      <Suspense fallback={<SkeletonSection lines={6} tall />}>
                        <MLInsights defaultCollapsed />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}

                {!panelPrefs.isHidden('sec-periscope-exposure') && (
                  <GatedSection
                    gate={hasMarketContext}
                    id="sec-periscope-exposure"
                    label="Periscope MM Exposure"
                    fallback={<SkeletonSection lines={6} tall />}
                  >
                    <PeriscopePanel
                      view={periscope.view}
                      emptyReason={periscope.emptyReason}
                      asOf={periscope.asOf}
                      isLoading={periscope.isLoading}
                      error={periscope.error}
                      onRefresh={periscope.refresh}
                      availableSlots={periscope.availableSlots}
                      selectedSlot={periscopeSlot}
                      onSelectSlot={setPeriscopeSlot}
                      playbook={periscopePlaybook}
                    />
                  </GatedSection>
                )}

                {/* Manual Periscope Chat upload UI removed in Phase 4d
                    of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md
                    — the scraper-triggered auto-playbook now produces a
                    playbook every 10-min RTH tick and renders directly in
                    PeriscopePanel above. PeriscopeChatHistory remains for
                    reviewing past entries (manual + auto). */}

                {isAuthenticated && (
                  <>
                    {!panelPrefs.isHidden('sec-periscope-history') && (
                      <>
                        <span
                          id="sec-periscope-history"
                          className="block scroll-mt-28"
                        />
                        <ErrorBoundary label="Periscope History">
                          <Suspense
                            fallback={<SkeletonSection lines={4} tall />}
                          >
                            <PeriscopeChatHistory />
                          </Suspense>
                        </ErrorBoundary>
                      </>
                    )}
                    {!panelPrefs.isHidden('sec-periscope-lessons') && (
                      <>
                        <span
                          id="sec-periscope-lessons"
                          className="block scroll-mt-28"
                        />
                        <ErrorBoundary label="Periscope Lesson Library">
                          <Suspense
                            fallback={<SkeletonSection lines={4} tall />}
                          >
                            <LessonLibrary />
                          </Suspense>
                        </ErrorBoundary>
                      </>
                    )}
                  </>
                )}

                {/* Paper Dashboard — lazy-loaded */}
                {!panelPrefs.isHidden('sec-positions') && (
                  <>
                    <span id="sec-positions" className="block scroll-mt-28" />
                    <ErrorBoundary label="Paper Dashboard">
                      <Suspense fallback={<SkeletonSection lines={5} tall />}>
                        <PositionMonitor
                          spotPrice={results?.spot ?? spxVal ?? 0}
                          onPositionSummaryChange={setCsvPositionSummary}
                          portfolioRiskThresholdPct={portfolioRiskThresholdPct}
                          defaultCollapsed
                        />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}

                {/* Contract Tracker — long-term position tracking (Wonce
                    guest-shared single-tenant). See
                    docs/superpowers/specs/contract-tracker-2026-05-17.md. */}
                {isAuthenticated && !panelPrefs.isHidden('sec-tracker') && (
                  <>
                    <span id="sec-tracker" className="block scroll-mt-28" />
                    <ErrorBoundary label="Contract Tracker">
                      <Suspense fallback={<SkeletonSection lines={5} tall />}>
                        <TrackerSection
                          marketOpen={market.data.quotes?.marketOpen ?? false}
                        />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}

                {isAuthenticated && !panelPrefs.isHidden('sec-bwb') && (
                  <>
                    <span id="sec-bwb" className="block scroll-mt-28" />
                    <ErrorBoundary label="BWB Calculator">
                      <Suspense fallback={<SkeletonSection lines={5} tall />}>
                        <BWBCalculator
                          selectedDate={vix.selectedDate}
                          vix={vixInput}
                          defaultCollapsed
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
