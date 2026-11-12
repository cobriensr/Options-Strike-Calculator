import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyUpdate,
  holdAutoUpdate,
  markNeedsRefresh,
  resetUpdateState,
  setUpdateFn,
  startTabAgreement,
} from '../lib/sw-update';
import { captureUnlessAuth } from '../lib/sentry-helpers';

vi.mock('../lib/sentry-helpers', () => ({ captureUnlessAuth: vi.fn() }));

// The spec'd values, written out so a changed constant fails a test.
const LOCK_NAME = 'sw-update-unsafe';
const TICK_MS = 60 * 1000;

// Wednesday 2026-12-02 at 10:00 CST, in the cash session, and Saturday
// 2026-12-05 at 10:00 CST, outside it. The policy itself is table-tested in
// sw-update-policy.test.ts; these tests drive it through the real clock.
const IN_SESSION = new Date('2026-12-02T16:00:00Z');
const OUT_OF_SESSION = new Date('2026-12-05T16:00:00Z');

type LockMode = 'shared' | 'exclusive';
type Tab = 'this' | 'other';
type Callback = (lock: { name: string; mode: LockMode } | null) => unknown;

interface LockOptions {
  mode?: LockMode;
  ifAvailable?: boolean;
}

interface RequestRecord {
  name: string;
  mode: LockMode;
  ifAvailable: boolean;
  tab: Tab;
}

interface LockRequest {
  mode: LockMode;
  tab: Tab;
  callback: Callback;
  resolve: (value: unknown) => void;
}

interface HeldLock {
  mode: LockMode;
  tab: Tab;
}

/**
 * An in-memory `navigator.locks` for one lock name that follows the Web Locks
 * spec (https://w3c.github.io/web-locks/): a request is grantable when it heads
 * the queue and no held lock conflicts with it (an exclusive request conflicts
 * with any held lock, a shared one only with an exclusive), `ifAvailable` calls
 * the callback with `null` when it isn't grantable, and a lock is released in a
 * later step after the callback's promise settles, with the `request()` promise
 * settling after that. Every step runs on its own microtask, so a request made
 * right after a release is evaluated first, as in a browser, where the lock
 * task queue lives in another process. A release takes `RELEASE_HOPS`
 * microtasks, so code that waits a fixed few turns instead of for the
 * `request()` promise still asks too early, and `stallReleases()` holds
 * releases back for as long as a test likes.
 */
const RELEASE_HOPS = 10;

/** Run `step` after `hops` microtask turns. */
function afterMicrotasks(hops: number, step: () => void): void {
  if (hops <= 0) step();
  else queueMicrotask(() => afterMicrotasks(hops - 1, step));
}

class FakeLockManager {
  readonly requests: RequestRecord[] = [];
  private readonly heldLocks: HeldLock[] = [];
  private readonly queue: LockRequest[] = [];
  private readonly failures: Partial<Record<LockMode, Error>> = {};
  private readonly throwing: Partial<Record<LockMode, Error>> = {};
  private stalled: Array<() => void> | null = null;

  /** What the app under test sees as `navigator.locks.request`. */
  request(
    name: string,
    optionsOrCallback: LockOptions | Callback,
    maybeCallback?: Callback,
  ): Promise<unknown> {
    const options =
      typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback;
    if (!callback) throw new TypeError('callback required');
    const thrown = this.throwing[options.mode ?? 'exclusive'];
    if (thrown) throw thrown;
    return this.enqueue('this', name, options, callback);
  }

  /** The modes of the locks a tab holds right now. */
  held(tab: Tab): LockMode[] {
    return this.heldLocks.filter((l) => l.tab === tab).map((l) => l.mode);
  }

  /** Another tab takes a shared lock, i.e. that tab is unsafe. */
  holdSharedAsOtherTab(): () => void {
    let release: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.enqueue('other', LOCK_NAME, { mode: 'shared' }, () => ended).catch(
      () => undefined,
    );
    return release;
  }

  /** Every request of this mode rejects, as when the document isn't active. */
  failRequests(mode: LockMode, error: Error): void {
    this.failures[mode] = error;
  }

  /** `request()` itself throws, before it returns a promise. */
  throwOnRequest(mode: LockMode, error: Error): void {
    this.throwing[mode] = error;
  }

