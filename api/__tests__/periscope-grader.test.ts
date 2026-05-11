/**
 * Deterministic grader tests — Phase 2 of
 * docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md.
 *
 * Table-driven: each it() locks one grading dimension's behavior with
 * minimal fixture data. The full Grade struct is asserted on a couple
 * end-to-end tests; individual rule tests assert only the field they
 * cover so a change to one rule doesn't ripple through every test.
 */

import { describe, it, expect } from 'vitest';
import {
  gradePlaybook,
  type GraderPlaybook,
  type GradePlaybookArgs,
} from '../_lib/periscope-grader.js';
import type { Candle } from '../_lib/periscope-grades-types.js';
import { GRADER_VERSION } from '../_lib/periscope-grades-types.js';

// ─── Fixture helpers ───────────────────────────────────────────────

function ts(hourCT: number, minute: number): Date {
  // 2026-05-08 (Friday). CT = UTC-5 in summer (CDT). So 08:30 CT =
  // 13:30 UTC.
  const utcHour = hourCT + 5;
  return new Date(Date.UTC(2026, 4, 8, utcHour, minute, 0));
}

function candle(args: {
  hourCT: number;
  minute: number;
  open: number;
  high?: number;
  low?: number;
  close: number;
}): Candle {
  return {
    ts: ts(args.hourCT, args.minute),
    open: args.open,
    high: args.high ?? Math.max(args.open, args.close),
    low: args.low ?? Math.min(args.open, args.close),
    close: args.close,
  };
}

function defaultPlaybook(
  overrides: Partial<GraderPlaybook> = {},
): GraderPlaybook {
  return {
    spot: 5800,
    cone: { lower: 5780, upper: 5820 },
    longTrigger: 5810,
    shortTrigger: 5790,
    regime: 'drift-and-cap',
    bias: 'long',
    recommended: [],
    avoid: [],
    gammaFloor: 5780,
    gammaCeiling: 5820,
    magnet: 5800,
    charmZero: 5800,
    confidence: 'medium',
    charmDriftDirection: null,
    ...overrides,
  };
}

function defaultArgs(
  overrides: Partial<GradePlaybookArgs> = {},
): GradePlaybookArgs {
  return {
    periscopeAnalysisId: 1,
    tradingDate: '2026-05-08',
    slotCapturedAt: ts(9, 0),
    mode: 'intraday',
    playbook: defaultPlaybook(),
    spxCandles: [],
    esCandles: [],
    nqCandles: [],
    spxPriorCandles: [],
    eodCloseTs: ts(15, 0),
    ...overrides,
  };
}

function flatCandlesAt(
  price: number,
  hourCT: number,
  minutes: number[],
): Candle[] {
  return minutes.map((m) =>
    candle({ hourCT, minute: m, open: price, close: price }),
  );
}

// ─── Bias ──────────────────────────────────────────────────────────

describe('gradePlaybook: bias', () => {
  it('grades long bias correct when EOD return positive', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ bias: 'long' }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5830, close: 5830 }),
        ],
      }),
    );
    expect(grade.biasCall).toBe('long');
    expect(grade.biasCorrect).toBe(true);
    expect(grade.biasObservedReturn).toBeCloseTo((5830 - 5800) / 5800, 6);
  });

  it('grades long bias incorrect when EOD return negative', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ bias: 'long' }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5770, close: 5770 }),
        ],
      }),
    );
    expect(grade.biasCorrect).toBe(false);
  });

  it('grades two-sided bias correct when |return| < 0.2%', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ bias: 'two-sided' }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5800, close: 5805 }),
        ],
      }),
    );
    expect(grade.biasCorrect).toBe(true);
  });

  it('grades two-sided bias incorrect on big directional moves', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ bias: 'two-sided' }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5850, close: 5850 }),
        ],
      }),
    );
    expect(grade.biasCorrect).toBe(false);
  });
});

// ─── Cone held ─────────────────────────────────────────────────────

describe('gradePlaybook: cone held', () => {
  it('returns true when EOD close lands inside the cone', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          // Intraday wick breaches the cone (high=5825), but settle
          // is inside (5810) — the 0DTE breakeven cone is a *settle*
          // bet, not an intraday-touch bet.
          candle({
            hourCT: 9,
            minute: 30,
            open: 5815,
            high: 5825,
            low: 5810,
            close: 5818,
          }),
          candle({ hourCT: 15, minute: 0, open: 5810, close: 5810 }),
        ],
      }),
    );
    expect(grade.coneHeld).toBe(true);
  });

  it('returns false when EOD close settles outside the cone', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5825, close: 5830 }),
        ],
      }),
    );
    expect(grade.coneHeld).toBe(false);
  });

  it('returns null when cone is absent from playbook', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ cone: null }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5810, close: 5810 }),
        ],
      }),
    );
    expect(grade.coneHeld).toBeNull();
  });
});

