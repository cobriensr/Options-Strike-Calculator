/**
 * Shared flow-signal predicates for the FuturesGammaPlaybook module.
 *
 * The drift-override rule was previously copy-pasted in three places
 * (`triggers.ts`, `playbook.ts`, `tradeBias.ts`), each materializing the
 * same `driftConsistent && direction === 'up' / 'down'` shape from a
 * `PlaybookFlowSignals` value. The trio drifted before — at least once,
 * `tradeBias.ts` carried a stricter consistency floor than the other
 * two, producing a regime where the trigger panel and the rule list
 * disagreed about whether the override should fire. Centralizing the
 * predicate here closes that footgun.
 *
 * Everything in this module is pure — no hooks, no fetches, no side
 * effects. Designed to be safe to import from both browser and server
 * code paths.
 */

import { DRIFT_OVERRIDE_CONSISTENCY_MIN } from './playbook.js';
import type { PlaybookFlowSignals } from './types';

/**
 * Decompose flow signals into a pair of "is the drift override firing
 * up?" / "...firing down?" booleans.
 *
 * The override is active for a given direction when:
 *   1. `flowSignals.priceTrend` exists (snapshot buffer has data), AND
 *   2. The trend's `consistency` clears `DRIFT_OVERRIDE_CONSISTENCY_MIN`
 *      (so the chop band doesn't fire), AND
 *   3. The trend's `direction` matches that side ('up' or 'down').
 *
 * `flat` direction returns `{ up: false, down: false }` regardless of
 * consistency — flat is intentionally outside the override universe.
 *
 * Missing `flowSignals` (server-side cron callers without a snapshot
 * buffer) returns `{ up: false, down: false }`, matching the pre-flow
 * behavior where no override was applied.
 */
export function evaluateDriftOverride(
  flowSignals: PlaybookFlowSignals | null | undefined,
): { up: boolean; down: boolean } {
  const trend = flowSignals?.priceTrend;
  if (trend == null) return { up: false, down: false };
  if (trend.consistency < DRIFT_OVERRIDE_CONSISTENCY_MIN) {
    return { up: false, down: false };
  }
  return {
    up: trend.direction === 'up',
    down: trend.direction === 'down',
  };
}
