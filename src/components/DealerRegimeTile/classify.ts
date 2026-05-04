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
 *
 * `confidenceGate` was tuned from 0.10 → 0.05 on 2026-05-03 after the
 * audit observed conf range 0.00–0.13 across 14 days of telemetry. At
 * 0.10 the tile was projected to read `uncertain` ≥70% of the time
 * (most rows fall below the gate), defeating the regime-read purpose.
 * 0.05 still filters obvious noise (random kernel-crossing artifacts
 * concentrate in the 0.00–0.03 band) while letting through the bulk
 * of legitimate signal. Re-tune again if production data shows either
 * uncertainty-dominance OR signal noise.
 */
export const REGIME_CONSTANTS: DealerRegimeConstants = {
  confidenceGate: 0.05,
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

/**
 * Why is this cell `uncertain`?
 *
 * Returns the FIRST gate that tripped, in the same priority order the
 * classifier applies:
 *   1. `no-data` — confidence or netGammaAtSpot is null
 *   2. `low-confidence` — confidence below the gate
 *   3. `stale` — row is older than the staleness threshold
 *   4. `null` — input would NOT classify as uncertain
 *
 * Surfaced to the trader so they can tell *why* a cell is dim — fresh
 * but low-confidence (wait for the next cron tick to maybe firm up) vs
 * stale (data feed is broken — investigate) — without forcing them to
 * read the underlying numbers.
 */
export type DealerRegimeUncertainReason = 'no-data' | 'low-confidence' | 'stale';

export function classifyUncertainReason(
  input: DealerRegimeInput,
  options: ClassifyOptions = {},
): DealerRegimeUncertainReason | null {
  const { confidenceGate, staleAgeMs } = options.constants ?? REGIME_CONSTANTS;
  const now = options.now ?? Date.now();

  if (input.confidence == null || input.netGammaAtSpot == null) {
    return 'no-data';
  }
  if (input.confidence < confidenceGate) {
    return 'low-confidence';
  }
  const tsMs = Date.parse(input.ts);
  if (Number.isNaN(tsMs) || now - tsMs > staleAgeMs) {
    return 'stale';
  }
  return null;
}
