import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startChime,
  stopChime,
  stopAllChimes,
  __resetChimesForTests,
} from '../../utils/alert-chime';

/**
 * Unit tests for the shared chime-lifecycle manager. The module owns a
 * single module-scoped activeChimes Map keyed by `${namespace}:${id}`, so
 * the critical properties under test are:
 *   - startChime plays immediately then schedules a repeating interval
 *   - stopChime clears the interval and is idempotent (double-stop safe)
 *   - stopAllChimes clears a whole set of ids in one namespace
 *   - the same numeric id under two namespaces is independent (no collision)
 *   - __resetChimesForTests tears every interval down
 *
 * setInterval / clearInterval are spied (not faked) so we can assert the
 * exact handles created and cleared. __resetChimesForTests runs in afterEach
 * because the dedupe Map is module-scope and would otherwise leak across
 * cases.
 */

beforeEach(() => {
  __resetChimesForTests();
});

afterEach(() => {
  __resetChimesForTests();
  vi.restoreAllMocks();
});

describe('alert-chime — startChime', () => {
  it('plays immediately and schedules a repeating interval', () => {
    const play = vi.fn();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });

    // Immediate ring.
    expect(play).toHaveBeenCalledTimes(1);
    // Repeating interval scheduled with the caller cadence.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(play, 10_000);
  });

  it('is idempotent per (namespace, id) — a second call is a no-op', () => {
    const play = vi.fn();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });
    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });

    // No double-ring, no leaked second interval.
    expect(play).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

describe('alert-chime — stopChime', () => {
  it('clears the interval created by startChime', () => {
    const play = vi.fn();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });
    const handle = setIntervalSpy.mock.results.at(-1)!.value;

    stopChime('alert', 1);

    expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
  });

  it('is idempotent — double-stop (and stop with no active chime) is safe', () => {
    const play = vi.fn();
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });
    stopChime('alert', 1);
    // Second stop, plus a stop for an id that was never started.
    expect(() => {
      stopChime('alert', 1);
      stopChime('alert', 999);
    }).not.toThrow();

    // Only the one real interval was cleared.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('re-arm works: stopped id can startChime again', () => {
    const play = vi.fn();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });
    stopChime('alert', 1);
    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });

    // Two immediate rings (one per start), two intervals scheduled.
    expect(play).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });
});

describe('alert-chime — stopAllChimes', () => {
  it('clears every id in the set for the namespace', () => {
    const play = vi.fn();
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });
    startChime(2, { namespace: 'alert', intervalMs: 10_000, play });
    startChime(3, { namespace: 'alert', intervalMs: 10_000, play });

    stopAllChimes('alert', [1, 2, 3]);

    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
  });

  it('skips ids with no active chime without throwing', () => {
    const play = vi.fn();
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });

    expect(() => stopAllChimes('alert', [1, 2, 3])).not.toThrow();
    // Only id 1 had an interval.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

describe('alert-chime — namespace isolation', () => {
  it('same numeric id under two namespaces is independent', () => {
    const playA = vi.fn();
    const playB = vi.fn();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play: playA });
    startChime(1, { namespace: 'intervalBA', intervalMs: 5_000, play: playB });

    // Both started — no cross-namespace dedupe.
    expect(playA).toHaveBeenCalledTimes(1);
    expect(playB).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);

    // Stopping one namespace leaves the other ringing.
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    stopChime('alert', 1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    // The intervalBA chime is still active: a re-start is a no-op.
    startChime(1, { namespace: 'intervalBA', intervalMs: 5_000, play: playB });
    expect(playB).toHaveBeenCalledTimes(1);
  });
});

describe('alert-chime — __resetChimesForTests', () => {
  it('clears all intervals across every namespace', () => {
    const play = vi.fn();
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });
    startChime(1, { namespace: 'intervalBA', intervalMs: 5_000, play });
    startChime(2, { namespace: 'alert', intervalMs: 10_000, play });

    __resetChimesForTests();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);

    // After reset every key is free again — re-start rings.
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    startChime(1, { namespace: 'alert', intervalMs: 10_000, play });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
