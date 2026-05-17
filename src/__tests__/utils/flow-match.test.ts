import { describe, it, expect } from 'vitest';
import { computeFlowMatch } from '../../utils/flow-match';

describe('computeFlowMatch', () => {
  describe('calls', () => {
    it('returns match when cumNcp > cumNpp (positive delta)', () => {
      expect(computeFlowMatch('C', 31_500_000, -13_400_000)).toBe('match');
    });

    it('returns mismatch when cumNcp < cumNpp', () => {
      expect(computeFlowMatch('C', 5_000, 12_000)).toBe('mismatch');
    });

    it('returns mismatch when both sides are negative but NCP < NPP', () => {
      // NCP -100, NPP -50 → delta -50 → mismatch for a call
      expect(computeFlowMatch('C', -100, -50)).toBe('mismatch');
    });
  });

  describe('puts', () => {
    it('returns match when cumNpp > cumNcp (negative delta)', () => {
      expect(computeFlowMatch('P', 5_000, 12_000)).toBe('match');
    });

    it('returns mismatch when cumNcp > cumNpp', () => {
      expect(computeFlowMatch('P', 31_500_000, -13_400_000)).toBe('mismatch');
    });
  });

  describe('edge values', () => {
    it('returns flat when NCP === NPP exactly', () => {
      expect(computeFlowMatch('C', 1000, 1000)).toBe('flat');
      expect(computeFlowMatch('P', 0, 0)).toBe('flat');
    });

    it('returns unknown when cumNcp is null', () => {
      expect(computeFlowMatch('C', null, 100)).toBe('unknown');
    });

    it('returns unknown when cumNpp is null', () => {
      expect(computeFlowMatch('P', 100, null)).toBe('unknown');
    });

    it('returns unknown when both are null (cold start)', () => {
      expect(computeFlowMatch('C', null, null)).toBe('unknown');
      expect(computeFlowMatch('P', null, null)).toBe('unknown');
    });

    it('returns unknown when either is undefined', () => {
      expect(computeFlowMatch('C', undefined, 100)).toBe('unknown');
      expect(computeFlowMatch('P', 100, undefined)).toBe('unknown');
    });

    it('returns unknown when either input is NaN (corrupt upstream)', () => {
      // Defense-in-depth: a NaN slipping through from a bad parse
      // shouldn't silently render as Mismatch via the NaN < 0
      // fallthrough — surface it as unknown so the badge omits.
      expect(computeFlowMatch('C', Number.NaN, 100)).toBe('unknown');
      expect(computeFlowMatch('P', 100, Number.NaN)).toBe('unknown');
      expect(computeFlowMatch('C', Number.NaN, Number.NaN)).toBe('unknown');
    });

    it('returns unknown for non-finite values (Infinity)', () => {
      expect(computeFlowMatch('C', Number.POSITIVE_INFINITY, 100)).toBe(
        'unknown',
      );
      expect(computeFlowMatch('P', 100, Number.NEGATIVE_INFINITY)).toBe(
        'unknown',
      );
    });
  });
});