// ─── Gamma floor / ceiling held ────────────────────────────────────

describe('gradePlaybook: gamma levels', () => {
  it('floor held when all bar lows stay strictly above', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ gammaFloor: 5780 }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, low: 5790, close: 5795 }),
          candle({ hourCT: 9, minute: 30, open: 5795, low: 5785, close: 5790 }),
        ],
      }),
    );
    expect(grade.gammaFloorHeld).toBe(true);
  });

  it('floor not held when any bar low touches or breaks', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ gammaFloor: 5780 }),
        spxCandles: [
          candle({ hourCT: 9, minute: 30, open: 5795, low: 5775, close: 5790 }),
        ],
      }),
    );
    expect(grade.gammaFloorHeld).toBe(false);
  });

  it('ceiling held when all bar highs stay strictly below', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ gammaCeiling: 5820 }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5805, high: 5815, close: 5810 }),
        ],
      }),
    );
    expect(grade.gammaCeilingHeld).toBe(true);
  });
});

// ─── Trigger fires ─────────────────────────────────────────────────

describe('gradePlaybook: trigger fires', () => {
  it('long trigger fires when 5-min bar closes ≥ trigger after touch', () => {
    // Build 5 consecutive 1m bars where each closes ≥ trigger (5810).
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5805, high: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 6, open: 5810, close: 5811 }),
      candle({ hourCT: 9, minute: 7, open: 5811, close: 5812 }),
      candle({ hourCT: 9, minute: 8, open: 5812, close: 5811 }),
      candle({ hourCT: 9, minute: 9, open: 5811, close: 5812 }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ longTrigger: 5810 }),
        spxCandles: spx,
      }),
    );
    expect(grade.longFired).toBe(true);
    expect(grade.longFiredAt).not.toBeNull();
  });

  it('long trigger does NOT fire on a single wick touch with close below', () => {
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5805, high: 5811, close: 5806 }),
      candle({ hourCT: 9, minute: 6, open: 5806, close: 5805 }),
      candle({ hourCT: 9, minute: 7, open: 5805, close: 5806 }),
      candle({ hourCT: 9, minute: 8, open: 5806, close: 5805 }),
      candle({ hourCT: 9, minute: 9, open: 5805, close: 5808 }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ longTrigger: 5810 }),
        spxCandles: spx,
      }),
    );
    expect(grade.longFired).toBe(false);
  });

  it('short trigger fires when 5-min close ≤ trigger after touch', () => {
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5795, low: 5789, close: 5790 }),
      candle({ hourCT: 9, minute: 6, open: 5790, close: 5789 }),
      candle({ hourCT: 9, minute: 7, open: 5789, close: 5788 }),
      candle({ hourCT: 9, minute: 8, open: 5788, close: 5789 }),
      candle({ hourCT: 9, minute: 9, open: 5789, close: 5790 }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ shortTrigger: 5790 }),
        spxCandles: spx,
      }),
    );
    expect(grade.shortFired).toBe(true);
  });

  it('returns no fire when trigger is null', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({ longTrigger: null }),
        spxCandles: flatCandlesAt(5810, 9, [0, 5, 6, 7, 8, 9]),
      }),
    );
    expect(grade.longFired).toBe(false);
    expect(grade.longFiredAt).toBeNull();
  });
});

// ─── Trade simulation ──────────────────────────────────────────────

