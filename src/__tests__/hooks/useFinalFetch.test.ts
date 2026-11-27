/**
 * Tests for `useFinalFetch`: the one fetch a GEXBot panel makes after the
 * close, armed for 3 minutes past it and re-armed for the next trading day.
 *
 * Fake timers drive every case: `vi.setSystemTime` moves the wall clock and,
 * like a sleeping tab, leaves the timers where they were.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  CLOSED_MAX_RETRIES,
  CLOSED_RETRY_MS,
  useFinalFetch,
  type FinalFetchOutcome,
} from '../../hooks/useFinalFetch';

const { captureUnlessAuth } = vi.hoisted(() => ({
  captureUnlessAuth: vi.fn(),
}));
vi.mock('../../lib/sentry-helpers', () => ({ captureUnlessAuth }));

// A passthrough, so a test can make the calendar answer "no trading day".
vi.mock('../../utils/closed-session', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/closed-session')>();
  return { ...actual, nextFinalFetchMs: vi.fn(actual.nextFinalFetchMs) };
});
import { nextFinalFetchMs } from '../../utils/closed-session';

/** Fri 2026-11-20: 16:00 ET close + 3 minutes. */
const FRI_FETCH = Date.parse('2026-11-20T21:03:00Z');
/** The next trading day's final fetch. */
const MON_FETCH = Date.parse('2026-11-23T21:03:00Z');
const TUE_FETCH = Date.parse('2026-11-24T21:03:00Z');

type Run = () => Promise<FinalFetchOutcome>;

