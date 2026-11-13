import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as Sentry from '@sentry/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOwnerSessionRenewal } from '../lib/owner-session-renewal';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getAccessMode, type AccessMode } from '../utils/auth';

vi.mock('../utils/auth', () => ({ getAccessMode: vi.fn() }));
vi.mock('../lib/sentry-helpers', () => ({ captureUnlessAuth: vi.fn() }));
vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// The spec'd values, written out so a changed constant fails a test.
const WHOAMI_URL = '/api/auth/whoami';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const fetchMock = vi.fn<typeof fetch>();

let stop: (() => void) | null = null;
let visibility: 'visible' | 'hidden';
let visibilitySpy: ReturnType<typeof vi.spyOn>;

function start(): () => void {
  stop = startOwnerSessionRenewal();
  return stop;
}

function setMode(mode: AccessMode): void {
  vi.mocked(getAccessMode).mockReturnValue(mode);
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function changeVisibility(next: 'visible' | 'hidden'): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Let the start's request settle, as it does on a real page. */
async function flush(): Promise<void> {
  await advance(0);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T15:00:00Z'));
  visibility = 'visible';
  visibilitySpy = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockImplementation(() => visibility);
  setMode('owner');
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ mode: 'owner' }))),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  stop?.();
  stop = null;
  visibilitySpy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('renewal at start', () => {
  it('asks whoami once when the app starts as the owner', async () => {
    start();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A plain same-origin GET: no body, no headers, nothing else to carry.
    expect(fetchMock).toHaveBeenCalledWith(WHOAMI_URL);
  });

  it.each(['guest', 'public'] as const)(
    'sends nothing in %s mode, at start, on a timer or on a tab switch',
    async (mode) => {
      setMode(mode);
      start();
      await advance(3 * DAY_MS);
      changeVisibility('hidden');
      changeVisibility('visible');

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('reads the mode fresh at start', async () => {
    setMode('public');
    stop = startOwnerSessionRenewal();
    stop();
    setMode('owner');
    stop = startOwnerSessionRenewal();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('at most once per 24 hours', () => {
  it('asks again after 24 hours and not before', async () => {
    start();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(DAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Within one check interval after the 24 hours are up.
    await advance(HOUR_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps asking once per day while the window stays open', async () => {
    start();
    await advance(10 * DAY_MS);

    // The start plus one a day. A tick that lands a little late never skips
    // a day, and never adds one.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('asks again on return to a visible tab once 24 hours have passed', async () => {
    start();
    await flush();
    changeVisibility('hidden');
    // The machine slept: the clock moved on and no timer fired.
    vi.setSystemTime(Date.now() + DAY_MS + 1);

    changeVisibility('visible');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not ask on a tab switch inside the 24 hours', async () => {
    start();
    await flush();
    await advance(DAY_MS - HOUR_MS);

    changeVisibility('hidden');
    changeVisibility('visible');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the tab is hidden, even past 24 hours', async () => {
    start();
    await flush();
    vi.setSystemTime(Date.now() + 2 * DAY_MS);

    changeVisibility('hidden');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again from a timer after the clock jumps past 24 hours', async () => {
    start();
    await flush();
    vi.setSystemTime(Date.now() + 3 * DAY_MS);

    await advance(HOUR_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops asking if the mode turns to guest or public', async () => {
    start();
    await flush();
    setMode('public');

    await advance(3 * DAY_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts asking once a guest session turns into the owner', async () => {
    setMode('guest');
    start();
    await advance(DAY_MS);
    expect(fetchMock).not.toHaveBeenCalled();

    setMode('owner');
    await advance(HOUR_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The first ask opens its own 24 hours.
    await advance(DAY_MS - 2 * HOUR_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a failed request', () => {
  it('a rejected fetch does not throw, and waits for the next day', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    expect(() => start()).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(DAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(HOUR_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 429, 500, 503])(
    'an HTTP %i answer is ignored and not retried inside the 24 hours',
    async (status) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(null, { status })),
      );

      expect(() => start()).not.toThrow();
      await advance(DAY_MS - 1);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('a failing mode read does not stop the start', async () => {
    vi.mocked(getAccessMode).mockImplementation(() => {
      throw new Error('cookies blocked');
    });

    expect(() => start()).not.toThrow();
    await advance(DAY_MS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a rejected fetch', () => Promise.reject(new Error('network down'))],
    [
      'a 500 answer',
      () => Promise.resolve(new Response(null, { status: 500 })),
    ],
  ])('reports nothing to Sentry for %s', async (_label, answer) => {
    // A failure here is routine (a laptop waking, a flaky network) and the
    // server reports its own errors.
    fetchMock.mockImplementation(answer);

    start();
    await advance(DAY_MS + HOUR_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});

describe('stopping', () => {
  it('removes the timer and the listener, and nothing is sent afterwards', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const stopRenewal = start();
    await flush();
    const added = add.mock.calls.find(([type]) => type === 'visibilitychange');
    expect(added).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    stopRenewal();

    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('visibilitychange', added?.[1]);
    fetchMock.mockClear();
    vi.setSystemTime(Date.now() + 3 * DAY_MS);
    changeVisibility('visible');
    await advance(3 * DAY_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a stop called twice is harmless', () => {
    const stopRenewal = start();
    stopRenewal();
    expect(() => stopRenewal()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second start replaces the first: the renewal does not double', async () => {
    startOwnerSessionRenewal();
    stop = startOwnerSessionRenewal();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per start
    expect(vi.getTimerCount()).toBe(1);

    fetchMock.mockClear();
    await advance(DAY_MS + HOUR_MS);

    // One run is left, so one ask after the day, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an old start's stop does not stop the current run", async () => {
    const stopFirst = startOwnerSessionRenewal();
    stop = startOwnerSessionRenewal();
    await flush();
    fetchMock.mockClear();

    stopFirst();
    expect(vi.getTimerCount()).toBe(1);
    await advance(DAY_MS + HOUR_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// main.tsx runs at import and is excluded from coverage, so a dropped call
// would fail silently (the sign-in would simply stop renewing). Read the
// source, as live-session-signal.test.ts does, with comments stripped so a
// comment naming a symbol doesn't count.
describe('main.tsx wiring', () => {
  const mainCode = readFileSync(path.resolve(__dirname, '../main.tsx'), 'utf-8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

  it('starts the renewal once, from outside React', () => {
    expect(mainCode.match(/\bstartOwnerSessionRenewal\(\)/g)).toHaveLength(1);
    expect(mainCode).toMatch(
      /import \{ startOwnerSessionRenewal \} from '\.\/lib\/owner-session-renewal'/,
    );
  });

  it('starts the renewal beside the live-session signals, before React mounts', () => {
    const signals = mainCode.indexOf('startLiveSessionSignals()');
    const renewal = mainCode.indexOf('startOwnerSessionRenewal()');
    const mount = mainCode.indexOf('createRoot(');
    expect(signals).toBeGreaterThan(-1);
    expect(renewal).toBeGreaterThan(signals);
    expect(mount).toBeGreaterThan(renewal);
  });
});
