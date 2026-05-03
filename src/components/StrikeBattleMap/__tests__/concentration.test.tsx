import { describe, it, expect } from 'vitest';
import {
  computeConcentration,
  nearestOtmStrikes,
  TOP_N_FOR_RATIO,
  MAGNET_THRESHOLD,
  SMEARED_THRESHOLD,
  type StrikeMagnitude,
} from '../concentration';

describe('computeConcentration', () => {
  it('returns empty result for empty input', () => {
    const r = computeConcentration([]);
    expect(r.label).toBe('empty');
    expect(r.topStrike).toBeNull();
    expect(r.ratio).toBe(0);
    expect(r.topSign).toBe(0);
  });

  it('returns empty when all signed values are 0', () => {
    const r = computeConcentration([
      { strike: 720, signed: 0 },
      { strike: 721, signed: 0 },
    ]);
    expect(r.label).toBe('empty');
  });

  it('classifies a single dominant strike as magnet', () => {
    const r = computeConcentration([
      { strike: 720, signed: 1000 }, // dominant
      { strike: 721, signed: 100 },
      { strike: 722, signed: 50 },
      { strike: 723, signed: 40 },
      { strike: 724, signed: 10 },
    ]);
    expect(r.topStrike).toBe(720);
    expect(r.topMagnitude).toBe(1000);
    expect(r.topNSum).toBe(1200);
    expect(r.ratio).toBeCloseTo(1000 / 1200, 5);
    expect(r.label).toBe('magnet');
    expect(r.topSign).toBe(1);
  });

  it('classifies a smeared distribution', () => {
    // Each strike contributes ~equally → top1/sum is close to 0.2
    const r = computeConcentration([
      { strike: 720, signed: 100 },
      { strike: 721, signed: 100 },
      { strike: 722, signed: 100 },
      { strike: 723, signed: 100 },
      { strike: 724, signed: 100 },
    ]);
    expect(r.label).toBe('smeared');
    expect(r.ratio).toBeCloseTo(0.2, 2);
  });

  it('classifies a partial concentration (between thresholds)', () => {
    const r = computeConcentration([
      { strike: 720, signed: 400 }, // 0.4 of total 1000
      { strike: 721, signed: 250 },
      { strike: 722, signed: 200 },
      { strike: 723, signed: 100 },
      { strike: 724, signed: 50 },
    ]);
    expect(r.ratio).toBeCloseTo(0.4, 5);
    expect(r.label).toBe('partial');
    expect(r.ratio).toBeGreaterThanOrEqual(SMEARED_THRESHOLD);
    expect(r.ratio).toBeLessThan(MAGNET_THRESHOLD);
  });

  it('detects bearish dominant sign', () => {
    const r = computeConcentration([
      { strike: 720, signed: -800 },
      { strike: 721, signed: 100 },
      { strike: 722, signed: 50 },
    ]);
    expect(r.topSign).toBe(-1);
    expect(r.topStrike).toBe(720);
    expect(r.topMagnitude).toBe(800);
  });

  it('caps the denominator at TOP_N_FOR_RATIO strikes', () => {
    // Top 5 sum to 500 (100 each); strikes 6-10 should not affect ratio
    const inputs: StrikeMagnitude[] = [
      { strike: 720, signed: 100 },
      { strike: 721, signed: 100 },
      { strike: 722, signed: 100 },
      { strike: 723, signed: 100 },
      { strike: 724, signed: 100 },
      // These should be excluded from top-N denominator
      { strike: 725, signed: 100 },
      { strike: 726, signed: 100 },
      { strike: 727, signed: 100 },
    ];
    const r = computeConcentration(inputs);
    expect(r.topNSum).toBe(100 * TOP_N_FOR_RATIO);
    expect(r.ratio).toBeCloseTo(0.2, 5);
  });

  it('handles fewer than TOP_N_FOR_RATIO strikes gracefully', () => {
    const r = computeConcentration([
      { strike: 720, signed: 1000 },
      { strike: 721, signed: 200 },
    ]);
    expect(r.topNSum).toBe(1200);
    expect(r.ratio).toBeCloseTo(1000 / 1200, 5);
    expect(r.label).toBe('magnet');
  });

  it('skips non-finite signed values', () => {
    const r = computeConcentration([
      { strike: 720, signed: 1000 },
      { strike: 721, signed: Number.NaN },
      { strike: 722, signed: Infinity },
      { strike: 723, signed: 200 },
    ]);
    // Only the finite, non-zero entries should make it into the
    // calculation: 1000 + 200 = 1200.
    expect(r.topNSum).toBe(1200);
    expect(r.topStrike).toBe(720);
  });

  it('uses absolute magnitude when picking the top strike', () => {
    // -1500 has bigger magnitude than +1000 → should win
    const r = computeConcentration([
      { strike: 720, signed: 1000 },
      { strike: 721, signed: -1500 },
    ]);
    expect(r.topStrike).toBe(721);
    expect(r.topMagnitude).toBe(1500);
    expect(r.topSign).toBe(-1);
  });

  it('exact 0.50 ratio is classified as magnet (>= boundary)', () => {
    const r = computeConcentration([
      { strike: 720, signed: 500 },
      { strike: 721, signed: 500 },
    ]);
    expect(r.ratio).toBe(0.5);
    expect(r.label).toBe('magnet');
  });

  it('exact 0.30 ratio is classified as partial (>= boundary)', () => {
    // top = 30, sum = 100 (30+25+20+15+10) → 0.30 exactly
    const r = computeConcentration([
      { strike: 720, signed: 30 },
      { strike: 721, signed: 25 },
      { strike: 722, signed: 20 },
      { strike: 723, signed: 15 },
      { strike: 724, signed: 10 },
    ]);
    expect(r.ratio).toBe(0.3);
    expect(r.label).toBe('partial');
  });
});

