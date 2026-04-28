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
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { useTopStrikesTracker } from '../../hooks/useTopStrikesTracker';
import { BiasPanel } from './BiasPanel';
import { ClassificationLegend } from './ClassificationLegend';
import { ScrubControls } from '../ScrubControls';
import { StrikeTable } from './StrikeTable';
import { computeBias } from './bias';
import { PRICE_WINDOW } from './constants';
import {
  computeDeltaMap,
  computePriceTrend,
  computeSmoothedStrikes,
  findClosestSnapshot,
} from './deltas';
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
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  timestamp: string | null;
  /** All snapshot timestamps for the active date, ascending. */
  timestamps: string[];
  onRefresh: () => void;
  selectedDate: string;
  onDateChange: (date: string) => void;
  isLive: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  onScrubPrev: () => void;
  onScrubNext: () => void;
  /** Jump directly to a specific snapshot timestamp. */
  onScrubTo: (ts: string) => void;
  onScrubLive: () => void;
  /** Called whenever the structural bias summary changes; pass to analyze. */
  onBiasChange?: (summary: string | null) => void;
}

const GexLandscape = memo(function GexLandscape({
  strikes,
  loading,
  error,
  timestamp,
  timestamps,
  onRefresh,
  selectedDate,
  onDateChange,
  isLive,
  isScrubbed,
  canScrubPrev,
  canScrubNext,
  onScrubPrev,
  onScrubNext,
  onScrubTo,
  onScrubLive,
  onBiasChange,
}: GexLandscapeProps) {
  const spotRowRef = useRef<HTMLDivElement>(null);
  // Scroll to ATM row only once on initial data arrival; never on scrub.
  const hasScrolledRef = useRef(false);
  // Rolling buffer of recent snapshots for Δ% computations
  // (1m, 5m, 10m, 15m, 30m).
  const snapshotBufferRef = useRef<Snapshot[]>([]);
  const [gexDeltaMap, setGexDeltaMap] = useState<Map<number, number | null>>(
    new Map(),
  );
  const [gexDelta5mMap, setGexDelta5mMap] = useState<
    Map<number, number | null>
  >(new Map());
  const [gexDelta10mMap, setGexDelta10mMap] = useState<
    Map<number, number | null>
  >(new Map());
  const [gexDelta15mMap, setGexDelta15mMap] = useState<
    Map<number, number | null>
  >(new Map());
  const [gexDelta30mMap, setGexDelta30mMap] = useState<
    Map<number, number | null>
  >(new Map());
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
    );
  }, [
    smoothedRows,
    rows,
    currentPrice,
    gexDeltaMap,
    gexDelta5mMap,
    priceTrend,
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

  // When the viewed date changes, reset scroll and all Δ% tracking so the new
  // date's first snapshot gets a clean baseline instead of comparing against
  // the previous date's strikes.
  useEffect(() => {
    hasScrolledRef.current = false;
    snapshotBufferRef.current = [];
    setGexDeltaMap(new Map());
    setGexDelta5mMap(new Map());
    setGexDelta10mMap(new Map());
    setGexDelta15mMap(new Map());
    setGexDelta30mMap(new Map());
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

  // Compute 1m, 5m, 10m, 15m, and 30m GEX Δ% on each new snapshot.
  // Uses a rolling buffer keyed by snapshot timestamp to avoid duplicate
  // processing and to support arbitrary lookback windows.
  useEffect(() => {
    if (!timestamp || strikes.length === 0) return;
    const now = new Date(timestamp).getTime();

    // Guard: don't process the same snapshot twice (e.g. re-render with same data).
    if (snapshotBufferRef.current.at(-1)?.ts === now) return;

    // Prune entries older than 31 minutes to keep the buffer bounded while
    // still covering the 30m lookback (extra minute absorbs the
    // findClosestSnapshot tolerance window).
    const cutoff = now - 31 * 60 * 1000;
    const buf = snapshotBufferRef.current.filter((snap) => snap.ts >= cutoff);

    // 1m delta — compare against the most recent buffered snapshot.
    const prev1m = buf.at(-1);
    setGexDeltaMap(
      prev1m ? computeDeltaMap(strikes, prev1m.strikes) : new Map(),
    );

    // 5/10/15/30m deltas — find closest snapshot for each lookback target.
    // Each map stays empty until the buffer holds a snapshot near that age,
    // so the table renders an em-dash until enough history accumulates.
    const snap5m = findClosestSnapshot(buf, now - 5 * 60 * 1000);
    setGexDelta5mMap(
      snap5m ? computeDeltaMap(strikes, snap5m.strikes) : new Map(),
    );
    const snap10m = findClosestSnapshot(buf, now - 10 * 60 * 1000);
    setGexDelta10mMap(
      snap10m ? computeDeltaMap(strikes, snap10m.strikes) : new Map(),
    );
    const snap15m = findClosestSnapshot(buf, now - 15 * 60 * 1000);
    setGexDelta15mMap(
      snap15m ? computeDeltaMap(strikes, snap15m.strikes) : new Map(),
    );
    const snap30m = findClosestSnapshot(buf, now - 30 * 60 * 1000);
    setGexDelta30mMap(
      snap30m ? computeDeltaMap(strikes, snap30m.strikes) : new Map(),
    );

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
      timestamps={timestamps}
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

  if (loading && rows.length === 0) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        <div className="text-muted flex items-center justify-center py-8 font-mono text-[13px]">
          Loading GEX landscape…
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        <div className="text-danger py-4 text-center font-mono text-[13px]">
          {error}
        </div>
      </SectionBox>
    );
  }

  if (rows.length === 0) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        <div className="text-muted py-8 text-center font-mono text-[13px]">
          No strike data available
        </div>
      </SectionBox>
    );
  }

  return (
    <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
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
            maxChanged1mStrike={maxChanged1mStrike}
            maxChanged5mStrike={maxChanged5mStrike}
            gexDeltaMap={gexDeltaMap}
            gexDelta5mMap={gexDelta5mMap}
            gexDelta10mMap={gexDelta10mMap}
            gexDelta15mMap={gexDelta15mMap}
            gexDelta30mMap={gexDelta30mMap}
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
            maxChanged1mStrike={maxChanged1mStrike}
            maxChanged5mStrike={maxChanged5mStrike}
            gexDeltaMap={gexDeltaMap}
            gexDelta5mMap={gexDelta5mMap}
            gexDelta10mMap={gexDelta10mMap}
            gexDelta15mMap={gexDelta15mMap}
            gexDelta30mMap={gexDelta30mMap}
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
