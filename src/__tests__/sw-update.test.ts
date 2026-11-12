import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUpdateState, startUpdateChecks } from '../lib/sw-update';
import { captureUnlessAuth } from '../lib/sentry-helpers';

vi.mock('../lib/sentry-helpers', () => ({ captureUnlessAuth: vi.fn() }));

// The spec'd values, written out so a changed constant fails a test.
const INTERVAL_MS = 15 * 60 * 1000;
const VISIBLE_THROTTLE_MS = 60 * 1000;
const SW_URL = '/sw.js';

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
      expect.objectContaining({ cache: 'no-store' }),
    );
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

  it('does not throw or report when update() rejects with a network error', async () => {
    const registration = makeRegistration();
    registration.update.mockRejectedValue(
      new TypeError('Failed to update a ServiceWorker: Failed to fetch'),
    );
    start(registration);

    await advance(INTERVAL_MS);

    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
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
