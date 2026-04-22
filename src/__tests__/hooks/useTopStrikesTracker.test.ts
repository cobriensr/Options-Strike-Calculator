import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTopStrikesTracker } from '../../hooks/useTopStrikesTracker';

// Inline the only subset of GexStrikeLevel we need so this test file has
// no dependency on the fetch-hook module that brings in useIsOwner etc.
interface GexStrikeLevel {
  strike: number;
  price: number;
  callGammaOi: number;
  putGammaOi: number;
  netGamma: number;
  callGammaVol: number;
  putGammaVol: number;
  netGammaVol: number;
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral';
  callGammaAsk: number;
  callGammaBid: number;
  putGammaAsk: number;
  putGammaBid: number;
  callCharmOi: number;
  putCharmOi: number;
  netCharm: number;
  callCharmVol: number;
  putCharmVol: number;
  netCharmVol: number;
  callDeltaOi: number;
  putDeltaOi: number;
  netDelta: number;
  callVannaOi: number;
  putVannaOi: number;
  netVanna: number;
  callVannaVol: number;
  putVannaVol: number;
  netVannaVol: number;
}

// ── AudioContext mock ─────────────────────────────────────
//
// Records calls to osc.start so tests can assert whether a chime fired.

const startSpy = vi.fn();
const stopSpy = vi.fn();
const closeSpy = vi.fn().mockResolvedValue(undefined);
const setValueAtTimeSpy = vi.fn();

class MockAudioContext {
  destination = {};
  currentTime = 0;
  createOscillator() {
    return {
      type: '',
      frequency: {
        value: 0,
        setValueAtTime: setValueAtTimeSpy,
      },
      connect: vi.fn(),
      start: startSpy,
      stop: stopSpy,
    };
  }
  createGain() {
    return {
      connect: vi.fn(),
      gain: { value: 0 },
    };
  }
  close = closeSpy;
}

// ── Helpers ───────────────────────────────────────────────

function makeStrike(strike: number, netGamma = 1e9): GexStrikeLevel {
  return {
    strike,
    price: 7125,
    callGammaOi: 0,
    putGammaOi: 0,
    netGamma,
    callGammaVol: 0,
    putGammaVol: 0,
    netGammaVol: 0,
    volReinforcement: 'neutral',
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    callCharmOi: 0,
    putCharmOi: 0,
    netCharm: 0,
    callCharmVol: 0,
    putCharmVol: 0,
    netCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    netDelta: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    netVanna: 0,
    callVannaVol: 0,
    putVannaVol: 0,
    netVannaVol: 0,
  };
}

const BASE = [7100, 7110, 7120, 7130, 7140].map((s) => makeStrike(s));

// ── Lifecycle ─────────────────────────────────────────────

