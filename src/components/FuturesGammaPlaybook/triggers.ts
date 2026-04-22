/**
 * Named-setup trigger evaluation for the FuturesGammaPlaybook.
 *
 * Given the current regime/phase plus the ES-translated levels, classify
 * each of five named setups. The panel renders the resulting rows as a
 * checklist so the trader can see, at a glance, which structural setups
 * are firing, close to firing, blocked by regime, or too far off to care.
 *
 * Everything here is pure — no hooks, no fetches, no side effects.
 *
 * ## Statuses
 *
 * - ACTIVE          — regime/phase/data preconditions met AND price inside
 *                     the 5-pt proximity band of the keyed level (or the
 *                     charm-drift window is live).
 * - ARMED           — preconditions met AND price is within 15 pts but >5
 *                     pts of the keyed level.
 * - DISTANT         — preconditions met but >15 pts away. Level is known
 *                     but nothing to do right now.
 * - BLOCKED         — a hard precondition fails (wrong regime, wrong
 *                     phase, or the keyed level / max-pain unknown). The
 *                     row is shown with a reason so the trader knows
 *                     WHY this trigger is unavailable.
 * - RECENTLY_FIRED  — forward-compat only; Phase 1E will emit this once
 *                     the alerts system tracks recent fires.
 */

import {
  DRIFT_OVERRIDE_CONSISTENCY_MIN,
  LEVEL_PROXIMITY_ES_POINTS,
  RULE_ARMED_BAND_ES,
} from './playbook.js';
import type {
  EsLevel,
  GexRegime,
  PlaybookFlowSignals,
  SessionPhase,
} from './types';

// ── Public types ───────────────────────────────────────────────────────

export type TriggerId =
  | 'fade-call-wall'
  | 'lift-put-wall'
  | 'break-call-wall'
  | 'break-put-wall'
  | 'charm-drift';

export type TriggerStatus =
  | 'ACTIVE'
  | 'ARMED'
  | 'DISTANT'
  | 'BLOCKED'
  | 'RECENTLY_FIRED';

export interface TriggerState {
  id: TriggerId;
  name: string;
  status: TriggerStatus;
  condition: string;
  /** Label of the ES level this trigger keys off (e.g. 'Call wall'), or null when none. */
  levelLabel: string | null;
  /** ES price of the keyed level, or null when missing. */
  levelEsPrice: number | null;
  /**
   * Signed ES points price must MOVE to reach the arm threshold. Null
   * when BLOCKED, when esPrice is unknown, or when the trigger is not
   * distance-gated (charm-drift).
   */
  distanceEsPoints: number | null;
  /**
   * Human-readable reason when `status === 'BLOCKED'`, null otherwise.
   * Rendered as a tooltip on the row so the trader sees what needs to
   * change for the trigger to become available.
   */
  blockedReason: string | null;
}

