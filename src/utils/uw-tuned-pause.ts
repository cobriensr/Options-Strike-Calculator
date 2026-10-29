/**
 * The pause on rules that were tuned on UW Periscope data. Shared by the
 * detect crons, their feed endpoints and the two panels.
 *
 * Owner decision D1 revised (2026-10-29): since PERISCOPE_GEXBOT_CUTOVER
 * every `periscope_snapshots` row is GEXBot's classified taker flow, not UW
 * Periscope's market-maker position (per-strike Spearman ~ +0.04 on the
 * cutover day). The gamma setups (E1/E5/PCS) and the Periscope lottery
 * filters were tuned and backtested on the UW data only, so they stay off
 * on GEXBot data until GEXBot-specific rules exist. Nothing is deleted: the
 * code, the tables and the historical fires stay.
 *
 * No runtime imports beyond periscope-source, so `api/` can pull it in under
 * Node's strict ESM resolver.
 */

import { PERISCOPE_SOURCE, periscopeSourceAt } from './periscope-source.js';

/** Machine-readable reason; goes in cron metadata (Axiom `meta`) and APIs. */
export const UW_TUNED_PAUSE_REASON = 'uw-tuned-rule-on-gexbot-data';

/** Banner copy; `noun` is what the panel shows ('setups' or 'alerts'). */
export function uwTunedPauseMessage(noun: 'setups' | 'alerts'): string {
  return `Paused — these ${noun} were tuned on UW Periscope data; live data is GEXBot. GEXBot-specific rules pending.`;
}

/**
 * True when a rule run against the Periscope slice at `at` would read
 * GEXBot data. Pass the slice time (or now, for the live crons).
 */
export function isUwTunedRulePaused(at: string | Date): boolean {
  return periscopeSourceAt(at) === PERISCOPE_SOURCE.gexbot;
}

/**
 * Same question for a whole ET/expiry day (`YYYY-MM-DD`): true when any part
 * of that day is on GEXBot data (the cutover day itself counts), so a feed
 * for a later date carries the pause and a scraper-era date does not.
 */
export function isUwTunedRulePausedForDay(day: string): boolean {
  return isUwTunedRulePaused(`${day}T23:59:59Z`);
}
