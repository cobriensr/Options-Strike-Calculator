/**
 * Pure-function tests for `detectAlertEdges`.
 *
 * The engine is deterministic — given `(prev, next, nowIso)` it emits a
 * fixed list of `AlertEvent`s. These tests drive each detection rule
 * through its expected branches plus a few cross-cutting cases
 * (first-render, multi-edge, de-fire silence).
 */

import { describe, it, expect } from 'vitest';
import {
  detectAlertEdges,
  type AlertState,
} from '../../../utils/futures-gamma/alerts';
import type { EsLevel } from '../../../utils/futures-gamma/types';

// ── Fixtures ─────────────────────────────────────────────────────────

const NOW = '2026-04-20T18:30:00.000Z';

function makeLevel(
  kind: EsLevel['kind'],
  status: EsLevel['status'],
  esPrice = 5820,
): EsLevel {
  return {
    kind,
    spxStrike: Math.round(esPrice - 12),
    esPrice,
    distanceEsPoints: 2,
    status,
  };
}

function baseState(overrides: Partial<AlertState> = {}): AlertState {
  return {
    regime: 'POSITIVE',
    phase: 'MORNING',
    levels: [],
    firedTriggers: [],
    esPrice: 5820,
    ...overrides,
  };
}

// ── Suites ────────────────────────────────────────────────────────────

