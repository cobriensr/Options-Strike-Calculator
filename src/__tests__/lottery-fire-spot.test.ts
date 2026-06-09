/**
 * Unit tests for the shared LotteryFinder fire-spot helper.
 *
 * Regression guard: the moneyness FILTER (`isFireOtm`) and the row's
 * ITM/OTM BADGE (`fireSpot` -> `otmPct`) must classify against the SAME
 * spot. Before the fix the filter used `entry.spotAtFirst` while the
 * badge used `entry.spotAtTrigger ?? entry.spotAtFirst`, so a chain that
 * moved between its first and latest fire could be hidden by the OTM
 * filter while still showing an ITM badge (and vice-versa).
 */
import { describe, it, expect } from 'vitest';
import { fireSpot, isFireOtm } from '../components/LotteryFinder/fire-spot';
import type { LotteryFire } from '../components/LotteryFinder/types';

function makeFire(overrides: Partial<LotteryFire> = {}): LotteryFire {
  return {
    id: 1,
    date: '2026-05-08',
    triggerTimeCt: '2026-05-08T14:30:00Z',
    entryTimeCt: '2026-05-08T14:31:00Z',
    optionChainId: 'AAPL260508C00200000',
    underlyingSymbol: 'AAPL',
    optionType: 'C',
    strike: 200,
    expiry: '2026-05-08',
    dte: 0,
    score: 15,
    scoreTier: 'tier2',
    directionGated: false,
    forecastHighPeakPct: '40-60%',
    avgHoldMinutes: 160,
    tickerStats: null,
    fireCount: 1,
    firstFireTimeCt: '2026-05-08T14:30:00Z',
    trigger: {
      volToOiWindow: 1.5,
      volToOiCum: 2.2,
      iv: 0.35,
      delta: 0.25,
      askPct: 0.7,
      windowSize: 5,
      windowPrints: 50,
    },
    entry: {
      price: 0.85,
      openInterest: 5000,
      spotAtFirst: 198.5,
      spotAtTrigger: 198.5,
      alertSeq: 7,
      minutesSincePrevFire: 30,
    },
    tags: {
      flowQuad: 'call_ask',
      tod: 'PM',
      mode: 'A_intraday_0DTE',
      reload: false,
      cheapCallPm: true,
      burstRatioVsPrev: null,
      entryDropPctVsPrev: null,
    },
    macro: {
      mktTideNcp: null,
      mktTideNpp: null,
      mktTideDiff: null,
      mktTideOtmDiff: null,
      tickerCumNcpAtFire: null,
      tickerCumNppAtFire: null,
      spxFlowDiff: null,
      spyEtfDiff: null,
      qqqEtfDiff: null,
      zeroDteDiff: null,
      spxSpotGammaOi: null,
      spxSpotGammaVol: null,
      spxSpotCharmOi: null,
      spxSpotVannaOi: null,
      gexStrikeCallMinusPut: null,
      gexStrikeCallAskMinusBid: null,
      gexStrikePutAskMinusBid: null,
      gexStrikeActualStrike: null,
    },
    gex: {
      oneCvroflow: null,
      netPutDex: null,
      oneDexoflow: null,
      oneGexoflow: null,
      zcvr: null,
      zeroGamma: null,
      spot: null,
      capturedAt: null,
    },
    outcomes: {
      realizedTrail30_10Pct: null,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: null,
      peakCeilingPct: null,
      minutesToPeak: null,
      enrichedAt: null,
    },
    hoursToNextMacroEvent: null,
    rangePosAtTrigger: null,
    qualityAdjustedScore: 15,
    inversionQuintile: null,
    inversionBlend: null,
    inversionN21d: null,
    inversionN90d: null,
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

/**
 * Mirror of the BADGE's classification (LotteryRow.tsx `otmPct`): a
 * fire is OTM ⇔ signed distance-from-spot is positive, computed against
 * `fireSpot(fire)`. Used to assert filter and badge agree.
 */
function badgeSaysOtm(fire: LotteryFire): boolean | null {
  const spot = fireSpot(fire);
  if (spot == null || spot <= 0) return null;
  const raw = (fire.strike - spot) / spot;
  const signed = fire.optionType === 'C' ? raw : -raw;
  return signed > 0;
}

describe('fireSpot', () => {
  it('prefers spotAtTrigger when finite and positive', () => {
    const fire = makeFire({
      entry: {
        price: 0.85,
        openInterest: 5000,
        spotAtFirst: 198.5,
        spotAtTrigger: 201,
        alertSeq: 7,
        minutesSincePrevFire: 30,
      },
    });
    expect(fireSpot(fire)).toBe(201);
  });

  it('falls back to spotAtFirst when spotAtTrigger is null', () => {
    const fire = makeFire({
      entry: {
        price: 0.85,
        openInterest: 5000,
        spotAtFirst: 198.5,
        spotAtTrigger: null,
        alertSeq: 7,
        minutesSincePrevFire: 30,
      },
    });
    expect(fireSpot(fire)).toBe(198.5);
  });

  it('falls back to spotAtFirst when spotAtTrigger is non-positive', () => {
    const fire = makeFire({
      entry: {
        price: 0.85,
        openInterest: 5000,
        spotAtFirst: 198.5,
        spotAtTrigger: 0,
        alertSeq: 7,
        minutesSincePrevFire: 30,
      },
    });
    expect(fireSpot(fire)).toBe(198.5);
  });

  it('returns null when neither snapshot is finite', () => {
    const fire = makeFire({
      entry: {
        price: 0.85,
        openInterest: 5000,
        spotAtFirst: Number.NaN,
        spotAtTrigger: null,
        alertSeq: 7,
        minutesSincePrevFire: 30,
      },
    });
    expect(fireSpot(fire)).toBeNull();
  });
});

describe('isFireOtm', () => {
  it('classifies a call as OTM when strike > spot', () => {
    const fire = makeFire({ optionType: 'C', strike: 205 });
    expect(isFireOtm(fire)).toBe(true);
  });

  it('classifies a call as ITM when strike < spot', () => {
    const fire = makeFire({ optionType: 'C', strike: 195 });
    expect(isFireOtm(fire)).toBe(false);
  });

  it('classifies a put as OTM when strike < spot', () => {
    const fire = makeFire({ optionType: 'P', strike: 195 });
    expect(isFireOtm(fire)).toBe(true);
  });
});

describe('filter and badge agree (regression for straddling fire)', () => {
  it('call whose strike sits between spotAtFirst and spotAtTrigger', () => {
    // strike 200; first-fire spot 198.5 (strike > spotAtFirst => the
    // OLD filter said OTM); trigger spot 201 (strike < spotAtTrigger =>
    // the badge said ITM). The two disagreed. With the shared helper
    // both now resolve against spotAtTrigger and agree on ITM.
    const fire = makeFire({
      optionType: 'C',
      strike: 200,
      entry: {
        price: 0.85,
        openInterest: 5000,
        spotAtFirst: 198.5,
        spotAtTrigger: 201,
        alertSeq: 7,
        minutesSincePrevFire: 30,
      },
    });

    // Document the legacy disagreement the bug produced.
    const oldFilterSaidOtm = fire.strike > fire.entry.spotAtFirst; // true
    expect(oldFilterSaidOtm).toBe(true);
    expect(badgeSaysOtm(fire)).toBe(false); // badge: ITM

    // Fixed: filter now matches the badge.
    expect(isFireOtm(fire)).toBe(false);
    expect(isFireOtm(fire)).toBe(badgeSaysOtm(fire));
  });

  it('put whose strike sits between spotAtFirst and spotAtTrigger', () => {
    // strike 200; first-fire spot 201.5 (strike < spotAtFirst => OLD
    // filter said put-OTM); trigger spot 198 (strike > spotAtTrigger =>
    // badge said put-ITM). Shared helper resolves both to spotAtTrigger.
    const fire = makeFire({
      optionType: 'P',
      strike: 200,
      entry: {
        price: 0.85,
        openInterest: 5000,
        spotAtFirst: 201.5,
        spotAtTrigger: 198,
        alertSeq: 7,
        minutesSincePrevFire: 30,
      },
    });

    const oldFilterSaidOtm = fire.strike < fire.entry.spotAtFirst; // true
    expect(oldFilterSaidOtm).toBe(true);
    expect(badgeSaysOtm(fire)).toBe(false); // badge: ITM

    expect(isFireOtm(fire)).toBe(false);
    expect(isFireOtm(fire)).toBe(badgeSaysOtm(fire));
  });
});
