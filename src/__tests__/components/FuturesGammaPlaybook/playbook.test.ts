import { describe, it, expect } from 'vitest';
import {
  classifyRegime,
  classifySessionPhase,
  convictionFromCls,
  DRIFT_OVERRIDE_CONSISTENCY_MIN,
  rulesForRegime,
  sizingGuidance,
  verdictForRegime,
  ES_TICK_SIZE,
  REGIME_TRANSITION_BAND_PCT,
  RULE_ACTIVE_BAND_ES,
  RULE_ARMED_BAND_ES,
} from '../../../components/FuturesGammaPlaybook/playbook';
import type { PlaybookFlowSignals } from '../../../components/FuturesGammaPlaybook/types';

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
    // Distinct from call/put walls so charm-drift doesn't hit the
    // coincidence guard; 5790 is between the walls, well inside the
    // display window but not identical to either.
    esGammaPin: 5790,
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
    // Target is gamma-pin (highest |GEX| strike), NOT max-pain.
    expect(drift.targetEs).toBe(5790);
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
        esGammaPin: null,
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

  // ── Target-placement geometry guard (2026-04-21 bug) ──────────────
  //
  // Before this guard, the fade/lift rules unconditionally set
  // targetEs = esZeroGamma. When ZG sits on the wrong side of the wall
  // (ZG > callWall, or ZG < putWall — the unusual-gamma-profile case)
  // the emitted rule had a target placed above entry on a SHORT or
  // below entry on a LONG — mathematically an inverted trade.

  it('pos-fade-call-wall target is null when ZG sits ABOVE the call wall', () => {
    const levels = {
      esCallWall: 5820,
      esPutWall: 5780,
      esZeroGamma: 5900, // ABOVE the call wall — invalid mean-revert target
      esMaxPain: 5795,
      esGammaPin: 5820,
    };
    const rules = rulesForRegime('POSITIVE', 'MORNING', levels, FAR_PRICE);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.targetEs).toBeNull();
    expect(fade.sizingNote).toMatch(/trail stops/i);
  });

  it('pos-lift-put-wall target is null when ZG sits BELOW the put wall', () => {
    const levels = {
      esCallWall: 5820,
      esPutWall: 5780,
      esZeroGamma: 5700, // BELOW the put wall — invalid lift target
      esMaxPain: 5795,
      esGammaPin: 5780,
    };
    const rules = rulesForRegime('POSITIVE', 'MORNING', levels, FAR_PRICE);
    const lift = rules.find((r) => r.id === 'pos-lift-put-wall')!;
    expect(lift.targetEs).toBeNull();
    expect(lift.sizingNote).toMatch(/trail stops/i);
  });

  it('fade/lift targets remain populated when ZG sits between the walls', () => {
    // fullLevels has esZeroGamma=5800 between call=5820 and put=5780
    const rules = rulesForRegime('POSITIVE', 'MORNING', fullLevels, FAR_PRICE);
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    const lift = rules.find((r) => r.id === 'pos-lift-put-wall')!;
    expect(fade.targetEs).toBe(5800);
    expect(lift.targetEs).toBe(5800);
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

// ── Phase 2+3: charm-aware conviction + drift-override ──────────────────

describe('convictionFromCls', () => {
  it('sticky-pin → high', () => {
    expect(convictionFromCls('sticky-pin')).toBe('high');
  });
  it('weakening-pin → low', () => {
    expect(convictionFromCls('weakening-pin')).toBe('low');
  });
  it('max-launchpad → standard (launchpad quadrants are flat)', () => {
    expect(convictionFromCls('max-launchpad')).toBe('standard');
  });
  it('fading-launchpad → standard', () => {
    expect(convictionFromCls('fading-launchpad')).toBe('standard');
  });
  it('null → standard', () => {
    expect(convictionFromCls(null)).toBe('standard');
  });
});

describe('rulesForRegime — charm-aware conviction', () => {
  const levels = {
    esCallWall: 5820,
    esPutWall: 5780,
    esZeroGamma: 5800,
    esMaxPain: 5795,
    esGammaPin: 5820,
  };
  const FAR_PRICE = 5700;

  const baseFlow = (
    overrides: Partial<PlaybookFlowSignals> = {},
  ): PlaybookFlowSignals => ({
    upsideTargetCls: null,
    downsideTargetCls: null,
    ceilingTrend5m: null,
    floorTrend5m: null,
    priceTrend: null,
    ...overrides,
  });

  it('fade-call conviction follows upsideTargetCls (sticky-pin → high)', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      baseFlow({ upsideTargetCls: 'sticky-pin' }),
    );
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.conviction).toBe('high');
  });

  it('fade-call conviction low when upsideTargetCls is weakening-pin', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      baseFlow({ upsideTargetCls: 'weakening-pin' }),
    );
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    expect(fade.conviction).toBe('low');
  });

  it('lift-put conviction tracks downsideTargetCls independently', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      baseFlow({
        upsideTargetCls: 'sticky-pin',
        downsideTargetCls: 'weakening-pin',
      }),
    );
    const fade = rules.find((r) => r.id === 'pos-fade-call-wall')!;
    const lift = rules.find((r) => r.id === 'pos-lift-put-wall')!;
    expect(fade.conviction).toBe('high');
    expect(lift.conviction).toBe('low');
  });

  it('breakout rules always resolve to standard (charm does not map to trend-follow)', () => {
    const rules = rulesForRegime(
      'NEGATIVE',
      'POWER',
      levels,
      FAR_PRICE,
      baseFlow({
        upsideTargetCls: 'sticky-pin',
        downsideTargetCls: 'weakening-pin',
      }),
    );
    for (const rule of rules) {
      expect(rule.conviction).toBe('standard');
    }
  });

  it('back-compat: omitting flowSignals yields standard conviction', () => {
    const rules = rulesForRegime('POSITIVE', 'MORNING', levels, FAR_PRICE);
    for (const rule of rules) {
      expect(rule.conviction).toBe('standard');
    }
  });
});