  recover(mode: LockMode): void {
    delete this.failures[mode];
    delete this.throwing[mode];
  }

  /**
   * Hold back every release from now on. The returned function lets the held
   * releases through; releases after a later `stallReleases()` wait for that
   * one's function instead.
   */
  stallReleases(): () => void {
    const batch: Array<() => void> = [];
    this.stalled = batch;
    return () => {
      if (this.stalled === batch) this.stalled = null;
      for (const step of batch.splice(0)) step();
    };
  }

  private enqueue(
    tab: Tab,
    name: string,
    options: LockOptions,
    callback: Callback,
  ): Promise<unknown> {
    const mode = options.mode ?? 'exclusive';
    const ifAvailable = options.ifAvailable ?? false;
    this.requests.push({ name, mode, ifAvailable, tab });
    const failure = this.failures[mode];
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        const request: LockRequest = { mode, tab, callback, resolve };
        if (ifAvailable && !this.grantable(request)) {
          queueMicrotask(() => {
            try {
              resolve(callback(null));
            } catch (err: unknown) {
              reject(err);
            }
          });
          return;
        }
        this.queue.push(request);
        this.process();
      });
    });
  }

  private grantable(request: LockRequest): boolean {
    if (this.queue.length > 0 && this.queue[0] !== request) return false;
    if (request.mode === 'exclusive') return this.heldLocks.length === 0;
    return !this.heldLocks.some((l) => l.mode === 'exclusive');
  }

  private process(): void {
    for (;;) {
      const request = this.queue[0];
      if (!request || !this.grantable(request)) return;
      this.queue.shift();
      const lock: HeldLock = { mode: request.mode, tab: request.tab };
      this.heldLocks.push(lock);
      queueMicrotask(() => this.invoke(request, lock));
    }
  }

  private invoke(request: LockRequest, lock: HeldLock): void {
    let waiting: Promise<unknown>;
    try {
      waiting = Promise.resolve(
        request.callback({ name: LOCK_NAME, mode: request.mode }),
      );
    } catch (err: unknown) {
      waiting = Promise.reject(err);
    }
    const finish = (): void => {
      this.heldLocks.splice(this.heldLocks.indexOf(lock), 1);
      this.process();
      request.resolve(waiting);
    };
    const release = (): void =>
      afterMicrotasks(RELEASE_HOPS, () => {
        if (this.stalled) this.stalled.push(finish);
        else finish();
      });
    waiting.then(release, release);
  }
}

type UpdateSWMock = ReturnType<
  typeof vi.fn<(reloadPage?: boolean) => Promise<void>>
>;

let visibility: 'visible' | 'hidden';
let locks: FakeLockManager;
let updateSW: UpdateSWMock;

function changeVisibility(next: 'visible' | 'hidden'): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Let every pending lock step run, without moving the clock. */
async function settle(): Promise<void> {
  await advance(0);
}

function requestsOf(tab: Tab, mode: LockMode): RequestRecord[] {
  return locks.requests.filter((r) => r.tab === tab && r.mode === mode);
}

function visibilityListeners(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(([type]) => type === 'visibilitychange').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(IN_SESSION);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility,
  );
  locks = new FakeLockManager();
  vi.stubGlobal(
    'navigator',
    Object.create(navigator, {
      locks: { value: locks, enumerable: true },
    }),
  );
  updateSW = vi.fn<(reloadPage?: boolean) => Promise<void>>();
  updateSW.mockResolvedValue(undefined);
  setUpdateFn(updateSW);
});

