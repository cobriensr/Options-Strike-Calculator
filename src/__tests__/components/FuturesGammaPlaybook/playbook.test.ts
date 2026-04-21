import { describe, it, expect } from 'vitest';
import {
  classifyRegime,
  classifySessionPhase,
  rulesForRegime,
  sizingGuidance,
  verdictForRegime,
  REGIME_TRANSITION_BAND_PCT,
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

  it('STAND_ASIDE returns no rules', () => {
    const rules = rulesForRegime('TRANSITIONING', 'MORNING', fullLevels);
    expect(rules).toEqual([]);
  });

  it('PRE_OPEN returns no rules (outside RTH)', () => {
    const rules = rulesForRegime('POSITIVE', 'PRE_OPEN', fullLevels);
    expect(rules).toEqual([]);
  });

  it('POST_CLOSE returns no rules (outside RTH)', () => {
    const rules = rulesForRegime('NEGATIVE', 'POST_CLOSE', fullLevels);
    expect(rules).toEqual([]);
  });

  it('POSITIVE + MORNING → fade calls + lift puts, no charm drift', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels);
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
    const rules = rulesForRegime('POSITIVE', 'AFTERNOON', fullLevels);
    expect(rules.map((r) => r.id)).toContain('pos-charm-drift');
    const drift = rules.find((r) => r.id === 'pos-charm-drift')!;
    expect(drift.direction).toBe('EITHER');
    expect(drift.targetEs).toBe(5795);
  });

  it('POSITIVE + POWER → charm-drift rule included', () => {
    const rules = rulesForRegime('POSITIVE', 'POWER', fullLevels);
    expect(rules.map((r) => r.id)).toContain('pos-charm-drift');
  });

  it('POSITIVE + LUNCH → no charm-drift (not in window)', () => {
    const rules = rulesForRegime('POSITIVE', 'LUNCH', fullLevels);
    expect(rules.map((r) => r.id)).not.toContain('pos-charm-drift');
  });

  it('NEGATIVE + POWER → breakout/breakdown rules', () => {
    const rules = rulesForRegime('NEGATIVE', 'POWER', fullLevels);
    expect(rules.map((r) => r.id)).toEqual([
      'neg-break-call-wall',
      'neg-break-put-wall',
    ]);
    expect(rules[0]!.direction).toBe('LONG');
    expect(rules[1]!.direction).toBe('SHORT');
  });

  it('skips rules that depend on null levels', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', {
      esCallWall: null,
      esPutWall: 5780,
      esZeroGamma: null,
      esMaxPain: null,
    });
    expect(rules.map((r) => r.id)).toEqual(['pos-lift-put-wall']);
  });

  it('every rule carries a sizingNote', () => {
    const rules = rulesForRegime('POSITIVE', 'AFTERNOON', fullLevels);
    for (const r of rules) {
      expect(r.sizingNote.length).toBeGreaterThan(0);
    }
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
