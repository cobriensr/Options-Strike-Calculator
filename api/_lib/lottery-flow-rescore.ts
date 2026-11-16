/**
 * The V2 score of a lottery fire whose flow was filled in after the fact, and
 * the weights it is scored with. Shared by the three writers that give a fire
 * its flow late:
 *   - `api/_lib/fire-flow-repair.ts`, the automatic post-close repair that runs
 *     inside `enrich-lottery-outcomes`;
 *   - `scripts/_lib/lottery-v2-rescore.ts`, the owner's whole-scope re-score
 *     after a flow backfill;
 *   - `scripts/_lib/fire-flow-correction.ts`, the correction of the doubled
 *     flow.
 * One scoring rule, so a fire repaired by any of them gets the score the live
 * detector (`api/cron/detect-lottery-fires.ts`, Pass 1) would have given it.
 * Spec: docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md.
 */

import {
  isAlignedFire,
  scoreLotteryV2,
  weekdayOf,
} from './lottery-score-weights-v2.js';
import {
  loadLotteryWeights,
  type VersionedWeights,
} from './lottery-weights-loader.js';
import type {
  DeepReadonly,
  LotteryWeights,
  TimeOfDay,
} from './lottery-weights-schema.js';

/**
 * The first ET trading day the seed weights were live. Commit f9f220fa put
 * them on the scorer on 2026-09-07 (after the close; plan
 * 2026-11-05-nightly-pipeline-phase4.md, "quintile-boundary bug" section), and
 * a fire before that day was scored with older weights. Re-scoring one here
 * would be a methodology change (the whole-table rescore does it on purpose,
 * at a promotion), so no writer re-scores a fire from before this day.
 */
export const SEED_WEIGHTS_LIVE_FROM = '2026-09-08';

/** One candidate row, with every input the scorer takes. */
export interface CandidateRow {
  id: string;
  /** `YYYY-MM-DD` */
  date: string;
  underlying_symbol: string;
  tod: string;
  dte: number;
  option_type: 'C' | 'P';
  trigger_vol_to_oi_window: number | null;
  gamma_at_trigger: number | null;
  trigger_ask_pct: number | null;
  cum_ncp_at_fire: number;
  cum_npp_at_fire: number;
  /** The tag the row holds now: NULL for a fire from before the store. */
  score_version: string | null;
}

/**
 * The V2 score for one row under `weights`: the cron's computation, from the
 * row's columns. Null when the scorer says so (not aligned, or dte outside 0
 * to 3). NaN is never returned: a `tod` the weights do not know would sum to
 * NaN, and that row is `'unscorable'` so it is counted and left alone.
 */
export function rescoreRow(
  weights: DeepReadonly<LotteryWeights>,
  row: CandidateRow,
): number | null | 'unscorable' {
  const score = scoreLotteryV2(weights, {
    ticker: row.underlying_symbol,
    tod: row.tod as TimeOfDay,
    dte: row.dte,
    volOiWindow: row.trigger_vol_to_oi_window,
    gammaAtTrigger: row.gamma_at_trigger,
    triggerAskPct: row.trigger_ask_pct,
    optionType: row.option_type,
    isAligned: isAlignedFire(
      row.option_type,
      row.cum_ncp_at_fire,
      row.cum_npp_at_fire,
    ),
    dayOfWeek: weekdayOf(row.date),
  });
  if (score == null) return null;
  return Number.isInteger(score) ? score : 'unscorable';
}

/**
 * The active version and its weights, from the store the cron scores from. The
 * loader answers a store it cannot read with the seed in both slots; scoring
 * and tagging rows with that would put a version on them that the store never
 * gave this run, so a fallback throws, before anything is read or written.
 */
export async function loadActive(): Promise<VersionedWeights> {
  const loaded = await loadLotteryWeights();
  if (loaded.fallback != null) {
    throw new Error(
      `the weights store could not be read (${loaded.fallback.kind}: ${loaded.fallback.reason}), so the active version is not known. Nothing was read or written.`,
    );
  }
  return loaded.active;
}
