/**
 * Tier + wall-side assignment.
 *
 * Pulled into its own module because both helpers are read by the UI
 * (tile/row rendering) and by the pipeline (scoreStrike), so co-locating
 * them here keeps the thresholds + labeling in one spot.
 */

import { GEX_TARGET_CONFIG } from './config.js';
import type { Tier, WallSide } from './types.js';

/**
 * Assign a `Tier` from `|finalScore|` per Appendix C.5.
 *
 * Thresholds are strict `>` (not `>=`), so a score exactly equal to a
 * threshold falls into the LOWER tier. This matches the spec's
 * inequalities literally.
 */
export function assignTier(finalScore: number): Tier {
  const abs = Math.abs(finalScore);
  const { high, medium, low } = GEX_TARGET_CONFIG.tierThresholds;
  if (abs > high) return 'HIGH';
  if (abs > medium) return 'MEDIUM';
  if (abs > low) return 'LOW';
  return 'NONE';
}

/**
 * Assign a `WallSide` per Appendix C.6. NONE tier always collapses to
 * NEUTRAL regardless of gamma sign, so the panel never shows a wall
 * label for a churning strike.
 */
export function assignWallSide(tier: Tier, gexDollars: number): WallSide {
  if (tier === 'NONE') return 'NEUTRAL';
  if (gexDollars > 0) return 'CALL';
  if (gexDollars < 0) return 'PUT';
  return 'NEUTRAL';
}
