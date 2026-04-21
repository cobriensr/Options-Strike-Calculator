/**
 * Pure-function tests for the named-setup trigger evaluator.
 *
 * Covers ACTIVE and IDLE branches for each of the five triggers plus a
 * couple of cross-cutting edge cases (missing levels, missing ES price).
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

function statusOf(states: TriggerState[], id: TriggerId): TriggerState['status'] {
  const row = states.find((s) => s.id === id);
  if (!row) throw new Error(`Missing trigger ${id}`);
  return row.status;
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

  it('marks all triggers IDLE when levels are empty', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [],
    });
    for (const row of states) {
      expect(row.status).toBe('IDLE');
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
    expect(statusOf(states, 'fade-call-wall')).toBe('ACTIVE');
  });

  it('fade-call-wall IDLE when regime is NEGATIVE even if within proximity', () => {
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5822, 2)],
    });
    expect(statusOf(states, 'fade-call-wall')).toBe('IDLE');
  });

  it('fade-call-wall IDLE when ES is outside 5 pts of call wall', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5830, 10)],
    });
    expect(statusOf(states, 'fade-call-wall')).toBe('IDLE');
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

  it('lift-put-wall IDLE when ES is outside 5 pts of put wall', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('PUT_WALL', 5800, -20)],
    });
    expect(statusOf(states, 'lift-put-wall')).toBe('IDLE');
  });

  // ── break-call-wall ────────────────────────────────────────────────

  it('break-call-wall ACTIVE in NEGATIVE regime when ES has broken above call wall', () => {
    // Distance is negative → price is above the level (i.e. broken above).
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5818, -2)],
    });
    expect(statusOf(states, 'break-call-wall')).toBe('ACTIVE');
  });

  it('break-call-wall IDLE in POSITIVE regime even if price is above call wall', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5818, -2)],
    });
    expect(statusOf(states, 'break-call-wall')).toBe('IDLE');
  });

  it('break-call-wall IDLE when ES is still below call wall', () => {
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('CALL_WALL', 5830, 10)],
    });
    expect(statusOf(states, 'break-call-wall')).toBe('IDLE');
  });

  // ── break-put-wall ─────────────────────────────────────────────────

  it('break-put-wall ACTIVE in NEGATIVE regime when ES has broken below put wall', () => {
    // Distance is positive → level is above price (price broke below level).
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('PUT_WALL', 5825, 5)],
    });
    expect(statusOf(states, 'break-put-wall')).toBe('ACTIVE');
  });

  it('break-put-wall IDLE when ES is still above put wall and distance is negative', () => {
    const states = evaluateTriggers({
      regime: 'NEGATIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('PUT_WALL', 5810, -10)],
    });
    expect(statusOf(states, 'break-put-wall')).toBe('IDLE');
  });

  // ── charm-drift ────────────────────────────────────────────────────

  it('charm-drift ACTIVE in POSITIVE regime during AFTERNOON with max-pain known', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'AFTERNOON',
      esPrice: ES_PRICE,
      levels: [makeLevel('MAX_PAIN', 5815, -5)],
    });
    expect(statusOf(states, 'charm-drift')).toBe('ACTIVE');
  });

  it('charm-drift ACTIVE in POSITIVE regime during POWER with max-pain known', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'POWER',
      esPrice: ES_PRICE,
      levels: [makeLevel('MAX_PAIN', 5815, -5)],
    });
    expect(statusOf(states, 'charm-drift')).toBe('ACTIVE');
  });

  it('charm-drift IDLE during MORNING even with max-pain known', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: ES_PRICE,
      levels: [makeLevel('MAX_PAIN', 5815, -5)],
    });
    expect(statusOf(states, 'charm-drift')).toBe('IDLE');
  });

  it('charm-drift IDLE when max-pain is missing', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'AFTERNOON',
      esPrice: ES_PRICE,
      levels: [],
    });
    expect(statusOf(states, 'charm-drift')).toBe('IDLE');
  });

  // ── Cross-cutting ──────────────────────────────────────────────────

  it('proximity-based triggers are IDLE when esPrice is null', () => {
    const states = evaluateTriggers({
      regime: 'POSITIVE',
      phase: 'MORNING',
      esPrice: null,
      levels: [
        makeLevel('CALL_WALL', 5822, 2),
        makeLevel('PUT_WALL', 5817, -3),
      ],
    });
    expect(statusOf(states, 'fade-call-wall')).toBe('IDLE');
    expect(statusOf(states, 'lift-put-wall')).toBe('IDLE');
  });

  it('TRANSITIONING regime never activates any trigger', () => {
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
      expect(row.status).toBe('IDLE');
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
        makeLevel('MAX_PAIN', 5815, -5),
      ],
    });
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get('fade-call-wall')?.levelEsPrice).toBe(5822);
    expect(byId.get('lift-put-wall')?.levelEsPrice).toBe(5817);
    expect(byId.get('charm-drift')?.levelEsPrice).toBe(5815);
  });
});
