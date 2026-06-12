/**
 * useTickerGrouping — group flat alert/fire rows into per-ticker
 * collapsible groups with rollup metadata + a deterministic sort.
 *
 * Extracted from a verbatim duplicate that lived in both
 * SilentBoomSection and LotteryFinderSection. The two call sites
 * differ only in the field names they pluck from each item — this
 * hook accepts an `extract` callback that returns a normalized shape
 * so the grouping / aggregation / ordering logic can be shared.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2E)
 */

import { useMemo, useRef } from 'react';

import {
  computeRollupAggregates,
  findEarliestConvictionWindow,
  isBurstStorm,
  isHighConviction,
  isStrongConviction,
  type RollupAlertSummary,
} from '../utils/ticker-rollup-aggregates.js';

/**
 * Pure projection from an item to the fields the grouping logic
 * needs. Must be a pure function — closure state is ignored across
 * renders so the hook can avoid putting `extract` in its memo deps.
 */
export interface TickerGroupingExtract {
  /** Group key — typically the underlying ticker symbol. */
  ticker: string;
  /** Realized peak %, or null when unknown. */
  peakPct: number | null;
  /** Trigger time as epoch ms — used as a recency tiebreak. */
  triggerMs: number;
  /** Rollup summary fed into computeRollupAggregates. */
  rollupSummary: RollupAlertSummary;
  /**
   * Distinct OTM-sweep cluster-strike count attached to this item by
   * the backend, or 0 when the item isn't part of a suspicious cluster.
   * Reduced to a per-ticker max so the `clusterStrikes` flag on the
   * returned group reflects the highest cluster size seen across the
   * UNFILTERED day-scoped set — mirroring the conviction/storm
   * upstream-computation pattern so chip filters can't silently erase
   * the badge once cluster members fall below a TAKE-IT floor.
   */
  clusterStrikeCount?: number;
}

export interface TickerGroup<T> {
  ticker: string;
  /**
   * Items in their within-group order — peak desc for 'peak' mode,
   * trigger-time desc for 'time' mode, input order for 'default'.
   */
  items: T[];
  conviction: boolean;
  /**
   * Stronger conviction tier: a conviction cluster that is also cheap
   * (every fire ≤ $1 entry) and pre-PM (< 12:30 CT) — higher spike
   * potential, NOT a profit/expectancy signal. Computed from the
   * unfiltered set (same back-compat fallback as `conviction`). See
   * {@link isStrongConviction}.
   */
  strongConviction: boolean;
  storm: boolean;
  peakBest: number | null;
  latestTriggerMs: number;
  /**
   * Epoch ms of the FIRST fire in the earliest 15-min sliding window
   * that satisfied the conviction predicate, or null if the ticker
   * never had a conviction footprint. Derived from `unfilteredItems`
   * (when provided) so it survives the spread-cap drop that erases
   * the live ✦ conviction badge later in the session. Always null
   * when `unfilteredItems` is omitted (back-compat).
   */
  wasConvictionAt: number | null;
  /**
   * Fire count inside the qualifying past-conviction window. 0 when
   * `wasConvictionAt` is null. Surfaces in the "was ✦ HH:MM (Nf)"
   * tooltip.
   */
  wasConvictionFireCount: number;
  /**
   * Highest OTM-sweep cluster-strike count across this ticker — derived
   * from the UNFILTERED set when `unfilteredItems` is provided, falling
   * back to the filtered set otherwise. Drives the violet 🎰 OTM SWEEP
   * badge on the group header (rendered at ≥ 3). 0 when no item in the
   * ticker carries a cluster mark.
   */
  clusterStrikes: number;
}

