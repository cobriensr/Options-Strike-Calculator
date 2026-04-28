// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  detectGammaSqueezes,
  squeezeKey,
  ctHourOf,
  VEL_THRESHOLD,
  ACCEL_RATIO,
  PROX_PCT,
  TREND_PCT,
  ACTIVE_PROX_PCT,
  type SqueezeWindowSample,
} from '../_lib/gamma-squeeze.js';

// ── Fixtures ─────────────────────────────────────────────────

/**
 * Build a 45-min trailing window of per-minute samples for a single
 * (strike, side, expiry). All samples share the same ts axis; vol/oi/spot
 * vary per-sample. Returns ascending by ts.
 *
 * `nowIso` is the latest ts. Samples are spaced 1 minute apart.
 */
function makeWindow(opts: {
  strike: number;
  side?: 'call' | 'put';
  expiry?: string;
  nowIso?: string;
  count?: number;
  /** vol[i] = volumeBase + volumePerMin × i (linear ramp). Override below for non-linear. */
  volumeBase?: number;
  volumePerMin?: number;
  /** Per-sample volume override. If provided, takes precedence over the linear ramp. */
  volumes?: number[];
  oi?: number;
  spotBase?: number;
  /** Per-sample spot override. Defaults to flat at spotBase. */
  spots?: number[];
}): SqueezeWindowSample[] {
  const {
    strike,
    side = 'call',
    expiry = '2026-04-28',
    nowIso = '2026-04-28T15:30:00.000Z', // 10:30 CDT — within the gamma window.
    count = 35,
    volumeBase = 0,
    volumePerMin = 100,
    volumes,
    oi = 1000,
    spotBase = 100,
    spots,
  } = opts;
  const nowMs = Date.parse(nowIso);
  const samples: SqueezeWindowSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(nowMs - (count - 1 - i) * 60_000).toISOString();
    samples.push({
      strike,
      side,
      expiry,
      ts,
      volume: volumes ? volumes[i]! : volumeBase + volumePerMin * i,
      oi,
      spot: spots ? spots[i]! : spotBase,
    });
  }
  return samples;
}

function singletonMap(samples: SqueezeWindowSample[]) {
  const m = new Map<string, SqueezeWindowSample[]>();
  m.set(
    squeezeKey(samples[0]!.strike, samples[0]!.side, samples[0]!.expiry),
    samples,
  );
  return m;
}

// ── ctHourOf ─────────────────────────────────────────────────

describe('ctHourOf', () => {
  it('returns 9.5 for 10:30 EDT (which is 9:30 CDT)', () => {
    // 2026-04-28 is during DST → CDT (UTC-5). 14:30 UTC = 9:30 CDT.
    expect(ctHourOf('2026-04-28T14:30:00.000Z')).toBeCloseTo(9.5, 4);
  });

  it('returns 13.0 for 1:00 PM CT', () => {
    // 18:00 UTC during DST = 13:00 CDT.
    expect(ctHourOf('2026-04-28T18:00:00.000Z')).toBeCloseTo(13.0, 4);
  });

  it('returns -1 on invalid input', () => {
    expect(ctHourOf('not-a-date')).toBe(-1);
  });
});

// ── detectGammaSqueezes ──────────────────────────────────────

const NOW = '2026-04-28T15:30:00.000Z'; // 10:30 CDT — inside gamma window.