describe('nearestOtmStrikes', () => {
  it('returns N calls (above spot) and N puts (below spot)', () => {
    const rows = [
      { strike: 718 },
      { strike: 719 },
      { strike: 720 },
      { strike: 721 },
      { strike: 722 },
      { strike: 723 },
      { strike: 724 },
    ];
    const r = nearestOtmStrikes(rows, 720.5, 2);
    expect(r.calls.map((c) => c.strike)).toEqual([721, 722]);
    // Puts come back nearest-first (descending strike)
    expect(r.puts.map((p) => p.strike)).toEqual([720, 719]);
  });

  it('handles spot exactly on a strike (strict OTM, equals excluded)', () => {
    const rows = [
      { strike: 719 },
      { strike: 720 }, // == spot → not OTM
      { strike: 721 },
    ];
    const r = nearestOtmStrikes(rows, 720, 1);
    expect(r.calls.map((c) => c.strike)).toEqual([721]);
    expect(r.puts.map((p) => p.strike)).toEqual([719]);
  });

  it('returns fewer than requested when not enough strikes exist', () => {
    const rows = [{ strike: 720 }, { strike: 721 }];
    const r = nearestOtmStrikes(rows, 720.5, 5);
    expect(r.calls.map((c) => c.strike)).toEqual([721]);
    expect(r.puts.map((p) => p.strike)).toEqual([720]);
  });

  it('returns empty when input is empty', () => {
    const r = nearestOtmStrikes([], 720, 5);
    expect(r.calls).toEqual([]);
    expect(r.puts).toEqual([]);
  });

  it('returns empty when spot is non-finite', () => {
    const rows = [{ strike: 720 }, { strike: 721 }];
    const r = nearestOtmStrikes(rows, Number.NaN, 5);
    expect(r.calls).toEqual([]);
    expect(r.puts).toEqual([]);
  });

  it('returns empty when countPerSide is 0 or negative', () => {
    const rows = [{ strike: 720 }, { strike: 721 }];
    expect(nearestOtmStrikes(rows, 720.5, 0)).toEqual({
      calls: [],
      puts: [],
    });
    expect(nearestOtmStrikes(rows, 720.5, -1)).toEqual({
      calls: [],
      puts: [],
    });
  });

  it('preserves additional row properties through the filter', () => {
    interface RowWithExtra {
      strike: number;
      gamma: number;
    }
    const rows: RowWithExtra[] = [
      { strike: 720, gamma: 100 },
      { strike: 721, gamma: 200 },
    ];
    const r = nearestOtmStrikes(rows, 720.5, 1);
    expect(r.calls[0]?.gamma).toBe(200);
    expect(r.puts[0]?.gamma).toBe(100);
  });
});
