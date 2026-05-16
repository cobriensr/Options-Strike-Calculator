import { describe, expect, it } from 'vitest';
import {
  detectSilentBoomFires,
  SILENT_BOOM_SPEC_V1,
  SILENT_BOOM_BUCKET_MS,
  type ChainBucket,
} from '../_lib/silent-boom.js';

// ============================================================
// Helpers — build a bucket sequence that satisfies the silent-boom
// pattern, then mutate one field at a time to verify each gate.
// ============================================================

const BASE_TS = new Date('2026-05-07T13:30:00Z'); // 08:30 CT

function makeBucket(
  bucketIdx: number,
  overrides: Partial<ChainBucket> = {},
): ChainBucket {
  return {
    bucket: new Date(BASE_TS.getTime() + bucketIdx * SILENT_BOOM_BUCKET_MS),
    size: 100,
    askSize: 60,
    bidSize: 40,
    multiLegSize: 0,
    maxOi: 5_000,
    vwap: 0.1,
    lastPrice: 0.1,
    ...overrides,
  };
}

/**
 * 5-bucket sequence: 4 silent baseline buckets (size=100) followed by
 * one boom bucket (size=2000, ask-dominant, vol/OI > 0.25). Should
 * fire exactly once.
 */
function fireableSequence(): ChainBucket[] {
  return [
    makeBucket(0, { size: 100 }),
    makeBucket(1, { size: 80 }),
    makeBucket(2, { size: 120 }),
    makeBucket(3, { size: 100 }),
    makeBucket(4, { size: 2_000, askSize: 1_700, bidSize: 300 }),
  ];
}

// ============================================================
// detectSilentBoomFires — single-fire happy path
// ============================================================