/**
 * `'peak'` orders both groups AND within-group items by realized
 * peak desc (nulls last). `'time'` orders within-group items by
 * trigger time desc (newest first) — use it for the sections'
 * time-based chips (SB 'newest', Lottery 'chronological'), where the
 * feeds' never-vanish kept-set union can interleave rows so arrival
 * order within a ticker is NOT guaranteed time-desc. `'default'`
 * leaves within-group order untouched — use it for metric chips
 * (score / spike_ratio / vol_oi) where the API order IS the chosen
 * ordering. Both `'time'` and `'default'` order groups by
 * conviction → storm → item-count desc → recency desc.
 */
export type TickerGroupSortMode = 'peak' | 'time' | 'default';

export interface UseTickerGroupingOptions<T> {
  items: readonly T[];
  sortMode: TickerGroupSortMode;
  /** Pure projection — see TickerGroupingExtract. */
  extract: (item: T) => TickerGroupingExtract;
  /** Intensity threshold passed to isBurstStorm. */
  stormIntensityThreshold: number;
  /**
   * Optional full-day unfiltered item set. When provided, the
   * `conviction` and `storm` flags on each displayed group are
   * computed from the unfiltered set, so chip filters that hide
   * rows do not erase a ticker's true-footprint badge state.
   * Trader complaint that motivated the option: filtering used to
   * silently drop the ✦ conviction badge once `fires.length` slipped
   * below 3 even though the underlying ticker had ≥3 clean fires
   * within 15 min earlier in the day.
   *
   * `peakBest` and `latestTriggerMs` stay filtered (they should
   * reflect what's visible). When this option is omitted, behavior
   * is unchanged from the pre-fix code path.
   */
  unfilteredItems?: readonly T[];
}

