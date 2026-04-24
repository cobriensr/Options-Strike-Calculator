import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  playAnomalyChime,
  setAnomalySoundEnabled,
  SOUND_THROTTLE_MS,
  __resetAnomalySoundForTests,
} from '../../../utils/anomaly-sound';

describe('anomaly-sound util', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAnomalySoundForTests();
    localStorage.clear();
    // jsdom doesn't ship Audio — stub it.
    vi.stubGlobal(
      'Audio',
      class FakeAudio {
        public src: string;
        public volume = 1;
        constructor(src: string) {
          this.src = src;
        }
        play() {
          return Promise.resolve();
        }
      },
    );
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

  it('plays the exit variant at lower volume', () => {
    const constructed: Array<{ volume: number }> = [];
    vi.stubGlobal(
      'Audio',
      class FakeAudio {
        public src: string;
        public volume = 1;
        constructor(src: string) {
          this.src = src;
          constructed.push(this);
        }
        play() {
          return Promise.resolve();
        }
      },
    );
    expect(playAnomalyChime('exit')).toBe('played');
    expect(constructed).toHaveLength(1);
    // Exit chime is softer than the default (0.4) entry chime.
    expect(constructed[0]?.volume).toBeLessThan(0.4);
    expect(constructed[0]?.volume).toBeGreaterThan(0);
  });

  it('entry variant plays at higher volume than exit', () => {
    const constructed: Array<{ volume: number }> = [];
    vi.stubGlobal(
      'Audio',
      class FakeAudio {
        public src: string;
        public volume = 1;
        constructor(src: string) {
          this.src = src;
          constructed.push(this);
        }
        play() {
          return Promise.resolve();
        }
      },
    );
    expect(playAnomalyChime('entry')).toBe('played');
    expect(constructed[0]?.volume).toBeGreaterThan(0.3);
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

  it('does not throw when Audio constructor is unavailable', () => {
    vi.stubGlobal('Audio', undefined);
    expect(() => playAnomalyChime()).not.toThrow();
  });

  it('swallows autoplay rejection silently', async () => {
    vi.stubGlobal(
      'Audio',
      class FakeAudio {
        public src: string;
        public volume = 1;
        constructor(src: string) {
          this.src = src;
        }
        play() {
          return Promise.reject(new Error('NotAllowedError'));
        }
      },
    );
    // Should not throw synchronously.
    expect(playAnomalyChime()).toBe('played');
    // Allow microtasks to flush; no unhandled rejection.
    await vi.runAllTimersAsync();
  });
});
