/**
 * Barrel re-export for the Gamma-Node Composite Detector tile.
 *
 * Consumers import `GammaNodeDetectorPanel` here; the inner components
 * (FireRow, DayConfidenceBanner) are tile-internal. The hook lives at
 * `src/hooks/useGammaSetups.ts` and is imported separately when needed.
 */

export { GammaNodeDetectorPanel } from './GammaNodeDetectorPanel';
