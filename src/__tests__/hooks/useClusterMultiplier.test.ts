import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useClusterMultiplier } from '../../hooks/useClusterMultiplier';
import { useRegimeClassification } from '../../hooks/useRegimeClassification';

/**
 * F24: the cluster multiplier used to exist only inside the Volatility
 * Clustering panel's effect, so with the Market Regime card closed (the
 * default) the app used and saved 1. These tests render the hook with no
 * panel anywhere: the value App reads must be right on its own.
 */
type Args = Parameters<typeof useClusterMultiplier>[0];

// VIX 22 (mid regime). 100 pts / 6800 = 1.47% -> Normal (p50-p75) -> 0.969.
const NORMAL_DAY = { open: 6800, high: 6850, low: 6750 };
// 174.4 pts / 6681.78 = 2.61% -> above p90 (2.15%) -> Hot -> 1.203.
const HOT_DAY = { open: 6681.78, high: 6810.44, low: 6636.04 };

function args(patch: Partial<Args> = {}): Args {
  return {
    vix: 22,
    spot: 6800,
    yesterday: NORMAL_DAY,
    scope: '2026-11-06',
    ...patch,
  };
}

describe('useClusterMultiplier: computed from the app inputs', () => {
  it('has the multiplier on the first render, never a transient 1', () => {
    const seen: number[] = [];
    renderHook(() => {
      const cluster = useClusterMultiplier(args({ yesterday: HOT_DAY }));
      seen.push(cluster.signal.mult);
      return cluster;
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((m) => m === 1.203)).toBe(true);
  });

  it('computes the multiplier with no panel mounted', () => {
    const { result } = renderHook(() => useClusterMultiplier(args()));
    expect(result.current.signal.mult).toBe(0.969);
    expect(result.current.signal.cluster?.yesterdayPctile).toBe(
      'Normal (p50–p75)',
    );
  });

  it('shows yesterday as two-decimal strings', () => {
    const { result } = renderHook(() =>
      useClusterMultiplier(args({ yesterday: HOT_DAY })),
    );
    expect(result.current.inputs).toEqual({
      open: '6681.78',
      high: '6810.44',
      low: '6636.04',
    });
  });

  it('is 1 with empty inputs while yesterday is missing', () => {
    const { result } = renderHook(() =>
      useClusterMultiplier(args({ yesterday: null })),
    );
    expect(result.current.signal.mult).toBe(1);
    expect(result.current.signal.rangePct).toBeNull();
    expect(result.current.inputs).toEqual({ open: '', high: '', low: '' });
  });

  it('is 1 while the VIX is missing, then the multiplier once it arrives', () => {
    const { result, rerender } = renderHook(
      (a: Args) => useClusterMultiplier(a),
      { initialProps: args({ vix: null }) },
    );
    expect(result.current.signal.mult).toBe(1);
    rerender(args({ vix: 22 }));
    expect(result.current.signal.mult).toBe(0.969);
  });

  it('follows yesterday when it arrives late (a live feed after first paint)', () => {
    const { result, rerender } = renderHook(
      (a: Args) => useClusterMultiplier(a),
      { initialProps: args({ yesterday: null }) },
    );
    expect(result.current.signal.mult).toBe(1);
    rerender(args({ yesterday: HOT_DAY }));
    expect(result.current.signal.mult).toBe(1.203);
  });

  it('uses spot as the reference when yesterday has no open', () => {
    const { result } = renderHook(() =>
      useClusterMultiplier(
        args({ spot: 5000, yesterday: { open: 0, high: 5100, low: 5000 } }),
      ),
    );
    expect(result.current.signal.rangePct).toBeCloseTo(2, 12);
  });

  it('keeps the same object between renders with the same inputs', () => {
    const { result, rerender } = renderHook(
      (a: Args) => useClusterMultiplier(a),
      { initialProps: args() },
    );
    const first = result.current;
    rerender(args());
    expect(result.current).toBe(first);
  });
});

describe('useClusterMultiplier: the owner edits yesterday', () => {
  it('an edit overrides the computed value', () => {
    const { result } = renderHook(() => useClusterMultiplier(args()));
    expect(result.current.signal.mult).toBe(0.969);
    // 200 pts / 6800 = 2.94% -> Hot at VIX 22 -> 1.203.
    act(() => result.current.setInput('high', '6950'));
    expect(result.current.signal.mult).toBe(1.203);
    expect(result.current.inputs.high).toBe('6950');
  });

  it('seeds the untouched fields from what was shown', () => {
    const { result } = renderHook(() =>
      useClusterMultiplier(args({ yesterday: HOT_DAY })),
    );
    act(() => result.current.setInput('open', '7000'));
    expect(result.current.inputs).toEqual({
      open: '7000',
      high: '6810.44',
      low: '6636.04',
    });
  });

  it('two edits in one batch both land', () => {
    const { result } = renderHook(() => useClusterMultiplier(args()));
    act(() => {
      result.current.setInput('high', '6950');
      result.current.setInput('low', '6900');
    });
    expect(result.current.inputs).toEqual({
      open: '6800.00',
      high: '6950',
      low: '6900',
    });
  });

  it('a later yesterday does not overwrite the edit', () => {
    const { result, rerender } = renderHook(
      (a: Args) => useClusterMultiplier(a),
      { initialProps: args({ yesterday: null }) },
    );
    act(() => result.current.setInput('high', '6850'));
    act(() => result.current.setInput('low', '6750'));
    act(() => result.current.setInput('open', '6800'));
    const edited = result.current.signal.mult;
    expect(edited).toBe(0.969);
    rerender(args({ yesterday: HOT_DAY }));
    expect(result.current.signal.mult).toBe(edited);
    expect(result.current.inputs.high).toBe('6850');
  });

  it('the edit follows the VIX and spot, which are not part of it', () => {
    const { result, rerender } = renderHook(
      (a: Args) => useClusterMultiplier(a),
      { initialProps: args({ vix: 22 }) },
    );
    act(() => result.current.setInput('high', '6950'));
    expect(result.current.signal.mult).toBe(1.203); // 2.94% at VIX 22
    rerender(args({ vix: 30 }));
    // 2.94% at VIX 25+ is Active (p75-p90 = 2.74-3.78%) -> 1.192.
    expect(result.current.signal.mult).toBe(1.192);
  });

  it('an edit made under another scope is ignored', () => {
    const { result, rerender } = renderHook(
      (a: Args) => useClusterMultiplier(a),
      { initialProps: args({ scope: '2026-11-06' }) },
    );
    act(() => result.current.setInput('high', '6950'));
    expect(result.current.signal.mult).toBe(1.203);
    rerender(args({ scope: '2026-11-05' }));
    expect(result.current.signal.mult).toBe(0.969);
    expect(result.current.inputs.high).toBe('6850.00');
  });

  it('an edit made under the new scope replaces the old one', () => {
    const { result, rerender } = renderHook(
      (a: Args) => useClusterMultiplier(a),
      { initialProps: args({ scope: 'a' }) },
    );
    act(() => result.current.setInput('high', '6950'));
    rerender(args({ scope: 'b' }));
    act(() => result.current.setInput('low', '6700'));
    expect(result.current.inputs).toEqual({
      open: '6800.00',
      high: '6850.00',
      low: '6700',
    });
  });

  it('unparseable text gives 1 and is shown as typed', () => {
    const { result } = renderHook(() => useClusterMultiplier(args()));
    act(() => result.current.setInput('high', 'abc'));
    expect(result.current.signal.mult).toBe(1);
    expect(result.current.signal.rangePct).toBeNull();
    expect(result.current.inputs.high).toBe('abc');
  });

  it('high at or below low gives 1', () => {
    const { result } = renderHook(() => useClusterMultiplier(args()));
    act(() => result.current.setInput('high', '6700'));
    expect(result.current.signal.mult).toBe(1);
  });

  it('a cleared open falls back to spot', () => {
    const { result } = renderHook(() =>
      useClusterMultiplier(args({ spot: 5000, yesterday: NORMAL_DAY })),
    );
    act(() => {
      result.current.setInput('open', '');
      result.current.setInput('high', '5100');
      result.current.setInput('low', '5000');
    });
    expect(result.current.signal.rangePct).toBeCloseTo(2, 12);
  });
});

describe('useClusterMultiplier: what the consumers get, no panel mounted', () => {
  // The put and call multipliers and the delta ceilings come from
  // useRegimeClassification, which takes this hook's value as clusterMult. The
  // saved snapshot, the ceilings and the analyze context all read them from
  // there, so they are right with the card closed once this value is.
  function regime(clusterMult: number) {
    return {
      vix: 22,
      spot: 6800,
      T: 0.003,
      skewPct: 3,
      clusterMult,
      selectedDate: '2026-11-06',
      liveYesterdayOpen: 6800,
      liveYesterdayClose: 6700, // down 1.47%
      historySnapshot: null,
    };
  }

  it('the put/call multipliers and ceilings use the computed value', () => {
    const { result } = renderHook(() => {
      const cluster = useClusterMultiplier(args({ yesterday: HOT_DAY }));
      return useRegimeClassification(regime(cluster.signal.mult));
    });
    const { result: unclustered } = renderHook(() =>
      useRegimeClassification(regime(1)),
    );

    // Down day, mult 1.203: put 1 + 0.203 x 1.3, call 1 + 0.203 x 1.1.
    expect(result.current.clusterPutMult).toBeCloseTo(1.2639, 4);
    expect(result.current.clusterCallMult).toBeCloseTo(1.2233, 4);
    // The default 1 the card-closed app used to save: symmetric and neutral.
    expect(unclustered.current.clusterPutMult).toBe(1);
    expect(unclustered.current.clusterCallMult).toBe(1);
    // A wider expected range pushes the 90th-percentile strikes out.
    expect(result.current.p90HlPct).toBeGreaterThan(
      unclustered.current.p90HlPct!,
    );
    expect(result.current.icCeiling).toBeLessThan(
      unclustered.current.icCeiling!,
    );
  });
});
