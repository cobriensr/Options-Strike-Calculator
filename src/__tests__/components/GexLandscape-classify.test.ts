/**
 * Unit tests for GexLandscape `computeGammaPressure`.
 *
 * The function combines bid/ask gamma volume into a per-strike pressure
 * label (reinforcing / unwinding / neutral) using a ratio-based neutral
 * band (`PRESSURE_NEUTRAL_BAND_RATIO`).
 */

import { describe, expect, it } from 'vitest';
import { computeGammaPressure } from '../../components/GexLandscape/classify';
import { PRESSURE_NEUTRAL_BAND_RATIO } from '../../components/GexLandscape/constants';

/** Convenience: the smallest |pressure| that exits the neutral band. */
function aboveBand(dollarGammaOi: number): number {
  // Use 2x the threshold to leave headroom past the strict-< boundary.
  return dollarGammaOi * PRESSURE_NEUTRAL_BAND_RATIO * 2;
}

/** Convenience: a |pressure| comfortably inside the neutral band. */
function belowBand(dollarGammaOi: number): number {
  return dollarGammaOi * PRESSURE_NEUTRAL_BAND_RATIO * 0.5;
}

describe('computeGammaPressure', () => {
  it('returns neutral when all vol fields are zero', () => {
    const result = computeGammaPressure({
      callGammaAskVol: 0,
      callGammaBidVol: 0,
      putGammaAskVol: 0,
      putGammaBidVol: 0,
      dollarGammaOi: 1_000_000,
    });
    expect(result).toBe('neutral');
  });

  it('returns neutral when all vol fields are null', () => {
    const result = computeGammaPressure({
      callGammaAskVol: null,
      callGammaBidVol: null,
      putGammaAskVol: null,
      putGammaBidVol: null,
      dollarGammaOi: 1_000_000,
    });
    expect(result).toBe('neutral');
  });

  it('returns unwinding when pressure is positive and ratio above band', () => {
    const dollarGammaOi = 1_000_000;
    // Customers buying calls at the ask + selling puts at the bid pulls
    // pressure positive (dealers shorter → walls unwinding).
    const lift = aboveBand(dollarGammaOi);
    const result = computeGammaPressure({
      callGammaAskVol: lift,
      callGammaBidVol: 0,
      putGammaAskVol: 0,
      putGammaBidVol: 0,
      dollarGammaOi,
    });
    expect(result).toBe('unwinding');
  });

  it('returns reinforcing when pressure is negative and ratio above band', () => {
    const dollarGammaOi = 1_000_000;
    // Customers selling calls at the bid pulls pressure negative
    // (dealers longer → walls reinforcing).
    const lift = aboveBand(dollarGammaOi);
    const result = computeGammaPressure({
      callGammaAskVol: 0,
      callGammaBidVol: lift,
      putGammaAskVol: 0,
      putGammaBidVol: 0,
      dollarGammaOi,
    });
    expect(result).toBe('reinforcing');
  });

  it('returns neutral when pressure is positive but ratio below band', () => {
    const dollarGammaOi = 1_000_000;
    const lift = belowBand(dollarGammaOi);
    const result = computeGammaPressure({
      callGammaAskVol: lift,
      callGammaBidVol: 0,
      putGammaAskVol: 0,
      putGammaBidVol: 0,
      dollarGammaOi,
    });
    expect(result).toBe('neutral');
  });

  it('returns neutral when dollarGammaOi is 0 (avoid divide-by-zero)', () => {
    const result = computeGammaPressure({
      callGammaAskVol: 1_000_000,
      callGammaBidVol: 0,
      putGammaAskVol: 0,
      putGammaBidVol: 0,
      dollarGammaOi: 0,
    });
    expect(result).toBe('neutral');
  });

  it('handles asymmetric inputs — only call vols populated, puts null', () => {
    const dollarGammaOi = 500_000;
    const lift = aboveBand(dollarGammaOi);
    const result = computeGammaPressure({
      callGammaAskVol: lift,
      callGammaBidVol: 0,
      putGammaAskVol: null,
      putGammaBidVol: null,
      dollarGammaOi,
    });
    expect(result).toBe('unwinding');
  });

  it('uses the magnitude of dollarGammaOi (negative net gamma still works)', () => {
    const magnitude = 1_000_000;
    const lift = aboveBand(magnitude);
    const result = computeGammaPressure({
      callGammaAskVol: lift,
      callGammaBidVol: 0,
      putGammaAskVol: 0,
      putGammaBidVol: 0,
      // Negative net gamma magnitude — function takes Math.abs internally.
      dollarGammaOi: -magnitude,
    });
    expect(result).toBe('unwinding');
  });

  it('combines call and put sides per the spec formula', () => {
    const dollarGammaOi = 1_000_000;
    // Verify both legs contribute and the sign of the *total* drives the
    // label. Formula: (callAsk − callBid) + (putBid − putAsk).
    //   callAsk − callBid = 0 − 80_000 = −80_000
    //   putBid  − putAsk  = 0 − 80_000 = −80_000
    //   total = −160_000  (ratio 0.16 > 0.05)  → reinforcing
    const result = computeGammaPressure({
      callGammaAskVol: 0,
      callGammaBidVol: 80_000,
      putGammaAskVol: 80_000,
      putGammaBidVol: 0,
      dollarGammaOi,
    });
    expect(result).toBe('reinforcing');
  });
});