describe('detectSilentBoomFires', () => {
  it('emits one fire when all gates are satisfied', () => {
    const fires = detectSilentBoomFires(fireableSequence());
    expect(fires).toHaveLength(1);
    const f = fires[0]!;
    expect(f.spikeVolume).toBe(2_000);
    expect(f.baselineVolume).toBeCloseTo(100, 6); // median of [100,80,120,100]
    expect(f.spikeRatio).toBeCloseTo(20, 6);
    expect(f.askPct).toBeCloseTo(1700 / 2000, 6);
    expect(f.volOi).toBeCloseTo(2000 / 5000, 6);
    expect(f.entryPrice).toBe(0.1);
    expect(f.openInterest).toBe(5_000);
    expect(f.multiLegShare).toBe(0);
  });

  it('returns no fires when fewer than baseline+1 buckets exist', () => {
    const seq = fireableSequence().slice(
      0,
      SILENT_BOOM_SPEC_V1.baselineBuckets,
    );
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when baseline median exceeds the silence threshold', () => {
    // Baseline buckets at 600 each — above the 500 silence ceiling.
    const seq = [
      makeBucket(0, { size: 600 }),
      makeBucket(1, { size: 600 }),
      makeBucket(2, { size: 600 }),
      makeBucket(3, { size: 600 }),
      makeBucket(4, { size: 5_000, askSize: 4_000, bidSize: 1_000 }),
    ];
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when spike volume is below MIN_SPIKE_VOL', () => {
    const seq = fireableSequence();
    seq[4]!.size = SILENT_BOOM_SPEC_V1.minSpikeVol - 1;
    seq[4]!.askSize = 700;
    seq[4]!.bidSize = 200;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when spike volume is below SPIKE_MULTIPLIER × baseline', () => {
    // Baseline=100, spike=400 → 4× < required 5×.
    const seq = fireableSequence();
    seq[4]!.size = 400;
    seq[4]!.askSize = 300;
    seq[4]!.bidSize = 100;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when ask% is below threshold', () => {
    const seq = fireableSequence();
    seq[4]!.askSize = 1_000; // 50% ask — below 0.7
    seq[4]!.bidSize = 1_000;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when vol/OI is below threshold', () => {
    const seq = fireableSequence();
    seq[4]!.maxOi = 100_000; // 2000/100000 = 0.02 < 0.25
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when chain OI is below MIN_OI', () => {
    const seq = fireableSequence();
    for (const b of seq) b.maxOi = SILENT_BOOM_SPEC_V1.minOi - 1;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when both ask and bid sizes are zero (no side classification)', () => {
    const seq = fireableSequence();
    seq[4]!.askSize = 0;
    seq[4]!.bidSize = 0;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('uses vwap as entry when available, falls back to lastPrice', () => {
    const seq = fireableSequence();
    seq[4]!.vwap = 0.25;
    seq[4]!.lastPrice = 0.1;
    expect(detectSilentBoomFires(seq)[0]!.entryPrice).toBe(0.25);
  });

  it('falls back to lastPrice when vwap is NaN', () => {
    const seq = fireableSequence();
    seq[4]!.vwap = Number.NaN;
    seq[4]!.lastPrice = 0.07;
    expect(detectSilentBoomFires(seq)[0]!.entryPrice).toBe(0.07);
  });

  it('rejects when entry price is non-positive', () => {
    const seq = fireableSequence();
    seq[4]!.vwap = 0;
    seq[4]!.lastPrice = 0;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when multi-leg share meets or exceeds threshold', () => {
    const seq = fireableSequence();
    // 1400 of 2000 = 0.7 — at the 2026-05-16 retuned floor, gate uses ≥.
    seq[4]!.multiLegSize = 1_400;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('rejects when multi-leg share dominates (100%)', () => {
    const seq = fireableSequence();
    seq[4]!.multiLegSize = 2_000;
    expect(detectSilentBoomFires(seq)).toHaveLength(0);
  });

  it('accepts when multi-leg share is below threshold', () => {
    const seq = fireableSequence();
    // 1300 of 2000 = 0.65 — below the 0.7 floor (post 2026-05-16
    // EDA-rerun retune from 0.5). This bucket previously would have
    // been rejected at 0.5; the rerun showed it preserves meaningful
    // signal (mean peak 42%, 11% hit ≥100% peak).
    seq[4]!.multiLegSize = 1_300;
    const fires = detectSilentBoomFires(seq);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.multiLegShare).toBeCloseTo(0.65, 6);
  });

  it('accepts a previously-rejected 0.5 bucket post-retune', () => {
    // Regression test for the 2026-05-16 relaxation from 0.5 → 0.7.
    // 1000 of 2000 = 0.5 was AT the old floor (rejected); post-retune
    // it sits comfortably below 0.7 and a fire should emit.
    const seq = fireableSequence();
    seq[4]!.multiLegSize = 1_000;
    const fires = detectSilentBoomFires(seq);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.multiLegShare).toBeCloseTo(0.5, 6);
  });
});

// ============================================================
// detectSilentBoomFires — cooldown + multi-fire
// ============================================================

describe('detectSilentBoomFires — cooldown', () => {
  it('emits two fires when separated by ≥ cooldown buckets', () => {
    const cool = SILENT_BOOM_SPEC_V1.cooldownBuckets;
    const seq: ChainBucket[] = [
      ...fireableSequence(), // fire at bucket index 4
    ];
    // Pad with silent buckets until cooldown elapses, then fire again.
    for (let i = 5; i < 4 + cool; i++) {
      seq.push(makeBucket(i, { size: 50 }));
    }
    // Second silent baseline window then second boom.
    seq.push(makeBucket(4 + cool, { size: 80 }));
    seq.push(
      makeBucket(4 + cool + 1, {
        size: 3_000,
        askSize: 2_500,
        bidSize: 500,
      }),
    );
    const fires = detectSilentBoomFires(seq);
    expect(fires.length).toBeGreaterThanOrEqual(2);
  });

  it('suppresses a second fire within the cooldown window', () => {
    // First fire at i=4. Second candidate at i=5 (within cooldown).
    const seq = [
      ...fireableSequence(),
      makeBucket(5, { size: 3_000, askSize: 2_500, bidSize: 500 }),
    ];
    expect(detectSilentBoomFires(seq)).toHaveLength(1);
  });

  it('honors priorLastFireMs from a prior cron tick', () => {
    // Same fireable sequence — but seed cooldown from a fresh prior
    // fire 1 minute before the spike bucket. Should suppress.
    const seq = fireableSequence();
    const priorMs = seq[4]!.bucket.getTime() - 60_000;
    expect(detectSilentBoomFires(seq, priorMs)).toHaveLength(0);
  });
});
