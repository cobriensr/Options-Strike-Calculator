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
 *
 * ## Internal structure (post-refactor)
 *
 * The body of `evaluateTriggers` is a thin orchestrator that dispatches
 * each trigger to one of three pattern-specific helpers:
 *
 *   - `evaluateWallProximity` — fade-call-wall / lift-put-wall. Mirror
 *     decision logic parameterized by direction (`'call'` vs `'put'`)
 *     and the trend signal that suppresses the fade in that direction.
 *   - `evaluateWallBreak` — break-call-wall / break-put-wall. Mirror
 *     distance-sign decision logic parameterized by direction.
 *   - `evaluateCharmDrift` — single-pattern session-window trigger.
 *
 * Each helper returns a fully-formed `TriggerState`. The shared
 * `buildTriggerState` factory at the bottom of this module reduces the
 * 8-field literal repetition that previously appeared 12+ times in the
 * evaluator body.
 */

import { LEVEL_PROXIMITY_ES_POINTS, RULE_ARMED_BAND_ES } from './playbook.js';
import { evaluateDriftOverride } from './flow-signals.js';
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

// ── Trigger metadata ───────────────────────────────────────────────────

/**
 * Static `id`/`name`/`condition` triple per trigger. Pulled out of the
 * evaluator body because every branch (ACTIVE, ARMED, DISTANT, BLOCKED)
 * needed them and was previously inlining all three identically.
 */
const TRIGGER_META: Record<TriggerId, { name: string; condition: string }> = {
  'fade-call-wall': {
    name: 'Fade call wall',
    condition:
      'Positive-gamma regime and ES within 5 pts of the call wall — structural fade.',
  },
  'lift-put-wall': {
    name: 'Lift put wall',
    condition:
      'Positive-gamma regime and ES within 5 pts of the put wall — structural lift.',
  },
  'break-call-wall': {
    name: 'Break call wall',
    condition:
      'Negative-gamma regime and ES has broken above the call wall — trend continuation.',
  },
  'break-put-wall': {
    name: 'Break put wall',
    condition:
      'Negative-gamma regime and ES has broken below the put wall — trend continuation.',
  },
  'charm-drift': {
    name: 'Charm drift to pin',
    condition:
      'Positive-gamma regime in afternoon/power hour with gamma pin known — pin drift.',
  },
};

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

/**
 * Factory: build a `TriggerState` literal. Handles the 4-field repetition
 * (id/name/condition pulled from `TRIGGER_META`) plus the optional fields
 * that vary per status. Callers supply the variable bits — status, level
 * label/price, distance, blocked reason — and never have to remember to
 * fill in the static metadata.
 */
function buildTriggerState(args: {
  id: TriggerId;
  status: TriggerStatus;
  levelLabel: string | null;
  levelEsPrice: number | null;
  distanceEsPoints: number | null;
  blockedReason: string | null;
}): TriggerState {
  const meta = TRIGGER_META[args.id];
  return {
    id: args.id,
    name: meta.name,
    status: args.status,
    condition: meta.condition,
    levelLabel: args.levelLabel,
    levelEsPrice: args.levelEsPrice,
    distanceEsPoints: args.distanceEsPoints,
    blockedReason: args.blockedReason,
  };
}

// ── Pattern: wall-proximity (fade-call-wall, lift-put-wall) ────────────

/**
 * Decide the BLOCKED reason for a wall-proximity trigger, or null when
 * no precondition fails. Centralizes the regime / drift-override / wall
 * gates so the two mirror triggers share one decision table.
 *
 * `wall` is what `findLevel(levels, 'CALL_WALL' | 'PUT_WALL')` returned
 * for this side; `driftAgainst` is true when the consistent priceTrend
 * direction would structurally invalidate the fade (drift up against a
 * call-wall fade, drift down against a put-wall lift).
 */
