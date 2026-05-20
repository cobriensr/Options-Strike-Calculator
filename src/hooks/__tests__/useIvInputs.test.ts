import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULTS, IV_MODES } from '../../constants/index';
import { useIvInputs } from '../useIvInputs';

const DEBOUNCE_MS = 300;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useIvInputs', () => {
  describe('defaults', () => {
    it("seeds ivMode='vix', vixInput='19', multiplier from DEFAULTS, directIV empty", () => {
      const { result } = renderHook(() => useIvInputs());
      expect(result.current.ivMode).toBe(IV_MODES.VIX);
      expect(result.current.vixInput).toBe('19');
      expect(result.current.multiplier).toBe(String(DEFAULTS.IV_PREMIUM_FACTOR));
      expect(result.current.directIVInput).toBe('');
    });
  });

  describe('setters', () => {
    it('updates ivMode', () => {
      const { result } = renderHook(() => useIvInputs());
      act(() => result.current.setIvMode(IV_MODES.DIRECT));
      expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    });

    it('updates vixInput and the debounced dVix after delay', () => {
      const { result } = renderHook(() => useIvInputs());
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.dVix).toBe('19');
      act(() => result.current.setVixInput('22'));
      expect(result.current.dVix).toBe('19');
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.dVix).toBe('22');
    });

    it('updates directIVInput + dIV', () => {
      const { result } = renderHook(() => useIvInputs());
      act(() => result.current.setDirectIVInput('0.25'));
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.directIVInput).toBe('0.25');
      expect(result.current.dIV).toBe('0.25');
    });

    it('updates multiplier + dMult', () => {
      const { result } = renderHook(() => useIvInputs());
      act(() => result.current.setMultiplier('1.2'));
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
      expect(result.current.multiplier).toBe('1.2');
      expect(result.current.dMult).toBe('1.2');
    });
  });
});
