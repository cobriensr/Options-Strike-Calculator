import { describe, it, expect } from 'vitest';
import {
  classifyRegime,
  classifySessionPhase,
  rulesForRegime,
  sizingGuidance,
  verdictForRegime,
  ES_TICK_SIZE,
  REGIME_TRANSITION_BAND_PCT,
  RULE_ACTIVE_BAND_ES,
  RULE_ARMED_BAND_ES,
} from '../../../components/FuturesGammaPlaybook/playbook';

// Anchor the suite at a known CT wall-clock so timezone conversions are
// deterministic. 14:00 UTC = 09:00 CT on this date (CDT in effect).
const at = (hhmmCt: string): Date => {
  // Parse CT HH:MM and build a UTC Date 5 hours ahead (CDT offset is -5h).
  const [h, m] = hhmmCt.split(':').map((v) => Number.parseInt(v, 10));
  const utc = new Date(
    Date.UTC(2026, 3 /* April */, 20, (h ?? 0) + 5, m ?? 0, 0),
  );
  return utc;
};

describe('classifyRegime', () => {
  it('returns TRANSITIONING when zeroGamma is null', () => {
    expect(classifyRegime(100, null, 5000)).toBe('TRANSITIONING');
  });

  it('returns TRANSITIONING when spot is exactly at zero-gamma', () => {
    expect(classifyRegime(100, 5000, 5000)).toBe('TRANSITIONING');
  });

  it('classifies POSITIVE when netGex>0 and spot clearly outside the band', () => {
    // Band half-width at zg=5000 is 5000 * 0.005 = 25.
    expect(classifyRegime(1, 5000, 5100)).toBe('POSITIVE');
  });

  it('classifies NEGATIVE when netGex<0 and spot clearly outside the band', () => {
    expect(classifyRegime(-1, 5000, 4900)).toBe('NEGATIVE');
  });

  it('treats the band edge (|spot−zg| = band) as still inside (TRANSITIONING)', () => {
    const zg = 5000;
    const band = zg * REGIME_TRANSITION_BAND_PCT;
    expect(classifyRegime(1, zg, zg + band)).toBe('TRANSITIONING');
    expect(classifyRegime(-1, zg, zg - band)).toBe('TRANSITIONING');
  });

  it('just outside the band (± 0.01 beyond) is classified by sign', () => {
    const zg = 5000;
    const band = zg * REGIME_TRANSITION_BAND_PCT;
    expect(classifyRegime(1, zg, zg + band + 0.01)).toBe('POSITIVE');
    expect(classifyRegime(-1, zg, zg - band - 0.01)).toBe('NEGATIVE');
  });

  it('returns TRANSITIONING when netGex is exactly zero outside the band', () => {
    expect(classifyRegime(0, 5000, 5100)).toBe('TRANSITIONING');
  });
});

describe('verdictForRegime', () => {
  it('maps POSITIVE → MEAN_REVERT', () => {
    expect(verdictForRegime('POSITIVE')).toBe('MEAN_REVERT');
  });
  it('maps NEGATIVE → TREND_FOLLOW', () => {
    expect(verdictForRegime('NEGATIVE')).toBe('TREND_FOLLOW');
  });
  it('maps TRANSITIONING → STAND_ASIDE', () => {
    expect(verdictForRegime('TRANSITIONING')).toBe('STAND_ASIDE');
  });
});

describe('classifySessionPhase', () => {
  it('08:29 CT → PRE_OPEN', () => {
    expect(classifySessionPhase(at('08:29'))).toBe('PRE_OPEN');
  });
  it('08:30 CT → OPEN', () => {
    expect(classifySessionPhase(at('08:30'))).toBe('OPEN');
  });
  it('09:00 CT → MORNING', () => {
    expect(classifySessionPhase(at('09:00'))).toBe('MORNING');
  });
  it('11:29 CT → MORNING', () => {
    expect(classifySessionPhase(at('11:29'))).toBe('MORNING');
  });
  it('11:30 CT → LUNCH', () => {
    expect(classifySessionPhase(at('11:30'))).toBe('LUNCH');
  });
  it('13:00 CT → AFTERNOON', () => {
    expect(classifySessionPhase(at('13:00'))).toBe('AFTERNOON');
  });
  it('14:30 CT → POWER', () => {
    expect(classifySessionPhase(at('14:30'))).toBe('POWER');
  });
  it('15:30 CT → CLOSE', () => {
    expect(classifySessionPhase(at('15:30'))).toBe('CLOSE');
  });
  it('16:00 CT → POST_CLOSE', () => {
    expect(classifySessionPhase(at('16:00'))).toBe('POST_CLOSE');
  });
  it('18:42 CT → POST_CLOSE', () => {
    expect(classifySessionPhase(at('18:42'))).toBe('POST_CLOSE');
  });
});

