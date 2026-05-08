// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  SILENT_BOOM_TIER_THRESHOLDS,
  computeSilentBoomScore,
  silentBoomScoreTier,
  silentBoomTodFromMinuteCt,
  type SilentBoomScoreInput,
} from '../_lib/silent-boom-score';

/** Build a baseline input that scores 0 (no positive or negative
 * weighted bucket) — perturbations from this isolate one feature. */
const ZERO_BASE: SilentBoomScoreInput = {
  dte: 5, // 4–7D bucket → 0
  baselineVolume: 600, // > 500 → 0 (defensive default)
  spikeRatio: 75, // 50–100× → 0
  entryPrice: 0.75, // 0.50–1.00 → 0
  askPct: 0.95, // 0.95+ → -1
  tod: 'LUNCH', // 0
  optionType: 'P', // 0
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

  it('TOD: rewards AM_open, penalizes PM/LATE', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'AM_open' })).toBe(
      -1 + 5,
    );
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'MID' })).toBe(-1 + 1);
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'PM' })).toBe(-1 + -3);
    expect(computeSilentBoomScore({ ...ZERO_BASE, tod: 'LATE' })).toBe(-1 + -3);
  });

  it('ask%: rewards 0.70–0.85, penalizes 0.95+', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, askPct: 0.75 })).toBe(0 + 2);
    expect(computeSilentBoomScore({ ...ZERO_BASE, askPct: 0.9 })).toBe(0 + 1);
    // ZERO_BASE has 0.95 → already -1, so the penalty is included.
    expect(computeSilentBoomScore(ZERO_BASE)).toBe(-1);
  });

  it('option type: +1 for calls', () => {
    expect(computeSilentBoomScore({ ...ZERO_BASE, optionType: 'C' })).toBe(
      -1 + 1,
    );
  });

  it('strongest possible alert lands near the empirical p99 (≈ +27)', () => {
    // 0DTE + baseline 200–500 + ratio 5–10× + price <$0.50 +
    // AM_open + ask% < 0.85 + call → 10 + 5 + 5 + 5 + 5 + 2 + 1 = 33.
    const top: SilentBoomScoreInput = {
      dte: 0,
      baselineVolume: 400,
      spikeRatio: 7,
      entryPrice: 0.4,
      askPct: 0.75,
      tod: 'AM_open',
      optionType: 'C',
    };
    expect(computeSilentBoomScore(top)).toBe(33);
  });

  it('worst possible alert lands near the empirical min (≈ -21)', () => {
    // 30D+ + baseline <50 + ratio 100×+ + price $5+ + LATE +
    // ask% 0.95+ + put → -8 + -1 + -3 + -5 + -3 + -1 + 0 = -21.
    const worst: SilentBoomScoreInput = {
      dte: 60,
      baselineVolume: 30,
      spikeRatio: 200,
      entryPrice: 12,
      askPct: 0.99,
      tod: 'LATE',
      optionType: 'P',
    };
    expect(computeSilentBoomScore(worst)).toBe(-21);
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