function wallProximityBlockedReason(args: {
  regime: GexRegime;
  wall: EsLevel | null;
  driftAgainst: boolean;
  driftDirectionLabel: 'up' | 'down';
  fadeOrLift: 'fade' | 'lift';
}): string | null {
  if (args.regime !== 'POSITIVE') {
    return 'Needs +GEX regime.';
  }
  if (args.driftAgainst) {
    return `Drifting ${args.driftDirectionLabel} — ${args.fadeOrLift} suppressed by trend override.`;
  }
  if (args.wall === null) {
    return 'Wall level unknown.';
  }
  return null;
}

interface WallProximityArgs {
  id: 'fade-call-wall' | 'lift-put-wall';
  regime: GexRegime;
  esPrice: number | null;
  wall: EsLevel | null;
  walLabel: 'Call wall' | 'Put wall';
  driftAgainst: boolean;
  driftDirectionLabel: 'up' | 'down';
  fadeOrLift: 'fade' | 'lift';
}

function evaluateWallProximity(args: WallProximityArgs): TriggerState {
  const blockedReason = wallProximityBlockedReason({
    regime: args.regime,
    wall: args.wall,
    driftAgainst: args.driftAgainst,
    driftDirectionLabel: args.driftDirectionLabel,
    fadeOrLift: args.fadeOrLift,
  });

  if (blockedReason !== null) {
    return buildTriggerState({
      id: args.id,
      status: 'BLOCKED',
      // The wall label/price still display when present so the trader sees
      // *which* level the BLOCKED row corresponds to. When the wall itself
      // is missing, both fields are null.
      levelLabel: args.wall ? args.walLabel : null,
      levelEsPrice: args.wall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason,
    });
  }

  // Past this point `args.wall` is non-null because `wallProximityBlockedReason`
  // would have caught a missing wall in the regime/drift-pass case.
  const wall = args.wall as EsLevel;
  const { status, distance } = proximityStatus(args.esPrice, wall);
  return buildTriggerState({
    id: args.id,
    status,
    levelLabel: args.walLabel,
    levelEsPrice: wall.esPrice,
    distanceEsPoints: distance,
    blockedReason: null,
  });
}

// ── Pattern: wall-break (break-call-wall, break-put-wall) ──────────────

/**
 * Decide the live status for a wall-break trigger when preconditions pass
 * and esPrice is known. The "broken" condition is direction-specific:
 *
 *   - break-call-wall: distance < 0 ⇒ price ABOVE the call wall ⇒ ACTIVE.
 *   - break-put-wall:  distance > 0 ⇒ wall ABOVE price (price below) ⇒ ACTIVE.
 *
 * ARMED fires when price is within `RULE_ARMED_BAND_ES` on the
 * pre-trigger side; otherwise DISTANT. The caller handles the
 * regime/wall/esPrice BLOCKED + DISTANT preconditions.
 */
function wallBreakLiveStatus(
  distance: number,
  side: 'call' | 'put',
): TriggerStatus {
  if (side === 'call') {
    if (distance < 0) return 'ACTIVE';
    if (distance <= RULE_ARMED_BAND_ES) return 'ARMED';
    return 'DISTANT';
  }
  // side === 'put': mirror — wall above price is the ACTIVE condition.
  if (distance > 0) return 'ACTIVE';
  if (-distance <= RULE_ARMED_BAND_ES) return 'ARMED';
  return 'DISTANT';
}

interface WallBreakArgs {
  id: 'break-call-wall' | 'break-put-wall';
  regime: GexRegime;
  esPrice: number | null;
  wall: EsLevel | null;
  wallLabel: 'Call wall' | 'Put wall';
  side: 'call' | 'put';
}