describe('rulesForRegime — drift-override', () => {
  const levels = {
    esCallWall: 5820,
    esPutWall: 5780,
    esZeroGamma: 5800,
    esMaxPain: 5795,
    esGammaPin: 5820,
  };
  const FAR_PRICE = 5700;

  const flowWithDrift = (
    direction: 'up' | 'down' | 'flat',
    consistency: number,
  ): PlaybookFlowSignals => ({
    upsideTargetCls: null,
    downsideTargetCls: null,
    ceilingTrend5m: null,
    floorTrend5m: null,
    priceTrend: {
      direction,
      consistency,
      changePct: direction === 'up' ? 0.5 : direction === 'down' ? -0.5 : 0,
      changePts: direction === 'up' ? 25 : direction === 'down' ? -25 : 0,
    },
  });

  it('drifting up with consistency ≥ threshold suppresses pos-fade-call-wall', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      flowWithDrift('up', 0.8),
    );
    const ids = rules.map((r) => r.id);
    expect(ids).not.toContain('pos-fade-call-wall');
    expect(ids).toContain('pos-lift-put-wall');
  });

  it('drifting down with consistency ≥ threshold suppresses pos-lift-put-wall', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      flowWithDrift('down', 0.8),
    );
    const ids = rules.map((r) => r.id);
    expect(ids).not.toContain('pos-lift-put-wall');
    expect(ids).toContain('pos-fade-call-wall');
  });

  it('drift below consistency threshold does NOT suppress (dead-band)', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      flowWithDrift('up', DRIFT_OVERRIDE_CONSISTENCY_MIN - 0.1),
    );
    const ids = rules.map((r) => r.id);
    expect(ids).toContain('pos-fade-call-wall');
    expect(ids).toContain('pos-lift-put-wall');
  });

  it('flat direction does not suppress anything', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      flowWithDrift('flat', 1.0),
    );
    const ids = rules.map((r) => r.id);
    expect(ids).toContain('pos-fade-call-wall');
    expect(ids).toContain('pos-lift-put-wall');
  });

  it('drift-override does not affect NEGATIVE regime rules', () => {
    const rules = rulesForRegime(
      'NEGATIVE',
      'POWER',
      levels,
      FAR_PRICE,
      flowWithDrift('up', 0.9),
    );
    const ids = rules.map((r) => r.id);
    expect(ids).toContain('neg-break-call-wall');
    expect(ids).toContain('neg-break-put-wall');
  });

  it('override fires at consistency === threshold (inclusive lower bound)', () => {
    // Regression: previously the threshold was 0.6 while computePriceTrend
    // emits a non-flat direction at 0.55. A drift at 0.56 was classified
    // as drifting but the override refused to suppress — silent mismatch.
    const rules = rulesForRegime(
      'POSITIVE',
      'MORNING',
      levels,
      FAR_PRICE,
      flowWithDrift('up', DRIFT_OVERRIDE_CONSISTENCY_MIN),
    );
    expect(rules.map((r) => r.id)).not.toContain('pos-fade-call-wall');
  });
});

describe('rulesForRegime — charm-drift coincidence guards', () => {
  const baseLevels = {
    esCallWall: 5820,
    esPutWall: 5780,
    esZeroGamma: 5800,
    esMaxPain: 5795,
    esGammaPin: 5820,
  };

  it('suppresses charm-drift when gamma pin coincides with call wall', () => {
    // esGammaPin === esCallWall — fade-call already covers that level
    // with a directional thesis; a second EITHER rule duplicates it.
    const rules = rulesForRegime(
      'POSITIVE',
      'AFTERNOON',
      baseLevels, // pin=5820 === callWall=5820
      5700,
    );
    expect(rules.map((r) => r.id)).not.toContain('pos-charm-drift');
  });

  it('suppresses charm-drift when gamma pin coincides with put wall', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'AFTERNOON',
      { ...baseLevels, esGammaPin: 5780 }, // pin === putWall
      5700,
    );
    expect(rules.map((r) => r.id)).not.toContain('pos-charm-drift');
  });

  it('suppresses charm-drift when gamma pin is within ACTIVE band of spot', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'AFTERNOON',
      { ...baseLevels, esGammaPin: 5801 }, // pin essentially at spot
      5800,
    );
    expect(rules.map((r) => r.id)).not.toContain('pos-charm-drift');
  });

  it('emits charm-drift when pin is a distinct strike away from both walls and spot', () => {
    const rules = rulesForRegime(
      'POSITIVE',
      'AFTERNOON',
      { ...baseLevels, esGammaPin: 5810 }, // between walls, far from spot=5700
      5700,
    );
    expect(rules.map((r) => r.id)).toContain('pos-charm-drift');
  });
});
