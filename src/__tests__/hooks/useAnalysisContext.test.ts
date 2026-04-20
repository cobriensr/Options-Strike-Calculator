import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAnalysisContext } from '../../hooks/useAnalysisContext';
import type { UseAnalysisContextParams } from '../../hooks/useAnalysisContext';
import type { CalculationResults } from '../../types';
import type { ComputedSignals } from '../../hooks/useComputedSignals';
import type { ChainResponse, ChainStrike } from '../../types/api';

// ============================================================
// HELPERS
// ============================================================

function makeParams(
  overrides: Partial<UseAnalysisContextParams> = {},
): UseAnalysisContextParams {
  return {
    selectedDate: '2026-03-24',
    timeHour: '10',
    timeMinute: '30',
    timeAmPm: 'AM',
    timezone: 'CT',
    results: {
      allDeltas: [
        {
          delta: 10,
          z: 1.28,
          putStrike: 5630,
          callStrike: 5770,
          putSnapped: 5630,
          callSnapped: 5770,
          putSpySnapped: 563,
          callSpySnapped: 577,
          spyPut: '563',
          spyCall: '577',
          putDistance: 70,
          callDistance: 70,
          putPct: '1.22%',
          callPct: '1.22%',
          putPremium: 1.85,
          callPremium: 1.72,
          putSigma: 0.2,
          callSigma: 0.18,
          basePutSigma: 0.19,
          baseCallSigma: 0.17,
          putActualDelta: 0.098,
          callActualDelta: 0.095,
          putGamma: 0.0012,
          callGamma: 0.0011,
          putTheta: -1500,
          callTheta: -1400,
          ivAccelMult: 1.05,
        },
      ],
      sigma: 0.15,
      T: 0.03,
      hoursRemaining: 7,
      spot: 5700,
      marketHours: 6.5,
    } as CalculationResults,
    dSpot: '570',
    dVix: '18.5',
    signals: {
      vix1d: 15,
      vix9d: 17,
      vvix: 90,
      sigmaSource: 'VIX1D',
      etHour: 11,
      etMinute: 30,
      regimeZone: 'GREEN',
      dowLabel: 'Tuesday',
      dowMultHL: 1.1,
      dowMultOC: 0.9,
      icCeiling: 8,
      putSpreadCeiling: 10,
      callSpreadCeiling: 10,
      moderateDelta: 12,
      conservativeDelta: 15,
      medianOcPct: 0.5,
      medianHlPct: 0.8,
      p90OcPct: 1.0,
      p90HlPct: 1.5,
      p90OcPts: 28.5,
      p90HlPts: 42.75,
      openingRangeAvailable: true,
      openingRangeHigh: 5720,
      openingRangeLow: 5680,
      openingRangePctConsumed: 45,
      openingRangeSignal: 'neutral',
      vixTermSignal: 'contango',
      vixTermShape: 'normal',
      vixTermShapeAdvice: null,
      clusterPutMult: 1.1,
      clusterCallMult: 0.9,
      rvIvRatio: 0.85,
      rvIvLabel: 'IV-rich',
      rvAnnualized: 14.2,
      spxOpen: 5695,
      spxHigh: 5720,
      spxLow: 5680,
      prevClose: 5690,
      overnightGap: 10,
      isEarlyClose: false,
      isEventDay: false,
      eventNames: [],
      dataNote: undefined,
    } as ComputedSignals,
    clusterMult: 1.0,
    historySnapshot: null,
    events: undefined,
    chain: null,
    ...overrides,
  };
}

function compute(overrides: Partial<UseAnalysisContextParams> = {}) {
  const params = makeParams(overrides);
  const { result } = renderHook(() => useAnalysisContext(params));
  return result.current;
}

// ============================================================
// HELPERS — chain data factories
// ============================================================

function makeChainStrike(overrides: Partial<ChainStrike> = {}): ChainStrike {
  return {
    strike: 5700,
    bid: 1.0,
    ask: 1.2,
    mid: 1.1,
    delta: 0.5,
    gamma: 0.001,
    theta: -1.0,
    vega: 0.5,
    iv: 0.2,
    volume: 1000,
    oi: 5000,
    itm: false,
    ...overrides,
  };
}

