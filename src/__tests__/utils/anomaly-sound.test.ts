import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  playAnomalyChime,
  setAnomalySoundEnabled,
  SOUND_THROTTLE_MS,
  __resetAnomalySoundForTests,
} from '../../utils/anomaly-sound';

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
      return {
        gain: {
          value: 0,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn((v: number) => {
            // Peak gain is whatever the util ramps UP to (entry = 0.4, exit = 0.2).
            // We capture the most recent non-trivial ramp value per context;
            // since there's one createOscillator + one createGain per call, this
            // aligns 1:1 with the `constructed` array tail.
            const tail = constructed[constructed.length - 1];
            if (tail && v > tail.peakGain) tail.peakGain = v;
          }),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
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
});
