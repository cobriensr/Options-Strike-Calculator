import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isLiveSaveDevice,
  subscribeLiveSaveDevice,
} from '../lib/live-save-device';
import { startLiveSessionSignals } from '../lib/live-session-signal';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getAccessMode, type AccessMode } from '../utils/auth';

vi.mock('../utils/auth', () => ({ getAccessMode: vi.fn() }));
vi.mock('../lib/live-save-device', () => ({
  isLiveSaveDevice: vi.fn(),
  subscribeLiveSaveDevice: vi.fn(),
}));
vi.mock('../lib/sentry-helpers', () => ({ captureUnlessAuth: vi.fn() }));

// The spec'd values, written out so a changed constant fails a test.
const URL_PATH = '/api/snapshot-close';
const FOLLOW_UP_MS = 30 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;
const WARNING = {
  level: 'warning',
  tags: { context: 'live_session_open_signal' },
};

// Tuesday 2026-03-10 at 11:00 EDT: inside the cash session.
const IN_SESSION = '2026-03-10T15:00:00Z';

const fetchMock = vi.fn<typeof fetch>();
const beaconMock =
  vi.fn<(url: string | URL, data?: BodyInit | null) => boolean>();
/** The callbacks `subscribeLiveSaveDevice` was given, as the real one keeps. */
const subscribers = new Set<() => void>();

let stop: (() => void) | null = null;
let onLine: ReturnType<typeof vi.spyOn>;

function start(): () => void {
  stop = startLiveSessionSignals();
  return stop;
}

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function respondWith(status: number): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(null, { status })),
  );
}

function notifySubscribers(): void {
  for (const notify of subscribers) notify();
}

/** The switch flipped in this tab: storage changes, subscribers are told. */
function flipSwitch(on: boolean): void {
  vi.mocked(isLiveSaveDevice).mockReturnValue(on);
  notifySubscribers();
}

function pageHide(persisted = false): void {
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted }));
}

function pageShow(persisted: boolean): void {
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted }));
}

