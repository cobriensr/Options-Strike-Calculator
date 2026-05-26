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
 * The Δ1m / Δ5m / Δ10m columns show the % change in MM dollar gamma at each
 * strike vs. the prior slot's value (all three windows native at GexBot's
 * 1-min cadence). The Vol Reinforcement column reads as "reinforcing" when
 * all three deltas align with the current netGamma sign — see
 * `computeVolReinforcement` (Locked Decision #1).
 *
 * Primary data source is `/api/gex-landscape` (GexBot-fed, 1-min cadence) —
 * see docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md.
 *
 * Module layout:
 *   types.ts                 — shared TS types
 *   constants.ts             — thresholds, Tailwind class maps, tooltip tables
 *   classify.ts              — classify / getDirection / signal+charm tooltips,
 *                              computeVolReinforcement
 *   deltas.ts                — computePriceTrend over a {ts, price}[] buffer
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
import { boolPersistOpts } from '../../hooks/persist-encoding';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useScrubController } from '../../hooks/useScrubController';
import { useTopStrikesTracker } from '../../hooks/useTopStrikesTracker';
import { getETToday } from '../../utils/timezone';
import { BiasPanel } from './BiasPanel';
import { ClassificationLegend } from './ClassificationLegend';
import { ScrubControls } from '../ScrubControls';
import { StrikeTable } from './StrikeTable';
import { computeBias } from './bias';
import { PRICE_WINDOW } from './constants';
import { computePriceTrend, type PricePoint } from './deltas';
import { formatBiasForClaude } from './formatters';
import type { PriceTrend } from './types';

const TOP5_MUTE_STORAGE_KEY = 'gex-landscape-top5-muted-v1';

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

/**
 * Lookback window for the price-trend buffer (30 min in ms). Matches the
 * legacy MM-era window — GexBot pushes minute-cadence so this gives ~30
 * samples to detect a drift, well above the 3-sample MIN_SNAPSHOTS gate.
 */
const PRICE_TREND_WINDOW_MS = 30 * 60 * 1000;

/**
 * Buffer cutoff in ms — keep 1 extra minute beyond the trend window to
 * absorb jitter at slot boundaries before old points get pruned.
 */
const PRICE_TREND_BUFFER_CUTOFF_MS = 31 * 60 * 1000;

export interface GexLandscapeProps {
  /** Whether the equity market is currently open (drives polling + LIVE badge). */
  marketOpen: boolean;
  /** Called whenever the structural bias summary changes; pass to analyze. */
  onBiasChange?: (summary: string | null) => void;
}