function mockRun(outcome: FinalFetchOutcome = 'ok') {
  return vi.fn<Run>().mockResolvedValue(outcome);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mount(run: Run, enabled = true) {
  return renderHook(
    (props: { run: Run; enabled: boolean }) =>
      useFinalFetch(props.run, props.enabled),
    { initialProps: { run, enabled } },
  );
}

/** Advance the fake clock, letting promise callbacks run between timers. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

/** The tab comes back, as a browser reports it. */
async function becomeVisible() {
  setVisibility('visible');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function fireWindowEvent(type: 'focus' | 'pageshow') {
  await act(async () => {
    window.dispatchEvent(new Event(type));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T21:00:00Z'));
  captureUnlessAuth.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
  // Back to the real calendar after a test that nulled it.
  vi.mocked(nextFinalFetchMs).mockReset();
});

describe('useFinalFetch: the timer', () => {
  it('fires once, at 3 minutes past the close', async () => {
    const run = mockRun();
    mount(run);

    await advance(FRI_FETCH - Date.now() - 1);
    expect(run).not.toHaveBeenCalled();

    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);

    await advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('arms for the half-day close on a half day', async () => {
    // Thu 2026-11-26 is a holiday; Fri 11-27 closes at 13:00 ET (18:00Z).
    vi.setSystemTime(new Date('2026-11-26T15:00:00Z'));
    const run = mockRun();
    mount(run);

    const halfDayFetch = Date.parse('2026-11-27T18:03:00Z');
    await advance(halfDayFetch - Date.now() - 1);
    expect(run).not.toHaveBeenCalled();
    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('re-arms for the next trading day after firing', async () => {
    const run = mockRun();
    mount(run);

    await advance(FRI_FETCH - Date.now());
    expect(run).toHaveBeenCalledTimes(1);

    // Friday night to Monday's fetch is Sat and Sun in between.
    await advance(MON_FETCH - Date.now() - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('re-arms for the next day when the timer fires 1 ms early by Date.now()', async () => {
    vi.setSystemTime(FRI_FETCH - 5_000);
    const run = mockRun();
    mount(run);

    // Slow the wall clock by 1 ms against the timer: it fires, but
    // Date.now() reads 1 ms short of the armed instant.
    vi.setSystemTime(FRI_FETCH - 5_001);
    await advance(5_000);
    expect(Date.now()).toBe(FRI_FETCH - 1);
    expect(run).toHaveBeenCalledTimes(1);

    // Re-armed for the same instant, it would fire again 1 ms later.
    await advance(10);
    expect(run).toHaveBeenCalledTimes(1);

    await advance(MON_FETCH - Date.now() - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs the latest run function, not the one it was armed with', async () => {
    const first = mockRun();
    const second = mockRun();
    const { rerender } = mount(first);
    rerender({ run: second, enabled: true });

    await advance(FRI_FETCH - Date.now());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('useFinalFetch: waking up', () => {
  it('fires exactly once on visible after the clock moved 3 days past, and the stale timer stays quiet', async () => {
    const run = mockRun();
    mount(run);

    // A sleeping tab: the wall clock jumps, the timers do not run.
    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    await becomeVisible();
    expect(run).toHaveBeenCalledTimes(1);

    // The old timer was 3 minutes out; it must not fire the run again.
    await advance(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);

    // The next one waits for Tuesday's close, not Monday's, which is past.
    await advance(TUE_FETCH - Date.now() - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // A tab that slept: the wall clock jumped past the armed instant, the timer
  // then runs late, and the visibility event follows it. The late timer has
  // already served the instant and re-armed, so the event has nothing left to
  // fire for.
  it('fires once when the overdue timer runs first and a visibilitychange follows', async () => {
    const run = mockRun();
    mount(run);

    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    await advance(3 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);

    await becomeVisible();
    await fireWindowEvent('focus');
    await fireWindowEvent('pageshow');
    expect(run).toHaveBeenCalledTimes(1);

    // The next one waits for Tuesday's close.
    await advance(TUE_FETCH - Date.now() - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fires once for a visibilitychange, a focus and a pageshow together', async () => {
    const run = mockRun();
    mount(run);

    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['focus', 'pageshow'] as const)(
    'fires on %s once the armed instant has passed',
    async (type) => {
      const run = mockRun();
      mount(run);

      vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
      await fireWindowEvent(type);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('fires on a wake-up at exactly the armed instant', async () => {
    const run = mockRun();
    mount(run);

    // The wall clock lands on the instant with the timer still pending.
    vi.setSystemTime(FRI_FETCH);
    await becomeVisible();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a wake-up before the armed instant', async () => {
    const run = mockRun();
    mount(run);

    await advance(60_000);
    await becomeVisible();
    await fireWindowEvent('focus');
    await fireWindowEvent('pageshow');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not fire while the tab is hidden, then fires when it shows', async () => {
    const run = mockRun();
    mount(run);

    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    setVisibility('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(run).not.toHaveBeenCalled();

    await becomeVisible();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('useFinalFetch: no trading day to arm for', () => {
  // `nextFinalFetchMs` finds none (a calendar that has run out): nothing is
  // armed, and no wake-up has an instant to fire for.
  it('arms nothing, and fires on no wake-up', async () => {
    vi.mocked(nextFinalFetchMs).mockReturnValue(null);
    const run = mockRun();
    mount(run);
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    await becomeVisible();
    await fireWindowEvent('focus');
    await fireWindowEvent('pageshow');
    await advance(24 * 60 * 60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('still starts a retry series for a failure the consumer reports', async () => {
    vi.mocked(nextFinalFetchMs).mockReturnValue(null);
    const run = mockRun('ok');
    const { result } = mount(run);

    act(() => result.current('transient'));
    await advance(CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('useFinalFetch: enabled', () => {
  it('arms nothing and ignores wake-ups when disabled', async () => {
    const run = mockRun();
    mount(run, false);
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    await becomeVisible();
    await fireWindowEvent('focus');
    await fireWindowEvent('pageshow');
    await advance(24 * 60 * 60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('drops its timer and listeners when disabled', async () => {
    const run = mockRun();
    const { rerender } = mount(run);
    expect(vi.getTimerCount()).toBe(1);

    rerender({ run, enabled: false });
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    await becomeVisible();
    await fireWindowEvent('focus');
    await fireWindowEvent('pageshow');
    expect(run).not.toHaveBeenCalled();
  });

  it('arms again when re-enabled', async () => {
    const run = mockRun();
    const { rerender } = mount(run, false);
    rerender({ run, enabled: true });

    await advance(FRI_FETCH - Date.now());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('drops its timer and listeners on unmount', async () => {
    const run = mockRun();
    const { unmount } = mount(run);
    unmount();
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(new Date('2026-11-23T22:00:00Z'));
    await becomeVisible();
    await fireWindowEvent('focus');
    await fireWindowEvent('pageshow');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('useFinalFetch: retrying a transient outcome', () => {
  it('retries at +30 s, up to 5 times, then stops', async () => {
    expect(CLOSED_RETRY_MS).toBe(30_000);
    expect(CLOSED_MAX_RETRIES).toBe(5);
    const run = mockRun('transient');
    mount(run);

    await advance(FRI_FETCH - Date.now());
    expect(run).toHaveBeenCalledTimes(1);

    for (let retry = 1; retry <= CLOSED_MAX_RETRIES; retry++) {
      await advance(CLOSED_RETRY_MS - 1);
      expect(run).toHaveBeenCalledTimes(retry);
      await advance(1);
      expect(run).toHaveBeenCalledTimes(retry + 1);
    }

    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1 + CLOSED_MAX_RETRIES);
  });

  it('stops retrying once a retry comes back ok', async () => {
    const run = vi
      .fn<Run>()
      .mockResolvedValueOnce('transient')
      .mockResolvedValueOnce('transient')
      .mockResolvedValue('ok');
    mount(run);

    await advance(FRI_FETCH - Date.now());
    await advance(2 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(3);

    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not retry a failed outcome', async () => {
    const run = mockRun('failed');
    mount(run);

    await advance(FRI_FETCH - Date.now());
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps the next day armed while retrying', async () => {
    const run = vi
      .fn<Run>()
      .mockResolvedValueOnce('transient')
      .mockResolvedValue('ok');
    mount(run);

    await advance(FRI_FETCH - Date.now());
    await advance(CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);

    await advance(MON_FETCH - Date.now());
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('treats a run that rejects as failed: no retry, reported to Sentry', async () => {
    const boom = new Error('boom');
    const run = vi.fn<Run>().mockRejectedValue(boom);
    mount(run);

    await advance(FRI_FETCH - Date.now());
    expect(run).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(boom);

    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ends the series when a retry rejects', async () => {
    const run = vi
      .fn<Run>()
      .mockResolvedValueOnce('transient')
      .mockRejectedValue(new Error('boom'));
    mount(run);

    await advance(FRI_FETCH - Date.now());
    await advance(CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);

    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('drops the series when disabled', async () => {
    const run = mockRun('transient');
    const { rerender } = mount(run);

    await advance(FRI_FETCH - Date.now());
    await advance(CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);

    rerender({ run, enabled: false });
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('starts no retry from a run that settles after unmount', async () => {
    const pending = deferred<FinalFetchOutcome>();
    const run = vi.fn<Run>().mockReturnValue(pending.promise);
    const { unmount } = mount(run);

    await advance(FRI_FETCH - Date.now());
    expect(run).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      pending.resolve('transient');
    });
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('schedules no further retry when a retry settles after unmount', async () => {
    const pending = deferred<FinalFetchOutcome>();
    const run = vi
      .fn<Run>()
      .mockResolvedValueOnce('transient')
      .mockReturnValue(pending.promise);
    const { unmount } = mount(run);

    await advance(FRI_FETCH - Date.now());
    await advance(CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      pending.resolve('transient');
    });
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('useFinalFetch: retryAfterFailure', () => {
  beforeEach(() => {
    // 3 hours before the fetch: the retries below belong to the consumer.
    vi.setSystemTime(new Date('2026-11-20T18:00:00Z'));
  });

  it('starts the same retry from a transient outcome the consumer reports', async () => {
    const run = mockRun('transient');
    const { result } = mount(run);

    act(() => result.current('transient'));
    await advance(CLOSED_RETRY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);

    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(CLOSED_MAX_RETRIES);
  });

  it('ends on an ok retry', async () => {
    const run = vi
      .fn<Run>()
      .mockResolvedValueOnce('transient')
      .mockResolvedValue('ok');
    const { result } = mount(run);

    act(() => result.current('transient'));
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(['ok', 'failed'] as const)(
    'ignores a %s outcome',
    async (outcome) => {
      const run = mockRun('transient');
      const { result } = mount(run);

      act(() => result.current(outcome));
      await advance(10 * CLOSED_RETRY_MS);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('ignores a report while a series runs, and keeps its count', async () => {
    const run = mockRun('transient');
    const { result } = mount(run);

    act(() => result.current('transient'));
    await advance(2 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);

    // Mid-series: a reset here would buy it five more retries.
    act(() => result.current('transient'));
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(CLOSED_MAX_RETRIES);
  });

  it("ignores a report while a retry's own fetch is in flight", async () => {
    const pending = deferred<FinalFetchOutcome>();
    const run = vi
      .fn<Run>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue('transient');
    const { result } = mount(run);

    act(() => result.current('transient'));
    await advance(CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // The first retry is still out. A second series would run beside it.
    act(() => result.current('transient'));
    expect(vi.getTimerCount()).toBe(1); // the final fetch's own timer only
    await act(async () => {
      pending.resolve('transient');
    });
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(CLOSED_MAX_RETRIES);
  });

  it('starts a fresh series after one has ended', async () => {
    const run = vi
      .fn<Run>()
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('transient')
      .mockResolvedValue('ok');
    const { result } = mount(run);

    act(() => result.current('transient'));
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(1);

    act(() => result.current('transient'));
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does nothing when the hook is disabled', async () => {
    const run = mockRun('transient');
    const { result } = mount(run, false);

    act(() => result.current('transient'));
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * CLOSED_RETRY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps one identity across renders', () => {
    const run = mockRun();
    const { result, rerender } = mount(run);
    const first = result.current;
    rerender({ run: mockRun(), enabled: true });
    rerender({ run, enabled: false });
    expect(result.current).toBe(first);
  });
});
