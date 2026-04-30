// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  computeSessionConsensus,
  MIN_TICKS_FOR_CONSENSUS,
  WINDOW_MINUTES,
  type ConsensusInput,
} from '../_lib/trace-live-consensus.js';

function tick(over: Partial<ConsensusInput>): ConsensusInput {
  return {
    id: 1,
    capturedAt: new Date('2026-04-29T19:52:00Z'),
    regime: 'trending_negative_gamma',
    predictedClose: 7131,
    ...over,
  };
}

describe('computeSessionConsensus', () => {
  it('returns null on empty input', () => {
    expect(computeSessionConsensus([])).toBeNull();
  });

  it('returns null when fewer than MIN_TICKS_FOR_CONSENSUS same-regime ticks', () => {
    const ticks = Array.from({ length: MIN_TICKS_FOR_CONSENSUS - 1 }, (_, i) =>
      tick({
        id: i + 1,
        capturedAt: new Date(2026, 3, 29, 14 + i, 0),
      }),
    );
    expect(computeSessionConsensus(ticks)).toBeNull();
  });

  it('computes weighted-mean consensus across same-regime ticks', () => {
    // Three captures at 14:00, 14:30, 14:52 (seed). Regime stable.
    const ticks: ConsensusInput[] = [
      tick({
        id: 1,
        capturedAt: new Date('2026-04-29T19:00:00Z'),
        predictedClose: 7100,
      }),
      tick({
        id: 2,
        capturedAt: new Date('2026-04-29T19:30:00Z'),
        predictedClose: 7120,
      }),
      tick({
        id: 3,
        capturedAt: new Date('2026-04-29T19:52:00Z'),
        predictedClose: 7131,
      }),
    ];
    const out = computeSessionConsensus(ticks);
    expect(out).not.toBeNull();
    expect(out?.agreementCount).toBe(3);
    // Seed (id 3, age=0) has weight 1.0; id 2 (age=22min, w=0.908); id 1 (age=52min, w=0.783).
    // Verify the consensus is between the min and max samples and closer to the seed.
    expect(out!.consensusClose).toBeGreaterThan(7100);
    expect(out!.consensusClose).toBeLessThan(7131);
    expect(out!.consensusClose).toBeGreaterThan(7115); // closer to seed
    expect(out?.sourceTickIds).toEqual([3, 2, 1]); // sorted newest-first
  });

  it('filters out ticks with a different regime', () => {
    const ticks: ConsensusInput[] = [
      tick({
        id: 1,
        capturedAt: new Date('2026-04-29T19:00:00Z'),
        regime: 'range_bound_positive_gamma', // EXCLUDE
        predictedClose: 9999,
      }),
      tick({
        id: 2,
        capturedAt: new Date('2026-04-29T19:30:00Z'),
        regime: 'trending_negative_gamma',
        predictedClose: 7120,
      }),
      tick({
        id: 3,
        capturedAt: new Date('2026-04-29T19:45:00Z'),
        regime: 'trending_negative_gamma',
        predictedClose: 7125,
      }),
      tick({
        id: 4,
        capturedAt: new Date('2026-04-29T19:52:00Z'),
        regime: 'trending_negative_gamma',
        predictedClose: 7131,
      }),
    ];
    const out = computeSessionConsensus(ticks);
    expect(out).not.toBeNull();
    expect(out?.agreementCount).toBe(3);
    expect(out?.sourceTickIds).not.toContain(1);
    // Outlier 9999 shouldn't pollute the consensus.
    expect(out!.consensusClose).toBeLessThan(7140);
  });

  it('filters out ticks older than WINDOW_MINUTES', () => {
    const seed = new Date('2026-04-29T19:52:00Z');
    const tooOld = new Date(seed.getTime() - (WINDOW_MINUTES + 1) * 60_000);
    const ticks: ConsensusInput[] = [
      tick({ id: 1, capturedAt: tooOld, predictedClose: 9999 }), // EXCLUDE
      tick({
        id: 2,
        capturedAt: new Date(seed.getTime() - 30 * 60_000),
        predictedClose: 7120,
      }),
      tick({
        id: 3,
        capturedAt: new Date(seed.getTime() - 60 * 60_000),
        predictedClose: 7125,
      }),
      tick({ id: 4, capturedAt: seed, predictedClose: 7131 }),
    ];
    const out = computeSessionConsensus(ticks);
    expect(out).not.toBeNull();
    expect(out?.agreementCount).toBe(3);
    expect(out?.sourceTickIds).not.toContain(1);
  });

  it('filters out ticks from a different trading day', () => {
    const seed = new Date('2026-04-29T19:52:00Z');
    const ticks: ConsensusInput[] = [
      // Yesterday's late-session capture — same regime but different session.
      tick({
        id: 1,
        capturedAt: new Date('2026-04-28T19:30:00Z'),
        predictedClose: 9999,
      }),
      tick({
        id: 2,
        capturedAt: new Date('2026-04-29T19:00:00Z'),
        predictedClose: 7100,
      }),
      tick({
        id: 3,
        capturedAt: new Date('2026-04-29T19:30:00Z'),
        predictedClose: 7125,
      }),
      tick({ id: 4, capturedAt: seed, predictedClose: 7131 }),
    ];
    const out = computeSessionConsensus(ticks);
    expect(out).not.toBeNull();
    expect(out?.agreementCount).toBe(3);
    expect(out?.sourceTickIds).not.toContain(1);
  });

  it('returns 0 stdev when all source ticks agree exactly', () => {
    const ticks: ConsensusInput[] = [
      tick({ id: 1, capturedAt: new Date('2026-04-29T19:00:00Z'), predictedClose: 7150 }),
      tick({ id: 2, capturedAt: new Date('2026-04-29T19:30:00Z'), predictedClose: 7150 }),
      tick({ id: 3, capturedAt: new Date('2026-04-29T19:52:00Z'), predictedClose: 7150 }),
    ];
    const out = computeSessionConsensus(ticks);
    expect(out?.stdev).toBe(0);
    expect(out?.consensusClose).toBe(7150);
  });
});