describe('gradePlaybook: trade sims', () => {
  it('long sim hits target → exit_reason=target, positive pnl', () => {
    // Long fires at minute 8 (close 5810); target 5820 (ceiling).
    // Bar at minute 30 prints high 5825 → target hit.
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5805, high: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 6, open: 5810, close: 5811 }),
      candle({ hourCT: 9, minute: 7, open: 5811, close: 5811 }),
      candle({ hourCT: 9, minute: 8, open: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 9, open: 5810, close: 5812 }),
      candle({ hourCT: 9, minute: 30, open: 5815, high: 5825, close: 5820 }),
      candle({ hourCT: 15, minute: 0, open: 5820, close: 5825 }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          longTrigger: 5810,
          shortTrigger: 5790,
          gammaCeiling: 5820,
          gammaFloor: 5780,
        }),
        spxCandles: spx,
      }),
    );
    expect(grade.longFired).toBe(true);
    const spxSim = grade.tradeSims.find(
      (s) => s.asset === 'SPX' && s.side === 'long',
    );
    expect(spxSim).toBeDefined();
    expect(spxSim!.exitReason).toBe('target');
    expect(spxSim!.pnlPct).toBeGreaterThan(0);
  });

  it('long sim hits stop → exit_reason=stop, negative pnl', () => {
    // Fire first (5 consecutive 1m bars closing >= trigger 5810), then
    // a later bar prints low <= stop (5790 = shortTrigger) for the
    // stop hit.
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5805, high: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 6, open: 5810, close: 5811 }),
      candle({ hourCT: 9, minute: 7, open: 5811, close: 5812 }),
      candle({ hourCT: 9, minute: 8, open: 5812, close: 5811 }),
      candle({ hourCT: 9, minute: 9, open: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 30, open: 5800, low: 5785, close: 5788 }),
      candle({ hourCT: 15, minute: 0, open: 5788, close: 5795 }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          longTrigger: 5810,
          shortTrigger: 5790,
          gammaCeiling: 5820,
          gammaFloor: 5780,
        }),
        spxCandles: spx,
      }),
    );
    const spxSim = grade.tradeSims.find(
      (s) => s.asset === 'SPX' && s.side === 'long',
    );
    expect(spxSim).toBeDefined();
    expect(spxSim!.exitReason).toBe('stop');
    expect(spxSim!.pnlPct).toBeLessThan(0);
  });

  it('does NOT exit on the entry bar itself (entry happens at bar close, intra-bar high/low already in past)', () => {
    // Fire at min 9 close=5810. Same bar has an intra-bar low of 5780
    // and high of 5811. Without the entry-bar skip, the loop would
    // detect a stop hit at 5780 immediately (durationMin=0). With the
    // skip, the trade survives the entry bar and proceeds to next.
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5805, high: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 6, open: 5810, close: 5811 }),
      candle({ hourCT: 9, minute: 7, open: 5811, close: 5812 }),
      candle({ hourCT: 9, minute: 8, open: 5812, close: 5811 }),
      // Entry bar: trigger fires here at close=5810, but bar low=5780
      // would have been a stop hit if entry bar were scanned.
      candle({ hourCT: 9, minute: 9, open: 5810, low: 5780, close: 5810 }),
      candle({ hourCT: 9, minute: 10, open: 5810, close: 5815 }),
      candle({ hourCT: 15, minute: 0, open: 5815, close: 5815 }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          longTrigger: 5810,
          shortTrigger: 5790,
          gammaCeiling: 5820,
          gammaFloor: 5780,
        }),
        spxCandles: spx,
      }),
    );
    const spxSim = grade.tradeSims.find((s) => s.asset === 'SPX' && s.side === 'long');
    expect(spxSim).toBeDefined();
    expect(spxSim!.exitReason).toBe('eod');
    expect(spxSim!.durationMin).toBeGreaterThan(0);
  });

  it('long sim times out at EOD → exit_reason=eod', () => {
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5805, high: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 6, open: 5810, close: 5811 }),
      candle({ hourCT: 9, minute: 7, open: 5811, close: 5811 }),
      candle({ hourCT: 9, minute: 8, open: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 9, open: 5810, close: 5812 }),
      candle({ hourCT: 10, minute: 0, open: 5812, close: 5815 }),
      candle({ hourCT: 11, minute: 0, open: 5815, close: 5813 }),
      candle({ hourCT: 12, minute: 0, open: 5813, close: 5811 }),
      candle({ hourCT: 13, minute: 0, open: 5811, close: 5812 }),
      candle({ hourCT: 14, minute: 0, open: 5812, close: 5813 }),
      candle({ hourCT: 15, minute: 0, open: 5813, close: 5814 }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          longTrigger: 5810,
          shortTrigger: 5790,
          gammaCeiling: 5820,
          gammaFloor: 5780,
        }),
        spxCandles: spx,
      }),
    );
    const spxSim = grade.tradeSims.find(
      (s) => s.asset === 'SPX' && s.side === 'long',
    );
    expect(spxSim?.exitReason).toBe('eod');
  });

  it('records ES + NQ sims alongside SPX when their candles exist', () => {
    const spx = [
      candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
      candle({ hourCT: 9, minute: 5, open: 5805, high: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 6, open: 5810, close: 5811 }),
      candle({ hourCT: 9, minute: 7, open: 5811, close: 5811 }),
      candle({ hourCT: 9, minute: 8, open: 5811, close: 5810 }),
      candle({ hourCT: 9, minute: 9, open: 5810, close: 5812 }),
      candle({ hourCT: 9, minute: 30, open: 5815, high: 5825, close: 5820 }),
      candle({ hourCT: 15, minute: 0, open: 5820, close: 5825 }),
    ];
    // ES ratio ~ 1.001 to SPX; NQ ratio ~ 3.5x SPX (Nasdaq numerics).
    const es = spx.map((c) => ({
      ...c,
      open: c.open * 1.001,
      high: c.high * 1.001,
      low: c.low * 1.001,
      close: c.close * 1.001,
    }));
    const nq = spx.map((c) => ({
      ...c,
      open: c.open * 3.5,
      high: c.high * 3.5,
      low: c.low * 3.5,
      close: c.close * 3.5,
    }));
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          longTrigger: 5810,
          shortTrigger: 5790,
          gammaCeiling: 5820,
          gammaFloor: 5780,
        }),
        spxCandles: spx,
        esCandles: es,
        nqCandles: nq,
      }),
    );
    const sims = grade.tradeSims;
    expect(sims.some((s) => s.asset === 'ES' && s.side === 'long')).toBe(true);
    expect(sims.some((s) => s.asset === 'NQ' && s.side === 'long')).toBe(true);
  });
});

