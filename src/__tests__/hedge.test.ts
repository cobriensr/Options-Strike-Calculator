import { describe, expect, it } from 'vitest';

import { stressedSigma, calcHedge } from '../utils/hedge';
import { STRESS, DEFAULTS } from '../constants';
import type { HedgeDelta } from '../types';

// ── stressedSigma ──────────────────────────────────────────────

describe('stressedSigma', () => {
  const baseSigma = 0.15;

  it('returns base sigma when movePct = 0', () => {
    expect(stressedSigma(baseSigma, 0)).toBe(baseSigma);
  });

  it('increases sigma on crash (positive movePct)', () => {
    const stressed = stressedSigma(baseSigma, 0.02); // 2% crash
    expect(stressed).toBeGreaterThan(baseSigma);
  });

  it('increases sigma on rally (negative movePct) but less aggressively', () => {
    const stressedCrash = stressedSigma(baseSigma, 0.02);
    const stressedRally = stressedSigma(baseSigma, -0.02);
    // Both should increase sigma (vol of vol effect)
    expect(stressedRally).toBeGreaterThan(baseSigma);
    // Crash sensitivity > rally sensitivity
    expect(stressedCrash).toBeGreaterThan(stressedRally);
  });

  it('uses CRASH_SENSITIVITY for positive movePct', () => {
    const movePct = 0.01;
    const expected = baseSigma * (1 + STRESS.CRASH_SENSITIVITY * movePct);
    expect(stressedSigma(baseSigma, movePct)).toBeCloseTo(expected, 8);
  });

  it('uses RALLY_SENSITIVITY for negative movePct', () => {
    const movePct = -0.01;
    const expected =
      baseSigma * (1 + STRESS.RALLY_SENSITIVITY * Math.abs(movePct));
    expect(stressedSigma(baseSigma, movePct)).toBeCloseTo(expected, 8);
  });

  it('is capped at MAX_MULT times base sigma', () => {
    const extreme = stressedSigma(baseSigma, 1.0); // 100% crash
    expect(extreme).toBe(baseSigma * STRESS.MAX_MULT);
  });

  it('larger moves produce higher stressed sigma', () => {
    const s1 = stressedSigma(baseSigma, 0.01);
    const s2 = stressedSigma(baseSigma, 0.03);
    const s3 = stressedSigma(baseSigma, 0.05);
    expect(s3).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s1);
  });
});

// ── calcHedge ──────────────────────────────────────────────────

