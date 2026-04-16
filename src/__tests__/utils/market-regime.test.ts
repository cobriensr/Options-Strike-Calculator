import { describe, expect, it } from 'vitest';
import type { InternalBar } from '../../types/market-internals';
import { classifyRegime, classifyTickBand } from '../../utils/market-regime';

// ============================================================
// FIXTURE HELPERS
// ============================================================

/** Generate N TICK bars with close values from the provided array. */
function makeTickBars(closes: number[]): InternalBar[] {
  return closes.map((close, i) => ({
    ts: new Date(2026, 3, 15, 9, 30 + i).toISOString(),
    symbol: '$TICK' as const,
    open: close - 10,
    high: close + 20,
    low: close - 20,
    close,
  }));
}

/** Generate N bars for an arbitrary symbol. */
function makeSymbolBars(
  symbol: '$ADD' | '$VOLD' | '$TRIN',
  closes: number[],
): InternalBar[] {
  return closes.map((close, i) => ({
    ts: new Date(2026, 3, 15, 9, 30 + i).toISOString(),
    symbol,
    open: close - 5,
    high: close + 10,
    low: close - 10,
    close,
  }));
}

/**
 * Build an oscillating TICK series that flips sign every `flipEvery`
 * bars, typical of a range day.
 */
function oscillatingTickCloses(
  count: number,
  amplitude: number,
  flipEvery: number,
): number[] {
  const closes: number[] = [];
  let sign = 1;
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % flipEvery === 0) sign *= -1;
    closes.push(sign * (amplitude * (0.5 + 0.5 * Math.random())));
  }
  return closes;
}

// ============================================================
// classifyTickBand
// ============================================================

describe('classifyTickBand', () => {
  it('returns neutral for +100', () => {
    expect(classifyTickBand(100)).toBe('neutral');
  });

  it('returns elevated for +420', () => {
    expect(classifyTickBand(420)).toBe('elevated');
  });

  it('returns extreme for +650', () => {
    expect(classifyTickBand(650)).toBe('extreme');
  });

  it('returns blowoff for +1050', () => {
    expect(classifyTickBand(1050)).toBe('blowoff');
  });

  it('returns extreme for -650 (negative)', () => {
    expect(classifyTickBand(-650)).toBe('extreme');
  });

  it('returns blowoff for -1050 (negative)', () => {
    expect(classifyTickBand(-1050)).toBe('blowoff');
  });

  it('returns neutral for NaN', () => {
    expect(classifyTickBand(NaN)).toBe('neutral');
  });

  it('returns neutral for 0', () => {
    expect(classifyTickBand(0)).toBe('neutral');
  });

  it('returns elevated at exact threshold boundary (400)', () => {
    expect(classifyTickBand(400)).toBe('elevated');
  });

  it('returns extreme at exact threshold boundary (600)', () => {
    expect(classifyTickBand(600)).toBe('extreme');
  });

  it('returns blowoff at exact threshold boundary (1000)', () => {
    expect(classifyTickBand(1000)).toBe('blowoff');
  });
});

// ============================================================
// classifyRegime
// ============================================================

