import { describe, it, expect } from 'vitest';
import {
  computeHhi,
  computeIvMorningVolCorr,
  evaluatePrecisionPass,
  quantile,
  HHI_PASS_PERCENTILE,
  IV_VOL_CORR_PASS_PERCENTILE,
  MIN_BAND_STRIKES,
  MIN_IV_SAMPLES,
  type BandStrikeSample,
  type IvVolSample,
} from '../_lib/precision-stack.js';

// ── computeHhi ─────────────────────────────────────────────

describe('computeHhi', () => {
  it('returns null when band has fewer than MIN_BAND_STRIKES strikes', () => {
    const samples: BandStrikeSample[] = [
      { strike: 7000, volume: 100, midPrice: 1 },
      { strike: 7005, volume: 100, midPrice: 1 },
    ];
    expect(samples.length).toBeLessThan(MIN_BAND_STRIKES);
    expect(computeHhi(samples)).toBeNull();
  });

  it('returns null when notional is zero everywhere', () => {
    const samples: BandStrikeSample[] = [
      { strike: 7000, volume: 0, midPrice: 1 },
      { strike: 7005, volume: 0, midPrice: 1 },
      { strike: 7010, volume: 0, midPrice: 1 },
    ];
    expect(computeHhi(samples)).toBeNull();
  });

  it('returns 1.0 when one strike captures all notional', () => {
    const samples: BandStrikeSample[] = [
      { strike: 7000, volume: 1_000_000, midPrice: 5 }, // dominant
      { strike: 7005, volume: 0, midPrice: 1 },
      { strike: 7010, volume: 0, midPrice: 1 },
    ];
    // Only one strike has non-zero notional → fewer than MIN_BAND_STRIKES
    // contribute → null per the contract.
    expect(computeHhi(samples)).toBeNull();
  });

  it('approaches 1/N when notional is evenly distributed', () => {
    const samples: BandStrikeSample[] = [
      { strike: 7000, volume: 100, midPrice: 1 },
      { strike: 7005, volume: 100, midPrice: 1 },
      { strike: 7010, volume: 100, midPrice: 1 },
      { strike: 7015, volume: 100, midPrice: 1 },
      { strike: 7020, volume: 100, midPrice: 1 },
    ];
    const hhi = computeHhi(samples);
    expect(hhi).toBeGreaterThan(0.19);
    expect(hhi).toBeLessThan(0.21);
  });

  it('a concentrated distribution scores higher than a diffuse one', () => {
    const concentrated: BandStrikeSample[] = [
      { strike: 7000, volume: 1000, midPrice: 5 },
      { strike: 7005, volume: 100, midPrice: 1 },
      { strike: 7010, volume: 100, midPrice: 1 },
      { strike: 7015, volume: 100, midPrice: 1 },
      { strike: 7020, volume: 100, midPrice: 1 },
    ];
    const diffuse: BandStrikeSample[] = [
      { strike: 7000, volume: 200, midPrice: 1 },
      { strike: 7005, volume: 200, midPrice: 1 },
      { strike: 7010, volume: 200, midPrice: 1 },
      { strike: 7015, volume: 200, midPrice: 1 },
      { strike: 7020, volume: 200, midPrice: 1 },
    ];
    const hConc = computeHhi(concentrated);
    const hDiff = computeHhi(diffuse);
    expect(hConc).not.toBeNull();
    expect(hDiff).not.toBeNull();
    expect(hConc!).toBeGreaterThan(hDiff!);
  });

  it('ignores non-finite or non-positive entries', () => {
    const samples: BandStrikeSample[] = [
      { strike: 7000, volume: NaN, midPrice: 1 },
      { strike: 7005, volume: 100, midPrice: 0 },
      { strike: 7010, volume: 100, midPrice: 1 },
      { strike: 7015, volume: 100, midPrice: 1 },
      { strike: 7020, volume: 100, midPrice: 1 },
    ];
    const hhi = computeHhi(samples);
    expect(hhi).not.toBeNull();
    // 3 valid strikes evenly distributed → ~1/3
    expect(hhi!).toBeGreaterThan(0.32);
    expect(hhi!).toBeLessThan(0.34);
  });
});

