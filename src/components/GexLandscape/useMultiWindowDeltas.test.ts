/**
 * Unit tests for useMultiWindowDeltas — keyed delta-map state for
 * GexLandscape. Verifies the per-window guarantees that the consuming
 * panel relies on:
 *
 *   - One Map per declared window from first render onward.
 *   - Atomic patches (single React commit per setDeltaMaps call).
 *   - Patches for windows that were not declared at construction
 *     are silently dropped (no state escape).
 *   - clearAll resets every window to a fresh empty Map.
 *   - The windows array is captured at first render — passing a new
 *     literal each render does not reset state or reset accumulated
 *     maps.
 */

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMultiWindowDeltas } from './useMultiWindowDeltas';

describe('useMultiWindowDeltas', () => {
  it('initializes with an empty Map for each declared window', () => {
    const { result } = renderHook(() =>
      useMultiWindowDeltas([1, 5, 10, 15, 30]),
    );

    expect(
      Object.keys(result.current.deltaMaps)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1, 5, 10, 15, 30]);
    for (const w of [1, 5, 10, 15, 30]) {
      expect(result.current.deltaMaps[w]).toBeInstanceOf(Map);
      expect(result.current.deltaMaps[w]?.size).toBe(0);
    }
  });

  it('atomically updates multiple windows via setDeltaMaps', () => {
    const { result } = renderHook(() => useMultiWindowDeltas([1, 5, 10]));
    const m1 = new Map<number, number | null>([[5800, 0.012]]);
    const m5 = new Map<number, number | null>([[5800, 0.034]]);
    const m10 = new Map<number, number | null>([[5800, 0.056]]);

    act(() => {
      result.current.setDeltaMaps({ 1: m1, 5: m5, 10: m10 });
    });

    expect(result.current.deltaMaps[1]).toBe(m1);
    expect(result.current.deltaMaps[5]).toBe(m5);
    expect(result.current.deltaMaps[10]).toBe(m10);
  });

  it('partial patches leave non-targeted windows unchanged', () => {
    const { result } = renderHook(() => useMultiWindowDeltas([1, 5, 10]));
    const initial5 = result.current.deltaMaps[5];
    const m1 = new Map<number, number | null>([[5800, 0.025]]);

    act(() => {
      result.current.setDeltaMaps({ 1: m1 });
    });

    expect(result.current.deltaMaps[1]).toBe(m1);
    // Untouched windows preserve identity.
    expect(result.current.deltaMaps[5]).toBe(initial5);
  });

  it('drops patch entries for undeclared windows', () => {
    const { result } = renderHook(() => useMultiWindowDeltas([1, 5]));
    const stray = new Map<number, number | null>([[6000, 0.01]]);

    act(() => {
      // 99 was never declared — should be ignored.
      result.current.setDeltaMaps({ 99: stray });
    });

    expect(result.current.deltaMaps[99]).toBeUndefined();
    expect(Object.keys(result.current.deltaMaps).map(Number).sort()).toEqual([
      1, 5,
    ]);
  });

  it('clearAll resets every window to a fresh empty Map', () => {
    const { result } = renderHook(() => useMultiWindowDeltas([1, 5, 30]));
    const m1 = new Map<number, number | null>([[5800, 0.01]]);

    act(() => {
      result.current.setDeltaMaps({ 1: m1, 5: m1, 30: m1 });
    });
    expect(result.current.deltaMaps[1]?.size).toBe(1);

    act(() => {
      result.current.clearAll();
    });

    for (const w of [1, 5, 30]) {
      expect(result.current.deltaMaps[w]).toBeInstanceOf(Map);
      expect(result.current.deltaMaps[w]?.size).toBe(0);
    }
  });

  it('keeps state stable when the windows array changes identity but contents match', () => {
    // The hook captures `windows` at first render; passing a new
    // literal each render must NOT reset state.
    const { result, rerender } = renderHook(
      ({ windows }) => useMultiWindowDeltas(windows),
      { initialProps: { windows: [1, 5, 10] } },
    );
    const m5 = new Map<number, number | null>([[5800, 0.04]]);
    act(() => {
      result.current.setDeltaMaps({ 5: m5 });
    });
    expect(result.current.deltaMaps[5]).toBe(m5);

    rerender({ windows: [1, 5, 10] }); // new array literal, same contents
    expect(result.current.deltaMaps[5]).toBe(m5);
  });

  it('no-ops when the patch contains no usable entries', () => {
    const { result } = renderHook(() => useMultiWindowDeltas([1, 5]));
    const beforeMaps = result.current.deltaMaps;

    act(() => {
      // Nothing in this patch matches a declared window → state
      // identity should be preserved.
      result.current.setDeltaMaps({ 99: new Map() });
    });

    expect(result.current.deltaMaps).toBe(beforeMaps);
  });
});