describe('classifyRegime', () => {
  it('returns neutral with confidence 0 for empty bars', () => {
    const result = classifyRegime([]);
    expect(result.regime).toBe('neutral');
    expect(result.confidence).toBe(0);
    expect(result.evidence).toContain('No bars available');
    expect(result.scores).toEqual({ range: 0, trend: 0, neutral: 1 });
  });

  it('returns neutral with "Insufficient data" for fewer than 10 TICK bars', () => {
    const bars = makeTickBars([100, -100, 200, -200, 150]);
    const result = classifyRegime(bars);
    expect(result.regime).toBe('neutral');
    expect(result.evidence.some((e) => e.includes('Insufficient data'))).toBe(
      true,
    );
    expect(result.evidence.some((e) => e.includes('5 TICK bars'))).toBe(true);
  });

  it('classifies a range-day fixture', () => {
    // TICK flips sign nearly every bar — classic range-bound oscillation.
    // Every-other-bar flips give MRR ~0.9, well above the 0.3 threshold.
    const tickCloses = [
      250, -280, 260, -250, 270, -260, 240, -270, 250, -260, 300, -310,
      290, -320, 310, -290, 300, -300, 280, -310,
    ];
    const tickBars = makeTickBars(tickCloses);

    // ADD hovers near the same value — flat.
    const addCloses = [
      500, 510, 495, 505, 498, 502, 508, 496, 504, 501, 507, 493, 506, 499, 503,
      497, 505, 500, 502, 498,
    ];
    const addBars = makeSymbolBars('$ADD', addCloses);

    // VOLD balanced — no strong direction.
    const voldCloses = [
      1000, 1010, 990, 1005, 995, 1008, 992, 1003, 997, 1006, 994, 1002, 998,
      1007, 991, 1004, 996, 1001, 999, 1005,
    ];
    const voldBars = makeSymbolBars('$VOLD', voldCloses);

    const result = classifyRegime([...tickBars, ...addBars, ...voldBars]);
    expect(result.regime).toBe('range');
    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('classifies a trend-day fixture', () => {
    // TICK consistently above +600 — pinned extreme.
    const tickCloses = [
      620, 650, 680, 700, 720, 690, 710, 740, 680, 650, 720, 700, 680, 750, 710,
      660, 690, 730, 670, 640,
    ];
    const tickBars = makeTickBars(tickCloses);

    // ADD drifts steadily upward — directional.
    const addCloses = [
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400,
      1500, 1600, 1700, 1800, 1900, 2000,
    ];
    const addBars = makeSymbolBars('$ADD', addCloses);

    // VOLD drifts strongly one direction.
    const voldCloses = [
      100, 300, 500, 700, 900, 1100, 1300, 1500, 1700, 1900, 2100, 2300, 2500,
      2700, 2900, 3100, 3300, 3500, 3700, 3900,
    ];
    const voldBars = makeSymbolBars('$VOLD', voldCloses);

    const result = classifyRegime([...tickBars, ...addBars, ...voldBars]);
    expect(result.regime).toBe('trend');
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('classifies a neutral fixture', () => {
    // TICK mostly positive, drifting slightly — few sign flips, low MRR.
    // Not pinned extreme either (all values well below 600).
    const tickCloses = [
      50, 80, 60, 90, 40, 70, 100, 55, 85, 65, 75, 45, 95, 60, 80, 50, 70,
      90, 55, 85,
    ];
    const tickBars = makeTickBars(tickCloses);

    // ADD moderately drifting — not flat enough for range, not steep
    // enough for trend.
    const addCloses = [
      500, 520, 540, 560, 550, 570, 590, 580, 600, 610, 605, 620, 615,
      630, 625, 640, 635, 650, 645, 660,
    ];
    const addBars = makeSymbolBars('$ADD', addCloses);

    // VOLD flat.
    const voldCloses = [
      1000, 1005, 1010, 1008, 1012, 1006, 1009, 1011, 1007, 1013, 1005,
      1010, 1008, 1012, 1006, 1009, 1011, 1007, 1013, 1010,
    ];
    const voldBars = makeSymbolBars('$VOLD', voldCloses);

    const result = classifyRegime([...tickBars, ...addBars, ...voldBars]);
    expect(result.regime).toBe('neutral');
  });

  it('classifies with only TICK bars and notes missing symbols', () => {
    // Oscillating TICK — should still attempt classification.
    const tickCloses = oscillatingTickCloses(20, 300, 2);
    const tickBars = makeTickBars(tickCloses);

    const result = classifyRegime(tickBars);
    // Should still produce a result.
    expect(['range', 'trend', 'neutral']).toContain(result.regime);
    // Should note missing symbols.
    expect(result.evidence.some((e) => e.includes('Missing symbols'))).toBe(
      true,
    );
    expect(result.evidence.some((e) => e.includes('$ADD'))).toBe(true);
    expect(result.evidence.some((e) => e.includes('$VOLD'))).toBe(true);
  });

  it('scores sum to approximately 1.0', () => {
    const tickCloses = [
      250, -300, 280, -310, 260, -290, 250, -320, 270, -310, 260, -290, 240,
      -300, 270, -300, 250, -280, 260, -310,
    ];
    const bars = makeTickBars(tickCloses);
    const result = classifyRegime(bars);
    const sum =
      result.scores.range + result.scores.trend + result.scores.neutral;
    expect(sum).toBeCloseTo(1, 0);
  });
});
