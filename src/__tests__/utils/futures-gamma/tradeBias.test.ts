import { describe, it, expect } from 'vitest';
import { deriveTradeBias } from '../../../utils/futures-gamma/tradeBias';
import type {
  EsLevel,
  PlaybookFlowSignals,
  PlaybookRule,
} from '../../../utils/futures-gamma/types';

// ── Fixtures ─────────────────────────────────────────────────────────

function rule(overrides: Partial<PlaybookRule>): PlaybookRule {
  return {
    id: 'pos-fade-call-wall',
    condition: '',
    direction: 'SHORT',
    entryEs: 5820,
    targetEs: 5800,
    stopEs: 5820.25,
    sizingNote: '',
    distanceEsPoints: 0,
    status: 'ACTIVE',
    conviction: 'standard',
    ...overrides,
  };
}

function level(kind: EsLevel['kind'], status: EsLevel['status']): EsLevel {
  return {
    kind,
    spxStrike: 5800,
    esPrice: 5820,
    distanceEsPoints: 0,
    status,
  };
}

const emptyFlow: PlaybookFlowSignals = {
  upsideTargetCls: null,
  downsideTargetCls: null,
  ceilingTrend5m: null,
  floorTrend5m: null,
  priceTrend: null,
};

// ── TRANSITIONING regime ─────────────────────────────────────────────

describe('deriveTradeBias — TRANSITIONING', () => {
  it('returns NEUTRAL with regime-ambiguous reason', () => {
    const bias = deriveTradeBias({
      regime: 'TRANSITIONING',
      rules: [],
      levels: [],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
    expect(bias.reason).toMatch(/regime ambiguous/);
  });
});

// ── POSITIVE regime (mean-revert) ────────────────────────────────────

describe('deriveTradeBias — POSITIVE', () => {
  it('ACTIVE fade-call with standard conviction → SHORT mild', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-fade-call-wall',
          direction: 'SHORT',
          status: 'ACTIVE',
        }),
      ],
      levels: [],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('SHORT');
    expect(bias.conviction).toBe('mild');
    expect(bias.entryEs).toBe(5820);
  });

  it('ACTIVE fade-call HIGH conviction + aligned flow → SHORT strong', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-fade-call-wall',
          direction: 'SHORT',
          status: 'ACTIVE',
          conviction: 'high',
        }),
      ],
      levels: [],
      flowSignals: {
        ...emptyFlow,
        ceilingTrend5m: 5, // strengthening, aligned with SHORT fade
      },
    });
    expect(bias.direction).toBe('SHORT');
    expect(bias.conviction).toBe('strong');
    expect(bias.reason).toMatch(/aligned/);
  });

  it('ACTIVE fade-call LOW conviction (weakening pin) → NEUTRAL', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-fade-call-wall',
          direction: 'SHORT',
          status: 'ACTIVE',
          conviction: 'low',
        }),
      ],
      levels: [],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
    expect(bias.reason).toMatch(/low conviction/i);
  });

  it('ACTIVE fade-call LOW conviction + aligned flow → SHORT mild (flow overrides)', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-fade-call-wall',
          direction: 'SHORT',
          status: 'ACTIVE',
          conviction: 'low',
        }),
      ],
      levels: [],
      flowSignals: {
        ...emptyFlow,
        ceilingTrend5m: 5, // strengthening, confirms the fade despite weak pin
      },
    });
    expect(bias.direction).toBe('SHORT');
    expect(bias.conviction).toBe('mild');
  });

  it('picks higher-conviction rule when both fade + lift are ACTIVE', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-fade-call-wall',
          direction: 'SHORT',
          status: 'ACTIVE',
          conviction: 'standard',
        }),
        rule({
          id: 'pos-lift-put-wall',
          direction: 'LONG',
          status: 'ACTIVE',
          conviction: 'high',
          entryEs: 5780,
        }),
      ],
      levels: [],
      flowSignals: emptyFlow,
    });
    // lift has higher conviction → bias LONG
    expect(bias.direction).toBe('LONG');
    expect(bias.entryEs).toBe(5780);
  });

  it('no ACTIVE but ARMED → direction from ARMED with wait-entry reason', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-lift-put-wall',
          direction: 'LONG',
          status: 'ARMED',
          entryEs: 5780,
        }),
      ],
      levels: [],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('LONG');
    expect(bias.conviction).toBe('mild');
    expect(bias.reason).toMatch(/armed/i);
  });

  it('no ACTIVE, no ARMED, drift-down present → NEUTRAL with drift reason', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-fade-call-wall',
          direction: 'SHORT',
          status: 'DISTANT',
        }),
      ],
      levels: [],
      flowSignals: {
        ...emptyFlow,
        priceTrend: {
          direction: 'down',
          consistency: 0.8,
          changePts: -10,
          changePct: -0.2,
        },
      },
    });
    expect(bias.direction).toBe('NEUTRAL');
    expect(bias.reason).toMatch(/drifting down/i);
  });

  it('all DISTANT and no drift → NEUTRAL · all setups distant', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [rule({ status: 'DISTANT' })],
      levels: [],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
    expect(bias.reason).toMatch(/distant/i);
  });

  it('charm-drift only ACTIVE (EITHER direction) → NEUTRAL, never forces direction', () => {
    const bias = deriveTradeBias({
      regime: 'POSITIVE',
      rules: [
        rule({
          id: 'pos-charm-drift',
          direction: 'EITHER',
          status: 'ACTIVE',
          entryEs: null,
        }),
      ],
      levels: [],
      flowSignals: emptyFlow,
    });
    // EITHER rules don't produce a bias; charm-drift is advisory
    expect(bias.direction).toBe('NEUTRAL');
  });
});