// ── computeIvMorningVolCorr ────────────────────────────────

describe('computeIvMorningVolCorr', () => {
  it('returns null when fewer than MIN_IV_SAMPLES + 1 samples', () => {
    const samples: IvVolSample[] = Array.from(
      { length: MIN_IV_SAMPLES },
      (_, i) => ({
        ts: `2026-04-30T13:${String(30 + i).padStart(2, '0')}:00.000Z`,
        iv: 0.2 + i * 0.001,
        volume: 100 + i * 10,
      }),
    );
    expect(computeIvMorningVolCorr(samples)).toBeNull();
  });

  it('returns ~+1 for IV and volume with deltas that move together', () => {
    // Each minute, iv and volume move proportionally — but the per-minute
    // step varies (1×, 2×, 3×, …) so the deltas have non-zero variance.
    // Pearson corr on (Δiv, Δvol) is then well-defined and ≈+1.
    const steps = [1, 3, 2, 5, 4, 6, 2, 7, 3, 4];
    let iv = 0.2;
    let vol = 100;
    const samples: IvVolSample[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      samples.push({
        ts: `2026-04-30T13:${String(30 + i).padStart(2, '0')}:00.000Z`,
        iv,
        volume: vol,
      });
      iv += steps[i]! * 0.001;
      vol += steps[i]! * 10;
    }
    const corr = computeIvMorningVolCorr(samples);
    expect(corr).not.toBeNull();
    expect(corr!).toBeGreaterThan(0.99);
  });

  it('returns ~−1 for perfectly anti-correlated IV and volume', () => {
    const samples: IvVolSample[] = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-04-30T13:${String(30 + i).padStart(2, '0')}:00.000Z`,
      // Strict alternation: vol increases by 10 then 20; IV by -0.005 then +0.005
      iv: 0.2 + (i % 2 === 0 ? 0.005 : -0.005),
      volume: 100 + (i % 2 === 0 ? 10 : 20),
    }));
    const corr = computeIvMorningVolCorr(samples);
    expect(corr).not.toBeNull();
    expect(corr!).toBeLessThan(-0.5);
  });

  it('returns null when one series has zero variance', () => {
    const samples: IvVolSample[] = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-04-30T13:${String(30 + i).padStart(2, '0')}:00.000Z`,
      iv: 0.2, // constant
      volume: 100 + i * 20,
    }));
    expect(computeIvMorningVolCorr(samples)).toBeNull();
  });

  it('sorts defensively by ts (descending input still works)', () => {
    // Use varied step sizes so the deltas have non-zero variance.
    const steps = [1, 3, 2, 5, 4, 6, 2, 7, 3];
    let iv = 0.2;
    let vol = 100;
    const ascending: IvVolSample[] = [];
    for (let i = 0; i <= steps.length; i += 1) {
      ascending.push({
        ts: `2026-04-30T13:${String(30 + i).padStart(2, '0')}:00.000Z`,
        iv,
        volume: vol,
      });
      if (i < steps.length) {
        iv += steps[i]! * 0.001;
        vol += steps[i]! * 10;
      }
    }
    const descending = [...ascending].reverse();
    const ascCorr = computeIvMorningVolCorr(ascending);
    const descCorr = computeIvMorningVolCorr(descending);
    expect(ascCorr).not.toBeNull();
    expect(descCorr).not.toBeNull();
    expect(Math.abs(ascCorr! - descCorr!)).toBeLessThan(1e-9);
  });

  it('skips samples with non-finite iv or volume in the delta computation', () => {
    // 10 valid samples with varied deltas + one NaN poison entry. After
    // skipping the two pairs that touch the NaN, we still have 7 valid
    // deltas — well above MIN_IV_SAMPLES (5).
    const samples: IvVolSample[] = [
      { ts: '2026-04-30T13:30:00.000Z', iv: 0.2, volume: 100 },
      { ts: '2026-04-30T13:31:00.000Z', iv: 0.201, volume: 110 },
      { ts: '2026-04-30T13:32:00.000Z', iv: NaN, volume: 120 },
      { ts: '2026-04-30T13:33:00.000Z', iv: 0.207, volume: 145 },
      { ts: '2026-04-30T13:34:00.000Z', iv: 0.21, volume: 160 },
      { ts: '2026-04-30T13:35:00.000Z', iv: 0.216, volume: 195 },
      { ts: '2026-04-30T13:36:00.000Z', iv: 0.218, volume: 205 },
      { ts: '2026-04-30T13:37:00.000Z', iv: 0.224, volume: 240 },
      { ts: '2026-04-30T13:38:00.000Z', iv: 0.227, volume: 260 },
      { ts: '2026-04-30T13:39:00.000Z', iv: 0.232, volume: 290 },
      { ts: '2026-04-30T13:40:00.000Z', iv: 0.235, volume: 305 },
    ];
    const corr = computeIvMorningVolCorr(samples);
    expect(corr).not.toBeNull();
    expect(corr!).toBeGreaterThan(0.5);
  });
});

