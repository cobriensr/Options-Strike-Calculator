/**
 * Named-setup trigger evaluation for the FuturesGammaPlaybook.
 *
 * Given the current regime/phase plus the ES-translated levels, classify
 * each of five named setups as ACTIVE or IDLE. The panel renders the
 * resulting rows as a checklist so the trader can see, at a glance, which
 * structural setups are firing right now.
 *
 * Everything here is pure — no hooks, no fetches, no side effects.
 *
 * ## Scope notes
 *
 * Phase 1D.3 ships two statuses: ACTIVE (conditions met right now) and
 * IDLE (conditions not met). The union includes `RECENTLY_FIRED` for
 * forward compatibility, but this evaluator never returns that value. A
 * later phase (Phase 1E / alerts) will track recent fires by feeding a
 * ring buffer of prior evaluations into this function and flipping the
 * status for triggers that fired within the last N minutes.
 */

import { LEVEL_PROXIMITY_ES_POINTS } from './playbook';
import type { EsLevel, GexRegime, SessionPhase } from './types';

// ── Public types ───────────────────────────────────────────────────────

export type TriggerId =
  | 'fade-call-wall'
  | 'lift-put-wall'
  | 'break-call-wall'
  | 'break-put-wall'
  | 'charm-drift';

export type TriggerStatus = 'ACTIVE' | 'IDLE' | 'RECENTLY_FIRED';

export interface TriggerState {
  id: TriggerId;
  name: string;
  status: TriggerStatus;
  condition: string;
  /** Label of the ES level this trigger keys off (e.g. 'Call wall'), or null when none. */
  levelLabel: string | null;
  /** ES price of the keyed level, or null when missing. */
  levelEsPrice: number | null;
}

export interface EvaluateTriggersInput {
  regime: GexRegime;
  phase: SessionPhase;
  esPrice: number | null;
  levels: EsLevel[];
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Look up the first level of a given kind, or null when absent. */
function findLevel(levels: EsLevel[], kind: EsLevel['kind']): EsLevel | null {
  return levels.find((l) => l.kind === kind) ?? null;
}

/**
 * True when `esPrice` is within `LEVEL_PROXIMITY_ES_POINTS` of `level`'s
 * ES price. Returns false when either input is missing.
 */
function withinProximity(
  esPrice: number | null,
  level: EsLevel | null,
): boolean {
  if (esPrice === null || level === null) return false;
  return Math.abs(esPrice - level.esPrice) <= LEVEL_PROXIMITY_ES_POINTS;
}

// ── Evaluator ──────────────────────────────────────────────────────────

/**
 * Evaluate all five named triggers against the current playbook state.
 *
 * Returns one `TriggerState` per trigger, always in stable order. Rows
 * whose keying level is missing render with `status = 'IDLE'` and a null
 * `levelEsPrice` — the UI decides whether to grey-out the row.
 */
export function evaluateTriggers(input: EvaluateTriggersInput): TriggerState[] {
  const { regime, phase, esPrice, levels } = input;

  const callWall = findLevel(levels, 'CALL_WALL');
  const putWall = findLevel(levels, 'PUT_WALL');
  const maxPain = findLevel(levels, 'MAX_PAIN');

  // Each trigger is evaluated independently. Keeping the rows declarative
  // makes the "what does each trigger mean?" answer read off the source.

  const fadeCallWall: TriggerState = {
    id: 'fade-call-wall',
    name: 'Fade call wall',
    status:
      regime === 'POSITIVE' && withinProximity(esPrice, callWall)
        ? 'ACTIVE'
        : 'IDLE',
    condition:
      'Positive-gamma regime and ES within 5 pts of the call wall — structural fade.',
    levelLabel: callWall ? 'Call wall' : null,
    levelEsPrice: callWall?.esPrice ?? null,
  };

  const liftPutWall: TriggerState = {
    id: 'lift-put-wall',
    name: 'Lift put wall',
    status:
      regime === 'POSITIVE' && withinProximity(esPrice, putWall)
        ? 'ACTIVE'
        : 'IDLE',
    condition:
      'Positive-gamma regime and ES within 5 pts of the put wall — structural lift.',
    levelLabel: putWall ? 'Put wall' : null,
    levelEsPrice: putWall?.esPrice ?? null,
  };

  // "Broken above" — call wall's distance sign flipped positive→negative,
  // i.e. price has crossed above the level. `distanceEsPoints` is
  // (level − price), so it is negative when price is above the level.
  const brokenAboveCallWall =
    callWall !== null && callWall.distanceEsPoints < 0;

  const breakCallWall: TriggerState = {
    id: 'break-call-wall',
    name: 'Break call wall',
    status:
      regime === 'NEGATIVE' && brokenAboveCallWall ? 'ACTIVE' : 'IDLE',
    condition:
      'Negative-gamma regime and ES has broken above the call wall — trend continuation.',
    levelLabel: callWall ? 'Call wall' : null,
    levelEsPrice: callWall?.esPrice ?? null,
  };

  // "Broken below" — put wall's distance sign flipped the other way, price
  // has crossed below the level.
  const brokenBelowPutWall = putWall !== null && putWall.distanceEsPoints > 0;

  const breakPutWall: TriggerState = {
    id: 'break-put-wall',
    name: 'Break put wall',
    status:
      regime === 'NEGATIVE' && brokenBelowPutWall ? 'ACTIVE' : 'IDLE',
    condition:
      'Negative-gamma regime and ES has broken below the put wall — trend continuation.',
    levelLabel: putWall ? 'Put wall' : null,
    levelEsPrice: putWall?.esPrice ?? null,
  };

  const charmDriftActive =
    regime === 'POSITIVE' &&
    (phase === 'AFTERNOON' || phase === 'POWER') &&
    maxPain !== null;

  const charmDrift: TriggerState = {
    id: 'charm-drift',
    name: 'Charm drift to pin',
    status: charmDriftActive ? 'ACTIVE' : 'IDLE',
    condition:
      'Positive-gamma regime in afternoon/power hour with max-pain known — pin drift.',
    levelLabel: maxPain ? 'Max pain' : null,
    levelEsPrice: maxPain?.esPrice ?? null,
  };

  return [fadeCallWall, liftPutWall, breakCallWall, breakPutWall, charmDrift];
}