// ── NEGATIVE regime (trend-follow) ───────────────────────────────────

describe('deriveTradeBias — NEGATIVE', () => {
  it('ACTIVE break-call + wall not broken → LONG mild', () => {
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-call-wall',
          direction: 'LONG',
          status: 'ACTIVE',
          entryEs: 5820,
        }),
      ],
      levels: [level('CALL_WALL', 'APPROACHING')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('LONG');
    expect(bias.conviction).toBe('mild');
  });

  it('ACTIVE break-call + aligned wall-flow (floor strengthening) → LONG strong', () => {
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-call-wall',
          direction: 'LONG',
          status: 'ACTIVE',
          entryEs: 5820,
        }),
      ],
      levels: [level('CALL_WALL', 'APPROACHING')],
      flowSignals: { ...emptyFlow, floorTrend5m: 10 },
    });
    expect(bias.direction).toBe('LONG');
    expect(bias.conviction).toBe('strong');
  });

  it('CALL_WALL already BROKEN + break-call rule DISTANT → LONG mild with wait-pullback reason', () => {
    // The 2:50 PM scenario: price is above a broken call wall.
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-call-wall',
          direction: 'LONG',
          status: 'DISTANT',
          distanceEsPoints: -22,
          entryEs: 7077.75,
        }),
      ],
      levels: [level('CALL_WALL', 'BROKEN')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('LONG');
    expect(bias.conviction).toBe('mild');
    expect(bias.entryEs).toBe(7077.75);
    expect(bias.reason).toMatch(/pullback/i);
  });

  it('both walls BROKEN simultaneously → NEUTRAL · whipsaw', () => {
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [],
      levels: [level('CALL_WALL', 'BROKEN'), level('PUT_WALL', 'BROKEN')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
    expect(bias.reason).toMatch(/whipsaw/i);
  });

  it('no ACTIVE, ARMED break-put → SHORT mild with wait-trigger reason', () => {
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-put-wall',
          direction: 'SHORT',
          status: 'ARMED',
          entryEs: 5780,
        }),
      ],
      levels: [level('PUT_WALL', 'APPROACHING')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('SHORT');
    expect(bias.reason).toMatch(/armed/i);
  });

  it('all DISTANT, no BROKEN walls → NEUTRAL', () => {
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-call-wall',
          direction: 'LONG',
          status: 'DISTANT',
          distanceEsPoints: 100,
          entryEs: 5900,
        }),
      ],
      levels: [level('CALL_WALL', 'IDLE')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
  });

  // ── Lines 276-279: PUT_WALL BROKEN, CALL_WALL not broken ───────────
  it('PUT_WALL already BROKEN + break-put rule DISTANT → SHORT mild with wait-pullback reason', () => {
    // Mirror of the call-wall broken case: price has overshot below the
    // put wall, trader missed the clean break entry.
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-put-wall',
          direction: 'SHORT',
          status: 'DISTANT',
          distanceEsPoints: 22, // overshot below
          entryEs: 5780,
        }),
      ],
      levels: [level('PUT_WALL', 'BROKEN')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('SHORT');
    expect(bias.conviction).toBe('mild');
    expect(bias.entryEs).toBe(5780);
    expect(bias.reason).toMatch(/break fired early.*pullback/i);
  });

  it('PUT_WALL BROKEN + break-put rule + aligned wall-flow → SHORT strong', () => {
    // Ceiling strengthening corroborates the down-trend continuation.
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-put-wall',
          direction: 'SHORT',
          status: 'DISTANT',
          distanceEsPoints: 22,
          entryEs: 5780,
        }),
      ],
      levels: [level('PUT_WALL', 'BROKEN')],
      flowSignals: { ...emptyFlow, ceilingTrend5m: 10 },
    });
    expect(bias.direction).toBe('SHORT');
    expect(bias.conviction).toBe('strong');
    expect(bias.reason).toMatch(/pullback/i);
  });

  it('PUT_WALL BROKEN but no break-put rule in set → falls through to default NEUTRAL', () => {
    // Edge case: BROKEN level present but rule list is missing the
    // break-put-wall id, so the early-fire branch can't fire.
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [],
      levels: [level('PUT_WALL', 'BROKEN')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
  });

  // ── Line 310 (sort comparator) + line 316 (nearest-setup neutral) ──
  it('no ACTIVE/ARMED/BROKEN, nearest directional DISTANT rule within 4×band → NEUTRAL with pts-off reason', () => {
    // RULE_ACTIVE_BAND_ES = 5, so 4× = 20. A DISTANT rule 12 pts off
    // should surface the "nearest setup N pts off" message. Two rules
    // exercise the .sort() comparator on line 310.
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-call-wall',
          direction: 'LONG',
          status: 'DISTANT',
          distanceEsPoints: 18,
          entryEs: 5840,
        }),
        rule({
          id: 'neg-break-put-wall',
          direction: 'SHORT',
          status: 'DISTANT',
          distanceEsPoints: -12, // closer in absolute terms
          entryEs: 5780,
        }),
      ],
      levels: [
        level('CALL_WALL', 'IDLE'),
        level('PUT_WALL', 'IDLE'),
      ],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
    // The closer rule (|-12| = 12) wins; reason preserves the signed value.
    expect(bias.reason).toMatch(/nearest setup -12 pts off/);
  });

  it('nearest directional rule beyond 4×band → falls through to all-setups-distant', () => {
    // Distance 25 > 20 (4 × RULE_ACTIVE_BAND_ES), so the pts-off branch
    // is skipped and the final NEUTRAL fires.
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-call-wall',
          direction: 'LONG',
          status: 'DISTANT',
          distanceEsPoints: 25,
          entryEs: 5860,
        }),
      ],
      levels: [level('CALL_WALL', 'IDLE')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
    expect(bias.reason).toMatch(/all setups distant/);
  });

  it('nearest directional rule exactly at 4×band threshold (20 pts) → NEUTRAL with pts-off reason', () => {
    // Boundary: distance == 20, predicate is `<=`, so it matches.
    const bias = deriveTradeBias({
      regime: 'NEGATIVE',
      rules: [
        rule({
          id: 'neg-break-call-wall',
          direction: 'LONG',
          status: 'DISTANT',
          distanceEsPoints: 20,
          entryEs: 5840,
        }),
      ],
      levels: [level('CALL_WALL', 'IDLE')],
      flowSignals: emptyFlow,
    });
    expect(bias.direction).toBe('NEUTRAL');
    expect(bias.reason).toMatch(/nearest setup 20 pts off/);
  });
});
