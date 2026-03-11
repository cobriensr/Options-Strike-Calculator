import { describe, it, expect } from 'vitest';
import {
  VIX_BUCKETS,
  SURVIVAL_DATA,
  FINE_VIX_STATS,
  TOTAL_MATCHED_DAYS,
  CORRELATIONS,
  findBucket,
  findFineStat,
  getSurvival,
  estimateRange,
  DOW_STATS_ALL,
  DOW_STATS_LOW_VIX,
  DOW_STATS_MID_VIX,
  DOW_STATS_HIGH_VIX,
  getDowMultiplier,
  getTodayDow,
} from '../data/vixRangeStats';

// ============================================================
// DATA INTEGRITY: VIX_BUCKETS
// ============================================================
describe('VIX_BUCKETS: data integrity', () => {
  it('contains exactly 8 buckets', () => {
    expect(VIX_BUCKETS).toHaveLength(8);
  });

  it('buckets span the full VIX range with no gaps', () => {
    expect(VIX_BUCKETS[0]!.lo).toBe(0);
    for (let i = 1; i < VIX_BUCKETS.length; i++) {
      expect(VIX_BUCKETS[i]!.lo).toBe(VIX_BUCKETS[i - 1]!.hi);
    }
    expect(VIX_BUCKETS[VIX_BUCKETS.length - 1]!.hi).toBeGreaterThanOrEqual(100);
  });

  it('all buckets have positive day counts', () => {
    for (const b of VIX_BUCKETS) {
      expect(b.count).toBeGreaterThan(0);
    }
  });

  it('total days across buckets equals TOTAL_MATCHED_DAYS', () => {
    const total = VIX_BUCKETS.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(TOTAL_MATCHED_DAYS);
  });

  it('p90 > median > 0 for all buckets (both H-L and O-C)', () => {
    for (const b of VIX_BUCKETS) {
      expect(b.p90HL).toBeGreaterThan(b.medHL);
      expect(b.medHL).toBeGreaterThan(0);
      expect(b.p90OC).toBeGreaterThan(b.medOC);
    }
  });

  it('H-L range >= O-C range for corresponding percentiles', () => {
    for (const b of VIX_BUCKETS) {
      expect(b.medHL).toBeGreaterThanOrEqual(b.medOC);
      expect(b.avgHL).toBeGreaterThanOrEqual(b.avgOC);
      expect(b.p90HL).toBeGreaterThanOrEqual(b.p90OC);
    }
  });

  it('median H-L increases monotonically with VIX level', () => {
    for (let i = 1; i < VIX_BUCKETS.length; i++) {
      expect(VIX_BUCKETS[i]!.medHL).toBeGreaterThan(VIX_BUCKETS[i - 1]!.medHL);
    }
  });

  it('% days >2% H-L increases with VIX level', () => {
    for (let i = 1; i < VIX_BUCKETS.length; i++) {
      expect(VIX_BUCKETS[i]!.over2HL).toBeGreaterThanOrEqual(VIX_BUCKETS[i - 1]!.over2HL);
    }
  });

  it('over1HL and over2HL are between 0 and 100', () => {
    for (const b of VIX_BUCKETS) {
      expect(b.over1HL).toBeGreaterThanOrEqual(0);
      expect(b.over1HL).toBeLessThanOrEqual(100);
      expect(b.over2HL).toBeGreaterThanOrEqual(0);
      expect(b.over2HL).toBeLessThanOrEqual(100);
    }
  });

  it('over2HL <= over1HL for all buckets', () => {
    for (const b of VIX_BUCKETS) {
      expect(b.over2HL).toBeLessThanOrEqual(b.over1HL);
    }
  });

  it('each bucket has a valid zone assignment', () => {
    const validZones = new Set(['go', 'caution', 'stop', 'danger']);
    for (const b of VIX_BUCKETS) {
      expect(validZones.has(b.zone)).toBe(true);
    }
  });

  it('zones progress from go toward danger', () => {
    expect(VIX_BUCKETS[0]!.zone).toBe('go');
    expect(VIX_BUCKETS[VIX_BUCKETS.length - 1]!.zone).toBe('danger');
  });

  it('all buckets have unique labels', () => {
    const labels = VIX_BUCKETS.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ============================================================
// DATA INTEGRITY: SURVIVAL_DATA
// ============================================================
describe('SURVIVAL_DATA: data integrity', () => {
  it('contains 6 wing width entries', () => {
    expect(SURVIVAL_DATA).toHaveLength(6);
  });

  it('wing widths are sorted ascending', () => {
    for (let i = 1; i < SURVIVAL_DATA.length; i++) {
      expect(SURVIVAL_DATA[i]!.wing).toBeGreaterThan(SURVIVAL_DATA[i - 1]!.wing);
    }
  });

  it('each entry has settle and intraday arrays matching bucket count', () => {
    for (const s of SURVIVAL_DATA) {
      expect(s.settle).toHaveLength(VIX_BUCKETS.length);
      expect(s.intraday).toHaveLength(VIX_BUCKETS.length);
    }
  });

  it('all survival rates are between 0 and 100', () => {
    for (const s of SURVIVAL_DATA) {
      for (const v of s.settle) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      for (const v of s.intraday) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('wider wings have higher survival rates at same VIX', () => {
    for (let bi = 0; bi < VIX_BUCKETS.length; bi++) {
      for (let si = 1; si < SURVIVAL_DATA.length; si++) {
        expect(SURVIVAL_DATA[si]!.settle[bi]).toBeGreaterThanOrEqual(SURVIVAL_DATA[si - 1]!.settle[bi]!);
        expect(SURVIVAL_DATA[si]!.intraday[bi]).toBeGreaterThanOrEqual(SURVIVAL_DATA[si - 1]!.intraday[bi]!);
      }
    }
  });

  it('higher VIX = lower survival rate at same wing width', () => {
    for (const s of SURVIVAL_DATA) {
      for (let bi = 1; bi < VIX_BUCKETS.length; bi++) {
        expect(s.settle[bi]).toBeLessThanOrEqual(s.settle[bi - 1]!);
        expect(s.intraday[bi]).toBeLessThanOrEqual(s.intraday[bi - 1]!);
      }
    }
  });

  it('each entry has a non-empty label', () => {
    for (const s of SURVIVAL_DATA) {
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// DATA INTEGRITY: FINE_VIX_STATS
// ============================================================
describe('FINE_VIX_STATS: data integrity', () => {
  it('contains 21 entries (VIX 10–30)', () => {
    expect(FINE_VIX_STATS).toHaveLength(21);
  });

  it('VIX values are consecutive integers from 10 to 30', () => {
    for (let i = 0; i < FINE_VIX_STATS.length; i++) {
      expect(FINE_VIX_STATS[i]!.vix).toBe(10 + i);
    }
  });

  it('all entries have positive day counts', () => {
    for (const s of FINE_VIX_STATS) {
      expect(s.count).toBeGreaterThan(0);
    }
  });

  it('all percentile values are non-negative', () => {
    for (const s of FINE_VIX_STATS) {
      expect(s.medHL).toBeGreaterThanOrEqual(0);
      expect(s.p90HL).toBeGreaterThanOrEqual(0);
      expect(s.medOC).toBeGreaterThanOrEqual(0);
      expect(s.p90OC).toBeGreaterThanOrEqual(0);
      expect(s.over2).toBeGreaterThanOrEqual(0);
    }
  });

  it('p90 > median for H-L and O-C', () => {
    for (const s of FINE_VIX_STATS) {
      expect(s.p90HL).toBeGreaterThan(s.medHL);
      expect(s.p90OC).toBeGreaterThan(s.medOC);
    }
  });

  it('H-L >= O-C for median and p90', () => {
    for (const s of FINE_VIX_STATS) {
      expect(s.medHL).toBeGreaterThanOrEqual(s.medOC);
      expect(s.p90HL).toBeGreaterThanOrEqual(s.p90OC);
    }
  });

  it('median H-L generally increases with VIX', () => {
    const first = FINE_VIX_STATS[0]!.medHL;
    const last = FINE_VIX_STATS[FINE_VIX_STATS.length - 1]!.medHL;
    expect(last).toBeGreaterThan(first * 2);
  });

  it('over2 is between 0 and 100', () => {
    for (const s of FINE_VIX_STATS) {
      expect(s.over2).toBeGreaterThanOrEqual(0);
      expect(s.over2).toBeLessThanOrEqual(100);
    }
  });
});

// ============================================================
// CONSTANTS
// ============================================================
describe('Constants', () => {
  it('TOTAL_MATCHED_DAYS is 9102', () => {
    expect(TOTAL_MATCHED_DAYS).toBe(9102);
  });

  it('correlations are between 0 and 1', () => {
    expect(CORRELATIONS.vixToHL).toBeGreaterThan(0);
    expect(CORRELATIONS.vixToHL).toBeLessThan(1);
    expect(CORRELATIONS.vixToOC).toBeGreaterThan(0);
    expect(CORRELATIONS.vixToOC).toBeLessThan(1);
  });

  it('VIX-to-HL correlation is stronger than VIX-to-OC', () => {
    expect(CORRELATIONS.vixToHL).toBeGreaterThan(CORRELATIONS.vixToOC);
  });
});

// ============================================================
// findBucket
// ============================================================
describe('findBucket', () => {
  it('returns correct bucket for VIX 10 (< 12)', () => {
    const b = findBucket(10);
    expect(b).not.toBeNull();
    expect(b!.lo).toBe(0);
    expect(b!.zone).toBe('go');
  });

  it('returns correct bucket for VIX 13 (12–15)', () => {
    const b = findBucket(13);
    expect(b).not.toBeNull();
    expect(b!.lo).toBe(12);
  });

  it('returns correct bucket for VIX 19 (18–20)', () => {
    const b = findBucket(19);
    expect(b).not.toBeNull();
    expect(b!.zone).toBe('caution');
  });

  it('returns correct bucket for VIX 28 (25–30)', () => {
    const b = findBucket(28);
    expect(b).not.toBeNull();
    expect(b!.zone).toBe('stop');
  });

  it('returns correct bucket for VIX 50 (40+)', () => {
    const b = findBucket(50);
    expect(b).not.toBeNull();
    expect(b!.zone).toBe('danger');
  });

  it('boundary: VIX exactly 12 falls into 12–15', () => {
    expect(findBucket(12)!.lo).toBe(12);
  });

  it('boundary: VIX exactly 25 falls into 25–30', () => {
    expect(findBucket(25)!.lo).toBe(25);
  });

  it('returns null for negative VIX', () => {
    expect(findBucket(-1)).toBeNull();
  });

  it('handles fractional VIX values', () => {
    const b = findBucket(14.73);
    expect(b).not.toBeNull();
    expect(b!.lo).toBe(12);
  });
});

// ============================================================
// findFineStat
// ============================================================
describe('findFineStat', () => {
  it('returns correct stat for VIX 15', () => {
    const s = findFineStat(15);
    expect(s).not.toBeNull();
    expect(s!.vix).toBe(15);
    expect(s!.medHL).toBe(0.83);
    expect(s!.p90OC).toBe(1.12);
  });

  it('floors fractional VIX: 15.9 → stat for VIX 15', () => {
    const s = findFineStat(15.9);
    expect(s).not.toBeNull();
    expect(s!.vix).toBe(15);
  });

  it('returns null for VIX 9 (below range)', () => {
    expect(findFineStat(9)).toBeNull();
  });

  it('returns null for VIX 31 (above range)', () => {
    expect(findFineStat(31)).toBeNull();
  });
});

// ============================================================
// getSurvival
// ============================================================
describe('getSurvival', () => {
  it('returns survival for VIX 13 with 1.00% wing', () => {
    const result = getSurvival(13, 1.00);
    expect(result).not.toBeNull();
    expect(result!.settle).toBe(92.6);
    expect(result!.intraday).toBe(99.2);
  });

  it('returns null for non-existent wing width', () => {
    expect(getSurvival(15, 0.33)).toBeNull();
  });

  it('returns null for negative VIX', () => {
    expect(getSurvival(-5, 1.00)).toBeNull();
  });
});

// ============================================================
// estimateRange
// ============================================================
describe('estimateRange', () => {
  it('returns all 4 fields', () => {
    const r = estimateRange(20);
    expect(typeof r.medHL).toBe('number');
    expect(typeof r.medOC).toBe('number');
    expect(typeof r.p90HL).toBe('number');
    expect(typeof r.p90OC).toBe('number');
  });

  it('returns exact values for integer VIX within range', () => {
    const r = estimateRange(15);
    expect(r.medHL).toBeCloseTo(0.83, 2);
    expect(r.medOC).toBeCloseTo(0.41, 2);
    expect(r.p90OC).toBeCloseTo(1.12, 2);
  });

  it('interpolates between VIX 15 and 16', () => {
    const r = estimateRange(15.5);
    const lo = FINE_VIX_STATS.find((s) => s.vix === 15)!;
    const hi = FINE_VIX_STATS.find((s) => s.vix === 16)!;
    expect(r.medHL).toBeCloseTo((lo.medHL + hi.medHL) / 2, 2);
    expect(r.p90OC).toBeCloseTo((lo.p90OC + hi.p90OC) / 2, 2);
  });

  it('interpolation is continuous — VIX 22 and 24 produce different results', () => {
    const r22 = estimateRange(22);
    const r24 = estimateRange(24);
    expect(r22.p90OC).not.toBe(r24.p90OC);
    expect(r24.p90OC).toBeGreaterThan(r22.p90OC);
  });

  it('interpolation is smooth across VIX 24.9 → 25.1', () => {
    const rLo = estimateRange(24.9);
    const rHi = estimateRange(25.1);
    // Should differ by only a tiny amount — no bucket jump
    expect(Math.abs(rLo.p90OC - rHi.p90OC)).toBeLessThan(0.1);
    expect(Math.abs(rLo.medHL - rHi.medHL)).toBeLessThan(0.1);
  });

  it('clamps VIX below 10 to VIX 10 values', () => {
    const r5 = estimateRange(5);
    const r10 = estimateRange(10);
    expect(r5.medHL).toBeCloseTo(r10.medHL, 4);
    expect(r5.p90OC).toBeCloseTo(r10.p90OC, 4);
  });

  it('uses bucket stats for VIX > 30', () => {
    const r35 = estimateRange(35);
    // VIX 35 falls in 30-40 bucket
    expect(r35.medHL).toBe(2.17);
    expect(r35.p90OC).toBe(3.00);
  });

  it('uses bucket stats for VIX 50', () => {
    const r50 = estimateRange(50);
    // VIX 50 falls in 40+ bucket
    expect(r50.medHL).toBe(3.62);
    expect(r50.p90OC).toBe(5.09);
  });

  it('higher VIX → higher estimated range (general trend)', () => {
    const low = estimateRange(12);
    const high = estimateRange(25);
    expect(high.medHL).toBeGreaterThan(low.medHL);
    expect(high.medOC).toBeGreaterThan(low.medOC);
    expect(high.p90HL).toBeGreaterThan(low.p90HL);
    expect(high.p90OC).toBeGreaterThan(low.p90OC);
  });

  it('p90 > median for all levels', () => {
    for (let vix = 10; vix <= 30; vix++) {
      const r = estimateRange(vix);
      expect(r.p90HL).toBeGreaterThan(r.medHL);
      expect(r.p90OC).toBeGreaterThan(r.medOC);
    }
  });

  it('H-L >= O-C for all levels', () => {
    for (let vix = 10; vix <= 30; vix++) {
      const r = estimateRange(vix);
      expect(r.medHL).toBeGreaterThanOrEqual(r.medOC);
      expect(r.p90HL).toBeGreaterThanOrEqual(r.p90OC);
    }
  });
});

// ============================================================
// DAY-OF-WEEK DATA
// ============================================================
describe('DOW_STATS: data integrity', () => {
  const allTables = [
    { name: 'ALL', data: DOW_STATS_ALL },
    { name: 'LOW_VIX', data: DOW_STATS_LOW_VIX },
    { name: 'MID_VIX', data: DOW_STATS_MID_VIX },
    { name: 'HIGH_VIX', data: DOW_STATS_HIGH_VIX },
  ];

  for (const { name, data } of allTables) {
    it(`${name} contains exactly 5 entries (Mon-Fri)`, () => {
      expect(data).toHaveLength(5);
    });

    it(`${name} has consecutive days 0-4`, () => {
      for (let i = 0; i < data.length; i++) {
        expect(data[i]!.day).toBe(i);
      }
    });

    it(`${name} has positive counts`, () => {
      for (const row of data) {
        expect(row.count).toBeGreaterThan(0);
      }
    });

    it(`${name} has valid multipliers near 1.0`, () => {
      for (const row of data) {
        expect(row.multHL).toBeGreaterThan(0.8);
        expect(row.multHL).toBeLessThan(1.2);
        expect(row.multOC).toBeGreaterThan(0.8);
        expect(row.multOC).toBeLessThan(1.2);
      }
    });

    it(`${name} multipliers average close to 1.0`, () => {
      const avgHL = data.reduce((s, r) => s + r.multHL, 0) / 5;
      const avgOC = data.reduce((s, r) => s + r.multOC, 0) / 5;
      expect(avgHL).toBeCloseTo(1.0, 1);
      expect(avgOC).toBeCloseTo(1.0, 1);
    });

    it(`${name} p90 > median for H-L and O-C`, () => {
      for (const row of data) {
        expect(row.p90HL).toBeGreaterThan(row.medHL);
        expect(row.p90OC).toBeGreaterThan(row.medOC);
      }
    });
  }

  it('Monday is quieter than Thursday across all regimes', () => {
    for (const { data } of allTables) {
      const mon = data[0]!;
      const thu = data[3]!;
      expect(mon.multHL).toBeLessThan(thu.multHL);
    }
  });
});

// ============================================================
// getDowMultiplier
// ============================================================
describe('getDowMultiplier', () => {
  it('returns Monday multiplier for VIX 15 (low regime)', () => {
    const m = getDowMultiplier(15, 0);
    expect(m.dayLabel).toBe('Monday');
    expect(m.dayShort).toBe('Mon');
    expect(m.multHL).toBeCloseTo(0.905, 3);
  });

  it('returns Thursday multiplier for VIX 22 (mid regime)', () => {
    const m = getDowMultiplier(22, 3);
    expect(m.dayLabel).toBe('Thursday');
    expect(m.multHL).toBeCloseTo(1.021, 3);
  });

  it('returns Friday multiplier for VIX 30 (high regime)', () => {
    const m = getDowMultiplier(30, 4);
    expect(m.dayLabel).toBe('Friday');
    expect(m.multHL).toBeCloseTo(1.013, 3);
  });

  it('clamps day of week to 0-4', () => {
    const m = getDowMultiplier(20, -1);
    expect(m.dayLabel).toBe('Monday');
    const m2 = getDowMultiplier(20, 7);
    expect(m2.dayLabel).toBe('Friday');
  });

  it('uses low VIX table for VIX < 18', () => {
    const m = getDowMultiplier(12, 0);
    expect(m.multHL).toBeCloseTo(0.905, 3);
  });

  it('uses mid VIX table for VIX 18-24.99', () => {
    const m = getDowMultiplier(22, 0);
    expect(m.multHL).toBeCloseTo(0.966, 3);
  });

  it('uses high VIX table for VIX >= 25', () => {
    const m = getDowMultiplier(35, 0);
    expect(m.multHL).toBeCloseTo(0.956, 3);
  });
});

// ============================================================
// getTodayDow
// ============================================================
describe('getTodayDow', () => {
  it('returns a number 0-4 or null', () => {
    const dow = getTodayDow();
    if (dow !== null) {
      expect(dow).toBeGreaterThanOrEqual(0);
      expect(dow).toBeLessThanOrEqual(4);
    }
  });
});
