import { describe, it, expect } from 'vitest';
import { computeExitNow } from '../../utils/exit-now';

describe('computeExitNow', () => {
  it('returns inactive when nothing has fired', () => {
    expect(
      computeExitNow({ remainingMin: 120, flowInverted: false }),
    ).toEqual({ active: false, reason: null });
  });

  it('returns expired when countdown elapsed but flow has not inverted', () => {
    expect(computeExitNow({ remainingMin: 0, flowInverted: false })).toEqual({
      active: true,
      reason: 'expired',
    });
    expect(computeExitNow({ remainingMin: -10, flowInverted: false })).toEqual(
      { active: true, reason: 'expired' },
    );
  });

  it('returns inverted when flow flipped but countdown still in window', () => {
    expect(computeExitNow({ remainingMin: 60, flowInverted: true })).toEqual({
      active: true,
      reason: 'inverted',
    });
  });

  it('returns expired_and_inverted when both fired', () => {
    expect(computeExitNow({ remainingMin: -5, flowInverted: true })).toEqual({
      active: true,
      reason: 'expired_and_inverted',
    });
  });

  it('treats remainingMin=null (no cohort stat) as "not expired"', () => {
    // Without a cohort, we cannot say the window passed.
    expect(
      computeExitNow({ remainingMin: null, flowInverted: false }),
    ).toEqual({ active: false, reason: null });
    // But a flow inversion alone is still actionable.
    expect(computeExitNow({ remainingMin: null, flowInverted: true })).toEqual({
      active: true,
      reason: 'inverted',
    });
  });
});
