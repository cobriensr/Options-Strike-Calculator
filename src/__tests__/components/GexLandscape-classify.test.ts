/**
 * Unit tests for GexLandscape `computeGammaPressure` and `getDirection`.
 *
 * `computeGammaPressure` combines bid/ask gamma volume into a per-strike
 *   pressure label (reinforcing / unwinding / neutral) using a ratio-based
 *   neutral band (`PRESSURE_NEUTRAL_BAND_RATIO`).
 * `getDirection` maps (strike, price, ticker) to ceiling / floor / atm
 *   using the per-ticker spot band (`BAND_BY_TICKER`).
 */

import { describe, expect, it } from 'vitest';
import {
  computeGammaPressure,
  getDirection,
} from '../../components/GexLandscape/classify';
import {
  BAND_BY_TICKER,
  PRESSURE_NEUTRAL_BAND_RATIO,
} from '../../components/GexLandscape/constants';

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

describe('getDirection — per-ticker bands', () => {
  // Sanity-check the band map matches the spec's documented values so a
  // future drift in `BAND_BY_TICKER` here surfaces as a single failing
  // assertion rather than a fan-out across the directional cases below.
  it('exposes the documented per-ticker band values', () => {
    expect(BAND_BY_TICKER.SPY).toBe(5);
    expect(BAND_BY_TICKER.QQQ).toBe(5);
    expect(BAND_BY_TICKER.SPX).toBe(25);
    expect(BAND_BY_TICKER.NDX).toBe(125);
  });

  // SPY / QQQ — 5pt band. A strike at spot+10 is well outside the band
  // and should label as `ceiling`; spot−10 should label as `floor`.
  it('SPY: a strike 10pt above spot is a ceiling (band 5)', () => {
    expect(getDirection(610, 600, 'SPY')).toBe('ceiling');
  });
  it('SPY: a strike 10pt below spot is a floor (band 5)', () => {
    expect(getDirection(590, 600, 'SPY')).toBe('floor');
  });
  it('SPY: a strike right at spot is atm', () => {
    expect(getDirection(600, 600, 'SPY')).toBe('atm');
  });
  it('SPY: a strike at the band edge (+5) is still atm (strict >)', () => {
    expect(getDirection(605, 600, 'SPY')).toBe('atm');
  });
  it('QQQ: a strike 6pt above spot is a ceiling (band 5)', () => {
    expect(getDirection(506, 500, 'QQQ')).toBe('ceiling');
  });

  // SPX — 25pt band. A strike at spot+10 (the SPY ceiling case) is
  // well *inside* the SPX band and should label as `atm` — this is the
  // key per-ticker behaviour difference the rebalance is designed for.
  it('SPX: a strike 10pt above spot is atm (band 25, was ceiling for SPY)', () => {
    expect(getDirection(7040, 7030, 'SPX')).toBe('atm');
  });
  it('SPX: a strike 26pt above spot is a ceiling (just outside band 25)', () => {
    expect(getDirection(7056, 7030, 'SPX')).toBe('ceiling');
  });
  it('SPX: a strike 26pt below spot is a floor', () => {
    expect(getDirection(7004, 7030, 'SPX')).toBe('floor');
  });
  it('SPX: a strike at the band edge (+25) is still atm (strict >)', () => {
    expect(getDirection(7055, 7030, 'SPX')).toBe('atm');
  });

  // NDX — 125pt band. Strikes that would be far ceilings on other
  // tickers fall well within NDX's wider band.
  it('NDX: a strike 100pt above spot is atm (band 125)', () => {
    expect(getDirection(20_100, 20_000, 'NDX')).toBe('atm');
  });
  it('NDX: a strike 130pt above spot is a ceiling (just outside band 125)', () => {
    expect(getDirection(20_130, 20_000, 'NDX')).toBe('ceiling');
  });
  it('NDX: a strike 130pt below spot is a floor', () => {
    expect(getDirection(19_870, 20_000, 'NDX')).toBe('floor');
  });
});