export interface EvaluateTriggersInput {
  regime: GexRegime;
  phase: SessionPhase;
  esPrice: number | null;
  levels: EsLevel[];
  /**
   * ES price of the highest-|netGamma| strike (gamma-pin). Passed
   * separately because it is not rendered as an EsLevel row — it would
   * always duplicate CALL_WALL or PUT_WALL by construction. Used only
   * by the charm-drift trigger as the pin magnet.
   */
  esGammaPin?: number | null;
  /**
   * Optional flow signals — when the priceTrend is drifting consistently
   * in POSITIVE regime, `fade-call-wall` / `lift-put-wall` are BLOCKED
   * with a drift-override reason, matching `rulesForRegime`'s suppression.
   * Without this parity, the server cron can fire TRIGGER_FIRE push
   * alerts for rules the UI has refused to display — a textbook
   * user-facing divergence.
   *
   * Server-side callers (regime cron) that don't maintain a snapshot
   * buffer can omit this field; they'll evaluate as if no drift is
   * present (the original pre-drift-override behavior).
   */
  flowSignals?: PlaybookFlowSignals | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Look up the first level of a given kind, or null when absent. */
function findLevel(levels: EsLevel[], kind: EsLevel['kind']): EsLevel | null {
  return levels.find((l) => l.kind === kind) ?? null;
}

/**
 * Classify proximity against the wall for fade/lift triggers. Returns one
 * of ACTIVE / ARMED / DISTANT — never BLOCKED (the caller handles that).
 */
function proximityStatus(
  esPrice: number | null,
  level: EsLevel | null,
): { status: 'ACTIVE' | 'ARMED' | 'DISTANT'; distance: number | null } {
  if (esPrice === null || level === null) {
    return { status: 'DISTANT', distance: null };
  }
  const distance = level.esPrice - esPrice;
  const abs = Math.abs(distance);
  if (abs <= LEVEL_PROXIMITY_ES_POINTS) {
    return { status: 'ACTIVE', distance };
  }
  if (abs <= RULE_ARMED_BAND_ES) {
    return { status: 'ARMED', distance };
  }
  return { status: 'DISTANT', distance };
}

// ── Evaluator ──────────────────────────────────────────────────────────

/**
 * Evaluate all five named triggers against the current playbook state.
 *
 * Returns one `TriggerState` per trigger, always in stable order. When a
 * hard precondition fails (wrong regime, missing wall, missing max-pain)
 * the trigger is BLOCKED with a reason so the UI can show the trader
 * what's missing rather than just hiding the row.
 */
export function evaluateTriggers(input: EvaluateTriggersInput): TriggerState[] {
  const { regime, phase, esPrice, levels, esGammaPin, flowSignals } = input;

  const callWall = findLevel(levels, 'CALL_WALL');
  const putWall = findLevel(levels, 'PUT_WALL');
  const gammaPin = esGammaPin ?? null;

  // Drift-override parity with `rulesForRegime`: when price is grinding
  // consistently in one direction inside a POSITIVE regime, the opposing
  // mean-revert rule is structurally wrong and `rulesForRegime` drops it.
  // Mirror that here so the trigger panel (and the push-alert cron that
  // reads `ACTIVE` rows) can't fire for a trade the UI refuses to show.
  const trend = flowSignals?.priceTrend;
  const driftConsistent =
    trend != null && trend.consistency >= DRIFT_OVERRIDE_CONSISTENCY_MIN;
  const driftUp = driftConsistent && trend != null && trend.direction === 'up';
  const driftDown =
    driftConsistent && trend != null && trend.direction === 'down';

  // ── fade-call-wall ────────────────────────────────────────────────
  let fadeCallWall: TriggerState;
  if (regime !== 'POSITIVE') {
    fadeCallWall = {
      id: 'fade-call-wall',
      name: 'Fade call wall',
      status: 'BLOCKED',
      condition:
        'Positive-gamma regime and ES within 5 pts of the call wall — structural fade.',
      levelLabel: callWall ? 'Call wall' : null,
      levelEsPrice: callWall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason: 'Needs +GEX regime.',
    };
  } else if (driftUp) {
    // Tape is drifting up through the call wall — fade is structurally
    // wrong here. Matches `rulesForRegime` suppression.
    fadeCallWall = {
      id: 'fade-call-wall',
      name: 'Fade call wall',
      status: 'BLOCKED',
      condition:
        'Positive-gamma regime and ES within 5 pts of the call wall — structural fade.',
      levelLabel: callWall ? 'Call wall' : null,
      levelEsPrice: callWall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason: 'Drifting up — fade suppressed by trend override.',
    };
  } else if (callWall === null) {
    fadeCallWall = {
      id: 'fade-call-wall',
      name: 'Fade call wall',
      status: 'BLOCKED',
      condition:
        'Positive-gamma regime and ES within 5 pts of the call wall — structural fade.',
      levelLabel: null,
      levelEsPrice: null,
      distanceEsPoints: null,
      blockedReason: 'Wall level unknown.',
    };
  } else {
    const { status, distance } = proximityStatus(esPrice, callWall);
    fadeCallWall = {
      id: 'fade-call-wall',
      name: 'Fade call wall',
      status,
      condition:
        'Positive-gamma regime and ES within 5 pts of the call wall — structural fade.',
      levelLabel: 'Call wall',
      levelEsPrice: callWall.esPrice,
      distanceEsPoints: distance,
      blockedReason: null,
    };
  }

  // ── lift-put-wall ─────────────────────────────────────────────────
  let liftPutWall: TriggerState;
  if (regime !== 'POSITIVE') {
    liftPutWall = {
      id: 'lift-put-wall',
      name: 'Lift put wall',
      status: 'BLOCKED',
      condition:
        'Positive-gamma regime and ES within 5 pts of the put wall — structural lift.',
      levelLabel: putWall ? 'Put wall' : null,
      levelEsPrice: putWall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason: 'Needs +GEX regime.',
    };
  } else if (driftDown) {
    // Tape is drifting down through the put wall — lift is structurally
    // wrong here. Matches `rulesForRegime` suppression.
    liftPutWall = {
      id: 'lift-put-wall',
      name: 'Lift put wall',
      status: 'BLOCKED',
      condition:
        'Positive-gamma regime and ES within 5 pts of the put wall — structural lift.',
      levelLabel: putWall ? 'Put wall' : null,
      levelEsPrice: putWall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason: 'Drifting down — lift suppressed by trend override.',
    };
  } else if (putWall === null) {
    liftPutWall = {
      id: 'lift-put-wall',
      name: 'Lift put wall',
      status: 'BLOCKED',
      condition:
        'Positive-gamma regime and ES within 5 pts of the put wall — structural lift.',
      levelLabel: null,
      levelEsPrice: null,
      distanceEsPoints: null,
      blockedReason: 'Wall level unknown.',
    };
  } else {
    const { status, distance } = proximityStatus(esPrice, putWall);
    liftPutWall = {
      id: 'lift-put-wall',
      name: 'Lift put wall',
      status,
      condition:
        'Positive-gamma regime and ES within 5 pts of the put wall — structural lift.',
      levelLabel: 'Put wall',
      levelEsPrice: putWall.esPrice,
      distanceEsPoints: distance,
      blockedReason: null,
    };
  }

  // ── break-call-wall ───────────────────────────────────────────────
  //
  // ARMED semantics for breakouts: regime+wall preconditions satisfied,
  // price is within 15 pts of the wall BUT still on the pre-trigger side
  // (below the wall for a LONG break). ACTIVE fires once price clears
  // the wall — i.e. distance sign flips negative. Beyond 15 pts below →
  // DISTANT.
  let breakCallWall: TriggerState;
  if (regime !== 'NEGATIVE') {
    breakCallWall = {
      id: 'break-call-wall',
      name: 'Break call wall',
      status: 'BLOCKED',
      condition:
        'Negative-gamma regime and ES has broken above the call wall — trend continuation.',
      levelLabel: callWall ? 'Call wall' : null,
      levelEsPrice: callWall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason: 'Needs −GEX regime.',
    };
  } else if (callWall === null) {
    breakCallWall = {
      id: 'break-call-wall',
      name: 'Break call wall',
      status: 'BLOCKED',
      condition:
        'Negative-gamma regime and ES has broken above the call wall — trend continuation.',
      levelLabel: null,
      levelEsPrice: null,
      distanceEsPoints: null,
      blockedReason: 'Wall level unknown.',
    };
  } else if (esPrice === null) {
    breakCallWall = {
      id: 'break-call-wall',
      name: 'Break call wall',
      status: 'DISTANT',
      condition:
        'Negative-gamma regime and ES has broken above the call wall — trend continuation.',
      levelLabel: 'Call wall',
      levelEsPrice: callWall.esPrice,
      distanceEsPoints: null,
      blockedReason: null,
    };
  } else {
    const distance = callWall.esPrice - esPrice;
    // Distance < 0 ⇒ price is above the wall ⇒ BROKEN ABOVE ⇒ ACTIVE.
    let status: TriggerStatus;
    if (distance < 0) {
      status = 'ACTIVE';
    } else if (distance <= RULE_ARMED_BAND_ES) {
      status = 'ARMED';
    } else {
      status = 'DISTANT';
    }
    breakCallWall = {
      id: 'break-call-wall',
      name: 'Break call wall',
      status,
      condition:
        'Negative-gamma regime and ES has broken above the call wall — trend continuation.',
      levelLabel: 'Call wall',
      levelEsPrice: callWall.esPrice,
      distanceEsPoints: distance,
      blockedReason: null,
    };
  }

  // ── break-put-wall ────────────────────────────────────────────────
  let breakPutWall: TriggerState;
  if (regime !== 'NEGATIVE') {
    breakPutWall = {
      id: 'break-put-wall',
      name: 'Break put wall',
      status: 'BLOCKED',
      condition:
        'Negative-gamma regime and ES has broken below the put wall — trend continuation.',
      levelLabel: putWall ? 'Put wall' : null,
      levelEsPrice: putWall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason: 'Needs −GEX regime.',
    };
  } else if (putWall === null) {
    breakPutWall = {
      id: 'break-put-wall',
      name: 'Break put wall',
      status: 'BLOCKED',
      condition:
        'Negative-gamma regime and ES has broken below the put wall — trend continuation.',
      levelLabel: null,
      levelEsPrice: null,
      distanceEsPoints: null,
      blockedReason: 'Wall level unknown.',
    };
  } else if (esPrice === null) {
    breakPutWall = {
      id: 'break-put-wall',
      name: 'Break put wall',
      status: 'DISTANT',
      condition:
        'Negative-gamma regime and ES has broken below the put wall — trend continuation.',
      levelLabel: 'Put wall',
      levelEsPrice: putWall.esPrice,
      distanceEsPoints: null,
      blockedReason: null,
    };
  } else {
    const distance = putWall.esPrice - esPrice;
    // Distance > 0 ⇒ level above price ⇒ price below wall ⇒ BROKEN BELOW
    // ⇒ ACTIVE.
    let status: TriggerStatus;
    if (distance > 0) {
      status = 'ACTIVE';
    } else if (-distance <= RULE_ARMED_BAND_ES) {
      status = 'ARMED';
    } else {
      status = 'DISTANT';
    }
    breakPutWall = {
      id: 'break-put-wall',
      name: 'Break put wall',
      status,
      condition:
        'Negative-gamma regime and ES has broken below the put wall — trend continuation.',
      levelLabel: 'Put wall',
      levelEsPrice: putWall.esPrice,
      distanceEsPoints: distance,
      blockedReason: null,
    };
  }

  // ── charm-drift ───────────────────────────────────────────────────
  // Target = highest |netGamma| strike (gamma-pin), NOT max-pain. Dealer
  // hedging concentrates where gamma concentrates; max-pain is a separate
  // payout-minimization concept that often but not always aligns.
  const charmRegimeOk = regime === 'POSITIVE';
  const charmPhaseOk = phase === 'AFTERNOON' || phase === 'POWER';
  let charmDrift: TriggerState;
  if (!charmRegimeOk || !charmPhaseOk || gammaPin === null) {
    charmDrift = {
      id: 'charm-drift',
      name: 'Charm drift to pin',
      status: 'BLOCKED',
      condition:
        'Positive-gamma regime in afternoon/power hour with gamma pin known — pin drift.',
      levelLabel: gammaPin !== null ? 'Gamma pin' : null,
      levelEsPrice: gammaPin,
      distanceEsPoints: null,
      blockedReason: 'Needs +GEX in afternoon/power with gamma pin.',
    };
  } else {
    // Charm-drift is a session-window trigger, not proximity-gated.
    // Once preconditions are satisfied it is ACTIVE.
    charmDrift = {
      id: 'charm-drift',
      name: 'Charm drift to pin',
      status: 'ACTIVE',
      condition:
        'Positive-gamma regime in afternoon/power hour with gamma pin known — pin drift.',
      levelLabel: 'Gamma pin',
      levelEsPrice: gammaPin,
      distanceEsPoints: null,
      blockedReason: null,
    };
  }

  return [fadeCallWall, liftPutWall, breakCallWall, breakPutWall, charmDrift];
}
