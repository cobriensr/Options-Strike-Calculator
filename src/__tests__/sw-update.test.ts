import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  applyUpdate,
  getNeedsRefresh,
  holdAutoUpdate,
  markNeedsRefresh,
  resetUpdateState,
  setUpdateFn,
  startUpdateChecks,
} from '../lib/sw-update';
import { captureUnlessAuth } from '../lib/sentry-helpers';

vi.mock('../lib/sentry-helpers', () => ({ captureUnlessAuth: vi.fn() }));

// The spec'd values, written out so a changed constant fails a test.
const INTERVAL_MS = 15 * 60 * 1000;
const VISIBLE_THROTTLE_MS = 60 * 1000;
const SAFE_MOMENT_INTERVAL_MS = 60 * 1000;
const SW_URL = '/sw.js';

type UpdateSWFn = (reloadPage?: boolean) => Promise<void>;
type UpdateSWMock = Mock<UpdateSWFn>;

type FakeRegistration = {
  installing: object | null;
  update: ReturnType<typeof vi.fn>;
};

function makeRegistration(): FakeRegistration {
  return { installing: null, update: vi.fn().mockResolvedValue(undefined) };
}

function start(registration: FakeRegistration): () => void {
  return startUpdateChecks(
    registration as unknown as ServiceWorkerRegistration,
    SW_URL,
  );
}

const fetchMock = vi.fn();
let visibility: 'visible' | 'hidden';
let onLine: ReturnType<typeof vi.spyOn>;

