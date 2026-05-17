import { describe, it, expect } from 'vitest';
import { computeFlowInverted } from '../../utils/flow-inverted';

describe('computeFlowInverted', () => {
  describe('inverted', () => {
    it('returns inverted when call alert was matched at fire and current is mismatched', () => {
      // Fire-time: NCP > NPP (match for call). Current: NCP < NPP (mismatch).
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: 10_000,
          fireTimeCumNpp: 2_000,
          currentCumNcp: 3_000,
          currentCumNpp: 15_000,
        }),
      ).toBe('inverted');
    });

    it('returns inverted when put alert was matched at fire and current is mismatched', () => {
      // Fire-time: NPP > NCP (match for put). Current: NPP < NCP.
      expect(
        computeFlowInverted({
          optionType: 'P',
          fireTimeCumNcp: 2_000,
          fireTimeCumNpp: 10_000,
          currentCumNcp: 20_000,
          currentCumNpp: 3_000,
        }),
      ).toBe('inverted');
    });

    it('treats current=flat as not-match → inverted when fire was match', () => {
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: 10_000,
          fireTimeCumNpp: 1_000,
          currentCumNcp: 5_000,
          currentCumNpp: 5_000,
        }),
      ).toBe('inverted');
    });
  });

  describe('stable', () => {
    it('returns stable when fire was match and current still matches', () => {
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: 10_000,
          fireTimeCumNpp: 1_000,
          currentCumNcp: 20_000,
          currentCumNpp: 5_000,
        }),
      ).toBe('stable');
    });

    it('returns stable when fire was mismatched (never had tailwind)', () => {
      // Even if current flipped to match, "inverted" applies only when
      // the alert had a tailwind that reversed. A mismatched-at-fire
      // trade that later gains a tailwind is not an exit signal.
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: 1_000,
          fireTimeCumNpp: 10_000,
          currentCumNcp: 20_000,
          currentCumNpp: 5_000,
        }),
      ).toBe('stable');
    });

    it('returns stable when fire was flat (no directional bias to invert)', () => {
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: 5_000,
          fireTimeCumNpp: 5_000,
          currentCumNcp: 1_000,
          currentCumNpp: 15_000,
        }),
      ).toBe('stable');
    });
  });

  describe('unknown', () => {
    it('returns unknown when fire-time snapshot is missing', () => {
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: null,
          fireTimeCumNpp: null,
          currentCumNcp: 20_000,
          currentCumNpp: 5_000,
        }),
      ).toBe('unknown');
    });

    it('returns unknown when current snapshot is missing', () => {
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: 10_000,
          fireTimeCumNpp: 1_000,
          currentCumNcp: null,
          currentCumNpp: null,
        }),
      ).toBe('unknown');
    });

    it('returns unknown when both are missing', () => {
      expect(
        computeFlowInverted({
          optionType: 'P',
          fireTimeCumNcp: null,
          fireTimeCumNpp: null,
          currentCumNcp: null,
          currentCumNpp: null,
        }),
      ).toBe('unknown');
    });

    it('returns unknown when either side is NaN', () => {
      expect(
        computeFlowInverted({
          optionType: 'C',
          fireTimeCumNcp: Number.NaN,
          fireTimeCumNpp: 1_000,
          currentCumNcp: 5_000,
          currentCumNpp: 1_000,
        }),
      ).toBe('unknown');
    });
  });
});