describe('rulesForRegime', () => {
  const fullLevels = {
    esCallWall: 5820,
    esPutWall: 5780,
    esZeroGamma: 5800,
    esMaxPain: 5795,
  };
  // Default price: far from every level so baseline rules are DISTANT.
  const FAR_PRICE = 5700;

  it('STAND_ASIDE returns no rules', () => {
    const rules = rulesForRegime(
      'TRANSITIONING',
      'MORNING',
      fullLevels,
      FAR_PRICE,
    );
    expect(rules).toEqual([]);
  });

  it('PRE_OPEN returns no rules (outside RTH)', () => {
    const rules = rulesForRegime('POSITIVE', 'PRE_OPEN', fullLevels, FAR_PRICE);
    expect(rules).toEqual([]);
  });

  it('POST_CLOSE returns no rules (outside RTH)', () => {
    const rules = rulesForRegime(
      'NEGATIVE',
      'POST_CLOSE',
      fullLevels,
      FAR_PRICE,
    );
    expect(rules).toEqual([]);
  });

  it('POSITIVE + MORNING → fade calls + lift puts, no charm drift', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, FAR_PRICE);
    expect(rules.map((r) => r.id)).toEqual([
      'pos-fade-call-wall',
      'pos-lift-put-wall',
    ]);
    const fade = rules[0]!;
    expect(fade.direction).toBe('SHORT');
    expect(fade.entryEs).toBe(5820);
    expect(fade.targetEs).toBe(5800);
    expect(fade.condition).toContain('5820');
  });

  it('POSITIVE + AFTERNOON → charm-drift rule included', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'AFTERNOON',
      fullLevels,
      FAR_PRICE,
    );
    expect(rules.map((r) => r.id)).toContain('pos-charm-drift');
    const drift = rules.find((r) => r.id === 'pos-charm-drift')!;
    expect(drift.direction).toBe('EITHER');
    expect(drift.targetEs).toBe(5795);
  });

  it('POSITIVE + POWER → charm-drift rule included', () => {
    const rules = rulesForRegime('POSITIVE', 'POWER', fullLevels, FAR_PRICE);
    expect(rules.map((r) => r.id)).toContain('pos-charm-drift');
  });

  it('POSITIVE + LUNCH → no charm-drift (not in window)', () => {
    const rules = rulesForRegime('POSITIVE', 'LUNCH', fullLevels, FAR_PRICE);
    expect(rules.map((r) => r.id)).not.toContain('pos-charm-drift');
  });

  it('NEGATIVE + POWER → breakout/breakdown rules', () => {
    const rules = rulesForRegime('NEGATIVE', 'POWER', fullLevels, FAR_PRICE);
    expect(rules.map((r) => r.id)).toEqual([
      'neg-break-call-wall',
      'neg-break-put-wall',
    ]);
    expect(rules[0]!.direction).toBe('LONG');
    expect(rules[1]!.direction).toBe('SHORT');
  });

  it('skips rules that depend on null levels', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      {
        esCallWall: null,
        esPutWall: 5780,
        esZeroGamma: null,
        esMaxPain: null,
      },
      FAR_PRICE,
    );
    expect(rules.map((r) => r.id)).toEqual(['pos-lift-put-wall']);
  });

  it('every rule carries a sizingNote', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'AFTERNOON',
      fullLevels,
      FAR_PRICE,
    );
    for (const r of rules) {
      expect(r.sizingNote.length).toBeGreaterThan(0);
    }
  });

  // ── Stop-logic regression (the bug this phase fixes) ──────────────
  //
  // Before Phase 2B the fade/lift rules set `stopEs = esZeroGamma`. For a
  // SHORT fade that placed the stop BELOW the entry — nonsense. A correct
  // stop on a short must be ABOVE entry. These tests pin the fix.

  it('pos-fade-call-wall stop is one ES tick ABOVE the wall', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, FAR_PRICE);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.stopEs).toBe(5820 + ES_TICK_SIZE);
    expect(fade.stopEs).toBeGreaterThan(fade.entryEs!);
    expect(fade.stopEs).not.toBe(fullLevels.esZeroGamma);
  });

  it('pos-lift-put-wall stop is one ES tick BELOW the wall', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, FAR_PRICE);
    const lift = rules.find((r) => r.id === 'pos-lift-put-wall')!;
    expect(lift.stopEs).toBe(5780 - ES_TICK_SIZE);
    expect(lift.stopEs).toBeLessThan(lift.entryEs!);
    expect(lift.stopEs).not.toBe(fullLevels.esZeroGamma);
  });

  it('neg-break-call-wall stop is one ES tick BELOW the wall', () => {
    const rules = rulesForRegime('NEGATIVE', 'POWER', fullLevels, FAR_PRICE);
    const br = rules.find((r) => r.id === 'neg-break-call-wall')!;
    expect(br.stopEs).toBe(5820 - ES_TICK_SIZE);
    expect(br.stopEs).toBeLessThan(br.entryEs!);
  });

  it('neg-break-put-wall stop is one ES tick ABOVE the wall', () => {
    const rules = rulesForRegime('NEGATIVE', 'POWER', fullLevels, FAR_PRICE);
    const br = rules.find((r) => r.id === 'neg-break-put-wall')!;
    expect(br.stopEs).toBe(5780 + ES_TICK_SIZE);
    expect(br.stopEs).toBeGreaterThan(br.entryEs!);
  });

  // ── Rule-level status + distance classification ────────────────────

  it('distance is signed: LONG entry above price → positive distance', () => {
    // ES=5778 → LONG lift entry 5780, must RALLY +2 pts.
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, 5778);
    const lift = rules.find((r) => r.id === 'pos-lift-put-wall')!;
    expect(lift.distanceEsPoints).toBe(2);
    expect(lift.status).toBe('ACTIVE');
  });

  it('distance is signed: SHORT entry above price → positive distance', () => {
    // Price must rally UP to the short entry — distance is still positive.
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, 5790);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.distanceEsPoints).toBe(5820 - 5790);
  });

  it('ACTIVE when |distance| ≤ RULE_ACTIVE_BAND_ES', () => {
    // ES=5820 → fade entry 5820 exactly → distance 0.
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, 5820);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.distanceEsPoints).toBe(0);
    expect(fade.status).toBe('ACTIVE');
  });

  it('ARMED when ACTIVE < |distance| ≤ ARMED band', () => {
    // ES=5810 → fade entry 5820 → distance 10 (>5, ≤15).
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, 5810);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.distanceEsPoints).toBe(10);
    expect(fade.status).toBe('ARMED');
    expect(10).toBeLessThanOrEqual(RULE_ARMED_BAND_ES);
    expect(10).toBeGreaterThan(RULE_ACTIVE_BAND_ES);
  });

  it('DISTANT when |distance| > ARMED band', () => {
    // ES=5700 → fade entry 5820 → distance 120.
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, 5700);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.status).toBe('DISTANT');
  });

  it('INVALIDATED when SHORT fade price is above wall by more than ACTIVE band', () => {
    // ES=5830 → fade entry 5820 → price overshot by 10 pts → INVALIDATED.
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, 5830);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.status).toBe('INVALIDATED');
  });

  it('INVALIDATED when LONG lift price is below wall by more than ACTIVE band', () => {
    // ES=5770 → lift entry 5780 → price below wall by 10 pts → INVALIDATED.
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, 5770);
    const lift = rules.find((r) => r.id === 'pos-lift-put-wall')!;
    expect(lift.status).toBe('INVALIDATED');
  });

  it('NEGATIVE breakout rules NEVER emit INVALIDATED (pre-trigger side is normal)', () => {
    // ES=5700 → break-call entry 5820 → way below wall, but a breakout
    // rule does not invalidate from pre-trigger side; status is DISTANT.
    const rules = rulesForRegime('NEGATIVE', 'POWER', fullLevels, 5700);
    const br = rules.find((r) => r.id === 'neg-break-call-wall')!;
    expect(br.status).toBe('DISTANT');
    expect(br.status).not.toBe('INVALIDATED');
  });

  it('charm-drift (EITHER) never emits INVALIDATED', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'AFTERNOON',
      fullLevels,
      FAR_PRICE,
    );
    const drift = rules.find((r) => r.id === 'pos-charm-drift')!;
    expect(drift.status).not.toBe('INVALIDATED');
  });

  it('null esPrice → distance null + DISTANT fallback', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, null);
    for (const r of rules) {
      expect(r.distanceEsPoints).toBeNull();
      expect(r.status).toBe('DISTANT');
    }
  });

  it('condition string references the corrected stop value', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, FAR_PRICE);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    // Stop = 5820.25 — one tick above 5820 wall.
    expect(fade.condition).toContain('5820.25');
  });
});

describe('sizingGuidance', () => {
  it('returns a generic advisory when spreadDelta is null', () => {
    expect(sizingGuidance(null)).toMatch(/sizing depends/);
  });

  it('returns a generic advisory when spreadDelta is 0', () => {
    expect(sizingGuidance(0)).toMatch(/sizing depends/);
  });

  it('1 ES ≈ 0.5/|δ| spread lots — δ=1.0 → 0.5 lots', () => {
    expect(sizingGuidance(1.0)).toContain('0.5');
  });

  it('δ=0.15 → 50 / (100·0.15) ≈ 3.3 lots', () => {
    expect(sizingGuidance(0.15)).toContain('3.3');
  });

  it('uses the absolute value of negative delta', () => {
    expect(sizingGuidance(-0.15)).toContain('3.3');
  });
});