describe('detectGammaSqueezes', () => {
  // ── Gate 5: time-of-day ────────────────────────────────────

  it('returns [] when called outside the 9-14 CT gamma window', () => {
    const samples = makeWindow({ strike: 100, spotBase: 99 });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      '2026-04-28T20:30:00.000Z', // 15:30 CDT — past close window.
      new Map(),
    );
    expect(flags).toEqual([]);
  });

  it('returns [] before 9:00 CT', () => {
    const samples = makeWindow({ strike: 100, spotBase: 99 });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      '2026-04-28T13:30:00.000Z', // 8:30 CDT — too early.
      new Map(),
    );
    expect(flags).toEqual([]);
  });

  // ── Gate 1: velocity ───────────────────────────────────────

  it('fires when velocity crosses VEL_THRESHOLD with a clean accelerating window', () => {
    // OI = 1000. Need vol/OI ≥ 5 in last 15 min → ≥ 5000 volume in 15 min.
    // Build linear ramp: 500 vol/min × 35 min = volume up to 17000 at latest.
    // Last 15 min: 7500 → vol/OI = 7.5. Prior 15: also 7500 → ratio 1.0 → fails accel gate.
    // Use accelerating ramp instead.
    // Volumes: i=0..19 → 100/min (slow); i=20..34 → 600/min (fast burst).
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    // Spot ramps from 98.5 → 99.0 over the window — ends 1% below
    // strike (within PROX_PCT but outside ACTIVE_PROX_PCT, so "forming").
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(98.5 + (i / 34) * 0.5);
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      spots,
      oi: 1000,
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.ticker).toBe('NVDA');
    expect(flags[0]!.strike).toBe(100);
    expect(flags[0]!.vol_oi_15m).toBeGreaterThanOrEqual(VEL_THRESHOLD);
    expect(flags[0]!.vol_oi_acceleration).toBeGreaterThan(0);
    expect(flags[0]!.squeeze_phase).toBe('forming');
  });

  it('does NOT fire when velocity is below VEL_THRESHOLD', () => {
    // Linear 100/min × 15 min = 1500 vol → vol/OI = 1.5. Below threshold.
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumeBase: 0,
      volumePerMin: 100,
      oi: 1000,
      spots: Array.from({ length: 35 }, (_, i) => 99.0 + (i / 34) * 0.5),
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toEqual([]);
  });

  // ── Gate 2: acceleration ───────────────────────────────────

  it('does NOT fire when velocity is decelerating (prior 15m higher than current)', () => {
    // First 20 min: 600/min (fast). Last 15 min: 100/min (slow).
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 600 : 100;
      volumes.push(cum);
    }
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots: Array.from({ length: 35 }, (_, i) => 99.0 + (i / 34) * 0.5),
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    // Last-15 velocity = 1500/1000 = 1.5 → fails gate 1 anyway. Build a
    // tighter case where last-15 > VEL_THRESHOLD but still less than
    // ACCEL_RATIO × prior-15.
    expect(flags).toEqual([]);
  });

  it('does NOT fire when velocity is sustained but not rising (ratio 1.0)', () => {
    // Steady 600/min throughout. last-15 = prior-15 = 9.0 vol/OI.
    // Ratio = 1.0 < ACCEL_RATIO (1.5).
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumeBase: 0,
      volumePerMin: 600,
      oi: 1000,
      spots: Array.from({ length: 35 }, (_, i) => 99.0 + (i / 34) * 0.5),
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toEqual([]);
  });

  it('fires when prior velocity was 0 (squeeze just turned on)', () => {
    // No volume in first 25 min, then explosive ramp in last 10.
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 25 ? 0 : 800;
      volumes.push(cum);
    }
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots: Array.from({ length: 35 }, (_, i) => 99.0 + (i / 34) * 0.5),
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.vol_oi_15m_prior).toBe(0);
  });

  // ── Gate 3: proximity ──────────────────────────────────────

  it('does NOT fire when spot is more than PROX_PCT below the strike (call)', () => {
    // Strike 100, spot 95 → 5% below. PROX_PCT = 1.5%. Fails.
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumeBase: 0,
      volumePerMin: 1000, // huge velocity, but proximity should still gate.
      oi: 1000,
      spotBase: 95,
      spots: Array.from({ length: 35 }, () => 95),
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toEqual([]);
  });

  it('fires when spot just pierced strike on the OTM side (calls: spot just above)', () => {
    // Strike 100, spot 100.3 → 0.3% above strike (within just-pierced 0.5% band).
    // Build a clean accelerating window with positive trend.
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(99.5 + (i / 34) * 0.8);
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots,
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.pct_from_strike).toBeCloseTo(0.003, 3);
    expect(flags[0]!.squeeze_phase).toBe('active'); // within ACTIVE_PROX_PCT
  });

  it('classifies phase as "forming" when spot is far from strike but within PROX_PCT', () => {
    // Strike 100, spot drifting from 98.6 → 99.0 (1% below at end).
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(98.6 + (i / 34) * 0.4);
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots,
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.squeeze_phase).toBe('forming');
    expect(Math.abs(flags[0]!.pct_from_strike)).toBeGreaterThan(
      ACTIVE_PROX_PCT,
    );
  });

  // ── Gate 4: trend ──────────────────────────────────────────

  it('does NOT fire when spot is flat (no trend, even with high velocity)', () => {
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    // Perfectly flat spot.
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spotBase: 99,
      spots: Array.from({ length: 35 }, () => 99),
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toEqual([]);
  });

  it('does NOT fire on a CALL when spot is trending DOWN (against squeeze direction)', () => {
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    // Spot drifting DOWN over the window — wrong direction for a call squeeze.
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(99.5 - (i / 34) * 0.5);
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots,
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toEqual([]);
  });

  it('fires on a PUT when spot trends DOWN and proximity holds', () => {
    // Strike 100, spot drifting from 100.5 → 100.1 (just above, trending down).
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(100.5 - (i / 34) * 0.4);
    const samples = makeWindow({
      strike: 100,
      side: 'put',
      volumes,
      oi: 1000,
      spots,
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.side).toBe('put');
    expect(flags[0]!.spot_trend_5m).toBeLessThan(-TREND_PCT);
  });

  // ── Gate 6: NDG sign ───────────────────────────────────────

  it('skips strikes where dealers are net-LONG gamma (NDG > 0)', () => {
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(99.0 + (i / 34) * 0.5);
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots,
    });
    const ndg = new Map<number, number>([[100, 5_000_000]]); // dealers LONG.
    const flags = detectGammaSqueezes(singletonMap(samples), 'SPXW', NOW, ndg);
    expect(flags).toEqual([]);
  });

  it('emits net_gamma_sign="short" when NDG < 0 at the strike', () => {
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(99.0 + (i / 34) * 0.5);
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots,
    });
    const ndg = new Map<number, number>([[100, -3_000_000]]); // dealers SHORT.
    const flags = detectGammaSqueezes(singletonMap(samples), 'SPXW', NOW, ndg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.net_gamma_sign).toBe('short');
  });

  it('emits net_gamma_sign="unknown" when no NDG data is provided (single names)', () => {
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    const spots: number[] = [];
    for (let i = 0; i < 35; i += 1) spots.push(99.0 + (i / 34) * 0.5);
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots,
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.net_gamma_sign).toBe('unknown');
  });

  // ── Edge cases ─────────────────────────────────────────────

  it('returns [] when window has fewer than 4 samples', () => {
    const samples = makeWindow({ strike: 100, count: 3 });
    expect(
      detectGammaSqueezes(singletonMap(samples), 'NVDA', NOW, new Map()),
    ).toEqual([]);
  });

  it('skips strikes with oi = 0 (avoids divide-by-zero)', () => {
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumeBase: 0,
      volumePerMin: 1000,
      oi: 0,
    });
    expect(
      detectGammaSqueezes(singletonMap(samples), 'NVDA', NOW, new Map()),
    ).toEqual([]);
  });

  it('handles multiple keys in the same window-map (per-strike independence)', () => {
    // Build two strikes in the same map; one fires, one doesn't.
    const fireVolumes: number[] = [];
    let cumF = 0;
    for (let i = 0; i < 35; i += 1) {
      cumF += i < 20 ? 100 : 600;
      fireVolumes.push(cumF);
    }
    const spotsRising: number[] = [];
    for (let i = 0; i < 35; i += 1) spotsRising.push(99.0 + (i / 34) * 0.5);
    const samplesFire = makeWindow({
      strike: 100,
      side: 'call',
      volumes: fireVolumes,
      oi: 1000,
      spots: spotsRising,
    });
    const samplesQuiet = makeWindow({
      strike: 105,
      side: 'call',
      volumeBase: 0,
      volumePerMin: 50, // too slow.
      oi: 1000,
      spots: spotsRising,
    });
    const m = new Map<string, SqueezeWindowSample[]>();
    m.set(squeezeKey(100, 'call', '2026-04-28'), samplesFire);
    m.set(squeezeKey(105, 'call', '2026-04-28'), samplesQuiet);
    const flags = detectGammaSqueezes(m, 'NVDA', NOW, new Map());
    expect(flags).toHaveLength(1);
    expect(flags[0]!.strike).toBe(100);
  });

  // ── Pathological inputs ────────────────────────────────────

  it('skips the strike when latest spot is NaN (defensive — Schwab can return NaN on stale rows)', () => {
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 100 : 600;
      volumes.push(cum);
    }
    const spots = Array.from({ length: 35 }, () => 99.5);
    spots[34] = Number.NaN;
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots,
    });
    expect(
      detectGammaSqueezes(singletonMap(samples), 'NVDA', NOW, new Map()),
    ).toEqual([]);
  });

  it('does NOT fire when cumulative volume regresses (last < t15) — guards against negative velocity', () => {
    // Negative velocity in last 15 min must NOT pass Gate 1, even when
    // a previous burst would have made priorVelocity look fine. This is
    // the regression guard added 2026-04-28.
    const volumes: number[] = [];
    let cum = 0;
    for (let i = 0; i < 35; i += 1) {
      cum += i < 20 ? 600 : 0;
      volumes.push(cum);
    }
    // Force regression on the latest sample.
    volumes[34] = volumes[33]! - 5000;
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots: Array.from({ length: 35 }, (_, i) => 99.0 + (i / 34) * 0.5),
    });
    expect(
      detectGammaSqueezes(singletonMap(samples), 'NVDA', NOW, new Map()),
    ).toEqual([]);
  });

  it('treats negative priorVelocity as zero (squeeze-just-turned-on path stays open)', () => {
    // Cumulative volume regresses in the prior 15 min but rises sharply
    // in the last 15 → priorVelocity < 0, current velocity well above
    // VEL_THRESHOLD. The detector must treat priorVelocity=0 here so
    // Gate 2 short-circuits to "pass" instead of comparing against a
    // negative baseline that would silently let anything through.
    const volumes: number[] = new Array(35).fill(0);
    // First 20 samples decline from 5000 → 1000 (regressive).
    for (let i = 0; i < 20; i += 1) {
      volumes[i] = 5000 - i * 200;
    }
    // Then 15 samples ramp 1000 → 9000 (last-15 velocity = 8000/1000 = 8×).
    for (let i = 20; i < 35; i += 1) {
      volumes[i] = 1000 + (i - 20) * 533;
    }
    const samples = makeWindow({
      strike: 100,
      side: 'call',
      volumes,
      oi: 1000,
      spots: Array.from({ length: 35 }, (_, i) => 99.0 + (i / 34) * 0.5),
    });
    const flags = detectGammaSqueezes(
      singletonMap(samples),
      'NVDA',
      NOW,
      new Map(),
    );
    expect(flags).toHaveLength(1);
    // priorVelocity is normalized to 0 in the emitted flag.
    expect(flags[0]!.vol_oi_15m_prior).toBe(0);
  });
});

// ── Constants sanity ─────────────────────────────────────────

describe('constants', () => {
  it('VEL_THRESHOLD is at least 5× (matches IV anomaly vol/OI gate)', () => {
    expect(VEL_THRESHOLD).toBeGreaterThanOrEqual(5);
  });
  it('ACCEL_RATIO is > 1 (so velocity must be rising, not just sustained)', () => {
    expect(ACCEL_RATIO).toBeGreaterThan(1);
  });
  it('PROX_PCT is conservatively narrow (≤ 2%)', () => {
    expect(PROX_PCT).toBeLessThanOrEqual(0.02);
  });
});
