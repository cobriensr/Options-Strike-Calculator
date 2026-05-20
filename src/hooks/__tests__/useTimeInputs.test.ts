import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTimeInputs } from '../useTimeInputs';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTimeInputs', () => {
  describe('outside market hours (default fallback)', () => {
    beforeEach(() => {
      // Use a Saturday so we're guaranteed outside the 9:30 AM ET –
      // 4:00 PM ET market-hours window (the seed function checks ET
      // wall-clock; a weekend just makes the test stable regardless
      // of what time zone the host machine is in).
      vi.setSystemTime(new Date('2026-05-23T02:00:00Z'));
    });

    it("seeds to 10:00 AM CT (timeHour '10', timeMinute '00', AM)", () => {
      const { result } = renderHook(() => useTimeInputs());
      expect(result.current.timeHour).toBe('10');
      expect(result.current.timeMinute).toBe('00');
      expect(result.current.timeAmPm).toBe('AM');
    });

    it("seeds timezone to 'CT'", () => {
      const { result } = renderHook(() => useTimeInputs());
      expect(result.current.timezone).toBe('CT');
    });
  });

  describe('setters', () => {
    it('updates timeHour', () => {
      const { result } = renderHook(() => useTimeInputs());
      act(() => result.current.setTimeHour('11'));
      expect(result.current.timeHour).toBe('11');
    });

    it('updates timeMinute', () => {
      const { result } = renderHook(() => useTimeInputs());
      act(() => result.current.setTimeMinute('15'));
      expect(result.current.timeMinute).toBe('15');
    });

    it('updates timeAmPm', () => {
      const { result } = renderHook(() => useTimeInputs());
      act(() => result.current.setTimeAmPm('PM'));
      expect(result.current.timeAmPm).toBe('PM');
    });

    it("updates timezone (toggles to 'ET')", () => {
      const { result } = renderHook(() => useTimeInputs());
      act(() => result.current.setTimezone('ET'));
      expect(result.current.timezone).toBe('ET');
    });
  });
});
