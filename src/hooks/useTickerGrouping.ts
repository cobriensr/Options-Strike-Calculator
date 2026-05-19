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
  isBurstStorm,
  isHighConviction,
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
}

export interface TickerGroup<T> {
  ticker: string;
  /** Items in their within-group order (peak desc for 'peak' mode). */
  items: T[];
  conviction: boolean;
  storm: boolean;
  peakBest: number | null;
  latestTriggerMs: number;
}

/**
 * `'peak'` orders both groups AND within-group items by realized
 * peak desc (nulls last). `'default'` orders groups by
 * conviction → storm → item-count desc → recency desc, and leaves
 * within-group order untouched.
 */
export type TickerGroupSortMode = 'peak' | 'default';

export interface UseTickerGroupingOptions<T> {
  items: readonly T[];
  sortMode: TickerGroupSortMode;
  /** Pure projection — see TickerGroupingExtract. */
  extract: (item: T) => TickerGroupingExtract;
  /** Intensity threshold passed to isBurstStorm. */
  stormIntensityThreshold: number;
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

  const { items, sortMode, stormIntensityThreshold } = opts;

  return useMemo(() => {
    const extract = extractRef.current;
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const { ticker } = extract(item);
      const arr = groups.get(ticker);
      if (arr) arr.push(item);
      else groups.set(ticker, [item]);
    }

    return Array.from(groups, ([ticker, list]) => {
      const orderedItems =
        sortMode === 'peak'
          ? [...list].sort((a, b) => {
              const ap = extract(a).peakPct ?? -Infinity;
              const bp = extract(b).peakPct ?? -Infinity;
              return bp - ap;
            })
          : list;
      const summaries = orderedItems.map(extract);
      const agg = computeRollupAggregates(
        summaries.map((s) => s.rollupSummary),
      );
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
      return {
        ticker,
        items: orderedItems,
        conviction: isHighConviction(agg, orderedItems.length),
        storm: isBurstStorm(agg, orderedItems.length, stormIntensityThreshold),
        peakBest,
        latestTriggerMs,
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
  }, [items, sortMode, stormIntensityThreshold]);
}