beforeEach(() => {
  startSpy.mockReset();
  stopSpy.mockReset();
  closeSpy.mockReset().mockResolvedValue(undefined);
  setValueAtTimeSpy.mockReset();
  vi.stubGlobal('AudioContext', MockAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────

describe('useTopStrikesTracker', () => {
  it('baseline snapshot: no chime, justEntered empty, oldestStrike null', () => {
    const { result } = renderHook(() =>
      useTopStrikesTracker({
        topFive: BASE,
        timestamp: '2026-04-22T18:00:00Z',
        isLive: true,
        muted: false,
      }),
    );

    expect(startSpy).not.toHaveBeenCalled();
    expect(result.current.justEntered.size).toBe(0);
    expect(result.current.oldestStrike).toBeNull();
  });

  it('same set on next tick: no chime, state still empty/null', () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE,
          timestamp: '2026-04-22T18:00:00Z',
          isLive: true,
          muted: false,
        },
      },
    );

    rerender({
      topFive: BASE.slice().reverse(), // same set, different order
      timestamp: '2026-04-22T18:01:00Z',
      isLive: true,
      muted: false,
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(result.current.justEntered.size).toBe(0);
    expect(result.current.oldestStrike).toBeNull();
  });

  it('one strike swapped: chime fires, justEntered has new strike, oldestStrike picks an original', () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE,
          timestamp: '2026-04-22T18:00:00Z',
          isLive: true,
          muted: false,
        },
      },
    );

    const swapped = [...BASE.slice(0, 4), makeStrike(7150)];
    rerender({
      topFive: swapped,
      timestamp: '2026-04-22T18:01:00Z',
      isLive: true,
      muted: false,
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(result.current.justEntered.has(7150)).toBe(true);
    expect(result.current.justEntered.size).toBe(1);
    // One of the four originals (7100/7110/7120/7130) has the earliest
    // firstSeen and is the anchor.
    expect([7100, 7110, 7120, 7130]).toContain(result.current.oldestStrike);
  });

  it('two strikes swapped in: both appear in justEntered', () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE,
          timestamp: '2026-04-22T18:00:00Z',
          isLive: true,
          muted: false,
        },
      },
    );

    const doubleSwap = [
      ...BASE.slice(0, 3),
      makeStrike(7150),
      makeStrike(7160),
    ];
    rerender({
      topFive: doubleSwap,
      timestamp: '2026-04-22T18:01:00Z',
      isLive: true,
      muted: false,
    });

    expect(result.current.justEntered.has(7150)).toBe(true);
    expect(result.current.justEntered.has(7160)).toBe(true);
    expect(result.current.justEntered.size).toBe(2);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('muted flag suppresses chime on set change', () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE,
          timestamp: '2026-04-22T18:00:00Z',
          isLive: true,
          muted: true,
        },
      },
    );

    rerender({
      topFive: [...BASE.slice(0, 4), makeStrike(7150)],
      timestamp: '2026-04-22T18:01:00Z',
      isLive: true,
      muted: true,
    });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('non-live (scrub) suppresses chime on set change', () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE,
          timestamp: '2026-04-22T18:00:00Z',
          isLive: false,
          muted: false,
        },
      },
    );

    rerender({
      topFive: [...BASE.slice(0, 4), makeStrike(7150)],
      timestamp: '2026-04-22T18:01:00Z',
      isLive: false,
      muted: false,
    });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('resetKey change clears tracking — next snapshot becomes new baseline', () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE,
          timestamp: '2026-04-22T18:00:00Z',
          isLive: true,
          muted: false,
          resetKey: '2026-04-22',
        },
      },
    );

    rerender({
      topFive: [...BASE.slice(0, 4), makeStrike(7150)],
      timestamp: '2026-04-21T18:00:00Z',
      isLive: true,
      muted: false,
      resetKey: '2026-04-21',
    });

    // resetKey change clears prev-set, so this becomes the new baseline:
    // no chime, no anchor, empty justEntered.
    expect(startSpy).not.toHaveBeenCalled();
    expect(result.current.justEntered.size).toBe(0);
    expect(result.current.oldestStrike).toBeNull();
  });

  it('null timestamp is a no-op — does not crash or update state', () => {
    const { result } = renderHook(() =>
      useTopStrikesTracker({
        topFive: BASE,
        timestamp: null,
        isLive: true,
        muted: false,
      }),
    );

    expect(result.current.justEntered.size).toBe(0);
    expect(result.current.oldestStrike).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('empty topFive does not crash', () => {
    const { result } = renderHook(() =>
      useTopStrikesTracker({
        topFive: [],
        timestamp: '2026-04-22T18:00:00Z',
        isLive: true,
        muted: false,
      }),
    );

    expect(result.current.justEntered.size).toBe(0);
    expect(result.current.oldestStrike).toBeNull();
  });

  it('stale strike leaves, then returns: re-records firstSeen (does not keep old timestamp)', () => {
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE, // 7100..7140 at t0
          timestamp: '2026-04-22T18:00:00Z',
          isLive: true,
          muted: false,
        },
      },
    );

    // 7100 leaves at t1
    rerender({
      topFive: [...BASE.slice(1), makeStrike(7150)],
      timestamp: '2026-04-22T18:01:00Z',
      isLive: true,
      muted: false,
    });

    // 7100 returns at t2 — by pruning, its firstSeen resets to t2 so the
    // anchor should be one of the strikes still in the set since t0
    // (7110, 7120, 7130, or 7140).
    rerender({
      topFive: BASE,
      timestamp: '2026-04-22T18:02:00Z',
      isLive: true,
      muted: false,
    });

    expect(result.current.justEntered.has(7100)).toBe(true);
    expect([7110, 7120, 7130, 7140]).toContain(result.current.oldestStrike);
  });

  it('chime fires again on each subsequent set change', () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useTopStrikesTracker>[0]) =>
        useTopStrikesTracker(props),
      {
        initialProps: {
          topFive: BASE,
          timestamp: '2026-04-22T18:00:00Z',
          isLive: true,
          muted: false,
        },
      },
    );

    rerender({
      topFive: [...BASE.slice(0, 4), makeStrike(7150)],
      timestamp: '2026-04-22T18:01:00Z',
      isLive: true,
      muted: false,
    });
    expect(startSpy).toHaveBeenCalledTimes(1);

    rerender({
      topFive: [...BASE.slice(0, 3), makeStrike(7150), makeStrike(7160)],
      timestamp: '2026-04-22T18:02:00Z',
      isLive: true,
      muted: false,
    });
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});