afterEach(() => {
  resetUpdateState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the shared lock follows this tab', () => {
  it('takes no lock until the tracker starts', async () => {
    await advance(5 * TICK_MS);
    changeVisibility('visible');
    await settle();

    expect(locks.requests).toEqual([]);
  });

  it('takes the shared lock at start when the tab is visible in the session', async () => {
    startTabAgreement();
    await settle();

    expect(locks.requests).toEqual([
      { name: LOCK_NAME, mode: 'shared', ifAvailable: false, tab: 'this' },
    ]);
    expect(locks.held('this')).toEqual(['shared']);
  });

  it('takes none at start when the tab is hidden', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    await settle();

    expect(locks.requests).toEqual([]);
  });

  it('takes none at start when the tab is visible outside the session', async () => {
    vi.setSystemTime(OUT_OF_SESSION);
    startTabAgreement();
    await settle();

    expect(locks.requests).toEqual([]);
  });

  it('takes the lock when a hidden tab becomes visible in the session, and releases it when hidden again', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    await settle();
    expect(locks.held('this')).toEqual([]);

    changeVisibility('visible');
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    changeVisibility('hidden');
    await settle();
    expect(locks.held('this')).toEqual([]);
  });

  it('releases the lock when the session ends under a tab that stays visible', async () => {
    // 14:58:30 CT; the ticks land on 14:59:30 (still open) and 15:00:30.
    vi.setSystemTime(new Date('2026-12-02T20:58:30Z'));
    startTabAgreement();
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    await advance(TICK_MS);
    expect(locks.held('this')).toEqual(['shared']);

    await advance(TICK_MS);
    expect(locks.held('this')).toEqual([]);
  });

  it('takes the lock one tick before the session opens under a tab that stays visible', async () => {
    // 08:28:30 CT is 09:28:30 ET: closed now, and still closed a tick later.
    vi.setSystemTime(new Date('2026-12-02T14:28:30Z'));
    startTabAgreement();
    await settle();
    expect(locks.held('this')).toEqual([]);

    // At 08:29:30 CT the next tick lands inside the session, so the tab holds
    // its lock already, half a minute before the open.
    await advance(TICK_MS);
    expect(locks.held('this')).toEqual(['shared']);

    await advance(TICK_MS);
    expect(locks.held('this')).toEqual(['shared']);
  });

  it.each([
    ['09:28:59 ET, a tick and a second before the open', '14:28:59Z', []],
    ['09:29:00 ET, a tick before the open', '14:29:00Z', ['shared']],
    ['09:29:30 ET, half a tick before the open', '14:29:30Z', ['shared']],
  ] as const)(
    'a visible tab holds the lock at the start only from a tick before the open: %s',
    async (_label, time, expected) => {
      vi.setSystemTime(new Date(`2026-12-02T${time}`));
      startTabAgreement();
      await settle();

      expect(locks.held('this')).toEqual(expected);
    },
  );

  it('asks once, however many evaluations find the tab still unsafe', async () => {
    startTabAgreement();
    await advance(3 * TICK_MS);
    changeVisibility('visible');
    changeVisibility('visible');
    await settle();

    expect(requestsOf('this', 'shared')).toHaveLength(1);
  });

  it('takes no lock back after the tab is hidden before the first grant', async () => {
    startTabAgreement();
    changeVisibility('hidden');
    await settle();

    expect(locks.held('this')).toEqual([]);
  });
});