// ── quantile ───────────────────────────────────────────────

describe('quantile', () => {
  it('returns null for empty input', () => {
    expect(quantile([], 0.5)).toBeNull();
  });

  it('matches numpy.quantile linear interpolation on a known sample', () => {
    const values = [1, 2, 3, 4, 5];
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 0.25)).toBe(2);
    expect(quantile(values, 0.5)).toBe(3);
    expect(quantile(values, 0.75)).toBe(4);
    expect(quantile(values, 1)).toBe(5);
  });

  it('ignores non-finite values', () => {
    expect(quantile([NaN, 1, 2, 3, Infinity], 0.5)).toBe(2);
  });
});

// ── evaluatePrecisionPass ─────────────────────────────────

describe('evaluatePrecisionPass', () => {
  it('returns false when HHI is null', () => {
    expect(evaluatePrecisionPass(null, 0.1, 0.2, 0.05)).toBe(false);
  });

  it('returns false when iv-vol-corr is null', () => {
    expect(evaluatePrecisionPass(0.1, null, 0.2, 0.05)).toBe(false);
  });

  it('returns false when day distribution stats are null', () => {
    expect(evaluatePrecisionPass(0.1, 0.5, null, 0.5)).toBe(false);
    expect(evaluatePrecisionPass(0.1, 0.5, 0.2, null)).toBe(false);
  });

  it('returns true at the boundaries', () => {
    expect(evaluatePrecisionPass(0.2, 0.5, 0.2, 0.5)).toBe(true);
  });

  it('returns false when HHI is above the cutoff', () => {
    expect(evaluatePrecisionPass(0.21, 0.5, 0.2, 0.5)).toBe(false);
  });

  it('returns false when iv-vol-corr is below the cutoff', () => {
    expect(evaluatePrecisionPass(0.2, 0.49, 0.2, 0.5)).toBe(false);
  });
});

// ── constants sanity ──────────────────────────────────────

describe('constants', () => {
  it('HHI cutoff is in (0, 1)', () => {
    expect(HHI_PASS_PERCENTILE).toBeGreaterThan(0);
    expect(HHI_PASS_PERCENTILE).toBeLessThan(1);
  });
  it('IV-vol-corr cutoff is in (0, 1)', () => {
    expect(IV_VOL_CORR_PASS_PERCENTILE).toBeGreaterThan(0);
    expect(IV_VOL_CORR_PASS_PERCENTILE).toBeLessThan(1);
  });
});
