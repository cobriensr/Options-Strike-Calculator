/**
 * GexLandscape — Strike classification table using the 4-quadrant
 * gamma × charm framework (Negative/Positive Gamma × Negative/Positive Charm).
 *
 * Each strike within ±50 pts of spot is labelled as one of:
 *   Max Launchpad    — neg gamma + pos charm  (accelerant that builds into close)
 *   Fading Launchpad — neg gamma + neg charm  (accelerant that weakens over time)
 *   Sticky Pin       — pos gamma + pos charm  (wall that strengthens into close)
 *   Weakening Pin    — pos gamma + neg charm  (wall losing grip as day ages)
 *
 * Direction context (Ceiling / Floor) is overlaid based on strike vs. spot.
 * GEX Δ% shows the % change in net gamma since the previous 1-min snapshot.
 * Vol reinforcement signals whether intraday flow confirms OI structure.
 *
 * Reuses the same gexStrike data passed to GexPerStrike — no extra fetch.
 *
 * Module layout:
 *   types.ts                 — shared TS types
 *   constants.ts             — thresholds, Tailwind class maps, tooltip tables
 *   classify.ts              — classify / getDirection / signalTooltip / charmTooltip
 *   deltas.ts                — snapshot Δ%, closest-snapshot lookup, 5m smoothing
 *   bias.ts                  — computeBias (structural verdict synthesis)
 *   formatters.ts            — fmtGex / fmtPct / fmtTime / formatBiasForClaude
 *   (ScrubControls)          — shared scrub/date/status/refresh controls (../ScrubControls)
 *   BiasPanel.tsx            — verdict + gravity + drift targets + trends block
 *   StrikeTable.tsx          — sticky-header + scrollable row grid
 *   ClassificationLegend.tsx — bottom legend
 *   index.tsx                — this file: state + effects + orchestration
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { SectionBox } from '../ui';
import type { GexStrikeLevel } from './types';
import { useGexLandscapeData } from '../../hooks/useGexLandscapeData';
import { useScrubController } from '../../hooks/useScrubController';
import { useTopStrikesTracker } from '../../hooks/useTopStrikesTracker';
import { getETToday } from '../../utils/timezone';
import { BiasPanel } from './BiasPanel';
import { ClassificationLegend } from './ClassificationLegend';
import { ScrubControls } from '../ScrubControls';
import { StrikeTable } from './StrikeTable';
import { computeBias } from './bias';
import { computeGammaPressure, type GammaPressure } from './classify';
import { PRICE_WINDOW, type Ticker } from './constants';
import { computePriceTrend, computeSmoothedStrikes } from './deltas';
import { formatBiasForClaude } from './formatters';
import type { PriceTrend, Snapshot } from './types';

const TOP5_MUTE_STORAGE_KEY = 'gex-landscape-top5-muted-v1';

function readTop5MutedFromStorage(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(TOP5_MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeTop5MutedToStorage(muted: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(TOP5_MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode / quota — keep in-memory state */
  }
}

/** View mode for the table area: full ±50pt grid or top 5 by |netGamma|. */
type LandscapeTab = 'all' | 'top5';

/** Number of strikes shown in the "Top 5 GEX" tab. */
const TOP_GEX_COUNT = 5;

const TAB_ORDER: readonly LandscapeTab[] = ['all', 'top5'];

const TAB_LABEL: Record<LandscapeTab, string> = {
  all: 'All strikes',
  top5: 'Top 5 GEX',
};

const TAB_TITLE: Record<LandscapeTab, string> = {
  all: 'Strikes within ±50 pts of spot, sorted ceiling → floor',
  top5: 'Top 5 strikes across the entire chain, ranked by absolute dollar gamma',
};

export interface GexLandscapeProps {
  /** Whether the equity market is currently open (drives polling + LIVE badge). */
  marketOpen: boolean;
  /** Called whenever the structural bias summary changes; pass to analyze. */
  onBiasChange?: (summary: string | null) => void;
}

