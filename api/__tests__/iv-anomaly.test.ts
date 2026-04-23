// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  computeSkewDelta,
  computeRollingZ,
  detectAnomalies,
  classifyFlowPhase,
  strikeKey,
  type StrikeSample,
  type AnomalyFlag,
} from '../_lib/iv-anomaly.js';
import type { ContextSnapshot } from '../_lib/anomaly-context.js';

// ── Fixtures ─────────────────────────────────────────────────

const TS = '2026-04-23T15:30:00.000Z';
const EXPIRY = '2026-04-23';

function makeSample(
  strike: number,
  ivMid: number,
  overrides: Partial<StrikeSample> = {},
): StrikeSample {
  return {
    ticker: 'SPX',
    strike,
    side: 'put',
    expiry: EXPIRY,
    iv_mid: ivMid,
    iv_bid: ivMid - 0.01,
    iv_ask: ivMid + 0.01,
    ts: TS,
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<ContextSnapshot> = {},
): ContextSnapshot {
  return {
    spot_delta_5m: null,
    spot_delta_15m: null,
    spot_delta_60m: null,
    vwap_distance: null,
    volume_percentile: null,
    spx_delta_15m: null,
    spy_delta_15m: null,
    qqq_delta_15m: null,
    iwm_delta_15m: null,
    es_delta_15m: null,
    nq_delta_15m: null,
    ym_delta_15m: null,
    rty_delta_15m: null,
    nq_ofi_1h: null,
    vix_level: null,
    vix_delta_5m: null,
    vix_delta_15m: null,
    vix_term_1d: null,
    vix_term_9d: null,
    vix_30d_spot: null,
    dxy_delta_15m: null,
    tlt_delta_15m: null,
    gld_delta_15m: null,
    uso_delta_15m: null,
    recent_flow_alerts: [],
    spx_recent_dark_prints: [],
    econ_release_t_minus: null,
    econ_release_t_plus: null,
    econ_release_name: null,
    institutional_program_latest: null,
    net_flow_5m: null,
    nope_current: null,
    put_premium_0dte_pctile: null,
    zero_gamma_level: null,
    zero_gamma_distance_pct: null,
    ...overrides,
  };
}

// ── computeSkewDelta ─────────────────────────────────────────

describe('computeSkewDelta', () => {
  it('returns ~0 for a symmetric chain where target equals the neighbor mean', () => {
    const target = makeSample(7000, 0.42);
    const neighbors = [
      makeSample(6990, 0.42),
      makeSample(6995, 0.42),
      makeSample(7005, 0.42),
      makeSample(7010, 0.42),
    ];
    const delta = computeSkewDelta(target, neighbors);
    expect(delta).toBeCloseTo(0, 6);
  });

  it('returns a positive delta when target IV is above neighbor mean', () => {
    const target = makeSample(7000, 0.48);
    const neighbors = [
      makeSample(6990, 0.42),
      makeSample(6995, 0.42),
      makeSample(7005, 0.42),
      makeSample(7010, 0.42),
    ];
    const delta = computeSkewDelta(target, neighbors);
    // 0.48 - 0.42 = 0.06 (6 vol pts)
    expect(delta).toBeCloseTo(0.06, 6);
  });

  it('returns null when target iv_mid is null', () => {
    const target = makeSample(7000, 0) as StrikeSample;
    (target as { iv_mid: number | null }).iv_mid = null;
    const neighbors = [
      makeSample(6990, 0.42),
      makeSample(6995, 0.42),
      makeSample(7005, 0.42),
      makeSample(7010, 0.42),
    ];
    expect(computeSkewDelta(target, neighbors)).toBeNull();
  });

  it('returns null when fewer than 4 usable neighbors (band edge)', () => {
    const target = makeSample(7000, 0.48);
    const neighbors = [makeSample(6990, 0.42), makeSample(6995, 0.42)];
    expect(computeSkewDelta(target, neighbors)).toBeNull();
  });

  it('skips null-iv neighbors but still requires 4 usable', () => {
    const target = makeSample(7000, 0.48);
    const neighbors = [
      makeSample(6990, 0.42),
      makeSample(6995, 0.42),
      { ...makeSample(7005, 0), iv_mid: null },
      makeSample(7010, 0.42),
    ];
    expect(computeSkewDelta(target, neighbors)).toBeNull();
  });
});

// ── computeRollingZ ──────────────────────────────────────────

describe('computeRollingZ', () => {
  it('returns a correct z-score for synthetic history with known mean/stddev', () => {
    // history: all 0.40. mean=0.40, stddev=0. Target 0.45 → null (stddev=0)
    const target = makeSample(7000, 0.45);
    const history = Array.from({ length: 20 }, () => makeSample(7000, 0.4));
    expect(computeRollingZ(target, history)).toBeNull();
  });

  it('returns ~+2 for a target 2 stddevs above the history mean', () => {
    // history: 10 samples alternating 0.40 and 0.44 → mean=0.42, var=0.0004, stddev=0.02
    // target 0.46 → z = (0.46-0.42)/0.02 = +2.0
    const target = makeSample(7000, 0.46);
    const history: StrikeSample[] = [];
    for (let i = 0; i < 10; i += 1) {
      history.push(makeSample(7000, i % 2 === 0 ? 0.4 : 0.44));
    }
    const z = computeRollingZ(target, history);
    expect(z).not.toBeNull();
    expect(z!).toBeCloseTo(2.0, 4);
  });

  it('returns ~-2 for a target 2 stddevs below the history mean', () => {
    const target = makeSample(7000, 0.38);
    const history: StrikeSample[] = [];
    for (let i = 0; i < 10; i += 1) {
      history.push(makeSample(7000, i % 2 === 0 ? 0.4 : 0.44));
    }
    const z = computeRollingZ(target, history);
    expect(z).not.toBeNull();
    expect(z!).toBeCloseTo(-2.0, 4);
  });

  it('returns null when history has fewer than 10 samples', () => {
    const target = makeSample(7000, 0.46);
    const history = Array.from({ length: 9 }, () => makeSample(7000, 0.4));
    expect(computeRollingZ(target, history)).toBeNull();
  });

  it('returns null when target iv_mid is null', () => {
    const target: StrikeSample = { ...makeSample(7000, 0.4), iv_mid: null };
    const history = Array.from({ length: 20 }, () => makeSample(7000, 0.4));
    expect(computeRollingZ(target, history)).toBeNull();
  });
});

// ── detectAnomalies ──────────────────────────────────────────

describe('detectAnomalies', () => {
  it('returns only the strike that exceeds the skew_delta threshold', () => {
    // Build 7 strikes: 6 with iv=0.40, 1 target (strike=7000) with iv=0.45.
    // neighbors (6990,6995,7005,7010) mean=0.40 → skew_delta=0.05 (5 vol pts)
    // which exceeds SKEW_DELTA_THRESHOLD=1.5/100=0.015.
    const snapshot: StrikeSample[] = [
      makeSample(6980, 0.4),
      makeSample(6990, 0.4),
      makeSample(6995, 0.4),
      makeSample(7000, 0.45), // TARGET
      makeSample(7005, 0.4),
      makeSample(7010, 0.4),
      makeSample(7020, 0.4),
    ];
    const historyByStrike = new Map<string, StrikeSample[]>();
    const spot = 7050; // puts are OTM (strike < spot)

    const flags = detectAnomalies(snapshot, historyByStrike, spot);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.strike).toBe(7000);
    expect(flags[0]!.flag_reasons).toContain('skew_delta');
    expect(flags[0]!.spot_at_detect).toBe(spot);
    expect(flags[0]!.iv_at_detect).toBe(0.45);
  });

  it('flags a strike via z_score even when skew_delta is in range', () => {
    // Symmetric snapshot → skew_delta = 0 (no flag).
    // But target strike's historical baseline is 0.40 ± 0.02 → current
    // 0.50 is +5 stddevs → z-score fires.
    const snapshot: StrikeSample[] = [
      makeSample(6990, 0.5),
      makeSample(6995, 0.5),
      makeSample(7000, 0.5),
      makeSample(7005, 0.5),
      makeSample(7010, 0.5),
    ];
    const history: StrikeSample[] = [];
    for (let i = 0; i < 20; i += 1) {
      history.push(makeSample(7000, i % 2 === 0 ? 0.38 : 0.42));
    }
    const key = strikeKey('SPX', 7000, 'put', EXPIRY);
    const historyByStrike = new Map<string, StrikeSample[]>([[key, history]]);

    const flags = detectAnomalies(snapshot, historyByStrike, 7050);
    // Only strike=7000 has a mapped history; neighbors get empty history
    // → null z → no flag. So exactly one z_score flag, on strike 7000.
    const zFlags = flags.filter((f) => f.flag_reasons.includes('z_score'));
    expect(zFlags).toHaveLength(1);
    expect(zFlags[0]!.strike).toBe(7000);
    expect(zFlags[0]!.skew_delta).toBeCloseTo(0, 6);
    expect(zFlags[0]!.z_score).not.toBeNull();
  });

  it('returns empty array when no strike exceeds any threshold', () => {
    const snapshot: StrikeSample[] = [
      makeSample(6990, 0.4),
      makeSample(6995, 0.4),
      makeSample(7000, 0.4),
      makeSample(7005, 0.4),
      makeSample(7010, 0.4),
    ];
    const flags = detectAnomalies(snapshot, new Map(), 7050);
    expect(flags).toEqual([]);
  });

  it('returns empty array on invalid spot', () => {
    const snapshot: StrikeSample[] = [
      makeSample(6990, 0.4),
      makeSample(6995, 0.4),
      makeSample(7000, 0.5),
      makeSample(7005, 0.4),
      makeSample(7010, 0.4),
    ];
    expect(detectAnomalies(snapshot, new Map(), 0)).toEqual([]);
    expect(detectAnomalies(snapshot, new Map(), Number.NaN)).toEqual([]);
  });

  it('skips strikes with null iv_mid', () => {
    const snapshot: StrikeSample[] = [
      makeSample(6990, 0.4),
      makeSample(6995, 0.4),
      { ...makeSample(7000, 0), iv_mid: null },
      makeSample(7005, 0.4),
      makeSample(7010, 0.4),
    ];
    const flags = detectAnomalies(snapshot, new Map(), 7050);
    expect(flags).toEqual([]);
  });
});