/** Another tab of the origin wrote localStorage: the browser fires this here. */
function storageEvent(): void {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'sc-live-save-device',
      newValue: 'on',
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  at(IN_SESSION);
  subscribers.clear();
  vi.mocked(getAccessMode).mockReturnValue('owner');
  vi.mocked(isLiveSaveDevice).mockReturnValue(true);
  vi.mocked(subscribeLiveSaveDevice).mockImplementation((cb) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  });
  respondWith(204);
  vi.stubGlobal('fetch', fetchMock);
  onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  beaconMock.mockReturnValue(true);
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: beaconMock,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  Reflect.deleteProperty(navigator, 'sendBeacon');
  onLine.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the open signal: cadence', () => {
  it('sends at start, at 30 s, then every 5 minutes, and none after stop', async () => {
    const stopSignals = start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(FOLLOW_UP_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(INTERVAL_MS - FOLLOW_UP_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    stopSignals();
    await advance(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('is a plain same-origin DELETE: no body, no headers, no mode', async () => {
    start();
    await advance(FOLLOW_UP_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(URL_PATH);
      expect(call[1]).toStrictEqual({ method: 'DELETE' });
    }
  });
});

describe('the open signal: only inside the cash session', () => {
  it.each([
    ['before the open', '2026-03-10T13:00:00Z', 29 * 60 * 1000], // 09:00 EDT
    ['at the close, 16:00 ET', '2026-03-10T20:00:00Z', 60 * 60 * 1000],
    ['on a Saturday', '2026-03-14T15:00:00Z', 60 * 60 * 1000],
    ['on a holiday (Thanksgiving)', '2026-11-26T16:00:00Z', 60 * 60 * 1000],
    [
      'after a half-day close, 13:00 ET',
      '2026-11-27T19:00:00Z',
      60 * 60 * 1000,
    ],
    ['at 08:45 ET in winter (13:45Z)', '2026-01-13T13:45:00Z', 40 * 60 * 1000],
  ])('sends nothing %s', async (_name, iso, runMs) => {
    at(iso);
    start();
    await advance(runMs);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends at 09:45 ET in summer (13:45Z), the same UTC time that is before the open in winter', () => {
    at('2026-03-10T13:45:00Z');
    start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the first tick inside the session, not before it', async () => {
    at('2026-03-10T13:29:50Z'); // 09:29:50 EDT
    start();
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(FOLLOW_UP_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(1); // 09:30:20
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts the open itself as inside the session (09:30:00 ET)', async () => {
    at('2026-03-10T13:29:30Z');
    start();
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(FOLLOW_UP_MS); // 09:30:00
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops at the close itself (16:00:00 ET)', async () => {
    at('2026-03-10T19:59:30Z');
    start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(FOLLOW_UP_MS); // 16:00:00
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at a half-day's own close (13:00 ET)", async () => {
    at('2026-11-27T17:59:30Z'); // 12:59:30 EST
    start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(FOLLOW_UP_MS); // 13:00:00
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a ticking page its first signal when the session opens', async () => {
    at('2026-03-10T13:02:00Z'); // 09:02 EDT; ticks 09:07 ... 09:27, 09:32
    start();
    await advance(29 * 60 * 1000); // 09:31
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(60 * 1000); // 09:32
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('who sends', () => {
  it.each<AccessMode>(['guest', 'public'])(
    'sends no signal and no beacon for a %s visitor',
    async (mode) => {
      vi.mocked(getAccessMode).mockReturnValue(mode);
      start();
      await advance(10 * 60 * 1000);
      pageHide();
      pageShow(true);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(beaconMock).not.toHaveBeenCalled();
    },
  );

  it('sends no signal and no beacon from a browser that is not a live-save device', async () => {
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();
    await advance(10 * 60 * 1000);
    pageHide();
    pageShow(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).not.toHaveBeenCalled();
  });
});

describe('the switch in this tab', () => {
  it('flipping it off sends one close, then stops the signals and the beacon', async () => {
    start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    flipSwitch(false);
    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0]).toStrictEqual([URL_PATH]);

    await advance(10 * 60 * 1000);
    pageHide();

    // Only the open signal from start: no DELETE since, no POST ever.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, { method: 'DELETE' });
    expect(beaconMock).toHaveBeenCalledTimes(1);
  });

  it('sends that close outside the cash session too, like pagehide', () => {
    at('2026-03-14T15:00:00Z'); // a Saturday
    start();

    flipSwitch(false);

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries that close in a keepalive POST when the beacon is refused', () => {
    start();
    fetchMock.mockClear();
    beaconMock.mockReturnValue(false);

    flipSwitch(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, {
      method: 'POST',
      keepalive: true,
    });
  });

  it('sends no close from a browser that never saved (a phone set to off)', () => {
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();

    flipSwitch(false);

    expect(beaconMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one close for one real off: setting off again sends no second', () => {
    start();

    flipSwitch(false);
    flipSwitch(false);

    expect(beaconMock).toHaveBeenCalledTimes(1);
  });

  it('sends a close for each off after an on in between', () => {
    start();
    fetchMock.mockClear();

    flipSwitch(false);
    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    flipSwitch(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(URL_PATH, { method: 'DELETE' });

    flipSwitch(false);
    expect(beaconMock).toHaveBeenCalledTimes(2);
  });

  it.each<AccessMode>(['guest', 'public'])(
    'sends no close for a %s visitor who turns it off',
    (mode) => {
      vi.mocked(getAccessMode).mockReturnValue(mode);
      start();

      flipSwitch(false);

      expect(beaconMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('flipping it on sends an open signal at once, inside the session', () => {
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();
    expect(fetchMock).not.toHaveBeenCalled();

    flipSwitch(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(URL_PATH, { method: 'DELETE' });
  });

  it('flipping it on outside the session sends nothing, then the first tick inside does', async () => {
    at('2026-03-10T13:29:00Z'); // 09:29 EDT
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();

    flipSwitch(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(FOLLOW_UP_MS); // 09:29:30, still before the open
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(INTERVAL_MS); // the 5-minute tick, 09:34:00
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flipping it on lets the beacon go again', () => {
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();
    flipSwitch(true);
    pageHide();
    expect(beaconMock).toHaveBeenCalledTimes(1);
  });
});

describe('the switch or the session changed with no notification here', () => {
  it('another tab flips the switch off: the next tick and the next pagehide send nothing', async () => {
    start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // No `flipSwitch`: the stored override changed in another tab, so this
    // tab's subscribers were never called.
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    await advance(INTERVAL_MS);
    pageHide();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(beaconMock).not.toHaveBeenCalled();
  });

  it('another tab flips the switch on: the next tick sends', async () => {
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();
    await advance(INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.mocked(isLiveSaveDevice).mockReturnValue(true);
    await advance(INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    // [name, now, ms before the other tab's flip, ms from it to the tick]
    ['the 30 s follow-up', IN_SESSION, 0, FOLLOW_UP_MS],
    [
      'the first 5-minute tick',
      IN_SESSION,
      FOLLOW_UP_MS,
      INTERVAL_MS - FOLLOW_UP_MS,
    ],
    [
      'a 5-minute tick outside the session',
      '2026-03-14T15:00:00Z', // a Saturday
      FOLLOW_UP_MS,
      INTERVAL_MS - FOLLOW_UP_MS,
    ],
  ])(
    'another tab turned it on, %s passes, then this tab turns it off: the close goes',
    async (_name, iso, beforeMs, ms) => {
      vi.mocked(isLiveSaveDevice).mockReturnValue(false);
      at(iso);
      start();
      await advance(beforeMs);

      // No `flipSwitch`: the other tab wrote the stored override, so this
      // tab's subscribers were never called. Only a tick can learn of it.
      vi.mocked(isLiveSaveDevice).mockReturnValue(true);
      await advance(ms);
      expect(beaconMock).not.toHaveBeenCalled();

      flipSwitch(false);

      expect(beaconMock).toHaveBeenCalledTimes(1);
      expect(beaconMock.mock.calls[0]).toStrictEqual([URL_PATH]);
    },
  );

  it('another tab turned it on (a storage event, no tick yet), then this tab turns it off: the close goes, and the event itself sends nothing', () => {
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();

    // The browser fires `storage` here when another tab of the origin writes
    // localStorage; `subscribeLiveSaveDevice` is never called for it.
    vi.mocked(isLiveSaveDevice).mockReturnValue(true);
    storageEvent();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).not.toHaveBeenCalled();

    flipSwitch(false);

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0]).toStrictEqual([URL_PATH]);
  });

  it('another tab turned it off (a storage event): this tab then turning it off sends no second close', () => {
    start();

    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    storageEvent();
    flipSwitch(false);

    expect(beaconMock).not.toHaveBeenCalled();
  });

  it('a throwing switch read inside the storage listener does not throw, reports nothing and keeps the last value', () => {
    start();
    fetchMock.mockClear();
    // jsdom reports a listener's throw as an `error` event on the window
    // rather than rethrowing it from `dispatchEvent`, so listen for that.
    const onError = vi.fn();
    window.addEventListener('error', onError);
    try {
      vi.mocked(isLiveSaveDevice).mockImplementation(() => {
        throw new Error('storage exploded');
      });
      expect(() => storageEvent()).not.toThrow();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(captureUnlessAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    flipSwitch(false);
    expect(beaconMock).toHaveBeenCalledTimes(1);
  });

  it('the owner session goes away: the next tick and the next pagehide send nothing', async () => {
    start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.mocked(getAccessMode).mockReturnValue('public');
    await advance(INTERVAL_MS);
    pageHide();
    pageShow(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(beaconMock).not.toHaveBeenCalled();
  });
});

describe('the close signal', () => {
  it.each([false, true])(
    'sends one beacon with no body on pagehide (persisted: %s)',
    (persisted) => {
      start();
      fetchMock.mockClear();

      pageHide(persisted);

      expect(beaconMock).toHaveBeenCalledTimes(1);
      expect(beaconMock.mock.calls[0]).toStrictEqual([URL_PATH]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('is not gated on the session', () => {
    at('2026-03-14T15:00:00Z'); // a Saturday
    start();

    pageHide();

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['sendBeacon returns false', () => beaconMock.mockReturnValue(false)],
    [
      'sendBeacon throws',
      () =>
        beaconMock.mockImplementation(() => {
          throw new Error('SecurityError');
        }),
    ],
    [
      'sendBeacon is missing',
      () => Reflect.deleteProperty(navigator, 'sendBeacon'),
    ],
  ])('falls back to a keepalive POST when %s', (_name, arrange) => {
    start();
    fetchMock.mockClear();
    arrange();

    pageHide();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, {
      method: 'POST',
      keepalive: true,
    });
  });

  it('swallows a failed fallback: the page is going away, so there is nothing to report', async () => {
    start();
    beaconMock.mockReturnValue(false);
    // A plain function, not `fetchMock`: the spy attaches its own handler to
    // a promise it returns, which would hide an unhandled rejection from the
    // run (vitest fails the run on one).
    let fallbackCalls = 0;
    vi.stubGlobal('fetch', () => {
      fallbackCalls += 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    });

    pageHide();
    await advance(0);

    expect(fallbackCalls).toBe(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });
});

describe('the back/forward cache', () => {
  it('sends one open signal when the page is restored from it', () => {
    start();
    fetchMock.mockClear();

    pageShow(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, { method: 'DELETE' });
  });

  it('re-reads the switch on a restore, so a flip made while it was frozen counts', () => {
    vi.mocked(isLiveSaveDevice).mockReturnValue(false);
    start();
    expect(fetchMock).not.toHaveBeenCalled();

    // Turned on in another tab while this page sat in the cache: no `storage`
    // event reached it, and no timer ran.
    vi.mocked(isLiveSaveDevice).mockReturnValue(true);
    pageShow(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_PATH, { method: 'DELETE' });

    flipSwitch(false);

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0]).toStrictEqual([URL_PATH]);
  });

  it('sends nothing on an ordinary pageshow', () => {
    start();
    fetchMock.mockClear();

    pageShow(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing on a restore outside the session', () => {
    at('2026-03-14T15:00:00Z'); // a Saturday
    start();

    pageShow(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a reload', () => {
  it('sends the beacon on the old page, then the DELETE from the new one', () => {
    start();
    fetchMock.mockClear();

    pageHide();
    stop?.(); // the old page is gone
    start(); // the new page loads

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(URL_PATH, { method: 'DELETE' });
    const beaconAt = beaconMock.mock.invocationCallOrder[0] ?? Infinity;
    const deleteAt = fetchMock.mock.invocationCallOrder[0] ?? -Infinity;
    expect(beaconAt).toBeLessThan(deleteAt);
  });
});

describe('a failed open signal', () => {
  it.each([401, 429])('reports nothing for a %s', async (status) => {
    respondWith(status);
    start();
    await advance(INTERVAL_MS);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it.each([500, 403])(
    'reports a %s once per page at warning level with the tag',
    async (status) => {
      respondWith(status);
      start();
      await advance(0);

      expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
      const [error, options] = vi.mocked(captureUnlessAuth).mock.calls[0] ?? [];
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(String(status));
      expect((error as Error & { status?: number }).status).toBe(status);
      expect(options).toStrictEqual(WARNING);

      // Later failures on the same page stay quiet.
      await advance(2 * INTERVAL_MS);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
      expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    },
  );

  it('reports a network error once per page at warning level with the tag', async () => {
    const failure = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(failure);
    start();
    await advance(0);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, WARNING);

    await advance(2 * INTERVAL_MS);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('counts a server error and a network error as the same page-wide one report', async () => {
    respondWith(500);
    start();
    await advance(0);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await advance(INTERVAL_MS);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('reports again on a new page (a fresh start)', async () => {
    respondWith(500);
    start();
    await advance(0);
    stop?.();
    start();
    await advance(0);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  describe('while the browser is offline', () => {
    // A laptop waking up has no network yet: routine, as for the update check.
    it.each([
      [
        'a network error',
        () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch')),
      ],
      ['a server error', () => respondWith(500)],
    ])('reports nothing for %s', async (_name, arrange) => {
      onLine.mockReturnValue(false);
      arrange();

      start();
      await advance(INTERVAL_MS);

      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    });

    it('keeps the one report for a later failure while online', async () => {
      onLine.mockReturnValue(false);
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      start();
      await advance(0);
      expect(captureUnlessAuth).not.toHaveBeenCalled();

      onLine.mockReturnValue(true);
      respondWith(500);
      await advance(INTERVAL_MS);
      expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
      expect(captureUnlessAuth).toHaveBeenCalledWith(
        expect.objectContaining({ status: 500 }),
        WARNING,
      );

      await advance(INTERVAL_MS);
      expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    });

    it('still reports a network error while online', async () => {
      const failure = new TypeError('Failed to fetch');
      fetchMock.mockRejectedValue(failure);

      start();
      await advance(0);

      expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
      expect(captureUnlessAuth).toHaveBeenCalledWith(failure, WARNING);
    });
  });
});

describe('the switch subscriber', () => {
  it('does not throw when the device check throws, and reports it once at warning level', async () => {
    start();
    vi.mocked(isLiveSaveDevice).mockImplementation(() => {
      throw new Error('storage exploded');
    });

    // `setLiveSaveOverride` calls subscribers unguarded: a throw would skip
    // the next subscriber (React's) too.
    expect(notifySubscribers).not.toThrow();
    await advance(0);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'storage exploded' }),
      WARNING,
    );

    expect(notifySubscribers).not.toThrow();
    await advance(0);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);

    // An unreadable switch is not "off": no close goes out on a guess.
    expect(beaconMock).not.toHaveBeenCalled();
  });

  it('does not throw when the owner check throws on a switch-off, and reports it once at warning level', async () => {
    start();
    vi.mocked(getAccessMode).mockImplementation(() => {
      throw new Error('cookie jar exploded');
    });

    expect(() => flipSwitch(false)).not.toThrow();
    await advance(0);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'cookie jar exploded' }),
      WARNING,
    );
    expect(beaconMock).not.toHaveBeenCalled();
  });

  it('swallows a failed keepalive fallback for the switch-off close: nothing to report', async () => {
    start();
    beaconMock.mockReturnValue(false);
    // A plain function, as in the pagehide test above: a spy would hide an
    // unhandled rejection from the run.
    let fallbackCalls = 0;
    vi.stubGlobal('fetch', () => {
      fallbackCalls += 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    });

    flipSwitch(false);
    await advance(0);

    expect(fallbackCalls).toBe(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });
});

describe('a switch that cannot be read at a timer', () => {
  function unreadable(): void {
    vi.mocked(isLiveSaveDevice).mockImplementation(() => {
      throw new Error('storage exploded');
    });
  }

  it('start does not throw, reports once at warning level, and a later flip off sends no close', async () => {
    unreadable();

    expect(() => start()).not.toThrow();
    await advance(0);

    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'storage exploded' }),
      WARNING,
    );

    // Unknown at start counts as "was not saving": no close on a guess.
    flipSwitch(false);
    expect(beaconMock).not.toHaveBeenCalled();
  });

  it('a read that throws at a tick keeps the last value: the later flip off still sends the close', async () => {
    start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unreadable();
    await advance(INTERVAL_MS);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);

    flipSwitch(false);

    expect(beaconMock).toHaveBeenCalledTimes(1);
  });
});

describe('stopping and restarting', () => {
  it('stop removes every listener, timer and subscription', async () => {
    const stopSignals = start();
    expect(subscribers.size).toBe(1);
    fetchMock.mockClear();

    stopSignals();

    expect(subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The storage listener's only trace is a read of the switch.
    vi.mocked(isLiveSaveDevice).mockClear();
    storageEvent();
    expect(isLiveSaveDevice).not.toHaveBeenCalled();
    pageHide();
    pageShow(true);
    await advance(60 * 60 * 1000);
    expect(beaconMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a stop called twice is harmless', () => {
    const stopSignals = start();
    stopSignals();
    expect(() => stopSignals()).not.toThrow();
    expect(subscribers.size).toBe(0);
  });

  it('a second start replaces the first: signals do not double', async () => {
    startLiveSessionSignals();
    stop = startLiveSessionSignals();
    expect(fetchMock).toHaveBeenCalledTimes(2); // one open signal per start
    expect(subscribers.size).toBe(1);
    expect(vi.getTimerCount()).toBe(2);

    await advance(FOLLOW_UP_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    pageHide();
    expect(beaconMock).toHaveBeenCalledTimes(1);
  });

  it("an old start's stop does not stop the page's current run", async () => {
    const stopFirst = startLiveSessionSignals();
    stop = startLiveSessionSignals();
    fetchMock.mockClear();

    stopFirst();
    await advance(FOLLOW_UP_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(subscribers.size).toBe(1);
  });

  it("an old start's stop leaves the current run known, so the next start replaces it", async () => {
    const stopFirst = startLiveSessionSignals();
    startLiveSessionSignals();
    stopFirst();
    stop = startLiveSessionSignals();
    fetchMock.mockClear();
    expect(vi.getTimerCount()).toBe(2); // the follow-up and the interval

    await advance(FOLLOW_UP_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(subscribers.size).toBe(1);
  });
});

// main.tsx runs at import and is excluded from coverage, so a dropped call or
// a dropped botid entry would fail silently (a guest or an unchallenged owner
// request is the only symptom). Read the source, as App.cluster-mult-wiring
// does, with comments stripped so a comment naming a symbol doesn't count.
describe('main.tsx wiring', () => {
  const mainCode = readFileSync(path.resolve(__dirname, '../main.tsx'), 'utf-8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

  it('starts the signals once, from outside React', () => {
    expect(mainCode.match(/\bstartLiveSessionSignals\(\)/g)).toHaveLength(1);
    expect(mainCode).toMatch(
      /import \{ startLiveSessionSignals \} from '\.\/lib\/live-session-signal'/,
    );
  });

  it('starts the signals after botid patches fetch, and before React mounts', () => {
    // botid's initBotId wraps fetch; started earlier, the load-time DELETE
    // would go out unchallenged and draw a 403 from checkBot.
    const botId = mainCode.indexOf('initBotId({');
    const signals = mainCode.indexOf('startLiveSessionSignals()');
    const mount = mainCode.indexOf('createRoot(');
    expect(botId).toBeGreaterThan(-1);
    expect(signals).toBeGreaterThan(botId);
    expect(mount).toBeGreaterThan(signals);
  });

  it.each(['POST', 'DELETE'])(
    'lists %s /api/snapshot-close for botid',
    (method) => {
      expect(mainCode).toContain(
        `{ path: '/api/snapshot-close', method: '${method}' }`,
      );
    },
  );
});