const GexLandscape = memo(function GexLandscape({
  marketOpen,
  onBiasChange,
}: GexLandscapeProps) {
  // SPX-only since Phase 3 of the MM swap
  // (docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md) — MM
  // data comes from periscope_snapshots which only captures SPX 0DTE.
  // The prior multi-ticker selector lived here; SPY/QQQ flow hunting
  // moved elsewhere per feedback_hunt_flow_in_spy_qqq.md.
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
    gexDelta1mMap,
    gexDelta5mMap,
    gexDelta10mMap,
    loading,
    error,
    refresh,
  } = useGexLandscapeData(marketOpen, selectedDate, scrubTimestamp);

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

  // Reset scrub when the user changes date — the previous selection's
  // pinned ts is meaningless against a different date's snapshot list.
  // Also reset `liveTimestamps` so the scrub controller doesn't see
  // stale timestamps from the previous date while the new fetch is in
  // flight.
  const clearScrub = scrub.scrubLive;
  useEffect(() => {
    clearScrub();
    setLiveTimestamps([]);
  }, [selectedDate, clearScrub]);

  const spotRowRef = useRef<HTMLDivElement>(null);
  // Scroll to ATM row only once on initial data arrival; never on scrub.
  const hasScrolledRef = useRef(false);
  // Minimal price-trend buffer: just `{ts, price}` tuples, not full strike
  // snapshots. This used to be a `Snapshot[]` so smoothing could read the
  // strike rows — Phase 4 dropped the 5-min smoothing buffer because the
  // 1-min GexBot cadence is fast enough that single-snapshot bias is
  // already stable. The drift-override still benefits from a 30-min spot
  // history, so we keep this thin buffer in-component.
  const priceBufferRef = useRef<PricePoint[]>([]);
  // Price trend over PRICE_TREND_WINDOW_MS — used to override the
  // rangebound verdict when price is grinding in one direction.
  const [priceTrend, setPriceTrend] = useState<PriceTrend | null>(null);
  // Which view is showing in the table area — structural grid or top-5 walls.
  const [activeTab, setActiveTab] = useState<LandscapeTab>('all');
  const tablistRef = useRef<HTMLDivElement>(null);
  // Mute the Top 5 composition-change chime. Persisted to localStorage so
  // the preference survives reloads.
  const [top5Muted, setTop5Muted] = usePersistedState<boolean>(
    TOP5_MUTE_STORAGE_KEY,
    false,
    boolPersistOpts,
  );
  const toggleTop5Mute = useCallback(
    () => setTop5Muted((prev) => !prev),
    [setTop5Muted],
  );

  const currentPrice = strikes[0]?.price ?? 0;

  // Filter to ±PRICE_WINDOW pts, sort descending: ceiling at top, floor at bottom.
  const rows = useMemo(
    () =>
      strikes
        .filter((s) => Math.abs(s.strike - currentPrice) <= PRICE_WINDOW)
        .sort((a, b) => b.strike - a.strike),
    [strikes, currentPrice],
  );

  // Top 5 strikes across the entire chain — ignores PRICE_WINDOW so
  // distant institutional walls surface even when they're far from
  // spot. Ranked by absolute MM-attributed netGamma.
  const topFive = useMemo(
    () =>
      [...strikes]
        .sort((a, b) => Math.abs(b.netGamma) - Math.abs(a.netGamma))
        .slice(0, TOP_GEX_COUNT),
    [strikes],
  );

  // Track Top 5 composition across polls so the trader gets a chime on
  // any set change and can see which strike is the session anchor vs.
  // which one just entered. Reset the tracker on date change so a new
  // session starts with a clean slate.
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

  // Strikes with the largest absolute Δ% at 1m / 5m / 10m. Used for the
  // confluence highlight in the bias panel and the row-level emphasis
  // in the strike table.
  const maxChanged1mStrike = useMemo(
    () => findMaxAbsDeltaStrike(rows, gexDelta1mMap),
    [rows, gexDelta1mMap],
  );
  const maxChanged5mStrike = useMemo(
    () => findMaxAbsDeltaStrike(rows, gexDelta5mMap),
    [rows, gexDelta5mMap],
  );
  const maxChanged10mStrike = useMemo(
    () => findMaxAbsDeltaStrike(rows, gexDelta10mMap),
    [rows, gexDelta10mMap],
  );

  // Structural bias synthesis — directional verdict + key levels + trends.
  // Reads raw rows directly now that the 5-min smoothing buffer is gone:
  // GexBot's 1-min native cadence is fast enough that single-snapshot
  // verdicts don't flap. Re-evaluate only if jitter shows up in the wild.
  const bias = useMemo(
    () =>
      computeBias(
        rows,
        currentPrice,
        gexDelta1mMap,
        gexDelta5mMap,
        gexDelta10mMap,
        priceTrend,
      ),
    [
      rows,
      currentPrice,
      gexDelta1mMap,
      gexDelta5mMap,
      gexDelta10mMap,
      priceTrend,
    ],
  );

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

  // When the viewed date changes, reset scroll and the price-trend
  // buffer so the new session gets a clean baseline. Δ% maps come
  // straight from the hook and refresh automatically on each poll.
  useEffect(() => {
    hasScrolledRef.current = false;
    priceBufferRef.current = [];
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

  // Maintain the price-trend buffer: push the current `{ts, price}`
  // tuple, prune older than the cutoff, and re-evaluate the trend.
  // The buffer is intentionally minimal — no per-strike state — so it
  // costs essentially nothing per render. See
  // `docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md`
  // for the rationale behind dropping the full snapshot buffer.
  useEffect(() => {
    if (!timestamp || strikes.length === 0) return;
    const now = new Date(timestamp).getTime();

    // Guard: don't process the same timestamp twice (re-render with same data).
    if (priceBufferRef.current.at(-1)?.ts === now) return;

    const cutoff = now - PRICE_TREND_BUFFER_CUTOFF_MS;
    const buf = priceBufferRef.current.filter((pt) => pt.ts >= cutoff);
    buf.push({ ts: now, price: strikes[0]?.price ?? 0 });
    priceBufferRef.current = buf;

    setPriceTrend(
      computePriceTrend(
        strikes[0]?.price ?? 0,
        buf,
        now,
        PRICE_TREND_WINDOW_MS,
      ),
    );
  }, [strikes, timestamp]);

  const headerRight = (
    <ScrubControls
      timestamp={timestamp}
      timestamps={liveTimestamps}
      selectedDate={selectedDate}
      onDateChange={setSelectedDate}
      isLive={isLive}
      isScrubbed={isScrubbed}
      canScrubPrev={canScrubPrev}
      canScrubNext={canScrubNext}
      onScrubPrev={scrub.scrubPrev}
      onScrubNext={scrub.scrubNext}
      onScrubTo={scrub.scrubTo}
      onScrubLive={scrubLive}
      onRefresh={refresh}
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
        maxChanged10mStrike={maxChanged10mStrike}
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
            maxChanged10mStrike={maxChanged10mStrike}
            gexDelta1mMap={gexDelta1mMap}
            gexDelta5mMap={gexDelta5mMap}
            gexDelta10mMap={gexDelta10mMap}
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
            maxChanged10mStrike={maxChanged10mStrike}
            gexDelta1mMap={gexDelta1mMap}
            gexDelta5mMap={gexDelta5mMap}
            gexDelta10mMap={gexDelta10mMap}
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

/**
 * Find the strike with the largest absolute Δ% in `map`, scoped to the
 * `rows` set. Returns `null` when no usable values exist. Excludes ATM
 * implicitly — the caller passes the same row set the table renders, so
 * the spot row is included but is the "natural" max only when there's
 * an actual spot-anchored move worth flagging.
 */
function findMaxAbsDeltaStrike(
  rows: GexStrikeLevel[],
  map: Map<number, number | null>,
): number | null {
  let maxAbs = 0;
  let maxStrike: number | null = null;
  for (const s of rows) {
    const pct = map.get(s.strike) ?? null;
    if (pct === null) continue;
    const abs = Math.abs(pct);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxStrike = s.strike;
    }
  }
  return maxAbs > 0 ? maxStrike : null;
}

export default GexLandscape;
