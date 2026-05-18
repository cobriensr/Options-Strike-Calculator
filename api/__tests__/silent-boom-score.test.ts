// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  SILENT_BOOM_TIER_THRESHOLDS,
  computeSilentBoomScore,
  silentBoomDowTypeBonus,
  silentBoomScoreTier,
  silentBoomTodFromMinuteCt,
  type SilentBoomScoreInput,
} from '../_lib/silent-boom-score';

/** Build a baseline input that scores 0 (no positive or negative
 * weighted bucket) — perturbations from this isolate one feature.
 *
 * Wednesday × PUT is the DOW × type combination that scores 0 (every
 * other day-of-week/option_type combo either gets a Friday bonus, a
 * Monday-PUT penalty, or the +1 call bonus); 2026-05-13 is a
 * Wednesday — stable scoring anchor for the rest of the test suite. */
const ZERO_BASE: SilentBoomScoreInput = {
  dte: 5, // 4–7D bucket → 0
  baselineVolume: 600, // > 500 → 0 (defensive default)
  spikeRatio: 75, // 50–100× → 0
  entryPrice: 0.75, // 0.50–1.00 → 0
  askPct: 0.95, // 0.95+ → -1
  tod: 'LUNCH', // 0
  optionType: 'P', // 0
  tradingDay: '2026-05-13', // Wednesday × PUT → 0 (no DOW bonus)
  preTradeCount: 0, // < 501 → 0 (no heavy-activity bonus)
  adjCofire: false, // → 0 (no co-fire bonus)
  firstMinShare: null, // null → 0 (no cadence weight applied)
  spreadInBucket: null, // null → 0 (no spread weight applied)
};