function evaluateWallBreak(args: WallBreakArgs): TriggerState {
  if (args.regime !== 'NEGATIVE') {
    return buildTriggerState({
      id: args.id,
      status: 'BLOCKED',
      levelLabel: args.wall ? args.wallLabel : null,
      levelEsPrice: args.wall?.esPrice ?? null,
      distanceEsPoints: null,
      blockedReason: 'Needs −GEX regime.',
    });
  }
  if (args.wall === null) {
    return buildTriggerState({
      id: args.id,
      status: 'BLOCKED',
      levelLabel: null,
      levelEsPrice: null,
      distanceEsPoints: null,
      blockedReason: 'Wall level unknown.',
    });
  }
  if (args.esPrice === null) {
    // Regime + wall OK, but no live ES price — degrade to DISTANT
    // rather than BLOCKED so the row still surfaces the wall level.
    return buildTriggerState({
      id: args.id,
      status: 'DISTANT',
      levelLabel: args.wallLabel,
      levelEsPrice: args.wall.esPrice,
      distanceEsPoints: null,
      blockedReason: null,
    });
  }
  const distance = args.wall.esPrice - args.esPrice;
  return buildTriggerState({
    id: args.id,
    status: wallBreakLiveStatus(distance, args.side),
    levelLabel: args.wallLabel,
    levelEsPrice: args.wall.esPrice,
    distanceEsPoints: distance,
    blockedReason: null,
  });
}

// ── Pattern: charm-drift ───────────────────────────────────────────────

function evaluateCharmDrift(args: {
  regime: GexRegime;
  phase: SessionPhase;
  gammaPin: number | null;
}): TriggerState {
  // Target = highest |netGamma| strike (gamma-pin), NOT max-pain. Dealer
  // hedging concentrates where gamma concentrates; max-pain is a separate
  // payout-minimization concept that often but not always aligns.
  const charmRegimeOk = args.regime === 'POSITIVE';
  const charmPhaseOk = args.phase === 'AFTERNOON' || args.phase === 'POWER';
  if (!charmRegimeOk || !charmPhaseOk || args.gammaPin === null) {
    return buildTriggerState({
      id: 'charm-drift',
      status: 'BLOCKED',
      levelLabel: args.gammaPin !== null ? 'Gamma pin' : null,
      levelEsPrice: args.gammaPin,
      distanceEsPoints: null,
      blockedReason: 'Needs +GEX in afternoon/power with gamma pin.',
    });
  }
  // Charm-drift is a session-window trigger, not proximity-gated.
  // Once preconditions are satisfied it is ACTIVE.
  return buildTriggerState({
    id: 'charm-drift',
    status: 'ACTIVE',
    levelLabel: 'Gamma pin',
    levelEsPrice: args.gammaPin,
    distanceEsPoints: null,
    blockedReason: null,
  });
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
  // The drift predicate is shared with `playbook.ts` and `tradeBias.ts`
  // via `evaluateDriftOverride` so the three sites can't drift apart
  // again — the previous inline copies briefly disagreed about the
  // consistency floor and produced a UI/cron divergence.
  const drift = evaluateDriftOverride(flowSignals);

  return [
    evaluateWallProximity({
      id: 'fade-call-wall',
      regime,
      esPrice,
      wall: callWall,
      walLabel: 'Call wall',
      driftAgainst: drift.up,
      driftDirectionLabel: 'up',
      fadeOrLift: 'fade',
    }),
    evaluateWallProximity({
      id: 'lift-put-wall',
      regime,
      esPrice,
      wall: putWall,
      walLabel: 'Put wall',
      driftAgainst: drift.down,
      driftDirectionLabel: 'down',
      fadeOrLift: 'lift',
    }),
    evaluateWallBreak({
      id: 'break-call-wall',
      regime,
      esPrice,
      wall: callWall,
      wallLabel: 'Call wall',
      side: 'call',
    }),
    evaluateWallBreak({
      id: 'break-put-wall',
      regime,
      esPrice,
      wall: putWall,
      wallLabel: 'Put wall',
      side: 'put',
    }),
    evaluateCharmDrift({ regime, phase, gammaPin }),
  ];
}