function changeVisibility(next: 'visible' | 'hidden'): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility,
  );
  onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fetchMock.mockResolvedValue({ status: 200 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  resetUpdateState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('startUpdateChecks scheduling', () => {
  it('does nothing until it is started', async () => {
    await advance(2 * INTERVAL_MS);
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not check at start, then checks at 15 and 30 minutes', async () => {
    const registration = makeRegistration();
    start(registration);

    await advance(0);
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(INTERVAL_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registration.update).toHaveBeenCalledTimes(1);

    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it('fetches the worker script uncached before it calls update()', async () => {
    const registration = makeRegistration();
    start(registration);
    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledWith(
      SW_URL,
      expect.objectContaining({
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('gives the worker script fetch a 30 second timeout signal', async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    start(makeRegistration());

    await advance(INTERVAL_MS);

    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock).toHaveBeenCalledWith(SW_URL, {
      cache: 'no-store',
      signal,
    });
  });

  it.each([200, 503])(
    'cancels the unread body of a %i worker script response',
    async (status) => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      fetchMock.mockResolvedValue({ status, body: { cancel } });
      start(makeRegistration());

      await advance(INTERVAL_MS);

      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('carries on, with no unhandled rejection, when cancelling the body fails', async () => {
    // A plain function, not vi.fn(): the spy tracks the promise it returns,
    // which would count as handling it and hide an unhandled rejection.
    let cancelCalls = 0;
    const body = {
      cancel: () => {
        cancelCalls += 1;
        return Promise.reject(new TypeError('stream is locked'));
      },
    };
    fetchMock.mockResolvedValue({ status: 200, body });
    const registration = makeRegistration();
    start(registration);

    await advance(INTERVAL_MS);

    expect(cancelCalls).toBe(1);
    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('skips update() when the worker script fetch is not a 200', async () => {
    fetchMock.mockResolvedValue({ status: 503 });
    const registration = makeRegistration();
    start(registration);
    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registration.update).not.toHaveBeenCalled();
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('skips a check while the registration is installing a worker', async () => {
    const registration = makeRegistration();
    registration.installing = {};
    start(registration);
    await advance(INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
  });

  it('skips a check while the previous one is still in flight', async () => {
    let finishFetch: () => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFetch = () => resolve({ status: 200 });
      }),
    );
    const registration = makeRegistration();
    start(registration);

    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishFetch();
    await advance(0);
    expect(registration.update).toHaveBeenCalledTimes(1);

    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing and sets no timer when there is no registration', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const stop = startUpdateChecks(undefined, SW_URL);

    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await advance(INTERVAL_MS);
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});

describe('startUpdateChecks on visibilitychange', () => {
  it('checks when the tab becomes visible, then at most once a minute', async () => {
    const registration = makeRegistration();
    start(registration);

    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registration.update).toHaveBeenCalledTimes(1);

    await advance(VISIBLE_THROTTLE_MS - 1);
    changeVisibility('hidden');
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1);
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not check when the tab becomes hidden', async () => {
    start(makeRegistration());
    changeVisibility('hidden');
    await advance(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts an interval check toward the one-minute throttle', async () => {
    start(makeRegistration());
    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(VISIBLE_THROTTLE_MS - 1);
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still runs the interval check right after a visible check', async () => {
    start(makeRegistration());
    await advance(INTERVAL_MS - 1000);
    changeVisibility('visible');
    await advance(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('startUpdateChecks offline', () => {
  it('skips interval and visible checks while the browser is offline', async () => {
    onLine.mockReturnValue(false);
    const registration = makeRegistration();
    start(registration);

    await advance(INTERVAL_MS);
    changeVisibility('visible');
    await advance(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('does not start the throttle when a visible check was skipped offline', async () => {
    onLine.mockReturnValue(false);
    start(makeRegistration());
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).not.toHaveBeenCalled();

    onLine.mockReturnValue(true);
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('startUpdateChecks failures', () => {
  it('does not throw or report when the script fetch hits a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const registration = makeRegistration();
    start(registration);

    await advance(INTERVAL_MS);

    expect(registration.update).not.toHaveBeenCalled();
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('treats a timeout of the script fetch as routine and releases the guard', async () => {
    fetchMock
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValue({ status: 200 });
    const registration = makeRegistration();
    start(registration);

    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registration.update).not.toHaveBeenCalled();
    expect(captureUnlessAuth).not.toHaveBeenCalled();

    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it('reports a TypeError from update() after a 200 as a warning', async () => {
    const failure = new TypeError('ServiceWorker script evaluation failed');
    const registration = makeRegistration();
    registration.update.mockRejectedValue(failure);
    start(registration);

    await advance(INTERVAL_MS);

    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      level: 'warning',
      tags: { context: 'sw_update_check' },
    });
  });

  it('does not report the same update() failure again on the next tick', async () => {
    const registration = makeRegistration();
    registration.update.mockRejectedValue(new TypeError('evaluation failed'));
    start(registration);

    await advance(INTERVAL_MS);
    await advance(INTERVAL_MS);

    expect(registration.update).toHaveBeenCalledTimes(2);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('reports the same update() failure again after a successful check', async () => {
    const failure = new TypeError('evaluation failed');
    const registration = makeRegistration();
    registration.update
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(failure);
    start(registration);

    await advance(3 * INTERVAL_MS);

    expect(registration.update).toHaveBeenCalledTimes(3);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('reports a failure of a different kind while another is latched', async () => {
    const registration = makeRegistration();
    registration.update
      .mockRejectedValueOnce(new TypeError('evaluation failed'))
      .mockRejectedValue(new DOMException('gone', 'InvalidStateError'));
    start(registration);

    await advance(2 * INTERVAL_MS);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('drops the latch when the checks restart', async () => {
    const registration = makeRegistration();
    registration.update.mockRejectedValue(new TypeError('evaluation failed'));
    start(registration);
    await advance(INTERVAL_MS);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);

    start(registration);
    await advance(INTERVAL_MS);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('does not report any failure that lands while the browser is offline', async () => {
    const registration = makeRegistration();
    registration.update.mockImplementation(() => {
      onLine.mockReturnValue(false);
      return Promise.reject(new Error('connection dropped'));
    });
    start(registration);

    await advance(INTERVAL_MS);

    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('reports a non-network update() failure as a warning', async () => {
    const failure = new DOMException(
      'registration is gone',
      'InvalidStateError',
    );
    const registration = makeRegistration();
    registration.update.mockRejectedValue(failure);
    start(registration);

    await advance(INTERVAL_MS);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      level: 'warning',
      tags: { context: 'sw_update_check' },
    });
  });

  it('reports a non-network failure of the script fetch as a warning', async () => {
    const failure = new Error('unexpected');
    fetchMock.mockRejectedValue(failure);
    start(makeRegistration());

    await advance(INTERVAL_MS);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      level: 'warning',
      tags: { context: 'sw_update_check' },
    });
  });

  it('checks again after a failed check', async () => {
    const registration = makeRegistration();
    registration.update
      .mockRejectedValueOnce(new Error('first check fails'))
      .mockResolvedValue(undefined);
    start(registration);

    await advance(INTERVAL_MS);
    await advance(INTERVAL_MS);

    expect(registration.update).toHaveBeenCalledTimes(2);
  });
});

describe('startUpdateChecks cleanup', () => {
  it('stop clears the interval and removes the listener', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const stop = start(makeRegistration());
    expect(vi.getTimerCount()).toBe(1);

    stop();

    const added = addListener.mock.calls.find(
      ([type]) => type === 'visibilitychange',
    );
    expect(added).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', added?.[1]);
    expect(vi.getTimerCount()).toBe(0);

    await advance(2 * INTERVAL_MS);
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stop is safe to call twice', () => {
    const stop = start(makeRegistration());
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('resetUpdateState stops the checks', async () => {
    start(makeRegistration());
    resetUpdateState();

    expect(vi.getTimerCount()).toBe(0);
    await advance(2 * INTERVAL_MS);
    changeVisibility('visible');
    await advance(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a second start replaces the first instead of stacking a timer', async () => {
    const first = makeRegistration();
    const second = makeRegistration();
    start(first);
    start(second);

    expect(vi.getTimerCount()).toBe(1);
    await advance(INTERVAL_MS);

    expect(first.update).not.toHaveBeenCalled();
    expect(second.update).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the visible listener is replaced too, so one event checks once', async () => {
    start(makeRegistration());
    const second = makeRegistration();
    start(second);

    changeVisibility('visible');
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.update).toHaveBeenCalledTimes(1);
  });

  it('the stop function of a replaced start leaves the newer checks running', async () => {
    const stopFirst = start(makeRegistration());
    const second = makeRegistration();
    start(second);

    stopFirst();
    await advance(INTERVAL_MS);

    expect(second.update).toHaveBeenCalledTimes(1);
  });

  it('resetUpdateState still stops the newer checks after a replaced stop ran', async () => {
    const stopFirst = start(makeRegistration());
    const second = makeRegistration();
    start(second);

    stopFirst();
    resetUpdateState();

    expect(vi.getTimerCount()).toBe(0);
    await advance(INTERVAL_MS);
    expect(second.update).not.toHaveBeenCalled();
  });
});

// Wednesday 2026-12-02 at 10:00 CST, in the cash session, and Saturday
// 2026-12-05 at 10:00 CST, outside it. The policy itself is table-tested in
// sw-update-policy.test.ts; these tests drive it through the real clock.
const IN_SESSION = new Date('2026-12-02T16:00:00Z');
const OUT_OF_SESSION = new Date('2026-12-05T16:00:00Z');

describe('a waiting update applies at a safe moment', () => {
  let updateSW: UpdateSWMock;

  beforeEach(() => {
    vi.setSystemTime(IN_SESSION);
    updateSW = vi.fn<UpdateSWFn>().mockResolvedValue(undefined);
    setUpdateFn(updateSW);
  });

  it('does nothing while no update waits', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    changeVisibility('hidden');
    await advance(10 * SAFE_MOMENT_INTERVAL_MS);

    expect(updateSW).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(addListener).not.toHaveBeenCalled();
  });

  it('applies a hidden tab at the next 60 second tick, once', async () => {
    changeVisibility('hidden');
    markNeedsRefresh();
    expect(updateSW).not.toHaveBeenCalled();

    await advance(SAFE_MOMENT_INTERVAL_MS - 1);
    expect(updateSW).not.toHaveBeenCalled();

    await advance(1);
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('leaves the first evaluation to the next tick, so an immediate Reload is the only apply', async () => {
    // The banner's own test marks an update with the real clock and then
    // clicks Reload; an apply inside markNeedsRefresh would run twice
    // whenever the clock is outside the session.
    vi.setSystemTime(OUT_OF_SESSION);
    markNeedsRefresh();
    applyUpdate();

    expect(updateSW).toHaveBeenCalledTimes(1);
    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('holds a visible tab in the session, then applies when it is hidden', async () => {
    markNeedsRefresh();

    await advance(15 * SAFE_MOMENT_INTERVAL_MS);
    changeVisibility('visible');
    await advance(0);
    expect(updateSW).not.toHaveBeenCalled();

    changeVisibility('hidden');
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('applies a visible tab at the first tick after the session closes', async () => {
    // 14:58:30 CT; the ticks land on 14:59:30 (still open) and 15:00:30.
    vi.setSystemTime(new Date('2026-12-02T20:58:30Z'));
    markNeedsRefresh();

    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).not.toHaveBeenCalled();

    await advance(SAFE_MOMENT_INTERVAL_MS - 1);
    expect(updateSW).not.toHaveBeenCalled();

    await advance(1);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('applies a visible tab outside the session at the next tick', async () => {
    vi.setSystemTime(OUT_OF_SESSION);
    markNeedsRefresh();
    expect(updateSW).not.toHaveBeenCalled();

    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates on a visibility change without waiting for the tick', () => {
    vi.setSystemTime(OUT_OF_SESSION);
    markNeedsRefresh();

    changeVisibility('visible');

    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('applies at most once however many safe moments follow', async () => {
    changeVisibility('hidden');
    markNeedsRefresh();
    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);

    changeVisibility('visible');
    changeVisibility('hidden');
    markNeedsRefresh();
    await advance(10 * SAFE_MOMENT_INTERVAL_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting once the banner Reload applies the update', async () => {
    markNeedsRefresh();

    applyUpdate();
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    changeVisibility('hidden');
    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when no update function is registered yet', async () => {
    resetUpdateState();
    changeVisibility('hidden');
    markNeedsRefresh();

    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(1);

    setUpdateFn(updateSW);
    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('reports a failed apply once and does not try again', async () => {
    const failure = new Error('postMessage failed');
    updateSW.mockRejectedValue(failure);
    changeVisibility('hidden');
    markNeedsRefresh();

    await advance(SAFE_MOMENT_INTERVAL_MS);
    await advance(10 * SAFE_MOMENT_INTERVAL_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      level: 'warning',
      tags: { context: 'sw_update_apply' },
    });
  });
});

describe('holdAutoUpdate', () => {
  let updateSW: UpdateSWMock;

  beforeEach(() => {
    vi.setSystemTime(IN_SESSION);
    updateSW = vi.fn<UpdateSWFn>().mockResolvedValue(undefined);
    setUpdateFn(updateSW);
    changeVisibility('hidden');
  });

  it('blocks a safe moment until released, then applies at the next tick', async () => {
    const release = holdAutoUpdate();
    markNeedsRefresh();

    await advance(10 * SAFE_MOMENT_INTERVAL_MS);
    changeVisibility('visible');
    changeVisibility('hidden');
    expect(updateSW).not.toHaveBeenCalled();

    release();
    expect(updateSW).not.toHaveBeenCalled();
    await advance(0);
    expect(updateSW).not.toHaveBeenCalled();

    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('blocks a hold taken while the update already waits', async () => {
    markNeedsRefresh();
    await advance(SAFE_MOMENT_INTERVAL_MS / 2);

    const release = holdAutoUpdate();
    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).not.toHaveBeenCalled();

    release();
    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('applies on a visibility change after the release without waiting for the tick', () => {
    const release = holdAutoUpdate();
    markNeedsRefresh();
    release();

    changeVisibility('hidden');

    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('stays blocked until every hold is released', async () => {
    const releaseFirst = holdAutoUpdate();
    const releaseSecond = holdAutoUpdate();
    markNeedsRefresh();

    releaseFirst();
    await advance(2 * SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).not.toHaveBeenCalled();

    releaseSecond();
    await advance(SAFE_MOMENT_INTERVAL_MS);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('counts a release once however often it is called', async () => {
    const releaseFirst = holdAutoUpdate();
    holdAutoUpdate();
    markNeedsRefresh();

    releaseFirst();
    releaseFirst();
    releaseFirst();
    await advance(2 * SAFE_MOMENT_INTERVAL_MS);

    expect(updateSW).not.toHaveBeenCalled();
  });

  it('ignores a release from before resetUpdateState', async () => {
    const staleRelease = holdAutoUpdate();
    resetUpdateState();
    setUpdateFn(updateSW);
    changeVisibility('hidden');
    holdAutoUpdate();
    markNeedsRefresh();

    staleRelease();
    await advance(2 * SAFE_MOMENT_INTERVAL_MS);

    expect(updateSW).not.toHaveBeenCalled();
  });

  it('is cleared by resetUpdateState', async () => {
    holdAutoUpdate();
    resetUpdateState();
    setUpdateFn(updateSW);
    changeVisibility('hidden');
    markNeedsRefresh();

    await advance(SAFE_MOMENT_INTERVAL_MS);

    expect(updateSW).toHaveBeenCalledTimes(1);
  });
});

describe('the safe-moment wait cleans up', () => {
  beforeEach(() => {
    vi.setSystemTime(IN_SESSION);
    setUpdateFn(vi.fn().mockResolvedValue(undefined));
  });

  it('adds one interval and one listener when an update waits, and removes both on apply', () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const removeListener = vi.spyOn(document, 'removeEventListener');

    markNeedsRefresh();

    expect(vi.getTimerCount()).toBe(1);
    const added = addListener.mock.calls.filter(
      ([type]) => type === 'visibilitychange',
    );
    expect(added).toHaveLength(1);

    changeVisibility('hidden');

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith(
      'visibilitychange',
      added[0]?.[1],
    );
  });

  it('is torn down by resetUpdateState while an update still waits', () => {
    const removeListener = vi.spyOn(document, 'removeEventListener');
    markNeedsRefresh();
    expect(getNeedsRefresh()).toBe(true);

    resetUpdateState();

    expect(getNeedsRefresh()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
  });

  it('runs apart from the update checks, which carry on after an apply', async () => {
    start(makeRegistration());
    expect(vi.getTimerCount()).toBe(1);
    markNeedsRefresh();
    expect(vi.getTimerCount()).toBe(2);

    changeVisibility('hidden');
    expect(vi.getTimerCount()).toBe(1);

    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetUpdateState();
    expect(vi.getTimerCount()).toBe(0);
  });
});