describe('computeSilentBoomScore', () => {
  it('returns the expected baseline (only the 0.95+ ask penalty applies)', () => {
    expect(computeSilentBoomScore(ZERO_BASE)).toBe(-1);
  });

  it('DTE: rewards 0DTE strongly and penalizes long-dated fires', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, dte: 0 })).toBe(-1 + 10);
    expect(computeSilentBoomScore({ ...ZERO_BASE, dte: 2 })).toBe(-1 + 4);
    expect(computeSilentBoomScore({ ...ZERO_BASE, dte: 7 })).toBe(-1 + 0);
    expect(computeSilentBoomScore({ ...ZERO_BASE, dte: 20 })).toBe(-1 + -3);
    expect(computeSilentBoomScore({ ...ZERO_BASE, dte: 60 })).toBe(-1 + -8);
  });

  it('baseline volume: rewards moderate, lightly penalizes deep silence', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, baselineVolume: 30 })).toBe(
      -1 + -1,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, baselineVolume: 100 })).toBe(
      -1 + 3,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, baselineVolume: 400 })).toBe(
      -1 + 5,
    );
  });

  it('spike ratio: rewards modest spikes, penalizes ghost-print spikes (100×+)', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, spikeRatio: 7 })).toBe(
      -1 + 5,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, spikeRatio: 20 })).toBe(
      -1 + 3,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, spikeRatio: 40 })).toBe(
      -1 + 1,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, spikeRatio: 200 })).toBe(
      -1 + -3,
    );
  });

  it('entry price: rewards <$0.50, penalizes $5+', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, entryPrice: 0.4 })).toBe(
      -1 + 5,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, entryPrice: 3.0 })).toBe(
      -1 + -2,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, entryPrice: 12 })).toBe(
      -1 + -5,
    );
  });

  it('TOD: rewards AM_open + MID, penalizes PM/LATE (2026-05-17 retune)', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'AM_open' })).toBe(
      -1 + 6,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'MID' })).toBe(-1 + 3);
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'PM' })).toBe(-1 + -4);
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'LATE' })).toBe(-1 + -5);
  });

  it('DOW × type bonus: Friday-PUT +2, Friday-CALL +1, Monday-PUT -2', () => {
    // 2026-05-15 = Friday, 2026-05-11 = Monday (verified by getUTCDay).
    expect(
      computeSilentBoomScore({
        ...ZERO_BASE,
        tradingDay: '2026-05-15', // Friday × PUT
      }),
    ).toBe(-1 + 2);
    expect(
      computeSilentBoomScore({
        ...ZERO_BASE,
        tradingDay: '2026-05-15', // Friday × CALL
        optionType: 'C',
      }),
    ).toBe(-1 + 1 /* call */ + 1 /* fri-call */);
    expect(
      computeSilentBoomScore({
        ...ZERO_BASE,
        tradingDay: '2026-05-11', // Monday × PUT
      }),
    ).toBe(-1 + -2);
    // Monday × CALL — only call bonus, no DOW penalty.
    expect(
      computeSilentBoomScore({
        ...ZERO_BASE,
        tradingDay: '2026-05-11',
        optionType: 'C',
      }),
    ).toBe(-1 + 1);
    // Tuesday × either — no DOW adjustment (only call bonus survives).
    expect(
      computeSilentBoomScore({
        ...ZERO_BASE,
        tradingDay: '2026-05-12', // Tuesday × PUT
      }),
    ).toBe(-1);
  });

  it('ask%: rewards 0.70–0.85, penalizes 0.95+, saturates at 1.0', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, askPct: 0.75 })).toBe(0 + 2);
    expect(computeSilentBoomScore({ ...ZERO_BASE, askPct: 0.9 })).toBe(0 + 1);
    // ZERO_BASE has 0.95 → already -1, so the penalty is included.
    expect(computeSilentBoomScore(ZERO_BASE)).toBe(-1);
    // 0.999 stays in the high-penalty band (cliff is at exactly 1.0).
    expect(computeSilentBoomScore({ ...ZERO_BASE, askPct: 0.999 })).toBe(-1);
    // ask = 1.0 — saturation penalty forces tier3. Penalty
    // escalated −30 → −32 in Phase B and again −32 → −36 in Phase
    // D-1 to keep the invariant intact against the cumulative new
    // bonuses (pre_trade_count, adj_cofire, cadence, spread).
    expect(computeSilentBoomScore({ ...ZERO_BASE, askPct: 1.0 })).toBe(-36);
  });

  it('saturation: best-possible inputs at ask=1.0 still land below tier2', () => {
    // Same components as the "strongest possible alert" case, but
    // with ask_pct = 1.0 instead of 0.75. Post-#171 top non-DOW
    // non-bonus score is +34, drops to -4 after −36 saturation
    // penalty (loses the +2 ask reward and applies -36). Even with
    // ALL non-ask bonuses stacked (Friday × CALL + pre_trade ≥501 +
    // adj_cofire + distributed cadence + Q3 spread → +10 of bonus),
    // the result is still below tier2 floor of 8 → tier3.
    const saturated: SilentBoomScoreInput = {
      dte: 0,
      baselineVolume: 400,
      spikeRatio: 7,
      entryPrice: 0.4,
      askPct: 1.0,
      tod: 'AM_open',
      optionType: 'C',
      tradingDay: '2026-05-13', // Wednesday — no DOW bonus
      preTradeCount: 0, // no heavy-activity bonus
      adjCofire: false, // no co-fire bonus
      firstMinShare: null, // no cadence weight
      spreadInBucket: null, // no spread weight
    };
    const score = computeSilentBoomScore(saturated);
    expect(score).toBe(-4);
    expect(score).toBeLessThan(SILENT_BOOM_TIER_THRESHOLDS.tier2MinScore);
    expect(silentBoomScoreTier(score)).toBe('tier3');

    // Stack ALL non-ask bonuses (Friday × CALL + pre_trade ≥501 +
    // adj_cofire + distributed cadence + Q3 spread) and confirm we
    // *still* fall short of tier2.
    const saturatedMaxBonus = computeSilentBoomScore({
      ...saturated,
      tradingDay: '2026-05-15', // Friday → +1 Fri-CALL bonus
      preTradeCount: 1000, // ≥501 → +4 heavy bonus
      adjCofire: true, // adj_cofire → +2 bonus
      firstMinShare: 0.1, // distributed → +1 bonus
      spreadInBucket: 0.15, // Q3 wide → +2 bonus
    });
    expect(saturatedMaxBonus).toBe(6);
    expect(saturatedMaxBonus).toBeLessThan(
      SILENT_BOOM_TIER_THRESHOLDS.tier2MinScore,
    );
    expect(silentBoomScoreTier(saturatedMaxBonus)).toBe('tier3');
  });

  it('option type: +1 for calls', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, optionType: 'C' })).toBe(
      -1 + 1,
    );
  });

  it('pre_trade_count: heavy-activity 501+ adds +4, anything below is 0', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, preTradeCount: 500 })).toBe(
      -1,
    ); // Below threshold → no bonus.
    expect(computeSilentBoomScore({ ...ZERO_BASE, preTradeCount: 501 })).toBe(
      -1 + 4,
    ); // At threshold → bonus fires.
    expect(
      computeSilentBoomScore({ ...ZERO_BASE, preTradeCount: 10_000 }),
    ).toBe(-1 + 4); // Far above → still +4 (one bucket only).
    expect(computeSilentBoomScore({ ...ZERO_BASE, preTradeCount: 0 })).toBe(-1); // Explicit dead-silent baseline.
  });

  it('strongest possible alert post-#171 stacks every bonus to +44', () => {
    // Wednesday baseline — no DOW bonus, no heavy-activity bonus,
    // no cadence weight, no spread weight.
    // 0DTE + baseline 200–500 + ratio 5–10× + price <$0.50 +
    // AM_open + ask% < 0.85 + call → 10 + 5 + 5 + 5 + 6 + 2 + 1 = 34.
    const topNoBonus: SilentBoomScoreInput = {
      dte: 0,
      baselineVolume: 400,
      spikeRatio: 7,
      entryPrice: 0.4,
      askPct: 0.75,
      tod: 'AM_open',
      optionType: 'C',
      tradingDay: '2026-05-13', // Wednesday
      preTradeCount: 0,
      adjCofire: false,
      firstMinShare: null,
      spreadInBucket: null,
    };
    expect(computeSilentBoomScore(topNoBonus)).toBe(34);

    // Stack: Friday × CALL (+1) → +35
    expect(
      computeSilentBoomScore({ ...topNoBonus, tradingDay: '2026-05-15' }),
    ).toBe(35);

    // Stack: Friday × CALL + pre_trade ≥501 (+4) → +39
    expect(
      computeSilentBoomScore({
        ...topNoBonus,
        tradingDay: '2026-05-15',
        preTradeCount: 1_000,
      }),
    ).toBe(39);

    // Stack: + adj_cofire (+2) → +41
    expect(
      computeSilentBoomScore({
        ...topNoBonus,
        tradingDay: '2026-05-15',
        preTradeCount: 1_000,
        adjCofire: true,
      }),
    ).toBe(41);

    // Stack: + first_min_share distributed (+1) → +42
    expect(
      computeSilentBoomScore({
        ...topNoBonus,
        tradingDay: '2026-05-15',
        preTradeCount: 1_000,
        adjCofire: true,
        firstMinShare: 0.1, // <0.25 → distributed
      }),
    ).toBe(42);

    // Stack: + spread Q3 wide (+2) → +44 (post-#171 absolute ceiling)
    expect(
      computeSilentBoomScore({
        ...topNoBonus,
        tradingDay: '2026-05-15',
        preTradeCount: 1_000,
        adjCofire: true,
        firstMinShare: 0.1,
        spreadInBucket: 0.15, // ≥0.1122 → Q3 wide
      }),
    ).toBe(44);
  });

  it('worst possible alert post-#171 lands at -31 (cadence + spread can subtract too)', () => {
    // 30D+ + baseline <50 + ratio 100×+ + price $5+ + LATE + ask% ≥0.95
    // + put + Monday-PUT bonus + single-block cadence + Q0 spread →
    // -8 -1 -3 -5 -5 -1 + 0 + (-2) + (-3) + (-3) = -31.
    // pre_trade_count and adj_cofire never add penalties; cadence and
    // spread now CAN — this is the new floor.
    const worst: SilentBoomScoreInput = {
      dte: 60,
      baselineVolume: 30,
      spikeRatio: 200,
      entryPrice: 12,
      askPct: 0.99,
      tod: 'LATE',
      optionType: 'P',
      tradingDay: '2026-05-11', // Monday — Mon × PUT = -2
      preTradeCount: 0,
      adjCofire: false,
      firstMinShare: 0.9, // >0.75 → single-block penalty -3
      spreadInBucket: 0.01, // <0.0181 → Q0 tight penalty -3
    };
    expect(computeSilentBoomScore(worst)).toBe(-31);
  });

  it('adj_cofire: TRUE adds +2 to the score, FALSE is a no-op', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, adjCofire: false })).toBe(-1);
    expect(computeSilentBoomScore({ ...ZERO_BASE, adjCofire: true })).toBe(
      -1 + 2,
    );
  });

  it('first_min_share (H2): distributed <25% +1, single-block >75% -3, mid bands 0, null 0', () => {
    // Null → no weight applied (baseline -1 from ZERO_BASE ask=0.95).
    expect(computeSilentBoomScore({ ...ZERO_BASE, firstMinShare: null })).toBe(
      -1,
    );
    // Distributed cadence: <25% in first 60s → +1.
    expect(computeSilentBoomScore({ ...ZERO_BASE, firstMinShare: 0.1 })).toBe(
      -1 + 1,
    );
    // Right at the 0.25 boundary — strict <, so 0.25 is NOT distributed.
    expect(computeSilentBoomScore({ ...ZERO_BASE, firstMinShare: 0.25 })).toBe(
      -1,
    );
    // Moderate (25–50%) — no weight.
    expect(computeSilentBoomScore({ ...ZERO_BASE, firstMinShare: 0.4 })).toBe(
      -1,
    );
    // Concentrated (50–75%) — no weight.
    expect(computeSilentBoomScore({ ...ZERO_BASE, firstMinShare: 0.6 })).toBe(
      -1,
    );
    // Right at the 0.75 boundary — strict >, so 0.75 is NOT single-block.
    expect(computeSilentBoomScore({ ...ZERO_BASE, firstMinShare: 0.75 })).toBe(
      -1,
    );
    // Single-block: >75% in first 60s → -3.
    expect(computeSilentBoomScore({ ...ZERO_BASE, firstMinShare: 0.9 })).toBe(
      -1 + -3,
    );
  });

  it('spread_in_bucket (H5): Q0 tight <0.0181 -3, Q3 wide ≥0.1122 +2, mid bands 0, null 0', () => {
    // Null → no weight applied.
    expect(computeSilentBoomScore({ ...ZERO_BASE, spreadInBucket: null })).toBe(
      -1,
    );
    // Q0 tight spreads — counter-intuitively penalized.
    expect(computeSilentBoomScore({ ...ZERO_BASE, spreadInBucket: 0.01 })).toBe(
      -1 + -3,
    );
    // Right at the 0.0181 boundary — strict <, so 0.0181 is NOT Q0.
    expect(
      computeSilentBoomScore({ ...ZERO_BASE, spreadInBucket: 0.0181 }),
    ).toBe(-1);
    // Q1 / Q2 (mid bands) — no weight.
    expect(computeSilentBoomScore({ ...ZERO_BASE, spreadInBucket: 0.03 })).toBe(
      -1,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, spreadInBucket: 0.08 })).toBe(
      -1,
    );
    // Right at the 0.1122 boundary — inclusive ≥, so 0.1122 IS Q3.
    expect(
      computeSilentBoomScore({ ...ZERO_BASE, spreadInBucket: 0.1122 }),
    ).toBe(-1 + 2);
    // Q3 wide spreads — bonus.
    expect(computeSilentBoomScore({ ...ZERO_BASE, spreadInBucket: 0.15 })).toBe(
      -1 + 2,
    );
  });
});