// ─── IC blown ──────────────────────────────────────────────────────

describe('gradePlaybook: IC blown at EOD', () => {
  it('blown when EOD close above ceiling', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          gammaFloor: 5780,
          gammaCeiling: 5820,
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5825, close: 5825 }),
        ],
      }),
    );
    expect(grade.icBlownAtEod).toBe(true);
  });

  it('blown when EOD close below floor', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          gammaFloor: 5780,
          gammaCeiling: 5820,
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5770, close: 5770 }),
        ],
      }),
    );
    expect(grade.icBlownAtEod).toBe(true);
  });

  it('safe when EOD close inside [floor, ceiling]', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          gammaFloor: 5780,
          gammaCeiling: 5820,
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5810, close: 5810 }),
        ],
      }),
    );
    expect(grade.icBlownAtEod).toBe(false);
  });
});

// ─── Structures ────────────────────────────────────────────────────

describe('gradePlaybook: structures', () => {
  it('debit_put_spread correct when EOD return ≤ -1 ATR', () => {
    // Build prior candles with avg range 0.5pt → ATR ~= 0.5/5800 ≈ 0.0001
    const prior: Candle[] = [
      candle({
        hourCT: 8,
        minute: 30,
        open: 5800,
        high: 5800.5,
        low: 5800,
        close: 5800,
      }),
      candle({
        hourCT: 8,
        minute: 31,
        open: 5800,
        high: 5800.5,
        low: 5800,
        close: 5800,
      }),
    ];
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          bias: 'short',
          recommended: ['debit_put_spread'],
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5790, close: 5790 }),
        ],
        spxPriorCandles: prior,
      }),
    );
    expect(grade.recommendedStructuresCorrect['debit_put_spread']).toBe(true);
  });

  it('iron_condor correct when spot ends inside floor/ceiling', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          recommended: ['iron_condor'],
          gammaFloor: 5780,
          gammaCeiling: 5820,
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5810, close: 5810 }),
        ],
      }),
    );
    expect(grade.recommendedStructuresCorrect['iron_condor']).toBe(true);
  });

  it('iron_condor incorrect when spot blows out', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          recommended: ['iron_condor'],
          gammaFloor: 5780,
          gammaCeiling: 5820,
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5830, close: 5830 }),
        ],
      }),
    );
    expect(grade.recommendedStructuresCorrect['iron_condor']).toBe(false);
  });

  it('unknown structure name grades as null', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          recommended: ['some_made_up_structure'],
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5810, close: 5810 }),
        ],
      }),
    );
    expect(
      grade.recommendedStructuresCorrect['some_made_up_structure'],
    ).toBeNull();
  });

  it('avoid list inverts the correctness — avoided structure that would have LOST is correct', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          avoid: ['iron_condor'],
          gammaFloor: 5780,
          gammaCeiling: 5820,
        }),
        // Spot ends ABOVE ceiling → IC would have lost → avoiding it
        // was correct.
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5830, close: 5830 }),
        ],
      }),
    );
    expect(grade.avoidStructuresCorrect['iron_condor']).toBe(true);
  });
});

// ─── Regime ────────────────────────────────────────────────────────

