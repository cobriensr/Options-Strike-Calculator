/**
 * Pure-function tests for the named-setup trigger evaluator.
 *
 * Covers ACTIVE / ARMED / DISTANT / BLOCKED branches for each of the five
 * triggers plus cross-cutting edge cases (missing levels, missing ES
 * price, TRANSITIONING regime, blocked-reason content).
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateTriggers,
  type TriggerId,
  type TriggerState,
} from '../../../components/FuturesGammaPlaybook/triggers';
import type {
  EsLevel,
  GexRegime,
  SessionPhase,
} from '../../../components/FuturesGammaPlaybook/types';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeLevel(
  kind: EsLevel['kind'],
  esPrice: number,
  distanceEsPoints: number,
): EsLevel {
  return {
    kind,
    spxStrike: Math.round(esPrice - 12), // basis-agnostic, just a plausible value
    esPrice,
    distanceEsPoints,
    status: 'IDLE',
  };
}

function rowOf(states: TriggerState[], id: TriggerId): TriggerState {
  const row = states.find((s) => s.id === id);
  if (!row) throw new Error(`Missing trigger ${id}`);
  return row;
}

function statusOf(
  states: TriggerState[],
  id: TriggerId,
): TriggerState['status'] {
  return rowOf(states, id).status;
}

// Standard ES price for the test scenarios.
const ES_PRICE = 5820;

// ── Suites ────────────────────────────────────────────────────────────

describe('evaluateTriggers', () => {
  it('returns all five trigger rows in stable order', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [],
    });
    expect(states.map((s) => s.id)).toEqual([
      'fade-call-wall',
      'lift-put-wall',
      'break-call-wall',
      'break-put-wall',
      'charm-drift',
    ]);
  });

  it('all triggers BLOCKED when levels are empty — keyed level unknown', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'AFTERNOON',
      esPrice: ES_PRICE,
      levels: [],
    });
    for (const row of states) {
      expect(row.status).toBe('BLOCKED');
    }
  });

  // ── fade-call-wall ─────────────────────────────────────────────────

  it('fade-call-wall ACTIVE in POSITIVE regime when ES is within 5 pts of call wall', () => {
    // ES at 5820, call wall at 5822 → 2 pts away, inside proximity.
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5822, 2)],
    });
    const row = rowOf(states, 'fade-call-wall');
    expect(row.status).toBe('ACTIVE');
    expect(row.distanceEsPoints).toBe(2);
    expect(row.blockedReason).toBeNull();
  });

  it('fade-call-wall ARMED when ES is 5-15 pts away', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5830, 10)],
    });
    expect(statusOf(states, 'fade-call-wall')).toBe('ARMED');
  });

  it('fade-call-wall DISTANT when ES is > 15 pts away', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5860, 40)],
    });
    expect(statusOf(states, 'fade-call-wall')).toBe('DISTANT');
  });

  it('fade-call-wall BLOCKED in NEGATIVE regime with correct reason', () => {
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5822, 2)],
    });
    const row = rowOf(states, 'fade-call-wall');
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toBe('Needs +GEX regime.');
  });

  it('fade-call-wall BLOCKED with "Wall level unknown." when call wall missing', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [],
    });
    const row = rowOf(states, 'fade-call-wall');
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toBe('Wall level unknown.');
  });

  // ── lift-put-wall ──────────────────────────────────────────────────

  it('lift-put-wall ACTIVE in POSITIVE regime when ES is within 5 pts of put wall', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('PUT_WALL', 5817, -3)],
    });
    expect(statusOf(states, 'lift-put-wall')).toBe('ACTIVE');
  });

  it('lift-put-wall DISTANT when ES is outside 15 pts of put wall', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('PUT_WALL', 5790, -30)],
    });
    expect(statusOf(states, 'lift-put-wall')).toBe('DISTANT');
  });

  // ── break-call-wall ────────────────────────────────────────────────

  it('break-call-wall ACTIVE in NEGATIVE regime when ES has broken above call wall', () => {
    // ES=5820, wall=5818 → distance = -2 → ACTIVE.
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5818, -2)],
    });
    const row = rowOf(states, 'break-call-wall');
    expect(row.status).toBe('ACTIVE');
    expect(row.distanceEsPoints).toBe(-2);
  });

  it('break-call-wall ARMED when ES is within 15 pts BELOW the wall', () => {
    // ES=5820, wall=5830 → distance = 10 → ARMED (pre-trigger side).
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5830, 10)],
    });
    expect(statusOf(states, 'break-call-wall')).toBe('ARMED');
  });

  it('break-call-wall DISTANT when ES is far below the wall', () => {
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5900, 80)],
    });
    expect(statusOf(states, 'break-call-wall')).toBe('DISTANT');
  });

  it('break-call-wall BLOCKED in POSITIVE regime with correct reason', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5818, -2)],
    });
    const row = rowOf(states, 'break-call-wall');
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toBe('Needs −GEX regime.');
  });

  // ── break-put-wall ─────────────────────────────────────────────────

  it('break-put-wall ACTIVE in NEGATIVE regime when ES has broken below put wall', () => {
    // Distance > 0 ⇒ level is above price ⇒ price broke BELOW the level.
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('PUT_WALL', 5825, 5)],
    });
    expect(statusOf(states, 'break-put-wall')).toBe('ACTIVE');
  });

  it('break-put-wall ARMED when ES is within 15 pts above put wall', () => {
    // ES=5820, wall=5810 → distance -10 → ARMED.
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('PUT_WALL', 5810, -10)],
    });
    expect(statusOf(states, 'break-put-wall')).toBe('ARMED');
  });

  // ── charm-drift ────────────────────────────────────────────────────

  it('charm-drift ACTIVE in POSITIVE regime during AFTERNOON with gamma pin known', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'AFTERNOON',
      esPrice: ES_PRICE,
      levels: [],
      esGammaPin: 5815,
    });
    expect(statusOf(states, 'charm-drift')).toBe('ACTIVE');
  });

  it('charm-drift ACTIVE in POSITIVE regime during POWER with gamma pin known', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'POWER',
      esPrice: ES_PRICE,
      levels: [],
      esGammaPin: 5815,
    });
    expect(statusOf(states, 'charm-drift')).toBe('ACTIVE');
  });

  it('charm-drift BLOCKED during MORNING with reason', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [],
      esGammaPin: 5815,
    });
    const row = rowOf(states, 'charm-drift');
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toBe(
      'Needs +GEX in afternoon/power with gamma pin.',
    );
  });

  it('charm-drift BLOCKED when gamma pin is missing', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'AFTERNOON',
      esPrice: ES_PRICE,
      levels: [],
    });
    expect(statusOf(states, 'charm-drift')).toBe('BLOCKED');
  });

  // ── Cross-cutting ──────────────────────────────────────────────────

  it('proximity-based triggers fall back to DISTANT when esPrice is null', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: null,
      levels: [
        makeLevel('CALL_WALL', 5822, 2),
        makeLevel('PUT_WALL', 5817, -3),
      ],
    });
    expect(statusOf(states, 'fade-call-wall')).toBe('DISTANT');
    expect(statusOf(states, 'lift-put-wall')).toBe('DISTANT');
  });

  it('TRANSITIONING regime blocks every trigger with a reason', () => {
    const states = evaluateTriggers({
      regime: 'TRANSITIONING' as GexRegime,
      phase: 'AFTERNOON' as SessionPhase,
      esPrice: ES_PRICE,
      levels: [
        makeLevel('CALL_WALL', 5822, 2),
        makeLevel('PUT_WALL', 5817, -3),
        makeLevel('MAX_PAIN', 5815, -5),
      ],
    });
    for (const row of states) {
      expect(row.status).toBe('BLOCKED');
      expect(row.blockedReason).not.toBeNull();
    }
  });

  it('exposes the keyed level price on each row when the level exists', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'AFTERNOON',
      esPrice: ES_PRICE,
      levels: [
        makeLevel('CALL_WALL', 5822, 2),
        makeLevel('PUT_WALL', 5817, -3),
      ],
      esGammaPin: 5815,
    });
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get('fade-call-wall')?.levelEsPrice).toBe(5822);
    expect(byId.get('lift-put-wall')?.levelEsPrice).toBe(5817);
    expect(byId.get('charm-drift')?.levelEsPrice).toBe(5815);
  });

  it('distance is null on BLOCKED rows', () => {
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [
        makeLevel('CALL_WALL', 5822, 2),
        makeLevel('PUT_WALL', 5817, -3),
      ],
    });
    // fade-call-wall and lift-put-wall are BLOCKED (wrong regime).
    expect(rowOf(states, 'fade-call-wall').distanceEsPoints).toBeNull();
    expect(rowOf(states, 'lift-put-wall').distanceEsPoints).toBeNull();
  });
});