describe('a hold on the update takes the shared lock too', () => {
  beforeEach(() => {
    changeVisibility('hidden');
  });

  it('holds the lock from the first hold until the last release, with no tick in between', async () => {
    startTabAgreement();
    await settle();
    expect(locks.held('this')).toEqual([]);

    const releaseFirst = holdAutoUpdate();
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    const releaseSecond = holdAutoUpdate();
    await settle();
    expect(requestsOf('this', 'shared')).toHaveLength(1);

    releaseFirst();
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    releaseSecond();
    await settle();
    expect(locks.held('this')).toEqual([]);
  });

  it('announces a hold taken before the tracker started', async () => {
    holdAutoUpdate();
    startTabAgreement();
    await settle();

    expect(locks.held('this')).toEqual(['shared']);
  });

  it('takes no lock for a hold when the tracker is not running', async () => {
    holdAutoUpdate()();
    await settle();

    expect(locks.requests).toEqual([]);
  });

  it('releases the lock on the last release without applying a waiting update', async () => {
    startTabAgreement();
    markNeedsRefresh();
    const release = holdAutoUpdate();
    await advance(2 * TICK_MS);
    expect(locks.held('this')).toEqual(['shared']);
    expect(updateSW).not.toHaveBeenCalled();

    release();
    await settle();
    expect(locks.held('this')).toEqual([]);
    expect(updateSW).not.toHaveBeenCalled();

    await advance(TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('counts a repeated release once', async () => {
    startTabAgreement();
    const releaseFirst = holdAutoUpdate();
    holdAutoUpdate();
    releaseFirst();
    releaseFirst();
    await settle();

    expect(locks.held('this')).toEqual(['shared']);
  });
});

describe('an update applies only when every tab is safe', () => {
  it('does not apply while another tab holds the lock, then applies at the first tick after it lets go', async () => {
    const otherTabSafe = locks.holdSharedAsOtherTab();
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();

    await advance(3 * TICK_MS);
    expect(updateSW).not.toHaveBeenCalled();
    expect(requestsOf('this', 'exclusive')).toHaveLength(3);

    otherTabSafe();
    await settle();
    expect(updateSW).not.toHaveBeenCalled();

    await advance(TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('asks for the exclusive lock without waiting for it', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();

    await advance(TICK_MS);

    expect(locks.requests.at(-1)).toEqual({
      name: LOCK_NAME,
      mode: 'exclusive',
      ifAvailable: true,
      tab: 'this',
    });
  });

  it('applies a lone hidden tab at the next tick, and lets go of the exclusive lock', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    expect(updateSW).not.toHaveBeenCalled();

    await advance(TICK_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(locks.held('this')).toEqual([]);
    expect(locks.held('other')).toEqual([]);
  });

  it('does not ask while the tab is unsafe itself', async () => {
    startTabAgreement();
    markNeedsRefresh();

    await advance(5 * TICK_MS);

    expect(requestsOf('this', 'exclusive')).toEqual([]);
    expect(updateSW).not.toHaveBeenCalled();
  });

  it('lets go of its lock when hidden, asks nothing then, and applies at the next tick', async () => {
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    changeVisibility('hidden');
    await settle();
    expect(locks.held('this')).toEqual([]);
    expect(requestsOf('this', 'exclusive')).toEqual([]);
    expect(updateSW).not.toHaveBeenCalled();

    await advance(TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
    expect(locks.held('this')).toEqual([]);
  });

  it('does not apply on the visibility change of a tab switch, which races the other tab taking its lock', async () => {
    startTabAgreement();
    markNeedsRefresh();
    await settle();

    // The owner switches tabs: this one is hidden at once, and the other one
    // becomes visible and takes its shared lock a few milliseconds later.
    changeVisibility('hidden');
    await advance(5);
    expect(requestsOf('this', 'exclusive')).toEqual([]);
    locks.holdSharedAsOtherTab();
    await advance(TICK_MS);

    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
    expect(updateSW).not.toHaveBeenCalled();
  });

  it('asks only after its own release has gone through, however long the browser takes', async () => {
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    const resume = locks.stallReleases();
    // No event: the tick is what finds the tab safe, while it still holds its
    // shared lock.
    visibility = 'hidden';
    await advance(TICK_MS);
    expect(requestsOf('this', 'exclusive')).toEqual([]);
    expect(updateSW).not.toHaveBeenCalled();

    resume();
    await settle();

    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('applies at the tick that finds the tab safe, past a release that takes many turns', async () => {
    startTabAgreement();
    markNeedsRefresh();
    await settle();

    visibility = 'hidden';
    await advance(TICK_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
  });

  it('applies at the tick when the session ends under a visible tab, in the same tick', async () => {
    vi.setSystemTime(new Date('2026-12-02T20:58:30Z'));
    startTabAgreement();
    markNeedsRefresh();
    await advance(TICK_MS);
    expect(updateSW).not.toHaveBeenCalled();
    expect(locks.held('this')).toEqual(['shared']);

    await advance(TICK_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
  });

  it('does not apply when the tab turned unsafe while it was asking', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await settle();

    vi.advanceTimersByTime(TICK_MS);
    // No event: the tab turns unsafe while its request is still in flight.
    visibility = 'visible';
    await settle();

    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
    expect(updateSW).not.toHaveBeenCalled();
  });

  it('keeps one attempt in flight when ticks land while the first still waits for its release', async () => {
    startTabAgreement();
    markNeedsRefresh();
    await settle();

    const resume = locks.stallReleases();
    visibility = 'hidden';
    await advance(3 * TICK_MS);
    // A second and third attempt would have asked, and been refused, by now.
    expect(requestsOf('this', 'exclusive')).toEqual([]);

    resume();
    await settle();

    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('applies at most once however many safe moments follow', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await advance(TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);

    changeVisibility('visible');
    changeVisibility('hidden');
    markNeedsRefresh();
    await advance(10 * TICK_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
  });

  it('lets the banner Reload apply at once while another tab holds the lock', async () => {
    locks.holdSharedAsOtherTab();
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await settle();

    applyUpdate();
    expect(updateSW).toHaveBeenCalledTimes(1);

    await advance(5 * TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(requestsOf('this', 'exclusive')).toEqual([]);
  });

  it('leaves the per-tab rule alone when the tracker is not running', async () => {
    locks.holdSharedAsOtherTab();
    changeVisibility('hidden');
    markNeedsRefresh();

    await advance(TICK_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(locks.requests.filter((r) => r.tab === 'this')).toEqual([]);
  });
});

describe('an automatic apply that no controllerchange follows', () => {
  it('reports once, then asks the other tabs again at the next tick', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: new EventTarget(),
    });
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await advance(TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);

    // 30 s without a controllerchange: reported, and the wait starts again.
    await advance(30_000);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(requestsOf('this', 'exclusive')).toHaveLength(1);

    await advance(TICK_MS);
    expect(requestsOf('this', 'exclusive')).toHaveLength(2);
    expect(updateSW).toHaveBeenCalledTimes(2);
  });
});

describe('the tracker and a waiting update share one watch', () => {
  it('adds one timer and one listener for both, and the tracker outlives the apply', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const stop = startTabAgreement();
    markNeedsRefresh();

    expect(vi.getTimerCount()).toBe(1);
    expect(visibilityListeners(addListener)).toBe(1);

    changeVisibility('hidden');
    await advance(TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(removeListener).not.toHaveBeenCalled();

    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(visibilityListeners(removeListener)).toBe(1);
  });

  it('adds nothing a second time when the tracker starts twice', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const first = startTabAgreement();
    const second = startTabAgreement();
    await settle();

    expect(second).toBe(first);
    expect(vi.getTimerCount()).toBe(1);
    expect(visibilityListeners(addListener)).toBe(1);
    expect(requestsOf('this', 'shared')).toHaveLength(1);
  });

  it('keeps a waiting update ticking after the tracker stops, and frees the lock', async () => {
    const stop = startTabAgreement();
    markNeedsRefresh();
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    stop();
    await settle();

    expect(locks.held('this')).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('ignores the stop of a tracker that was already stopped and started again', async () => {
    const stopFirst = startTabAgreement();
    stopFirst();
    startTabAgreement();
    await settle();

    stopFirst();
    await settle();

    expect(vi.getTimerCount()).toBe(1);
    expect(locks.held('this')).toEqual(['shared']);
  });
});

describe('resetUpdateState', () => {
  it('releases a held lock and clears the timer and the listener', async () => {
    const removeListener = vi.spyOn(document, 'removeEventListener');
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    expect(locks.held('this')).toEqual(['shared']);

    resetUpdateState();
    await settle();

    expect(locks.held('this')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(visibilityListeners(removeListener)).toBe(1);
  });

  it('applies nothing for a request that was in flight', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    vi.advanceTimersByTime(TICK_MS);

    resetUpdateState();
    setUpdateFn(updateSW);
    await settle();

    expect(requestsOf('this', 'exclusive')).toEqual([]);
    expect(updateSW).not.toHaveBeenCalled();
  });

  it('keeps a stale attempt from applying for a wait that started after the reset', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    vi.advanceTimersByTime(TICK_MS);

    resetUpdateState();
    setUpdateFn(updateSW);
    startTabAgreement();
    markNeedsRefresh();
    await settle();

    // The new wait applies at its own tick, not through the old attempt.
    expect(requestsOf('this', 'exclusive')).toEqual([]);
    expect(updateSW).not.toHaveBeenCalled();
  });

  it('lets a new attempt start while a stale one waits, and keeps the stale one from clearing the new one', async () => {
    // Attempt 1 waits for the release of the first lock, which stalls.
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    const resumeFirst = locks.stallReleases();
    visibility = 'hidden';
    vi.advanceTimersByTime(TICK_MS);

    // A reset, then the same tab starts over, visible, with a second lock.
    resetUpdateState();
    setUpdateFn(updateSW);
    visibility = 'visible';
    startTabAgreement();
    markNeedsRefresh();
    await settle();
    expect(locks.held('this')).toEqual(['shared', 'shared']);

    // Attempt 2 waits for the release of the second lock, which stalls too.
    const resumeSecond = locks.stallReleases();
    visibility = 'hidden';
    vi.advanceTimersByTime(TICK_MS);

    // Attempt 1 comes through, finds a new epoch and ends without a trace.
    resumeFirst();
    await settle();
    expect(requestsOf('this', 'exclusive')).toEqual([]);

    // Attempt 2 is still in flight, so the next tick starts no third one.
    await advance(TICK_MS);
    expect(requestsOf('this', 'exclusive')).toEqual([]);

    resumeSecond();
    await settle();
    expect(requestsOf('this', 'exclusive')).toHaveLength(1);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('lets the tracker start afresh', async () => {
    startTabAgreement();
    resetUpdateState();
    await settle();

    startTabAgreement();
    await settle();

    expect(locks.held('this')).toEqual(['shared']);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('without navigator.locks', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not there in this environment, so these tests run Task 2 behavior', () => {
    expect('locks' in navigator).toBe(false);
  });

  it('starts nothing and returns a stop that does nothing', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const stop = startTabAgreement();

    expect(vi.getTimerCount()).toBe(0);
    expect(addListener).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('applies a hidden tab at the next tick on its own policy, as before', async () => {
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();

    await advance(TICK_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('holds a visible tab in the session', async () => {
    startTabAgreement();
    markNeedsRefresh();

    await advance(10 * TICK_MS);

    expect(updateSW).not.toHaveBeenCalled();
  });
});

describe('when the Web Locks API fails', () => {
  const failure = new DOMException('not fully active', 'InvalidStateError');

  it('reports a rejected shared request once, retries at each tick, and takes the lock when it recovers', async () => {
    locks.failRequests('shared', failure);
    startTabAgreement();
    await settle();

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      level: 'warning',
      tags: { context: 'sw_update_tabs' },
    });
    expect(locks.held('this')).toEqual([]);

    await advance(2 * TICK_MS);
    expect(requestsOf('this', 'shared')).toHaveLength(3);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);

    locks.recover('shared');
    await advance(TICK_MS);
    expect(locks.held('this')).toEqual(['shared']);
  });

  it('treats a request that throws before it returns a promise as a failed one, asked again at the next tick', async () => {
    const thrown = new TypeError('Illegal invocation');
    locks.throwOnRequest('shared', thrown);
    startTabAgreement();
    await settle();

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(thrown, {
      level: 'warning',
      tags: { context: 'sw_update_tabs' },
    });
    expect(locks.held('this')).toEqual([]);

    await advance(TICK_MS);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);

    locks.recover('shared');
    await advance(TICK_MS);
    expect(locks.held('this')).toEqual(['shared']);
  });

  it('reports a shared failure again after a lock has been granted in between', async () => {
    locks.failRequests('shared', failure);
    startTabAgreement();
    await settle();
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);

    locks.recover('shared');
    await advance(TICK_MS);
    expect(locks.held('this')).toEqual(['shared']);

    changeVisibility('hidden');
    await settle();
    locks.failRequests('shared', failure);
    changeVisibility('visible');
    await settle();

    expect(captureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected exclusive request once, applies nothing, and applies after it recovers', async () => {
    locks.failRequests('exclusive', failure);
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();

    await advance(3 * TICK_MS);
    expect(updateSW).not.toHaveBeenCalled();
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      level: 'warning',
      tags: { context: 'sw_update_tabs' },
    });

    locks.recover('exclusive');
    await advance(TICK_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('reports the failure again after a request has worked in between', async () => {
    locks.failRequests('exclusive', failure);
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();
    await advance(TICK_MS);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);

    const otherTabSafe = locks.holdSharedAsOtherTab();
    locks.recover('exclusive');
    await advance(TICK_MS);
    expect(updateSW).not.toHaveBeenCalled();

    otherTabSafe();
    locks.failRequests('exclusive', failure);
    await advance(TICK_MS);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('reports an error thrown while applying and keeps the tracker alive', async () => {
    const broken = new Error('postMessage failed');
    updateSW.mockImplementation(() => {
      throw broken;
    });
    changeVisibility('hidden');
    startTabAgreement();
    markNeedsRefresh();

    await advance(TICK_MS);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(broken, {
      level: 'warning',
      tags: { context: 'sw_update_tabs' },
    });
    expect(vi.getTimerCount()).toBe(1);
  });
});