describe('gradePlaybook: regime', () => {
  it('classifies cone-breach-up when SPX highs > cone upper', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          regime: 'cone-breach-up',
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({
            hourCT: 10,
            minute: 0,
            open: 5820,
            high: 5830,
            close: 5825,
          }),
          candle({ hourCT: 15, minute: 0, open: 5825, close: 5824 }),
        ],
      }),
    );
    expect(grade.regimeObserved).toBe('cone-breach-up');
    expect(grade.regimeCorrect).toBe(true);
  });

  it('grades generic `cone-breach` call correct when either direction is observed', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          regime: 'cone-breach',
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 10, minute: 0, open: 5820, high: 5830, close: 5825 }),
          candle({ hourCT: 15, minute: 0, open: 5825, close: 5825 }),
        ],
      }),
    );
    expect(grade.regimeObserved).toBe('cone-breach-up');
    expect(grade.regimeCorrect).toBe(true);
  });

  it('maps chop call to observed mixed', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          regime: 'chop',
          bias: 'two-sided',
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          // No breach, no pin, two-sided → mixed.
          candle({ hourCT: 10, minute: 0, open: 5810, close: 5790 }),
          candle({ hourCT: 15, minute: 0, open: 5795, close: 5808 }),
        ],
      }),
    );
    expect(grade.regimeObserved).toBe('mixed');
    expect(grade.regimeCorrect).toBe(true);
  });

  it('maps gap-and-rip call to observed cone-breach-up', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          regime: 'gap-and-rip',
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 10, minute: 0, open: 5820, high: 5830, close: 5825 }),
          candle({ hourCT: 15, minute: 0, open: 5825, close: 5825 }),
        ],
      }),
    );
    expect(grade.regimeCorrect).toBe(true);
  });

  it('returns null (ungraded) for an unrecognized regime call', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          regime: 'made-up-regime',
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 15, minute: 0, open: 5810, close: 5810 }),
        ],
      }),
    );
    expect(grade.regimeCorrect).toBeNull();
  });

  it('classifies pin when spot ends within 5pt of magnet AND cone held', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          regime: 'pin',
          magnet: 5800,
          cone: { lower: 5780, upper: 5820 },
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 12, minute: 0, open: 5805, close: 5803 }),
          candle({ hourCT: 15, minute: 0, open: 5802, close: 5802 }),
        ],
      }),
    );
    expect(grade.regimeObserved).toBe('pin');
    expect(grade.regimeCorrect).toBe(true);
  });
});

// ─── Charm drift ───────────────────────────────────────────────────

describe('gradePlaybook: charm drift', () => {
  it('predicts up when charmZero > spot, grades correct on up move', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          spot: 5800,
          charmZero: 5810,
          charmDriftDirection: null,
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 9, minute: 30, open: 5803, close: 5808 }),
        ],
      }),
    );
    expect(grade.charmDriftCall).toBe('up');
    expect(grade.charmDriftCorrect).toBe(true);
  });

  it('grades correct when explicit drift direction matches observed', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          spot: 5800,
          charmDriftDirection: 'down',
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 9, minute: 30, open: 5795, close: 5793 }),
        ],
      }),
    );
    expect(grade.charmDriftCall).toBe('down');
    expect(grade.charmDriftCorrect).toBe(true);
  });

  it('flat call correct when |return| under noise threshold', () => {
    const grade = gradePlaybook(
      defaultArgs({
        playbook: defaultPlaybook({
          spot: 5800,
          charmDriftDirection: 'flat',
        }),
        spxCandles: [
          candle({ hourCT: 9, minute: 0, open: 5800, close: 5800 }),
          candle({ hourCT: 9, minute: 30, open: 5800.5, close: 5800.5 }),
        ],
      }),
    );
    expect(grade.charmDriftCorrect).toBe(true);
  });
});

// ─── Grader version + plumbing ─────────────────────────────────────

describe('gradePlaybook: meta + smoke', () => {
  it('stamps the current GRADER_VERSION on every grade', () => {
    const grade = gradePlaybook(defaultArgs());
    expect(grade.graderVersion).toBe(GRADER_VERSION);
  });

  it('returns null bias when EOD close cannot be resolved (no candles)', () => {
    const grade = gradePlaybook(
      defaultArgs({
        spxCandles: [],
      }),
    );
    expect(grade.biasCorrect).toBeNull();
    expect(grade.eodClose).toBeNull();
  });

  it('records mode + tradingDate + slot as passed in', () => {
    const grade = gradePlaybook(
      defaultArgs({
        mode: 'pre_trade',
        tradingDate: '2026-05-08',
        slotCapturedAt: ts(8, 30),
      }),
    );
    expect(grade.mode).toBe('pre_trade');
    expect(grade.tradingDate).toBe('2026-05-08');
    expect(grade.slotCapturedAt).toBe(ts(8, 30).toISOString());
  });
});
