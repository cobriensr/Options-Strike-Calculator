import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  playAnomalyChime,
  playSweepAlarm,
  isAnomalySoundEnabled,
  setAnomalySoundEnabled,
  SOUND_THROTTLE_MS,
  __resetAnomalySoundForTests,
} from '../../utils/anomaly-sound';

/**
 * Shared GainNode stub used by both AudioContext stubs below. Captures the
 * peak ramp value onto the most-recently-constructed oscillator record so
 * tests can assert per-tone gain (entry/exit chime + per-severity sweep).
 */
function makeGainNode(
  constructed: Array<{ frequency: number; peakGain: number }>,
) {
  return {
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn((v: number) => {
        const tail = constructed[constructed.length - 1];
        if (tail && v > tail.peakGain) tail.peakGain = v;
      }),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
}

/**
 * Build a minimal AudioContext stub that captures oscillator frequency +
 * peak gain per construction. The anomaly-sound util uses sine-wave tones
 * via Web Audio, not HTMLAudioElement, so these are the knobs we care
 * about for behavioral assertions.
 */
function makeAudioContextStub(): {
  Ctor: new () => AudioContext;
  constructed: Array<{ frequency: number; peakGain: number }>;
} {
  const constructed: Array<{ frequency: number; peakGain: number }> = [];

  class FakeAudioContext {
    public currentTime = 0;
    public destination = {};

    createOscillator() {
      const record = { frequency: 0, peakGain: 0 };
      constructed.push(record);
      return {
        type: 'sine',
        frequency: {
          set value(hz: number) {
            record.frequency = hz;
          },
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn(),
      };
    }

    createGain() {
      return makeGainNode(constructed);
    }

    close() {
      return Promise.resolve();
    }
  }

  return {
    Ctor: FakeAudioContext as unknown as new () => AudioContext,
    constructed,
  };
}

/**
 * Richer AudioContext stub for the sweep-alarm + lifecycle tests. Beyond
 * capturing per-oscillator frequency + peak gain, it tracks how many
 * contexts were constructed, the `close()` call count (via a shared resolved
 * Promise), and the `ended` listeners registered on each oscillator so a test
 * can fire the lifecycle handler that releases the context.
 */
function makeRichAudioContextStub(): {
  Ctor: new () => AudioContext;
  constructed: Array<{ frequency: number; peakGain: number }>;
  contexts: number;
  closeCalls: () => number;
  endedListeners: Array<() => void>;
} {
  const constructed: Array<{ frequency: number; peakGain: number }> = [];
  const endedListeners: Array<() => void> = [];
  const state = { contexts: 0, close: 0 };

  class FakeAudioContext {
    public currentTime = 0;
    public destination = {};

    constructor() {
      state.contexts += 1;
    }

    createOscillator() {
      const record = { frequency: 0, peakGain: 0 };
      constructed.push(record);
      return {
        type: 'sine',
        frequency: {
          set value(hz: number) {
            record.frequency = hz;
          },
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn((event: string, cb: () => void) => {
          if (event === 'ended') endedListeners.push(cb);
        }),
      };
    }

    createGain() {
      return makeGainNode(constructed);
    }

    close() {
      state.close += 1;
      return Promise.resolve();
    }
  }

  return {
    Ctor: FakeAudioContext as unknown as new () => AudioContext,
    constructed,
    get contexts() {
      return state.contexts;
    },
    closeCalls: () => state.close,
    endedListeners,
  };
}

describe('anomaly-sound util', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAnomalySoundForTests();
    localStorage.clear();
    const { Ctor } = makeAudioContextStub();
    vi.stubGlobal('AudioContext', Ctor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
    __resetAnomalySoundForTests();
  });

  it('plays the chime when enabled', () => {
    expect(playAnomalyChime()).toBe('played');
  });

  it('plays the exit variant at lower volume and lower frequency than entry', () => {
    const { Ctor, constructed } = makeAudioContextStub();
    vi.stubGlobal('AudioContext', Ctor);
    expect(playAnomalyChime('exit')).toBe('played');
    expect(constructed).toHaveLength(1);
    const exit = constructed[0]!;
    // Exit tone: 400 Hz, peak gain 0.2.
    expect(exit.frequency).toBe(400);
    expect(exit.peakGain).toBeCloseTo(0.2, 5);
    expect(exit.peakGain).toBeLessThan(0.4);
  });

  it('plays the entry variant at higher volume and higher frequency than exit', () => {
    const { Ctor, constructed } = makeAudioContextStub();
    vi.stubGlobal('AudioContext', Ctor);
    expect(playAnomalyChime('entry')).toBe('played');
    expect(constructed).toHaveLength(1);
    const entry = constructed[0]!;
    // Entry tone: 660 Hz, peak gain 0.4 (brighter + louder than exit).
    expect(entry.frequency).toBe(660);
    expect(entry.peakGain).toBeCloseTo(0.4, 5);
    expect(entry.peakGain).toBeGreaterThan(0.2);
  });

  it('is disabled when the localStorage flag is false', () => {
    setAnomalySoundEnabled(false);
    expect(playAnomalyChime()).toBe('disabled');
  });

  it('throttles repeated plays within 3 seconds', () => {
    expect(playAnomalyChime()).toBe('played');
    expect(playAnomalyChime()).toBe('throttled');
    vi.advanceTimersByTime(SOUND_THROTTLE_MS - 1);
    expect(playAnomalyChime()).toBe('throttled');
    vi.advanceTimersByTime(2);
    expect(playAnomalyChime()).toBe('played');
  });

  it('does not throw when AudioContext constructor is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    expect(() => playAnomalyChime()).not.toThrow();
    // Still returns 'played' — alerting is best-effort, not something
    // callers should branch on.
    __resetAnomalySoundForTests();
    expect(playAnomalyChime()).toBe('played');
  });

  it('swallows AudioContext construction failure silently', () => {
    class ExplodingAudioContext {
      constructor() {
        throw new Error('AudioContext locked');
      }
    }
    vi.stubGlobal(
      'AudioContext',
      ExplodingAudioContext as unknown as new () => AudioContext,
    );
    expect(() => playAnomalyChime()).not.toThrow();
    expect(playAnomalyChime()).toBe('throttled'); // second call within window
  });

  it('fails open (enabled) when localStorage.getItem throws', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError: storage blocked');
      });
    expect(isAnomalySoundEnabled()).toBe(true);
    getItem.mockRestore();
  });

  it("closes the AudioContext when the oscillator 'ended' event fires", () => {
    const stub = makeRichAudioContextStub();
    vi.stubGlobal('AudioContext', stub.Ctor);

    expect(playAnomalyChime('entry')).toBe('played');
    // One oscillator → one registered 'ended' listener, none fired yet.
    expect(stub.endedListeners).toHaveLength(1);
    expect(stub.closeCalls()).toBe(0);

    // Simulate the browser dispatching 'ended' once the tone finishes.
    stub.endedListeners[0]!();
    expect(stub.closeCalls()).toBe(1);
  });

  describe('playSweepAlarm', () => {
    it('returns disabled when the localStorage flag is false', () => {
      setAnomalySoundEnabled(false);
      expect(playSweepAlarm('warning')).toBe('disabled');
    });

    it('returns played and builds 3 ascending sweep notes (E5 → A5 → C6)', () => {
      const stub = makeRichAudioContextStub();
      vi.stubGlobal('AudioContext', stub.Ctor);

      expect(playSweepAlarm('warning')).toBe('played');
      expect(stub.constructed).toHaveLength(3);
      expect(stub.constructed.map((n) => n.frequency)).toEqual([
        659.25, 880.0, 1046.5,
      ]);
    });

    it.each([
      ['warning', 0.35],
      ['critical', 0.55],
      ['extreme', 0.75],
    ] as const)(
      'scales peak gain to %s severity (%d) across all 3 notes',
      (severity, expectedPeak) => {
        const stub = makeRichAudioContextStub();
        vi.stubGlobal('AudioContext', stub.Ctor);

        expect(playSweepAlarm(severity)).toBe('played');
        expect(stub.constructed).toHaveLength(3);
        for (const note of stub.constructed) {
          expect(note.peakGain).toBeCloseTo(expectedPeak, 5);
        }
      },
    );

    it('makes extreme audibly louder than warning', () => {
      const warn = makeRichAudioContextStub();
      vi.stubGlobal('AudioContext', warn.Ctor);
      playSweepAlarm('warning');

      const extreme = makeRichAudioContextStub();
      vi.stubGlobal('AudioContext', extreme.Ctor);
      playSweepAlarm('extreme');

      expect(extreme.constructed[0]!.peakGain).toBeGreaterThan(
        warn.constructed[0]!.peakGain,
      );
    });

    it('closes the AudioContext after the scheduled timeout elapses', () => {
      const stub = makeRichAudioContextStub();
      vi.stubGlobal('AudioContext', stub.Ctor);

      expect(playSweepAlarm('critical')).toBe('played');
      expect(stub.contexts).toBe(1);
      // Close is deferred via setTimeout — not yet invoked.
      expect(stub.closeCalls()).toBe(0);

      // Total sweep window: 3 notes × (0.12 + 0.04) + 0.1 buffer ≈ 580ms.
      vi.advanceTimersByTime(1000);
      expect(stub.closeCalls()).toBe(1);
    });

    it('defaults to warning severity when called with no argument', () => {
      const stub = makeRichAudioContextStub();
      vi.stubGlobal('AudioContext', stub.Ctor);

      expect(playSweepAlarm()).toBe('played');
      expect(stub.constructed).toHaveLength(3);
      for (const note of stub.constructed) {
        expect(note.peakGain).toBeCloseTo(0.35, 5);
      }
    });

    it('returns played without throwing when no AudioContext is available', () => {
      vi.stubGlobal('AudioContext', undefined);
      vi.stubGlobal('webkitAudioContext', undefined);
      expect(() => playSweepAlarm('warning')).not.toThrow();
      expect(playSweepAlarm('warning')).toBe('played');
    });

    it('swallows AudioContext construction failure and still returns played', () => {
      class ExplodingAudioContext {
        constructor() {
          throw new Error('AudioContext locked');
        }
      }
      vi.stubGlobal(
        'AudioContext',
        ExplodingAudioContext as unknown as new () => AudioContext,
      );
      expect(() => playSweepAlarm('extreme')).not.toThrow();
      expect(playSweepAlarm('extreme')).toBe('played');
    });
  });
});
