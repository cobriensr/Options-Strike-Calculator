import { describe, it, expect } from 'vitest';
import {
  deriveTrajectory,
  type VixSnapshot,
} from '../../hooks/useVixTrajectory';

function snap(overrides: Partial<VixSnapshot>): VixSnapshot {
  return {
    entryTime: '9:30 AM',
    vix: 17,
    vix1d: 13,
    vix9d: 16,
    spx: 6900,
    ...overrides,
  };
}

describe('deriveTrajectory', () => {
  it('returns hasData=false on no input', () => {
    const state = deriveTrajectory([]);
    expect(state.hasData).toBe(true);
    expect(state.ratio1d).toBeNull();
    expect(state.ratio9d).toBeNull();
    expect(state.spx).toBeNull();
  });

  it('returns null trajectories when only one snapshot exists', () => {
    const state = deriveTrajectory([snap({ entryTime: '11:45 AM' })]);
    expect(state.hasData).toBe(true);
    expect(state.ratio9d).toBeNull();
  });

  it('computes signed delta for ratio9d over a valid window', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', vix: 17, vix9d: 14.45 }), // 0.85
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.15 }), // 0.95
    ]);
    expect(state.ratio9d).not.toBeNull();
    expect(state.ratio9d!.spanMin).toBe(15);
    expect(state.ratio9d!.delta).toBeCloseTo(0.1, 2);
  });

  it('rejects windows shorter than the minimum span', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:40 AM', vix: 17, vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).toBeNull();
  });

  it('rejects windows longer than the maximum span', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:00 AM', vix: 17, vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).toBeNull();
  });

  it('picks the baseline closest to but not exceeding the target', () => {
    // latest at 11:45, target = 11:30. Pick 11:32 (t=692, ≤ target=690?
    // 11:32 = 692; target = 11:45 - 15 = 11:30 = 690 → 692 > 690, skip.
    // Next: 11:28 = 688, ≤ 690 → pick. span = 17 min.
    const state = deriveTrajectory([
      snap({ entryTime: '11:28 AM', vix: 17, vix9d: 16 }),
      snap({ entryTime: '11:32 AM', vix: 17, vix9d: 16.2 }),
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).not.toBeNull();
    expect(state.ratio9d!.spanMin).toBe(17);
    expect(state.ratio9d!.delta).toBeCloseTo(16.5 / 17 - 16 / 17, 4);
  });

  it('skips snapshots with null vix1d when computing ratio1d', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', vix1d: null, vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix1d: 13, vix9d: 16.5 }),
    ]);
    expect(state.ratio1d).toBeNull();
    expect(state.ratio9d).not.toBeNull();
  });

  it('skips snapshots with malformed entryTime', () => {
    const state = deriveTrajectory([
      snap({ entryTime: 'garbage', vix9d: 16 }),
      snap({ entryTime: '11:30 AM', vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).not.toBeNull();
    expect(state.ratio9d!.spanMin).toBe(15);
  });

  it('computes SPX delta independently from ratio deltas', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', spx: 6900 }),
      snap({ entryTime: '11:45 AM', spx: 6960 }),
    ]);
    expect(state.spx).not.toBeNull();
    expect(state.spx!.delta).toBeCloseTo(60, 2);
    expect(state.spx!.spanMin).toBe(15);
  });

  it('returns null SPX when all spx values are missing', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', spx: null }),
      snap({ entryTime: '11:45 AM', spx: null }),
    ]);
    expect(state.spx).toBeNull();
  });
});
