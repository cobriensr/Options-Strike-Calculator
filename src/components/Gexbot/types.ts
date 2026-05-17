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
 * spot > zero_gamma → dealers long gamma (vol stable / suppression).
 * spot < zero_gamma → dealers short gamma (vol expansion regime).
 */
export type GammaSign = 'long' | 'short' | 'unknown';

export function deriveGammaSign(
  spot: number | null,
  zeroGamma: number | null,
): GammaSign {
  if (spot == null || zeroGamma == null) return 'unknown';
  if (spot > zeroGamma) return 'long';
  if (spot < zeroGamma) return 'short';
  return 'unknown';
}
