import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSpotInputs } from '../useSpotInputs';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * useDebounced (300ms default) is used internally. Tests that need the
 * debounced value need to advance fake timers past the delay.
 */
const DEBOUNCE_MS = 300;

describe('useSpotInputs', () => {
  describe('defaults', () => {
    it("seeds spotPrice='572', spxDirect='5720', spxRatio=10", () => {
      const { result } = renderHook(() => useSpotInputs());
      expect(result.current.spotPrice).toBe('572');
      expect(result.current.spxDirect).toBe('5720');
      expect(result.current.spxRatio).toBe(10);
    });
  });

  describe('derived (spxDirectActive=true, both inputs valid)', () => {
    it('computes effectiveRatio as spxVal/spyVal once debounced', () => {
      const { result } = renderHook(() => useSpotInputs());
      // Default inputs (5720/572) → effectiveRatio = 10 (derived ratio).
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.spxDirectActive).toBe(true);
      expect(result.current.spyVal).toBe(572);
      expect(result.current.spxVal).toBe(5720);
      expect(result.current.effectiveRatio).toBeCloseTo(10);
    });

    it('updates effectiveRatio when spxDirect changes (after debounce)', () => {
      const { result } = renderHook(() => useSpotInputs());
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.effectiveRatio).toBeCloseTo(10);
      act(() => result.current.setSpxDirect('6000'));
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      // spxVal/spyVal = 6000/572 ≈ 10.489
      expect(result.current.effectiveRatio).toBeCloseTo(6000 / 572);
    });
  });

  describe('derived (spxDirectActive=false, falls back to spxRatio)', () => {
    it('falls back to spxRatio when spxDirect is empty', () => {
      const { result } = renderHook(() => useSpotInputs());
      act(() => result.current.setSpxDirect(''));
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.spxDirectActive).toBe(false);
      expect(result.current.effectiveRatio).toBe(10);
    });

    it('falls back to spxRatio when spxDirect is non-numeric', () => {
      const { result } = renderHook(() => useSpotInputs());
      act(() => result.current.setSpxDirect('not-a-number'));
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.spxDirectActive).toBe(false);
      expect(result.current.effectiveRatio).toBe(10);
    });

    it('respects the manual spxRatio when SPX direct is inactive', () => {
      const { result } = renderHook(() => useSpotInputs());
      act(() => result.current.setSpxDirect(''));
      act(() => result.current.setSpxRatio(11));
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.spxDirectActive).toBe(false);
      expect(result.current.effectiveRatio).toBe(11);
    });
  });

  describe('debounce timing', () => {
    it('does not change dSpot until the debounce timer fires', () => {
      const { result } = renderHook(() => useSpotInputs());
      // First flush the initial debounce so we have a baseline.
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      const baselineDSpot = result.current.dSpot;
      expect(baselineDSpot).toBe('572');

      act(() => result.current.setSpotPrice('600'));
      // Before the debounce fires, dSpot still holds the prior value.
      expect(result.current.dSpot).toBe('572');
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.dSpot).toBe('600');
    });
  });
});