describe('silentBoomDowTypeBonus', () => {
  it('returns +2 for Friday × PUT, +1 for Friday × CALL', () => {
    expect(silentBoomDowTypeBonus('2026-05-15', 'P')).toBe(2);
    expect(silentBoomDowTypeBonus('2026-05-15', 'C')).toBe(1);
  });

  it('returns -2 for Monday × PUT, 0 for Monday × CALL', () => {
    expect(silentBoomDowTypeBonus('2026-05-11', 'P')).toBe(-2);
    expect(silentBoomDowTypeBonus('2026-05-11', 'C')).toBe(0);
  });

  it('returns 0 for unscored weekdays', () => {
    expect(silentBoomDowTypeBonus('2026-05-12', 'P')).toBe(0); // Tue
    expect(silentBoomDowTypeBonus('2026-05-13', 'C')).toBe(0); // Wed
    expect(silentBoomDowTypeBonus('2026-05-14', 'P')).toBe(0); // Thu
  });
});

describe('silentBoomScoreTier', () => {
  it('returns tier1 at and above the threshold', () => {
    expect(silentBoomScoreTier(SILENT_BOOM_TIER_THRESHOLDS.tier1MinScore)).toBe(
      'tier1',
    );
    expect(
      silentBoomScoreTier(SILENT_BOOM_TIER_THRESHOLDS.tier1MinScore + 5),
    ).toBe('tier1');
  });

  it('returns tier2 between the thresholds', () => {
    expect(silentBoomScoreTier(SILENT_BOOM_TIER_THRESHOLDS.tier2MinScore)).toBe(
      'tier2',
    );
    expect(
      silentBoomScoreTier(SILENT_BOOM_TIER_THRESHOLDS.tier1MinScore - 1),
    ).toBe('tier2');
  });

  it('returns tier3 below tier2', () => {
    expect(
      silentBoomScoreTier(SILENT_BOOM_TIER_THRESHOLDS.tier2MinScore - 1),
    ).toBe('tier3');
    expect(silentBoomScoreTier(0)).toBe('tier3');
    expect(silentBoomScoreTier(-10)).toBe('tier3');
  });

  it('treats null score as tier3 (defensive — null means "no score")', () => {
    expect(silentBoomScoreTier(null)).toBe('tier3');
  });
});