describe('calcHedge', () => {
  // Standard IC parameters: SPX 5800, 10-delta, 25pt wings
  const baseParams = {
    spot: 5800,
    sigma: 0.15,
    T: 1 / 252,
    skew: 0.03,
    icContracts: 2,
    icCreditPts: 1.5,
    icMaxLossPts: 23.5, // 25 - 1.5
    icShortPut: 5740,
    icLongPut: 5715,
    icShortCall: 5860,
    icLongCall: 5885,
    hedgeDelta: 2 as HedgeDelta,
  };

  it('returns the requested hedge delta', () => {
    const result = calcHedge(baseParams);
    expect(result.hedgeDelta).toBe(2);
  });

  it('returns a default hedge DTE of 7', () => {
    const result = calcHedge(baseParams);
    expect(result.hedgeDte).toBe(DEFAULTS.HEDGE_DTE);
  });

  it('respects custom hedgeDte', () => {
    const result = calcHedge({ ...baseParams, hedgeDte: 14 });
    expect(result.hedgeDte).toBe(14);
  });

  it('put hedge strike < spot < call hedge strike', () => {
    const result = calcHedge(baseParams);
    expect(result.putStrikeSnapped).toBeLessThan(baseParams.spot);
    expect(result.callStrikeSnapped).toBeGreaterThan(baseParams.spot);
  });

  it('snapped strikes are multiples of STRIKE_INCREMENT', () => {
    const result = calcHedge(baseParams);
    expect(result.putStrikeSnapped % DEFAULTS.STRIKE_INCREMENT).toBe(0);
    expect(result.callStrikeSnapped % DEFAULTS.STRIKE_INCREMENT).toBe(0);
  });

  it('hedge strikes are further OTM than IC short strikes', () => {
    const result = calcHedge(baseParams);
    // Hedge puts are further OTM (lower) than IC short puts
    expect(result.putStrikeSnapped).toBeLessThan(baseParams.icShortPut);
    // Hedge calls are further OTM (higher) than IC short calls
    expect(result.callStrikeSnapped).toBeGreaterThan(baseParams.icShortCall);
  });

  it('premiums are non-negative', () => {
    const result = calcHedge(baseParams);
    expect(result.putPremium).toBeGreaterThanOrEqual(0);
    expect(result.callPremium).toBeGreaterThanOrEqual(0);
  });

  it('recommended contracts are at least 1', () => {
    const result = calcHedge(baseParams);
    expect(result.recommendedPuts).toBeGreaterThanOrEqual(1);
    expect(result.recommendedCalls).toBeGreaterThanOrEqual(1);
  });

  it('daily cost is non-negative', () => {
    const result = calcHedge(baseParams);
    // Daily cost = entry premium - EOD recovery, should be >= 0
    expect(result.dailyCostDollars).toBeGreaterThanOrEqual(0);
  });

  it('breakeven crash/rally points are positive', () => {
    const result = calcHedge(baseParams);
    expect(result.breakEvenCrashPts).toBeGreaterThan(0);
    expect(result.breakEvenRallyPts).toBeGreaterThan(0);
  });

  it('scenario table has both crash and rally scenarios', () => {
    const result = calcHedge(baseParams);
    const crashScenarios = result.scenarios.filter(
      (s) => s.direction === 'crash',
    );
    const rallyScenarios = result.scenarios.filter(
      (s) => s.direction === 'rally',
    );
    expect(crashScenarios.length).toBeGreaterThan(0);
    expect(rallyScenarios.length).toBeGreaterThan(0);
  });

  it('IC P&L is positive (max profit) when no crash/rally', () => {
    const result = calcHedge(baseParams);
    // The smallest crash scenario should still have positive IC P&L
    // if it's within the IC wings
    const smallCrash = result.scenarios.find(
      (s) => s.direction === 'crash' && s.movePoints < 50,
    );
    if (smallCrash) {
      // At small moves, IC should still be profitable
      expect(smallCrash.icPnL).toBeGreaterThan(0);
    }
  });

  it('large crashes have negative IC P&L', () => {
    const result = calcHedge(baseParams);
    const bigCrash = result.scenarios.find(
      (s) => s.direction === 'crash' && s.movePoints > 200,
    );
    if (bigCrash) {
      expect(bigCrash.icPnL).toBeLessThan(0);
    }
  });

  it('vega values are positive', () => {
    const result = calcHedge(baseParams);
    expect(result.putVegaPer1Pct).toBeGreaterThanOrEqual(0);
    expect(result.callVegaPer1Pct).toBeGreaterThanOrEqual(0);
    expect(result.totalVegaPer1Pct).toBeGreaterThanOrEqual(0);
  });

  it('recovery is less than premium (theta cost)', () => {
    const result = calcHedge(baseParams);
    // Recovery is what you get selling EOD; should be less than entry premium
    expect(result.putRecovery).toBeLessThanOrEqual(result.putPremium);
    expect(result.callRecovery).toBeLessThanOrEqual(result.callPremium);
  });

  it('lower hedge delta = further OTM strikes = cheaper premiums', () => {
    const h2 = calcHedge({ ...baseParams, hedgeDelta: 2 as HedgeDelta });
    const h5 = calcHedge({ ...baseParams, hedgeDelta: 5 as HedgeDelta });
    // 2-delta is further OTM than 5-delta
    expect(h2.putStrikeSnapped).toBeLessThanOrEqual(h5.putStrikeSnapped);
    expect(h2.callStrikeSnapped).toBeGreaterThanOrEqual(h5.callStrikeSnapped);
    // Cheaper premiums for further OTM
    expect(h2.putPremium).toBeLessThanOrEqual(h5.putPremium);
    expect(h2.callPremium).toBeLessThanOrEqual(h5.callPremium);
  });
});