function makeChain(overrides: Partial<ChainResponse> = {}): ChainResponse {
  return {
    underlying: { symbol: 'SPX', price: 5700, prevClose: 5690 },
    expirationDate: '2026-03-24',
    daysToExpiration: 0,
    contractCount: 100,
    puts: [],
    calls: [],
    targetDeltas: {},
    asOf: '2026-03-24T15:00:00Z',
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('useAnalysisContext', () => {
  // ── 1. Basic construction ─────────────────────────────────
  it('returns expected fields with default params', () => {
    const ctx = compute();

    expect(ctx.entryTime).toBe('10:30 AM CT');
    expect(ctx.spx).toBe(5700);
    expect(ctx.spy).toBe(570);
    expect(ctx.vix).toBe(18.5);
    expect(ctx.selectedDate).toBe('2026-03-24');
    expect(ctx.sigma).toBe(0.15);
    expect(ctx.T).toBe(0.03);
    expect(ctx.hoursRemaining).toBe(7);
    expect(ctx.regimeZone).toBe('GREEN');
    expect(ctx.clusterMult).toBe(1.0);
    expect(ctx.dowLabel).toBe('Tuesday');
  });

  // ── 2. Entry time formatting ──────────────────────────────
  it('formats entryTime as "HH:MM AMPM TZ"', () => {
    const ctx = compute({
      timeHour: '2',
      timeMinute: '05',
      timeAmPm: 'PM',
      timezone: 'ET',
    });
    expect(ctx.entryTime).toBe('2:05 PM ET');
  });

  // ── 3. SPY/VIX parsing — non-numeric returns undefined ────
  it('returns undefined spy when dSpot is non-numeric', () => {
    const ctx = compute({ dSpot: 'abc' });
    expect(ctx.spy).toBeUndefined();
  });

  it('returns undefined vix when dVix is non-numeric', () => {
    const ctx = compute({ dVix: '' });
    expect(ctx.vix).toBeUndefined();
  });

  it('returns undefined spy when dSpot is "0"', () => {
    // Number.parseFloat('0') returns 0, which is falsy => || undefined
    const ctx = compute({ dSpot: '0' });
    expect(ctx.spy).toBeUndefined();
  });

  // ── 4. RV/IV ratio formatting ─────────────────────────────
  it('formats rvIvRatio when present', () => {
    const ctx = compute();
    expect(ctx.rvIvRatio).toBe('0.85 (IV-rich)');
  });

  it('returns undefined rvIvRatio when signals.rvIvRatio is null', () => {
    const ctx = compute({
      signals: {
        ...makeParams().signals,
        rvIvRatio: null,
        rvIvLabel: null,
      },
    });
    expect(ctx.rvIvRatio).toBeUndefined();
  });

  // ── 5. Overnight gap conversion ───────────────────────────
  it('converts overnightGap number to string', () => {
    const ctx = compute();
    expect(ctx.overnightGap).toBe('10');
  });

  it('returns undefined overnightGap when signals.overnightGap is null', () => {
    const ctx = compute({
      signals: {
        ...makeParams().signals,
        overnightGap: null,
      },
    });
    expect(ctx.overnightGap).toBeUndefined();
  });

  // ── 6. ivAccelMult extraction ─────────────────────────────
  it('extracts ivAccelMult from first non-error delta row', () => {
    const ctx = compute();
    expect(ctx.ivAccelMult).toBe(1.05);
  });

  it('extracts ivAccelMult from second row when first is error', () => {
    const ctx = compute({
      results: {
        ...makeParams().results!,
        allDeltas: [
          { delta: 5, error: 'OTM too far' },
          {
            delta: 10,
            z: 1.28,
            putStrike: 5630,
            callStrike: 5770,
            putSnapped: 5630,
            callSnapped: 5770,
            putSpySnapped: 563,
            callSpySnapped: 577,
            spyPut: '563',
            spyCall: '577',
            putDistance: 70,
            callDistance: 70,
            putPct: '1.22%',
            callPct: '1.22%',
            putPremium: 1.85,
            callPremium: 1.72,
            putSigma: 0.2,
            callSigma: 0.18,
            basePutSigma: 0.19,
            baseCallSigma: 0.17,
            putActualDelta: 0.098,
            callActualDelta: 0.095,
            putGamma: 0.0012,
            callGamma: 0.0011,
            putTheta: -1500,
            callTheta: -1400,
            ivAccelMult: 1.12,
          },
        ],
      } as CalculationResults,
    });
    expect(ctx.ivAccelMult).toBe(1.12);
  });

  // ── 7. ivAccelMult with all error rows ────────────────────
  it('returns undefined ivAccelMult when all rows are errors', () => {
    const ctx = compute({
      results: {
        ...makeParams().results!,
        allDeltas: [
          { delta: 5, error: 'OTM too far' },
          { delta: 10, error: 'Strike not found' },
        ],
      } as CalculationResults,
    });
    expect(ctx.ivAccelMult).toBeUndefined();
  });

  // ── 8. isBacktest flag ────────────────────────────────────
  it('sets isBacktest false when historySnapshot is null', () => {
    const ctx = compute({ historySnapshot: null });
    expect(ctx.isBacktest).toBe(false);
  });

  it('sets isBacktest true when historySnapshot is non-null', () => {
    const ctx = compute({
      historySnapshot: {
        spot: 5700,
        spy: 570,
      } as UseAnalysisContextParams['historySnapshot'],
    });
    expect(ctx.isBacktest).toBe(true);
  });

  // ── 9. Events filtering ───────────────────────────────────
  it('filters events by severity and matching date', () => {
    const ctx = compute({
      events: [
        {
          date: '2026-03-24',
          event: 'FOMC',
          description: 'Rate decision',
          time: '14:00',
          severity: 'high' as const,
          source: 'fred' as const,
        },
        {
          date: '2026-03-24',
          event: 'GDP',
          description: 'GDP report',
          time: '08:30',
          severity: 'medium' as const,
          source: 'fred' as const,
        },
        {
          date: '2026-03-25',
          event: 'PCE',
          description: 'Inflation',
          time: '08:30',
          severity: 'high' as const,
          source: 'fred' as const,
        },
      ],
    });
    expect(ctx.events).toHaveLength(2);
    expect(ctx.events).toEqual([
      { event: 'FOMC', time: '14:00', severity: 'high' },
      { event: 'GDP', time: '08:30', severity: 'medium' },
    ]);
  });

  it('returns empty array when events is undefined', () => {
    const ctx = compute({ events: undefined });
    expect(ctx.events).toEqual([]);
  });

  // ── 10. topOIStrikes ──────────────────────────────────────
  it('returns undefined topOIStrikes when chain is null', () => {
    const ctx = compute({ chain: null });
    expect(ctx.topOIStrikes).toBeUndefined();
  });

  it('computes topOIStrikes when chain has puts and calls', () => {
    const chain = makeChain({
      puts: [
        makeChainStrike({
          strike: 5650,
          delta: -0.25,
          oi: 8000,
        }),
        makeChainStrike({
          strike: 5700,
          delta: -0.5,
          oi: 12000,
        }),
      ],
      calls: [
        makeChainStrike({
          strike: 5700,
          delta: 0.5,
          oi: 10000,
        }),
        makeChainStrike({
          strike: 5750,
          delta: 0.25,
          oi: 6000,
        }),
      ],
    });
    const ctx = compute({ chain });
    expect(ctx.topOIStrikes).toBeDefined();
    expect(ctx.topOIStrikes!.length).toBeGreaterThan(0);

    // 5700 has both put (12000) and call (10000) OI
    const strike5700 = ctx.topOIStrikes!.find((s) => s.strike === 5700);
    expect(strike5700).toBeDefined();
    expect(strike5700!.putOI).toBe(12000);
    expect(strike5700!.callOI).toBe(10000);
    expect(strike5700!.totalOI).toBe(22000);
  });

  it('returns topOIStrikes from calls only when puts is empty', () => {
    const chain = makeChain({
      puts: [],
      calls: [makeChainStrike({ strike: 5700, delta: 0.5, oi: 10000 })],
    });
    // Empty arrays are truthy, so getTopOIStrikes is called and returns
    // call-only strikes.
    const ctx = compute({ chain });
    expect(ctx.topOIStrikes).toBeDefined();
    expect(ctx.topOIStrikes).toHaveLength(1);
    const first = ctx.topOIStrikes!.at(0);
    expect(first?.callOI).toBe(10000);
    expect(first?.putOI).toBe(0);
  });

  // ── 11. skewMetrics computation ───────────────────────────
  it('computes skewMetrics when chain has puts and calls with IVs', () => {
    const chain = makeChain({
      puts: [
        makeChainStrike({
          strike: 5600,
          delta: -0.25,
          iv: 0.22,
        }),
        makeChainStrike({
          strike: 5650,
          delta: -0.35,
          iv: 0.21,
        }),
      ],
      calls: [
        makeChainStrike({
          strike: 5700,
          delta: 0.5,
          iv: 0.18,
        }),
        makeChainStrike({
          strike: 5750,
          delta: 0.25,
          iv: 0.2,
        }),
      ],
    });
    const ctx = compute({ chain });
    expect(ctx.skewMetrics).toBeDefined();

    const sm = ctx.skewMetrics!;
    // ATM = call closest to 0.5 delta = 5700 with iv 0.18
    expect(sm.atmIV).toBe(18);
    // put25d = put closest to |delta| = 0.25 => strike 5600, iv 0.22
    expect(sm.put25dIV).toBe(22);
    // call25d = call closest to delta = 0.25 => strike 5750, iv 0.20
    expect(sm.call25dIV).toBe(20);
    // putSkew25d = 22 - 18 = 4
    expect(sm.putSkew25d).toBe(4);
    // callSkew25d = 20 - 18 = 2
    expect(sm.callSkew25d).toBe(2);
    // skewRatio = |4| / |2| = 2
    expect(sm.skewRatio).toBe(2);
  });

  it('returns undefined skewMetrics when IV is 0', () => {
    const chain = makeChain({
      puts: [makeChainStrike({ strike: 5600, delta: -0.25, iv: 0 })],
      calls: [
        makeChainStrike({ strike: 5700, delta: 0.5, iv: 0 }),
        makeChainStrike({ strike: 5750, delta: 0.25, iv: 0 }),
      ],
    });
    const ctx = compute({ chain });
    expect(ctx.skewMetrics).toBeUndefined();
  });

  // ── 12. skewMetrics undefined when chain is null ──────────
  it('returns undefined skewMetrics when chain is null', () => {
    const ctx = compute({ chain: null });
    expect(ctx.skewMetrics).toBeUndefined();
  });

  it('returns undefined skewMetrics when chain puts are empty', () => {
    const chain = makeChain({
      puts: [],
      calls: [makeChainStrike({ strike: 5700, delta: 0.5, iv: 0.2 })],
    });
    const ctx = compute({ chain });
    expect(ctx.skewMetrics).toBeUndefined();
  });

  // ── 13. null results ──────────────────────────────────────
  it('returns undefined for spx/sigma/T when results is null', () => {
    const ctx = compute({ results: null });
    expect(ctx.spx).toBeUndefined();
    expect(ctx.sigma).toBeUndefined();
    expect(ctx.T).toBeUndefined();
    expect(ctx.hoursRemaining).toBeUndefined();
    expect(ctx.ivAccelMult).toBeUndefined();
  });

  // ── Signal passthrough fields ─────────────────────────────
  it('passes through vix signal fields', () => {
    const ctx = compute();
    expect(ctx.vix1d).toBe(15);
    expect(ctx.vix9d).toBe(17);
    expect(ctx.vvix).toBe(90);
    expect(ctx.sigmaSource).toBe('VIX1D');
  });

  it('passes through ceiling and regime fields', () => {
    const ctx = compute();
    expect(ctx.deltaCeiling).toBe(8);
    expect(ctx.putSpreadCeiling).toBe(10);
    expect(ctx.callSpreadCeiling).toBe(10);
  });

  it('passes through opening range fields', () => {
    const ctx = compute();
    expect(ctx.openingRangeSignal).toBe('neutral');
    expect(ctx.openingRangeAvailable).toBe(true);
    expect(ctx.openingRangeHigh).toBe(5720);
    expect(ctx.openingRangeLow).toBe(5680);
    expect(ctx.openingRangePctConsumed).toBe(45);
  });

  it('passes through term structure fields', () => {
    const ctx = compute();
    expect(ctx.vixTermSignal).toBe('contango');
    expect(ctx.vixTermShape).toBe('normal');
  });

  it('passes through cluster multiplier fields', () => {
    const ctx = compute();
    expect(ctx.clusterPutMult).toBe(1.1);
    expect(ctx.clusterCallMult).toBe(0.9);
  });

  it('passes through prevClose', () => {
    const ctx = compute();
    expect(ctx.prevClose).toBe(5690);
  });

  it('converts null signal fields to undefined', () => {
    const ctx = compute({
      signals: {
        ...makeParams().signals,
        regimeZone: null,
        dowLabel: null,
        icCeiling: null,
        openingRangeSignal: null,
        vixTermSignal: null,
      },
    });
    expect(ctx.regimeZone).toBeUndefined();
    expect(ctx.dowLabel).toBeUndefined();
    expect(ctx.deltaCeiling).toBeUndefined();
    expect(ctx.openingRangeSignal).toBeUndefined();
    expect(ctx.vixTermSignal).toBeUndefined();
  });

  // ── 14. targetDeltaStrikes ────────────────────────────────
  it('returns undefined targetDeltaStrikes when chain is null', () => {
    const ctx = compute({ chain: null });
    expect(ctx.targetDeltaStrikes).toBeUndefined();
  });

  it('populates targetDeltaStrikes when chain has puts and calls covering all rungs', () => {
    // Provide at least one put and one call per target rung (5/8/10/12/15/20/25Δ).
    const puts: ChainStrike[] = [
      makeChainStrike({
        strike: 7020,
        delta: -0.05,
        bid: 0.4,
        ask: 0.5,
        iv: 0.25,
        oi: 1200,
      }),
      makeChainStrike({
        strike: 7035,
        delta: -0.08,
        bid: 0.65,
        ask: 0.8,
        iv: 0.24,
        oi: 900,
      }),
      makeChainStrike({
        strike: 7045,
        delta: -0.1,
        bid: 0.9,
        ask: 1.0,
        iv: 0.23,
        oi: 1500,
      }),
      makeChainStrike({
        strike: 7055,
        delta: -0.12,
        bid: 1.15,
        ask: 1.25,
        iv: 0.23,
        oi: 800,
      }),
      makeChainStrike({
        strike: 7070,
        delta: -0.15,
        bid: 1.5,
        ask: 1.6,
        iv: 0.22,
        oi: 700,
      }),
      makeChainStrike({
        strike: 7090,
        delta: -0.2,
        bid: 2.1,
        ask: 2.3,
        iv: 0.21,
        oi: 600,
      }),
      makeChainStrike({
        strike: 7110,
        delta: -0.25,
        bid: 2.8,
        ask: 3.0,
        iv: 0.2,
        oi: 400,
      }),
    ];
    const calls: ChainStrike[] = [
      makeChainStrike({
        strike: 7215,
        delta: 0.05,
        bid: 0.35,
        ask: 0.4,
        iv: 0.19,
        oi: 300,
      }),
      makeChainStrike({
        strike: 7200,
        delta: 0.08,
        bid: 0.55,
        ask: 0.65,
        iv: 0.19,
        oi: 500,
      }),
      makeChainStrike({
        strike: 7190,
        delta: 0.1,
        bid: 0.8,
        ask: 0.9,
        iv: 0.18,
        oi: 700,
      }),
      makeChainStrike({
        strike: 7180,
        delta: 0.12,
        bid: 1.05,
        ask: 1.15,
        iv: 0.18,
        oi: 1100,
      }),
      makeChainStrike({
        strike: 7165,
        delta: 0.15,
        bid: 1.4,
        ask: 1.55,
        iv: 0.17,
        oi: 900,
      }),
      makeChainStrike({
        strike: 7145,
        delta: 0.2,
        bid: 2.0,
        ask: 2.2,
        iv: 0.17,
        oi: 650,
      }),
      makeChainStrike({
        strike: 7125,
        delta: 0.25,
        bid: 2.7,
        ask: 2.95,
        iv: 0.16,
        oi: 500,
      }),
    ];
    const chain = makeChain({ puts, calls });
    const ctx = compute({ chain });
    expect(ctx.targetDeltaStrikes).toBeDefined();

    const rungs = ctx.targetDeltaStrikes!;
    expect(rungs.preferredDelta).toBe(12);
    expect(rungs.floorDelta).toBe(10);
    expect(rungs.puts).toHaveLength(7);
    expect(rungs.calls).toHaveLength(7);

    // Each entry has all required fields.
    for (const entry of [...rungs.puts, ...rungs.calls]) {
      expect(entry).toMatchObject({
        delta: expect.any(Number),
        strike: expect.any(Number),
        bid: expect.any(Number),
        ask: expect.any(Number),
        iv: expect.any(Number),
        oi: expect.any(Number),
      });
      // Delta is stored as absolute decimal (0.05-0.25 range).
      expect(entry.delta).toBeGreaterThan(0);
      expect(entry.delta).toBeLessThanOrEqual(0.3);
    }

    // Put at 12Δ should map to strike 7055 (|-0.12| closest to 0.12).
    const put12 = rungs.puts.find((p) => p.strike === 7055);
    expect(put12).toBeDefined();
    expect(put12!.delta).toBeCloseTo(0.12, 5);
    expect(put12!.iv).toBeCloseTo(0.23, 5);
  });

  it('maps 12Δ rung to nearest-|delta| strike (sparse chain)', () => {
    // Puts with |delta| [0.04, 0.10, 0.13, 0.20]:
    // For target 0.12 → nearest is 0.13 (distance 0.01), not 0.10 (0.02) or 0.20 (0.08).
    const puts: ChainStrike[] = [
      makeChainStrike({ strike: 7000, delta: -0.04, iv: 0.25 }),
      makeChainStrike({ strike: 7040, delta: -0.1, iv: 0.24 }),
      makeChainStrike({ strike: 7060, delta: -0.13, iv: 0.23 }),
      makeChainStrike({ strike: 7100, delta: -0.2, iv: 0.22 }),
    ];
    const calls: ChainStrike[] = [
      makeChainStrike({ strike: 7200, delta: 0.12, iv: 0.18 }),
    ];
    const chain = makeChain({ puts, calls });
    const ctx = compute({ chain });

    const rungs = ctx.targetDeltaStrikes!;
    const put12 = rungs.puts.find((p) => Math.abs(p.delta - 0.13) < 1e-6);
    expect(put12).toBeDefined();
    expect(put12!.strike).toBe(7060);
  });

  it('dedupes when two rungs collapse to the same strike', () => {
    // Only ONE put strike exists — every rung collapses onto it.
    // The surviving rung should be the one whose target is closest to
    // the strike's actual |delta| (0.12 target ↔ 0.12 actual = distance 0).
    const puts: ChainStrike[] = [
      makeChainStrike({ strike: 7055, delta: -0.12, iv: 0.23 }),
    ];
    const calls: ChainStrike[] = [];
    const chain = makeChain({ puts, calls });
    const ctx = compute({ chain });

    const rungs = ctx.targetDeltaStrikes!;
    // Only one put entry after dedupe — the 0.12 delta strike.
    expect(rungs.puts).toHaveLength(1);
    const firstPut = rungs.puts.at(0)!;
    expect(firstPut.strike).toBe(7055);
    expect(firstPut.delta).toBeCloseTo(0.12, 5);
  });

  // ── skewMetrics edge: callSkew25d === 0 → skewRatio = 0 ──
  it('returns skewRatio 0 when callSkew25d is 0', () => {
    // When call25d IV equals ATM IV, callSkew25d = 0 → division avoided
    const chain = makeChain({
      puts: [makeChainStrike({ strike: 5600, delta: -0.25, iv: 0.22 })],
      calls: [
        // ATM and 25-delta call both have same IV
        makeChainStrike({ strike: 5700, delta: 0.5, iv: 0.2 }),
        makeChainStrike({ strike: 5750, delta: 0.25, iv: 0.2 }),
      ],
    });
    const ctx = compute({ chain });
    expect(ctx.skewMetrics).toBeDefined();
    expect(ctx.skewMetrics!.callSkew25d).toBe(0);
    expect(ctx.skewMetrics!.skewRatio).toBe(0);
  });
});
