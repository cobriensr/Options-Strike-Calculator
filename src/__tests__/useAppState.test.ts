import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAppState } from '../hooks/useAppState';
import { DEFAULTS, IV_MODES } from '../constants';

describe('useAppState', () => {
  // ── Default values ──

  it('returns correct default values', () => {
    const { result } = renderHook(() => useAppState());
    const s = result.current;

    expect(s.darkMode).toBe(false);
    expect(s.spotPrice).toBe('');
    expect(s.spxDirect).toBe('');
    expect(s.spxRatio).toBe(10);
    expect(s.ivMode).toBe(IV_MODES.VIX);
    expect(s.vixInput).toBe('');
    expect(s.multiplier).toBe(String(DEFAULTS.IV_PREMIUM_FACTOR));
    expect(s.directIVInput).toBe('');
    expect(s.timeHour).toBe('10');
    expect(s.timeMinute).toBe('00');
    expect(s.timeAmPm).toBe('AM');
    expect(s.timezone).toBe('CT');
    expect(s.wingWidth).toBe(20);
    expect(s.showIC).toBe(true);
    expect(s.contracts).toBe(20);
    expect(s.skewPct).toBe(3);
    expect(s.clusterMult).toBe(1);
  });

  it('debounced values start matching initial state', () => {
    const { result } = renderHook(() => useAppState());
    expect(result.current.dSpot).toBe('');
    expect(result.current.dSpx).toBe('');
    expect(result.current.dVix).toBe('');
    expect(result.current.dIV).toBe('');
    expect(result.current.dMult).toBe(String(DEFAULTS.IV_PREMIUM_FACTOR));
  });

  // ── Setters ──

  it('setDarkMode toggles theme', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setDarkMode(true));
    expect(result.current.darkMode).toBe(true);
  });

  it('setSpotPrice updates spotPrice', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setSpotPrice('580.50'));
    expect(result.current.spotPrice).toBe('580.50');
  });

  it('setSpxDirect updates spxDirect', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setSpxDirect('5800'));
    expect(result.current.spxDirect).toBe('5800');
  });

  it('setSpxRatio updates spxRatio', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setSpxRatio(10.08));
    expect(result.current.spxRatio).toBe(10.08);
  });

  it('setIvMode updates ivMode', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setIvMode(IV_MODES.DIRECT));
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
  });

  it('setVixInput updates vixInput', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setVixInput('22.5'));
    expect(result.current.vixInput).toBe('22.5');
  });

  it('setMultiplier updates multiplier', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setMultiplier('0.85'));
    expect(result.current.multiplier).toBe('0.85');
  });

  it('setDirectIVInput updates directIVInput', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setDirectIVInput('0.1520'));
    expect(result.current.directIVInput).toBe('0.1520');
  });

  it('setTimeHour/setTimeMinute/setTimeAmPm/setTimezone update time state', () => {
    const { result } = renderHook(() => useAppState());
    act(() => {
      result.current.setTimeHour('2');
      result.current.setTimeMinute('30');
      result.current.setTimeAmPm('PM');
      result.current.setTimezone('ET');
    });
    expect(result.current.timeHour).toBe('2');
    expect(result.current.timeMinute).toBe('30');
    expect(result.current.timeAmPm).toBe('PM');
    expect(result.current.timezone).toBe('ET');
  });

  it('setWingWidth updates wingWidth', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setWingWidth(30));
    expect(result.current.wingWidth).toBe(30);
  });

  it('setShowIC updates showIC', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setShowIC(false));
    expect(result.current.showIC).toBe(false);
  });

  it('setContracts updates contracts', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setContracts(50));
    expect(result.current.contracts).toBe(50);
  });

  it('setSkewPct updates skewPct', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setSkewPct(5));
    expect(result.current.skewPct).toBe(5);
  });

  it('setClusterMult updates clusterMult', () => {
    const { result } = renderHook(() => useAppState());
    act(() => result.current.setClusterMult(2));
    expect(result.current.clusterMult).toBe(2);
  });

  // ── Derived ratio ──

  it('effectiveRatio falls back to spxRatio when no valid SPX/SPY', () => {
    const { result } = renderHook(() => useAppState());
    expect(result.current.spxDirectActive).toBe(false);
    expect(result.current.effectiveRatio).toBe(10);
  });

  it('effectiveRatio computes spxVal/spyVal when both are valid', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAppState());
    act(() => {
      result.current.setSpotPrice('580');
      result.current.setSpxDirect('5820');
    });
    act(() => vi.advanceTimersByTime(350));
    expect(result.current.spxDirectActive).toBe(true);
    expect(result.current.effectiveRatio).toBeCloseTo(5820 / 580, 2);
    vi.useRealTimers();
  });

  it('spxDirectActive is false when spxDirect is zero', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAppState());
    act(() => {
      result.current.setSpotPrice('580');
      result.current.setSpxDirect('0');
    });
    act(() => vi.advanceTimersByTime(350));
    expect(result.current.spxDirectActive).toBe(false);
    vi.useRealTimers();
  });

  it('spxDirectActive is false when spotPrice is not a number', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAppState());
    act(() => {
      result.current.setSpotPrice('abc');
      result.current.setSpxDirect('5800');
    });
    act(() => vi.advanceTimersByTime(350));
    expect(result.current.spxDirectActive).toBe(false);
    vi.useRealTimers();
  });
});