describe('silentBoomTodFromMinuteCt', () => {
  it('maps minute-of-day to TOD bucket', () => {
    expect(silentBoomTodFromMinuteCt(8 * 60 + 30)).toBe('AM_open'); // 08:30
    expect(silentBoomTodFromMinuteCt(9 * 60 + 59)).toBe('AM_open'); // 09:59
    expect(silentBoomTodFromMinuteCt(10 * 60)).toBe('MID'); //  10:00
    expect(silentBoomTodFromMinuteCt(11 * 60 + 59)).toBe('MID'); // 11:59
    expect(silentBoomTodFromMinuteCt(12 * 60)).toBe('LUNCH'); //   12:00
    expect(silentBoomTodFromMinuteCt(12 * 60 + 59)).toBe('LUNCH'); //  12:59
    expect(silentBoomTodFromMinuteCt(13 * 60)).toBe('PM'); //  13:00
    expect(silentBoomTodFromMinuteCt(14 * 60 + 59)).toBe('PM'); //  14:59
    expect(silentBoomTodFromMinuteCt(15 * 60)).toBe('LATE'); // 15:00
    expect(silentBoomTodFromMinuteCt(16 * 60)).toBe('LATE'); // 16:00
  });
});

describe('SILENT_BOOM_TIER_THRESHOLDS', () => {
  it('is frozen at runtime (load-bearing — defends against mutation)', () => {
    expect(Object.isFrozen(SILENT_BOOM_TIER_THRESHOLDS)).toBe(true);
  });

  it('preserves the calibrated tier ordering (tier1 floor > tier2 floor)', () => {
    expect(SILENT_BOOM_TIER_THRESHOLDS.tier1MinScore).toBeGreaterThan(
      SILENT_BOOM_TIER_THRESHOLDS.tier2MinScore,
    );
  });
});
