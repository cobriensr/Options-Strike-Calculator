/**
 * Pure classifier for the Dealer Regime Tile.
 *
 * Maps a `zero_gamma_levels` row to one of four states:
 *   `long-γ`     — dealers net long γ (dampening / mean-reverting regime)
 *   `short-γ`    — dealers net short γ (amplifying / acceleration-prone)
 *   `transition` — spot is sitting on the zero-gamma boundary; sign read
 *                  is unreliable, defer instead of picking a side
 *   `uncertain`  — input is missing, confidence below the gate, or the
 *                  row is older than the staleness threshold
 *
 * Sign convention: interpretation #1 (dealer-side signed), confirmed via
 * SpotGamma TRACE spot-check on 2026-05-01 09:15 CT
 * (see docs/tmp/zero-gamma-audit/AUDIT_FINDINGS.md → Concern #1). Direct
 * read: `netGammaAtSpot > 0` ⇒ dealers long γ. No label-flip required.
 *
 * Decision tree (apply in order, first match wins):
 *   1. uncertain  if any input is null OR confidence < gate OR row is stale
 *   2. transition if zero-gamma is set AND |spot − zero_gamma| / spot < buffer
 *   3. long-γ    if netGammaAtSpot > 0
 *   4. short-γ   if netGammaAtSpot < 0
 *   5. uncertain fallthrough (defensive — should not hit)
 *
 * Pure: no DOM, no fetch, no time singleton — `now` is injected so the
 * staleness branch is testable without faking globals.
 */

export type DealerRegimeState =
  | 'long-γ'
  | 'short-γ'
  | 'transition'
  | 'uncertain';

export interface DealerRegimeInput {
  spot: number;
  zeroGamma: number | null;
  confidence: number | null;
  netGammaAtSpot: number | null;
  /** ISO timestamp of the underlying row (when it was written). */
  ts: string;
}

export interface DealerRegimeConstants {
  /** Confidence below this gate ⇒ uncertain. */
  confidenceGate: number;
  /** |spot − zero_gamma| / spot below this ratio ⇒ transition. */
  boundaryPct: number;
  /** Row age (now − ts, ms) above this ⇒ uncertain. */
  staleAgeMs: number;
}

/**
 * Locked constants per the Phase 2 spec.
 * `confidenceGate` may be re-tuned post-launch if `uncertain` dominates
 * the cell distribution; the audit observed 0.00–0.13 range so 0.10 is
 * deliberately conservative.
 */
export const REGIME_CONSTANTS: DealerRegimeConstants = {
  confidenceGate: 0.1,
  boundaryPct: 0.003,
  staleAgeMs: 15 * 60 * 1000,
};

interface ClassifyOptions {
  now?: number;
  constants?: DealerRegimeConstants;
}

export function classify(
  input: DealerRegimeInput,
  options: ClassifyOptions = {},
): DealerRegimeState {
  const { confidenceGate, boundaryPct, staleAgeMs } =
    options.constants ?? REGIME_CONSTANTS;
  const now = options.now ?? Date.now();

  // 1. Missing data, low confidence, or stale row → uncertain.
  if (input.confidence == null || input.netGammaAtSpot == null) {
    return 'uncertain';
  }
  if (input.confidence < confidenceGate) {
    return 'uncertain';
  }
  const tsMs = Date.parse(input.ts);
  if (Number.isNaN(tsMs) || now - tsMs > staleAgeMs) {
    return 'uncertain';
  }

  // 2. Spot sitting on the zero-gamma boundary → transition. We can only
  // evaluate this when zero_gamma is non-null AND spot is positive; spot
  // ≤ 0 is meaningless for index/ETF data and would divide by zero.
  if (input.zeroGamma != null && input.spot > 0) {
    const distance = Math.abs(input.spot - input.zeroGamma) / input.spot;
    if (distance < boundaryPct) {
      return 'transition';
    }
  }

  // 3 / 4. Sign of net gamma at spot.
  if (input.netGammaAtSpot > 0) return 'long-γ';
  if (input.netGammaAtSpot < 0) return 'short-γ';

  // 5. Defensive — exact zero is treated as uncertain. The kernel sum is
  // floating-point so an exact 0 in practice means we have no data, not
  // that dealers are perfectly delta-hedged.
  return 'uncertain';
}
