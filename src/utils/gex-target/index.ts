/**
 * GexTarget scoring math: pure component scorers that turn per-strike
 * gamma-exposure (GEX) features into a composite "target strike" signal.
 *
 * This is the v1 rebuild of the GEX magnet logic. It replaces the old
 * `gex-migration.ts` module with a spec-driven, multi-mode scoring
 * pipeline described in
 * `docs/superpowers/plans/gex-target-rebuild.md`, Appendix C.
 *
 * Design notes:
 * - Every function in this module is pure and synchronous. No React, no
 *   network, no database. The scorers are called from a `useMemo` on
 *   the frontend after the board-history hook delivers snapshots.
 * - Each scorer has a bounded output range (documented in its JSDoc)
 *   so the composite score in Appendix C.4 has a predictable envelope.
 * - Null-handling is explicit: a null horizon in `flowConfluence` is
 *   dropped and the remaining weights are renormalized, so early-session
 *   snapshots (no 20m / 60m history yet) still produce usable signal.
 *
 * This barrel file re-exports the complete public API of the module.
 * The split-by-concern layout (scorers / features / tiers / pipeline /
 * config / types) is structural — callers import the same symbols they
 * did from the old monolith:
 *
 *     import { computeGexTarget, proximity } from '../utils/gex-target';
 *
 * See `src/__tests__/utils/gex-target.components.test.ts` and
 * `gex-target.pipeline.test.ts` for the exhaustive test matrices
 * (Appendix D of the plan doc).
 */

export { GEX_TARGET_CONFIG } from './config.js';

export type {
  ComponentScores,
  GexSnapshot,
  GexStrikeRow,
  MagnetFeatures,
  Mode,
  PriceMovementContext,
  StrikeScore,
  TargetScore,
  Tier,
  WallSide,
} from './types.js';

export {
  charmScore,
  clarity,
  computeAttractingMomentum,
  dominance,
  flowConfluence,
  priceConfirm,
  proximity,
} from './scorers.js';

export { extractFeatures } from './features.js';

export { assignTier, assignWallSide } from './tiers.js';

export {
  computeGexTarget,
  pickUniverse,
  scoreMode,
  scoreStrike,
} from './pipeline.js';