// ── classifyFlowPhase ────────────────────────────────────────

describe('classifyFlowPhase', () => {
  const baseFlag: AnomalyFlag = {
    ticker: 'SPX',
    strike: 7000,
    side: 'put',
    expiry: EXPIRY,
    spot_at_detect: 7100,
    iv_at_detect: 0.45,
    skew_delta: 0.05,
    z_score: 3.0,
    ask_mid_div: 0.02,
    flag_reasons: ['skew_delta', 'z_score'],
    flow_phase: 'mid',
    ts: TS,
  };

  it('classifies as "early" for far-OTM strike + quiet VIX + fresh ASK flow', () => {
    // distPct = |7000-7100|/7100 = 0.0141 → NOT > 0.02, so need other axes.
    // Use a farther-OTM strike to flip the distance axis.
    const flag = { ...baseFlag, strike: 6900 }; // |6900-7100|/7100 = 0.0282 > 0.02
    const ctx = makeContext({ vix_delta_15m: 0.1 }); // quiet
    // ask_mid_div 0.02 is > 0.5/100 = 0.005 → fresh
    expect(classifyFlowPhase(flag, ctx)).toBe('early');
  });

  it('classifies as "reactive" for near-ATM strike + spiking VIX', () => {
    const flag = { ...baseFlag, strike: 7095, ask_mid_div: 0 }; // |7095-7100|/7100 ≈ 0.0007 < 0.005
    const ctx = makeContext({ vix_delta_15m: 1.5 }); // spiking
    expect(classifyFlowPhase(flag, ctx)).toBe('reactive');
  });

  it('defaults to "mid" when no axis strongly tilts either way', () => {
    const flag = { ...baseFlag, strike: 7050, ask_mid_div: 0 }; // medium distance
    const ctx = makeContext({ vix_delta_15m: 0.5 }); // moderate
    expect(classifyFlowPhase(flag, ctx)).toBe('mid');
  });

  it('handles null VIX delta gracefully (uses other axes)', () => {
    // far OTM + fresh ASK skew → should still be early
    const flag = { ...baseFlag, strike: 6900, ask_mid_div: 0.02 };
    const ctx = makeContext({ vix_delta_15m: null });
    expect(classifyFlowPhase(flag, ctx)).toBe('early');
  });
});
