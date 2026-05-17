/**
 * ReignitionSection — pinned "Hot Right Now" panel that sits above the
 * per-ticker grouped feed. Surfaces chains that match the daily top-N
 * REIGNITION pattern (multi-fire chain that went quiet ≥30 min then
 * had ≥2 post-gap fires) so the bursty alert doesn't get buried in the
 * regular ticker grouping.
 *
 * Source of `reignited` flag: api/lottery-finder.ts (Phase 1 of
 * docs/superpowers/specs/lottery-reignition-ui-2026-05-17.md). Locked
 * thresholds: 3 fires, 30 min gap, 2 post-gap, top 5/day.
 *
 * Task A of the spec — promote out of the per-ticker group entirely
 * (each fire renders here OR in its ticker group, never both) so the
 * user catches the BOOM moment before scrolling.
 */

import { memo } from 'react';
import type { ExitPolicy, LotteryFire } from './types.js';
import { LotteryRow } from './LotteryRow.js';
import type { TickerNetFlowSnapshot } from '../../hooks/useTickerNetFlowBatch.js';

interface ReignitionSectionProps {
  /** Fires that have `reignited === true`, sorted most-recent first. */
  fires: LotteryFire[];
  /** Which realized exit policy to surface as the primary number. */
  exitPolicy: ExitPolicy;
  /** Whether the parent's date is today (drives polling on the chart). */
  marketOpen: boolean;
  /**
   * Per-ticker live cumulative NCP/NPP snapshot. Reignited fires can
   * span many tickers (a hot 5/15 like QQQ + AMD + TSLA may all
   * qualify), so the section receives the map and looks up per-row.
   * Function form keeps the parent's existing Map shape without
   * forcing it to be re-keyed.
   */
  getFlowSnapshot: (ticker: string) => TickerNetFlowSnapshot | null;
}

/**
 * Inner render — pulled out behind React.memo so polling refresh on
 * the parent doesn't re-render the section unless the fires array or
 * filters actually change.
 */
function ReignitionSectionInner({
  fires,
  exitPolicy,
  marketOpen,
  getFlowSnapshot,
}: ReignitionSectionProps) {
  // Empty state — section hides entirely. Per spec: "don't show empty
  // box". Returning null keeps the DOM clean and avoids a layout shift
  // when the daily top-N becomes populated mid-session.
  if (fires.length === 0) return null;

  return (
    <section
      aria-labelledby="reignition-heading"
      data-testid="reignition-section"
      className="mb-4 overflow-hidden rounded-lg border border-orange-500/40 bg-gradient-to-br from-orange-950/30 via-neutral-950/60 to-neutral-950/40 shadow-lg shadow-orange-950/20"
    >
      <header className="flex items-center justify-between gap-3 border-b border-orange-500/30 bg-orange-950/30 px-3 py-2">
        <h3
          id="reignition-heading"
          className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.10em] text-orange-200 uppercase"
        >
          <span
            className="inline-block animate-pulse text-base leading-none"
            aria-hidden="true"
          >
            🔥
          </span>
          <span>Hot Right Now</span>
          <span className="rounded border border-orange-400/40 bg-orange-900/50 px-1.5 py-0.5 font-mono text-[10px] tracking-normal text-orange-100">
            {fires.length}
          </span>
        </h3>
        <p className="hidden text-[10px] text-orange-200/70 sm:block">
          Chains that fired, went quiet ≥30 min, then re-ignited — daily top{' '}
          {fires.length}.
        </p>
      </header>

      <ul className="divide-y divide-orange-900/40">
        {fires.map((fire) => (
          <li key={fire.id} className="px-1 py-1">
            <LotteryRow
              fire={fire}
              exitPolicy={exitPolicy}
              marketOpen={marketOpen}
              liveFlowSnapshot={getFlowSnapshot(fire.underlyingSymbol)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export const ReignitionSection = memo(ReignitionSectionInner);
