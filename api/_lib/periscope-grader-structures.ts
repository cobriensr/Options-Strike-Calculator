/**
 * Per-structure outcome rules for grading recommended/avoid lists.
 * Appendix A of docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md.
 *
 * Each rule takes the EOD signed return % (close - slotSpot) / slotSpot
 * and a few level inputs and returns true (structure was profitable),
 * false (would have lost), or null (unknown structure).
 *
 * ATR (1-min realized volatility over the 30 min preceding the slot)
 * is computed by the caller and passed in as a percentage. Used for
 * directional debit-spread thresholds.
 */

import { GRADER_THRESHOLDS } from './periscope-grades-types.js';

export interface StructureGradeInput {
  /** Signed EOD return (close - slotSpot) / slotSpot. */
  eodReturnPct: number;
  /** Spot at slot_captured_at. */
  slotSpot: number;
  /** SPX EOD close (15:00 CT). */
  eodClose: number;
  /** Realized 30-min ATR as % of spot, e.g. 0.003 = 0.3%. */
  atrPct: number;
  /** Playbook gamma floor (downside structural level). */
  gammaFloor: number | null;
  /** Playbook gamma ceiling (upside structural level). */
  gammaCeiling: number | null;
  /** Playbook magnet / charm-zero strike. */
  magnet: number | null;
  /** Did EOD close land outside [gammaFloor, gammaCeiling]? */
  icBlownAtEod: boolean | null;
}

/**
 * Grade a single structure name. Returns null when we don't have a
 * rule (so the dashboard can show "ungraded" without polluting the
 * accuracy aggregate).
 */
export function gradeStructure(
  structure: string,
  input: StructureGradeInput,
): boolean | null {
  const {
    eodReturnPct,
    eodClose,
    atrPct,
    gammaFloor,
    gammaCeiling,
    magnet,
    icBlownAtEod,
  } = input;

  const {
    DIRECTIONAL_LONG_RETURN_PCT,
    DIRECTIONAL_ATR_MULT,
    STRADDLE_RETURN_PCT,
    IRON_BUTTERFLY_PIN_PTS,
    BROKEN_WING_PIN_PTS,
  } = GRADER_THRESHOLDS;

  switch (structure) {
    // ─── Directional debit spreads ─────────────────────────────────
    // Profitable if price moves ≥ 1 ATR in the favored direction.
    case 'debit_put_spread':
      return eodReturnPct <= -DIRECTIONAL_ATR_MULT * atrPct;
    case 'debit_call_spread':
      return eodReturnPct >= DIRECTIONAL_ATR_MULT * atrPct;

    // ─── Naked directional buys ────────────────────────────────────
    // Same direction logic, slightly tighter % threshold to count.
    case 'directional_long_call':
    case 'naked_directional_call':
      return eodReturnPct >= DIRECTIONAL_LONG_RETURN_PCT;
    case 'directional_long_put':
    case 'naked_directional_put':
      return eodReturnPct <= -DIRECTIONAL_LONG_RETURN_PCT;

    // ─── Pin-favorable structures ──────────────────────────────────
    // Iron condor: profitable iff spot stays inside the floor/ceiling
    // band at EOD. The grader pre-computes `icBlownAtEod` so we can
    // reuse it here instead of recomputing.
    case 'iron_condor':
      return icBlownAtEod == null ? null : !icBlownAtEod;

    // Iron butterfly: tight pin at the magnet.
    case 'iron_butterfly': {
      if (magnet == null) return null;
      return Math.abs(eodClose - magnet) <= IRON_BUTTERFLY_PIN_PTS;
    }

    // Broken wing butterfly: looser pin tolerance.
    case 'broken_wing_butterfly': {
      if (magnet == null) return null;
      return Math.abs(eodClose - magnet) <= BROKEN_WING_PIN_PTS;
    }

    // ─── Credit spreads ────────────────────────────────────────────
    // Credit call spread: short call expires worthless when spot stays
    // below the ceiling. Use gamma ceiling as the proxy strike — the
    // playbook doesn't expose a short-strike level, but the ceiling is
    // structurally what limits a credit-call sold "at the cap".
    case 'credit_call_spread':
      return gammaCeiling == null ? null : eodClose < gammaCeiling;
    case 'credit_put_spread':
      return gammaFloor == null ? null : eodClose > gammaFloor;

    // ─── Vol expansion ─────────────────────────────────────────────
    case 'long_straddle':
      return Math.abs(eodReturnPct) >= STRADDLE_RETURN_PCT;

    default:
      // Unrecognized structure — surface as null so the dashboard
      // can render "ungraded" rather than counting it as wrong.
      return null;
  }
}

/**
 * Apply `gradeStructure` to a list of structure names, returning the
 * full {name: bool|null} map. Used for both recommended and avoid
 * lists — the caller inverts the bool downstream for the `avoid`
 * list when computing the "avoid was correct" aggregate.
 */
export function gradeStructureList(
  structures: string[],
  input: StructureGradeInput,
): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const s of structures) {
    out[s] = gradeStructure(s, input);
  }
  return out;
}