export function useTickerGrouping<T>(
  opts: UseTickerGroupingOptions<T>,
): TickerGroup<T>[] {
  // Stash `extract` in a ref so callers can pass inline lambdas
  // without invalidating the memo on every render. The function is
  // assumed pure — closure state changes across renders are ignored,
  // which matches every existing call site (the projections only
  // read fields off their argument).
  const extractRef = useRef(opts.extract);
  extractRef.current = opts.extract;

  const { items, sortMode, stormIntensityThreshold, unfilteredItems } = opts;

  return useMemo(() => {
    const extract = extractRef.current;
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const { ticker } = extract(item);
      const arr = groups.get(ticker);
      if (arr) arr.push(item);
      else groups.set(ticker, [item]);
    }

    // Per-ticker conviction/storm + earliest-conviction-window
    // computed from the UNFILTERED set (when provided). Filter chips
    // shrink the visible items but the badge state should reflect the
    // ticker's true day-footprint. The `wasConvictionAt` field
    // backstops the past-tense "was ✦" pill so the trader doesn't
    // lose track of a ticker that DID have a clean conviction
    // footprint earlier in the session.
    const unfilteredFlags = new Map<
      string,
      {
        conviction: boolean;
        strongConviction: boolean;
        storm: boolean;
        wasConvictionAt: number | null;
        wasConvictionFireCount: number;
        clusterStrikes: number;
      }
    >();
    if (unfilteredItems) {
      const fullByTicker = new Map<string, T[]>();
      for (const item of unfilteredItems) {
        const { ticker } = extract(item);
        const arr = fullByTicker.get(ticker);
        if (arr) arr.push(item);
        else fullByTicker.set(ticker, [item]);
      }
      for (const [ticker, list] of fullByTicker) {
        const summaries = list.map(extract);
        const rollupSummaries = summaries.map((s) => s.rollupSummary);
        const agg = computeRollupAggregates(rollupSummaries);
        const window = findEarliestConvictionWindow(rollupSummaries);
        // Reduce-with-0-seed matches the peakBest pattern below and
        // handles the empty-list case naturally (no need for a
        // Math.max-spread + empty guard).
        const clusterStrikes = summaries.reduce(
          (max, s) => Math.max(max, s.clusterStrikeCount ?? 0),
          0,
        );
        unfilteredFlags.set(ticker, {
          conviction: isHighConviction(agg, list.length),
          strongConviction: isStrongConviction(
            agg,
            list.length,
            rollupSummaries,
          ),
          storm: isBurstStorm(agg, list.length, stormIntensityThreshold),
          wasConvictionAt: window?.firstFireMs ?? null,
          wasConvictionFireCount: window?.fireCount ?? 0,
          clusterStrikes,
        });
      }
    }

    return Array.from(groups, ([ticker, list]) => {
      const orderedItems =
        sortMode === 'peak'
          ? [...list].sort((a, b) => {
              const ap = extract(a).peakPct ?? -Infinity;
              const bp = extract(b).peakPct ?? -Infinity;
              return bp - ap;
            })
          : sortMode === 'time'
            ? [...list].sort((a, b) => {
                // Trigger-time desc (newest first). Non-finite
                // triggerMs sinks to the bottom — same NaN guard
                // philosophy as the latestTriggerMs reduction below.
                const at = extract(a).triggerMs;
                const bt = extract(b).triggerMs;
                return (
                  (Number.isFinite(bt) ? bt : -Infinity) -
                  (Number.isFinite(at) ? at : -Infinity)
                );
              })
            : list;
      const summaries = orderedItems.map(extract);
      const rollupSummaries = summaries.map((s) => s.rollupSummary);
      const agg = computeRollupAggregates(rollupSummaries);
      const peakBest = summaries.reduce<number | null>((best, s) => {
        const p = s.peakPct;
        if (p == null) return best;
        if (best == null) return p;
        return Math.max(best, p);
      }, null);
      // Guard against NaN / non-finite triggerMs leaking from a caller
      // that forgot to validate Date.parse output. Defense in depth —
      // both current callers already guard, but treating the hook's
      // input contract as "caller must filter NaN" would be a footgun
      // if a future call site forgets.
      const latestTriggerMs = summaries.reduce<number>(
        (max, s) =>
          Number.isFinite(s.triggerMs) && s.triggerMs > max ? s.triggerMs : max,
        0,
      );
      // Back-compat fallback: when unfilteredItems is omitted, fall
      // back to the filtered subset (same shape as conviction/storm
      // back-compat). Uses the same reduce-with-0-seed pattern as the
      // unfiltered branch.
      const filteredClusterStrikes = summaries.reduce(
        (max, s) => Math.max(max, s.clusterStrikeCount ?? 0),
        0,
      );
      const unfiltered = unfilteredFlags.get(ticker);
      return {
        ticker,
        items: orderedItems,
        conviction:
          unfiltered?.conviction ?? isHighConviction(agg, orderedItems.length),
        strongConviction:
          unfiltered?.strongConviction ??
          isStrongConviction(agg, orderedItems.length, rollupSummaries),
        storm:
          unfiltered?.storm ??
          isBurstStorm(agg, orderedItems.length, stormIntensityThreshold),
        peakBest,
        latestTriggerMs,
        wasConvictionAt: unfiltered?.wasConvictionAt ?? null,
        wasConvictionFireCount: unfiltered?.wasConvictionFireCount ?? 0,
        clusterStrikes: unfiltered?.clusterStrikes ?? filteredClusterStrikes,
      };
    }).sort((a, b) => {
      if (sortMode === 'peak') {
        const ap = a.peakBest ?? -Infinity;
        const bp = b.peakBest ?? -Infinity;
        if (ap !== bp) return bp - ap;
        return b.latestTriggerMs - a.latestTriggerMs;
      }
      // Conviction first (clean), then storm (loud) — both above the
      // regular item-count + recency rule. A ticker that hits BOTH
      // lives at the very top.
      if (a.conviction !== b.conviction) return a.conviction ? -1 : 1;
      if (a.storm !== b.storm) return a.storm ? -1 : 1;
      if (b.items.length !== a.items.length) {
        return b.items.length - a.items.length;
      }
      return b.latestTriggerMs - a.latestTriggerMs;
    });
  }, [items, sortMode, stormIntensityThreshold, unfilteredItems]);
}