describe('detectAlertEdges', () => {
  it('emits no alerts when nothing changed', () => {
    const prev = baseState();
    const next = baseState();
    const events = detectAlertEdges(prev, next, NOW);
    expect(events).toEqual([]);
  });

  it('emits a REGIME_FLIP with urgent severity on POSITIVE → NEGATIVE', () => {
    const prev = baseState({ regime: 'POSITIVE' });
    const next = baseState({ regime: 'NEGATIVE' });
    const events = detectAlertEdges(prev, next, NOW);
    const flip = events.find((e) => e.type === 'REGIME_FLIP');
    expect(flip).toBeDefined();
    expect(flip?.severity).toBe('urgent');
    expect(flip?.title).toContain('POSITIVE');
    expect(flip?.title).toContain('NEGATIVE');
  });

  it('emits a REGIME_FLIP with info severity on NEGATIVE → POSITIVE', () => {
    const prev = baseState({ regime: 'NEGATIVE' });
    const next = baseState({ regime: 'POSITIVE' });
    const events = detectAlertEdges(prev, next, NOW);
    const flip = events.find((e) => e.type === 'REGIME_FLIP');
    expect(flip).toBeDefined();
    expect(flip?.severity).toBe('info');
  });

  it('emits a REGIME_FLIP with info severity on TRANSITIONING → POSITIVE', () => {
    const prev = baseState({ regime: 'TRANSITIONING' });
    const next = baseState({ regime: 'POSITIVE' });
    const events = detectAlertEdges(prev, next, NOW);
    const flip = events.find((e) => e.type === 'REGIME_FLIP');
    expect(flip).toBeDefined();
    expect(flip?.severity).toBe('info');
  });

  it('does NOT emit a REGIME_FLIP on POSITIVE → TRANSITIONING (loss of clarity)', () => {
    const prev = baseState({ regime: 'POSITIVE' });
    const next = baseState({ regime: 'TRANSITIONING' });
    const events = detectAlertEdges(prev, next, NOW);
    expect(events.find((e) => e.type === 'REGIME_FLIP')).toBeUndefined();
  });

  it('fires LEVEL_APPROACH once when a level transitions IDLE → APPROACHING', () => {
    const prev = baseState({
      levels: [makeLevel('CALL_WALL', 'IDLE')],
    });
    const next = baseState({
      levels: [makeLevel('CALL_WALL', 'APPROACHING')],
    });
    const events = detectAlertEdges(prev, next, NOW);
    const approach = events.filter((e) => e.type === 'LEVEL_APPROACH');
    expect(approach).toHaveLength(1);
    expect(approach[0]?.id).toContain('CALL_WALL');
  });

  it('does NOT re-fire LEVEL_APPROACH when already APPROACHING', () => {
    const prev = baseState({
      levels: [makeLevel('CALL_WALL', 'APPROACHING')],
    });
    const next = baseState({
      levels: [makeLevel('CALL_WALL', 'APPROACHING')],
    });
    const events = detectAlertEdges(prev, next, NOW);
    expect(events.find((e) => e.type === 'LEVEL_APPROACH')).toBeUndefined();
  });

  it('fires LEVEL_BREACH once when status transitions !== BROKEN → BROKEN', () => {
    const prev = baseState({
      levels: [makeLevel('PUT_WALL', 'APPROACHING')],
    });
    const next = baseState({
      levels: [makeLevel('PUT_WALL', 'BROKEN')],
    });
    const events = detectAlertEdges(prev, next, NOW);
    const breach = events.filter((e) => e.type === 'LEVEL_BREACH');
    expect(breach).toHaveLength(1);
    expect(breach[0]?.id).toContain('PUT_WALL');
    expect(breach[0]?.severity).toBe('urgent');
  });

  it('does NOT re-fire LEVEL_BREACH on BROKEN → BROKEN', () => {
    const prev = baseState({
      levels: [makeLevel('CALL_WALL', 'BROKEN')],
    });
    const next = baseState({
      levels: [makeLevel('CALL_WALL', 'BROKEN')],
    });
    const events = detectAlertEdges(prev, next, NOW);
    expect(events.find((e) => e.type === 'LEVEL_BREACH')).toBeUndefined();
  });

  it('fires TRIGGER_FIRE when a new id enters firedTriggers', () => {
    const prev = baseState({ firedTriggers: [] });
    const next = baseState({ firedTriggers: ['fade-call-wall'] });
    const events = detectAlertEdges(prev, next, NOW);
    const fire = events.filter((e) => e.type === 'TRIGGER_FIRE');
    expect(fire).toHaveLength(1);
    expect(fire[0]?.id).toContain('fade-call-wall');
  });

  it('does NOT fire on trigger de-fire (id present then absent)', () => {
    const prev = baseState({ firedTriggers: ['fade-call-wall'] });
    const next = baseState({ firedTriggers: [] });
    const events = detectAlertEdges(prev, next, NOW);
    expect(events.find((e) => e.type === 'TRIGGER_FIRE')).toBeUndefined();
  });

  it('fires PHASE_TRANSITION when entering AFTERNOON', () => {
    const prev = baseState({ phase: 'LUNCH' });
    const next = baseState({ phase: 'AFTERNOON' });
    const events = detectAlertEdges(prev, next, NOW);
    const phaseEvt = events.find((e) => e.type === 'PHASE_TRANSITION');
    expect(phaseEvt).toBeDefined();
    expect(phaseEvt?.severity).toBe('info');
  });

  it('fires PHASE_TRANSITION when entering POWER', () => {
    const prev = baseState({ phase: 'AFTERNOON' });
    const next = baseState({ phase: 'POWER' });
    const events = detectAlertEdges(prev, next, NOW);
    expect(events.find((e) => e.type === 'PHASE_TRANSITION')).toBeDefined();
  });

  it('fires PHASE_TRANSITION when entering CLOSE', () => {
    const prev = baseState({ phase: 'POWER' });
    const next = baseState({ phase: 'CLOSE' });
    const events = detectAlertEdges(prev, next, NOW);
    expect(events.find((e) => e.type === 'PHASE_TRANSITION')).toBeDefined();
  });

  it('suppresses PHASE_TRANSITION for noisy phases (OPEN, MORNING)', () => {
    const openEvents = detectAlertEdges(
      baseState({ phase: 'PRE_OPEN' }),
      baseState({ phase: 'OPEN' }),
      NOW,
    );
    expect(
      openEvents.find((e) => e.type === 'PHASE_TRANSITION'),
    ).toBeUndefined();

    const morningEvents = detectAlertEdges(
      baseState({ phase: 'OPEN' }),
      baseState({ phase: 'MORNING' }),
      NOW,
    );
    expect(
      morningEvents.find((e) => e.type === 'PHASE_TRANSITION'),
    ).toBeUndefined();
  });

  it('on first-render (prev === null) emits PHASE_TRANSITION only', () => {
    const next = baseState({
      phase: 'AFTERNOON',
      // Regime / level / trigger edges cannot be detected without prev,
      // but phase can.
      regime: 'NEGATIVE',
      levels: [makeLevel('CALL_WALL', 'APPROACHING')],
      firedTriggers: ['fade-call-wall'],
    });
    const events = detectAlertEdges(null, next, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('PHASE_TRANSITION');
  });

  it('on first-render with a noisy phase emits nothing', () => {
    const next = baseState({ phase: 'MORNING', regime: 'NEGATIVE' });
    const events = detectAlertEdges(null, next, NOW);
    expect(events).toEqual([]);
  });

  it('emits all qualifying edges in one tick', () => {
    const prev = baseState({
      regime: 'POSITIVE',
      phase: 'LUNCH',
      levels: [
        makeLevel('CALL_WALL', 'IDLE'),
        makeLevel('PUT_WALL', 'APPROACHING'),
      ],
      firedTriggers: [],
    });
    const next = baseState({
      regime: 'NEGATIVE',
      phase: 'AFTERNOON',
      levels: [
        makeLevel('CALL_WALL', 'APPROACHING'),
        makeLevel('PUT_WALL', 'BROKEN'),
      ],
      firedTriggers: ['fade-call-wall'],
    });
    const events = detectAlertEdges(prev, next, NOW);
    const types = events.map((e) => e.type);
    expect(types).toContain('REGIME_FLIP');
    expect(types).toContain('LEVEL_APPROACH');
    expect(types).toContain('LEVEL_BREACH');
    expect(types).toContain('TRIGGER_FIRE');
    expect(types).toContain('PHASE_TRANSITION');
    expect(events.length).toBe(5);
  });
});
