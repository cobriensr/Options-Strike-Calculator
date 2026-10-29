/**
 * Shared types for GEXBot frontend components. Re-export hook view
 * payload types so component files don't need to reach back into the
 * hook module.
 */

export type {
  ConvexityTrendRow,
  MaxchangeWinnerRow,
  SiblingConfirmRow,
  SnapshotsLatestRow,
} from '../../hooks/useGexbotData';

/**
 * Long-gamma / short-gamma / unknown derivation from spot vs zero_gamma.
 * spot > zero_gamma → long gamma (vol stable / suppression).
 * spot < zero_gamma → short gamma (vol expansion regime).
 *
 * GEXBot sends `zero_gamma = 0` when no volume has printed yet (the
 * vendor hides the level in that case). A zero level is a sentinel, not
 * a price, so the sign is unknown — without this guard any positive spot
 * would read as "long".
 */
export type GammaSign = 'long' | 'short' | 'unknown';

export function deriveGammaSign(
  spot: number | null,
  zeroGamma: number | null,
): GammaSign {
  if (spot == null || zeroGamma == null || zeroGamma === 0) return 'unknown';
  if (spot > zeroGamma) return 'long';
  if (spot < zeroGamma) return 'short';
  return 'unknown';
}

/**
 * Nearest-expiry label from the snapshot's `min_dte` ("0DTE", "2DTE").
 * Null means the vendor did not report it; say so instead of assuming 0.
 */
export function formatDte(minDte: number | null | undefined): string {
  return minDte == null ? 'DTE n/a' : `${minDte}DTE`;
}