/**
 * Tickers offered by the GexLandscape selector. SPY is first because the
 * uw-stream daemon currently only subscribes to SPY/QQQ; SPX/NDX appear
 * in the radio group but render empty until Phase 3d widens the WS
 * subscriptions and the Zod validator. Order is deliberate: ETFs first
 * (where flow is hunted), index second (reaction surface).
 */
const TICKER_OPTIONS: readonly Ticker[] = ['SPY', 'QQQ', 'SPX', 'NDX'];

const GexLandscape = memo(function GexLandscape({
  marketOpen,
  onBiasChange,
}: GexLandscapeProps) {
  // Owned internally (Phase 3c): App.tsx no longer threads scrub props.
  // Defaults: SPX preserves the historical SPX-only mental model — users
  // opening the page expect the SPX view. SPX renders empty until Phase
  // 3d widens the uw-stream WS subscription + Zod validator; that brief
  // regression is the accepted cost of the Path A migration. Date is
  // today's ET calendar (used as the 0DTE expiry).
  const [selectedTicker, setSelectedTicker] = useState<Ticker>('SPX');
  const [selectedDate, setSelectedDate] = useState<string>(() => getETToday());

  // Scrub state machine. We need the controller's `scrubTimestamp` BEFORE
  // calling the data hook so we can pass it through as `at`. The
  // controller's `timestamps` dep is the live response's `timestamps[]`
  // — but on first mount that array is empty, so the controller starts
  // out with `scrubTimestamp = null` (live), `at` is null, and the data
  // hook polls live. As soon as the live response arrives, `timestamps`
  // populates and the user can scrub. Stepping back from live sets
  // `scrubTimestamp` to a real ts; the data hook's `at` flips, polling
  // halts (per `useGexStrikeExpiry` semantics), and the API returns
  // the at-or-before snapshot for that minute.
  //
  // The data hook is called with the live `timestamps` driving
  // controller, then the controller's pin feeds back as `at`. This
  // creates a single render-cycle dependency chain (no double fetch).
  // We seed the controller from a separate snapshot of `timestamps`
  // captured by a small effect to avoid a circular ref between hook
  // calls — see the `liveTimestamps` state below.
  const [liveTimestamps, setLiveTimestamps] = useState<string[]>([]);
  const scrub = useScrubController(liveTimestamps);
  const { scrubTimestamp, isScrubbed, canScrubPrev, canScrubNext } = scrub;

  const {
    strikes,
    timestamps,
    gexDeltaMap,
    gexDelta5mMap,
    gexDelta10mMap,
    gexDelta15mMap,
    gexDelta30mMap,
    loading,
    error,
    refresh,
  } = useGexLandscapeData(
    selectedTicker,
    marketOpen,
    selectedDate,
    scrubTimestamp,
  );

  // Mirror live `timestamps` into the scrub controller's input. The
  // controller can't depend on the same hook's output without creating
  // a same-render circular dep (controller drives `at` → hook returns
  // timestamps → controller reads them). Mirroring through state breaks
  // the cycle: `timestamps` only update after the controller has
  // already settled for this render. While scrubbed, the response's
  // `timestamps` is just the single pinned minute, so we ignore it
  // and keep the last live list.
  useEffect(() => {
    if (scrubTimestamp != null) return;
    setLiveTimestamps(timestamps);
  }, [scrubTimestamp, timestamps]);

  const timestamp = scrubTimestamp ?? liveTimestamps.at(-1) ?? null;
  const isLive = scrubTimestamp == null && marketOpen;

  // `scrubLive` resets the scrub pin AND snaps the date back to today
  // (mirrors the original useGexPerStrike behaviour — a single button
  // returns the panel to "now" across both axes).
  const scrubLive = useCallback(() => {
    scrub.scrubLive();
    setSelectedDate((cur) => {
      const today = getETToday();
      return cur === today ? cur : today;
    });
  }, [scrub]);

  // Reset scrub when the user changes date or ticker — the previous
  // selection's pinned ts is meaningless against a different (date,
  // ticker) snapshot list. Also reset `liveTimestamps` so the scrub
  // controller doesn't see stale timestamps from the previous ticker
  // while the new fetch is in flight.
  const clearScrub = scrub.scrubLive;
  useEffect(() => {
    clearScrub();
    setLiveTimestamps([]);
  }, [selectedDate, selectedTicker, clearScrub]);

  const onRefresh = refresh;
  const onDateChange = setSelectedDate;
  const onScrubPrev = scrub.scrubPrev;
  const onScrubNext = scrub.scrubNext;
  const onScrubTo = scrub.scrubTo;
  const onScrubLive = scrubLive;

  // `ticker` was previously a prop; now derived from local state.
  const ticker = selectedTicker;
  const spotRowRef = useRef<HTMLDivElement>(null);
  // Scroll to ATM row only once on initial data arrival; never on scrub.
  const hasScrolledRef = useRef(false);
  // Rolling buffer of recent snapshots — retained ONLY for the bias
  // verdict's smoothed-strikes computation and price-trend detection
  // (drifting-up/down override). Per-strike Δ% no longer reads from
  // this buffer; that moved to a server-side SQL `LAG()` query in
  // Phase 4 of `docs/superpowers/specs/gex-landscape-ws-upgrade-2026-05-03.md`,
  // surfaced via the `gex*DeltaMap` props from `useGexLandscapeData`.
  // The buffer still warms up over the session but the table's Δ%
  // columns are populated from first paint regardless.
  const snapshotBufferRef = useRef<Snapshot[]>([]);
  // 5-minute smoothed strikes — updated in the snapshot effect so the ref read
  // happens inside an effect (not during render), satisfying react-hooks/purity.
  const [smoothedRows, setSmoothedRows] = useState<GexStrikeLevel[]>([]);
  // Price trend from the snapshot buffer — used to override rangebound verdict.
  const [priceTrend, setPriceTrend] = useState<PriceTrend | null>(null);
  // Which view is showing in the table area — structural grid or top-5 walls.
  const [activeTab, setActiveTab] = useState<LandscapeTab>('all');
  const tablistRef = useRef<HTMLDivElement>(null);
  // Mute the Top 5 composition-change chime. Persisted to localStorage so
  // the preference survives reloads.
  const [top5Muted, setTop5Muted] = useState<boolean>(() =>
    readTop5MutedFromStorage(),
  );
  const toggleTop5Mute = useCallback(() => {
    setTop5Muted((prev) => {
      const next = !prev;
      writeTop5MutedToStorage(next);
      return next;
    });
  }, []);

  const currentPrice = strikes[0]?.price ?? 0;

  // Filter to ±PRICE_WINDOW pts, sort descending: ceiling at top, floor at bottom.
  const rows = useMemo(
    () =>
      strikes
        .filter((s) => Math.abs(s.strike - currentPrice) <= PRICE_WINDOW)
        .sort((a, b) => b.strike - a.strike),
    [strikes, currentPrice],
  );

  // Top 5 strikes by |netGamma| across the entire chain — ignores PRICE_WINDOW
  // so distant institutional walls surface even when they're far from spot.
  // Sorted descending so the biggest wall appears first.
  const topFive = useMemo(() => {
    return [...strikes]
      .sort((a, b) => Math.abs(b.netGamma) - Math.abs(a.netGamma))
      .slice(0, TOP_GEX_COUNT);
  }, [strikes]);

  // Track Top 5 composition across polls so the trader gets a chime on
  // any set change and can see which strike is the session anchor vs.
  // which one just entered.
  const { justEntered, oldestStrike } = useTopStrikesTracker({
    topFive,
    timestamp,
    isLive,
    muted: top5Muted,
    resetKey: selectedDate,
  });

  // Find the strike closest to spot for the ATM indicator.
  const spotStrike = useMemo(() => {
    if (!rows.length) return null;
    return rows.reduce(
      (best, s) =>
        Math.abs(s.strike - currentPrice) < Math.abs(best.strike - currentPrice)
          ? s
          : best,
      rows[0]!,
    );
  }, [rows, currentPrice]);

  // Strike with the largest absolute 1m GEX Δ% (excludes ATM row).
  const maxChanged1mStrike = useMemo(() => {
    let maxAbs = 0;
    let maxStrike: number | null = null;
    for (const s of rows) {
      const pct = gexDeltaMap.get(s.strike) ?? null;
      if (pct === null) continue;
      const abs = Math.abs(pct);
      if (abs > maxAbs) {
        maxAbs = abs;
        maxStrike = s.strike;
      }
    }
    return maxAbs > 0 ? maxStrike : null;
  }, [gexDeltaMap, rows]);

  // Per-strike gamma-pressure map (reinforcing / unwinding / neutral).
  // Built from the full `strikes` list (not just the `rows` window) so the
  // Top 5 tab — which surfaces walls outside ±PRICE_WINDOW — also lights up.
  const gammaPressureMap = useMemo<Map<number, GammaPressure>>(() => {
    const m = new Map<number, GammaPressure>();
    for (const s of strikes) {
      m.set(
        s.strike,
        computeGammaPressure({
          callGammaAskVol: s.callGammaAsk,
          callGammaBidVol: s.callGammaBid,
          putGammaAskVol: s.putGammaAsk,
          putGammaBidVol: s.putGammaBid,
          dollarGammaOi: Math.abs(s.callGammaOi + s.putGammaOi),
        }),
      );
    }
    return m;
  }, [strikes]);

  // Strike with the largest absolute 5m GEX Δ% (excludes ATM row).
  const maxChanged5mStrike = useMemo(() => {
    let maxAbs = 0;
    let maxStrike: number | null = null;
    for (const s of rows) {
      const pct = gexDelta5mMap.get(s.strike) ?? null;
      if (pct === null) continue;
      const abs = Math.abs(pct);
      if (abs > maxAbs) {
        maxAbs = abs;
        maxStrike = s.strike;
      }
    }
    return maxAbs > 0 ? maxStrike : null;
  }, [gexDelta5mMap, rows]);

  // Structural bias synthesis — directional verdict + key levels + trends.
  // Uses smoothedRows (5-min avg) so small per-snapshot GEX fluctuations don't
  // flip the verdict. Falls back to raw rows until enough history accumulates.
  const bias = useMemo(() => {
    const base = smoothedRows.length > 0 ? smoothedRows : rows;
    return computeBias(
      base,
      currentPrice,
      gexDeltaMap,
      gexDelta5mMap,
      priceTrend,
      ticker,
    );
  }, [
    smoothedRows,
    rows,
    currentPrice,
    gexDeltaMap,
    gexDelta5mMap,
    priceTrend,
    ticker,
  ]);

  // Notify parent whenever the structural bias verdict changes so it can be
  // forwarded to the analyze endpoint as part of AnalysisContext.
  useEffect(() => {
    onBiasChange?.(formatBiasForClaude(bias));
  }, [bias, onBiasChange]);

  // Arrow/Home/End keyboard nav between tabs (WAI-ARIA APG "Tabs (automatic
  // activation)" pattern). Focus follows the newly selected tab so the
  // corresponding tabpanel is immediately reachable via Tab.
  const handleTabKey = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      const current = e.currentTarget.dataset.tab as LandscapeTab | undefined;
      if (!current) return;
      const idx = TAB_ORDER.indexOf(current);
      let next: LandscapeTab | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        next = TAB_ORDER[(idx + 1) % TAB_ORDER.length] ?? null;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        next =
          TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length] ?? null;
      } else if (e.key === 'Home') {
        next = TAB_ORDER[0] ?? null;
      } else if (e.key === 'End') {
        next = TAB_ORDER.at(-1) ?? null;
      }
      if (!next || next === current) return;
      e.preventDefault();
      setActiveTab(next);
      const btn = tablistRef.current?.querySelector<HTMLButtonElement>(
        `[data-tab="${next}"]`,
      );
      btn?.focus();
    },
    [],
  );

  // When the viewed date changes, reset scroll and the smoothing/price-trend
  // buffer so the new date's first snapshot gets a clean baseline. Δ% maps
  // are sourced server-side now and refresh automatically with each poll —
  // no client-side reset needed.
  useEffect(() => {
    hasScrolledRef.current = false;
    snapshotBufferRef.current = [];
    setSmoothedRows([]);
    setPriceTrend(null);
  }, [selectedDate]);

  // Scroll ATM row into view only on initial data arrival.
  useEffect(() => {
    if (hasScrolledRef.current) return;
    if (!loading && rows.length > 0 && spotRowRef.current) {
      spotRowRef.current.scrollIntoView?.({
        block: 'center',
        behavior: 'instant',
      });
      hasScrolledRef.current = true;
    }
  }, [loading, rows.length]);

  // Maintain the snapshot buffer for the bias verdict: 5-minute strike
  // smoothing keeps the verdict stable across minor GEX fluctuations,
  // and the price-trend computation drives the drifting-up/down override
  // for the rangebound verdict. Per-strike Δ% used to be computed here
  // too — Phase 4 moved that to a server-side SQL `LAG()` query so the
  // table's Δ% columns populate immediately on first paint.
  useEffect(() => {
    if (!timestamp || strikes.length === 0) return;
    const now = new Date(timestamp).getTime();

    // Guard: don't process the same snapshot twice (e.g. re-render with same data).
    if (snapshotBufferRef.current.at(-1)?.ts === now) return;

    // Prune entries older than 6 minutes — the smoothing window is 5
    // minutes (extra minute absorbs minor jitter). The previous 31-min
    // bound supported the largest server-bound delta lookup; now that
    // deltas live server-side, the buffer can be much smaller.
    const cutoff = now - 6 * 60 * 1000;
    const buf = snapshotBufferRef.current.filter((snap) => snap.ts >= cutoff);

    // Push current snapshot and persist the updated buffer.
    buf.push({ strikes, ts: now });
    snapshotBufferRef.current = buf;

    // Smooth only the strikes within the display window (same filter as rows)
    // so the bias panel never shows out-of-range strikes.
    const price = strikes[0]?.price ?? 0;
    const windowStrikes = strikes.filter(
      (s) => Math.abs(s.strike - price) <= PRICE_WINDOW,
    );
    setSmoothedRows(computeSmoothedStrikes(windowStrikes, buf, now));
    setPriceTrend(computePriceTrend(price, buf, now));
  }, [strikes, timestamp]);

  const headerRight = (
    <ScrubControls
      timestamp={timestamp}
      timestamps={liveTimestamps}
      selectedDate={selectedDate}
      onDateChange={onDateChange}
      isLive={isLive}
      isScrubbed={isScrubbed}
      canScrubPrev={canScrubPrev}
      canScrubNext={canScrubNext}
      onScrubPrev={onScrubPrev}
      onScrubNext={onScrubNext}
      onScrubTo={onScrubTo}
      onScrubLive={onScrubLive}
      onRefresh={onRefresh}
      loading={loading}
      sectionLabel="GEX landscape"
    />
  );

  const tickerSelector = (
    <TickerSelector value={selectedTicker} onChange={setSelectedTicker} />
  );

  if (loading && rows.length === 0) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        {tickerSelector}
        <div className="text-muted flex items-center justify-center py-8 font-mono text-[13px]">
          Loading GEX landscape…
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        {tickerSelector}
        <div className="text-danger py-4 text-center font-mono text-[13px]">
          {error}
        </div>
      </SectionBox>
    );
  }

  if (rows.length === 0) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        {tickerSelector}
        <div className="text-muted py-8 text-center font-mono text-[13px]">
          No strike data available
        </div>
      </SectionBox>
    );
  }

  return (
    <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
      {tickerSelector}
      <BiasPanel
        bias={bias}
        maxChanged1mStrike={maxChanged1mStrike}
        maxChanged5mStrike={maxChanged5mStrike}
      />
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="GEX landscape view"
        className="border-edge mt-2 mb-2 flex items-end gap-1 border-b"
      >
        {TAB_ORDER.map((tab) => {
          const selected = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`gex-landscape-tab-${tab}`}
              aria-controls={`gex-landscape-panel-${tab}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-tab={tab}
              onClick={() => setActiveTab(tab)}
              onKeyDown={handleTabKey}
              title={TAB_TITLE[tab]}
              className={[
                '-mb-px border-b-2 px-3 py-2 font-mono text-[11px] font-semibold tracking-wider uppercase transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50',
                selected
                  ? 'border-sky-400/60 text-sky-300'
                  : 'text-muted hover:text-secondary border-transparent',
              ].join(' ')}
            >
              {TAB_LABEL[tab]}
            </button>
          );
        })}
        <button
          type="button"
          onClick={toggleTop5Mute}
          aria-label={
            top5Muted
              ? 'Unmute Top 5 composition alert'
              : 'Mute Top 5 composition alert'
          }
          aria-pressed={top5Muted}
          title={
            top5Muted
              ? 'Top 5 alert muted — click to enable chime on composition change'
              : 'Top 5 alert on — click to mute chime'
          }
          className={[
            'mb-1 ml-auto rounded px-2 py-1 font-mono text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50',
            top5Muted
              ? 'text-muted hover:text-secondary'
              : 'text-sky-300 hover:text-sky-200',
          ].join(' ')}
        >
          {top5Muted ? '🔕 Muted' : '🔔 Top 5 alert'}
        </button>
      </div>
      <div
        role="tabpanel"
        id="gex-landscape-panel-all"
        aria-labelledby="gex-landscape-tab-all"
        hidden={activeTab !== 'all'}
      >
        {activeTab === 'all' && (
          <StrikeTable
            rows={rows}
            currentPrice={currentPrice}
            spotStrike={spotStrike}
            ticker={ticker}
            maxChanged1mStrike={maxChanged1mStrike}
            maxChanged5mStrike={maxChanged5mStrike}
            gexDeltaMap={gexDeltaMap}
            gexDelta5mMap={gexDelta5mMap}
            gexDelta10mMap={gexDelta10mMap}
            gexDelta15mMap={gexDelta15mMap}
            gexDelta30mMap={gexDelta30mMap}
            gammaPressureMap={gammaPressureMap}
            spotRowRef={spotRowRef}
          />
        )}
      </div>
      <div
        role="tabpanel"
        id="gex-landscape-panel-top5"
        aria-labelledby="gex-landscape-tab-top5"
        hidden={activeTab !== 'top5'}
      >
        {activeTab === 'top5' && (
          <StrikeTable
            rows={topFive}
            currentPrice={currentPrice}
            spotStrike={spotStrike}
            ticker={ticker}
            maxChanged1mStrike={maxChanged1mStrike}
            maxChanged5mStrike={maxChanged5mStrike}
            gexDeltaMap={gexDeltaMap}
            gexDelta5mMap={gexDelta5mMap}
            gexDelta10mMap={gexDelta10mMap}
            gexDelta15mMap={gexDelta15mMap}
            gexDelta30mMap={gexDelta30mMap}
            gammaPressureMap={gammaPressureMap}
            spotRowRef={spotRowRef}
            showAtmDistance
            justEntered={justEntered}
            oldestStrike={oldestStrike}
          />
        )}
      </div>
      <ClassificationLegend />
    </SectionBox>
  );
});

export default GexLandscape;

interface TickerSelectorProps {
  value: Ticker;
  onChange: (ticker: Ticker) => void;
}

/**
 * Ticker radio group rendered at the top of the GEX Landscape section.
 * Pattern matches `StrikeBattleMap`'s strike-count toggle so the two
 * sibling panels stay visually consistent. SPX/NDX render until Phase
 * 3d widens the WS subscriptions; until then they show empty state.
 */
function TickerSelector({ value, onChange }: TickerSelectorProps) {
  return (
    <div
      role="radiogroup"
      aria-label="GEX landscape ticker"
      className="border-edge mb-2 inline-flex overflow-hidden rounded border"
    >
      {TICKER_OPTIONS.map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          onClick={() => onChange(opt)}
          className={`cursor-pointer px-3 py-1 font-mono text-[11px] tracking-wider uppercase transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ${
            value === opt
              ? 'bg-surface text-primary'
              : 'text-secondary hover:text-primary'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
