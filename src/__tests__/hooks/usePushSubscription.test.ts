/**
 * usePushSubscription tests — full lifecycle + error handling.
 *
 * We mock `navigator.serviceWorker`, `PushManager`, and global `fetch`
 * so no real network / service worker is ever touched. The
 * `Notification` constructor's `.permission` and `.requestPermission`
 * are stubbed per-test so we can drive every permission branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePushSubscription } from '../../hooks/usePushSubscription';

// ── Fake browser Push types ──────────────────────────────────

interface FakeSubscription {
  endpoint: string;
  toJSON: () => object;
  unsubscribe: () => Promise<boolean>;
}

interface FakePushManager {
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
}

interface FakeRegistration {
  pushManager: FakePushManager;
}

let currentSubscription: FakeSubscription | null = null;
let pushManager: FakePushManager;
let registration: FakeRegistration;

const mockFetch = vi.fn();
const mockRequestPermission = vi.fn();

function makeSubscription(endpoint: string): FakeSubscription {
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: {
        p256dh: 'fake-p256dh',
        auth: 'fake-auth',
      },
    }),
    unsubscribe: vi.fn(async () => true),
  };
}

function setNotificationPermission(state: NotificationPermission): void {
  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    get: () => state,
  });
}

// ── Lifecycle ─────────────────────────────────────────────────

beforeEach(() => {
  currentSubscription = null;

  pushManager = {
    subscribe: vi.fn(async () => {
      currentSubscription = makeSubscription(
        'https://fcm.googleapis.com/fcm/send/abc',
      );
      return currentSubscription;
    }),
    getSubscription: vi.fn(async () => currentSubscription),
  };
  registration = { pushManager };

  // Stub navigator.serviceWorker — jsdom doesn't implement it.
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(registration),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });

  // Stub PushManager so the support check passes.
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: class {},
  });

  // Stub Notification with controllable permission + requestPermission.
  mockRequestPermission.mockReset().mockResolvedValue('granted');
  class FakeNotification {
    static readonly requestPermission = mockRequestPermission;
  }
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: FakeNotification,
  });
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: FakeNotification,
  });
  setNotificationPermission('default');

  // Default fetch: happy path for VAPID key + subscribe.
  mockFetch.mockReset().mockImplementation(async (url: string) => {
    if (url === '/api/push/vapid-public-key') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          // URL-safe base64 for "abc" padded out — any valid base64 works.
          publicKey:
            'ZmFrZS12YXBpZC1wdWJsaWMta2V5LTY1LWJ5dGVzLWV4YWN0bHktbG9uZy0wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMA',
        }),
      };
    }
    if (url === '/api/push/subscribe' || url === '/api/push/unsubscribe') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────

describe('usePushSubscription: initial state', () => {
  it('reports unsupported when serviceWorker is absent', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: undefined,
    });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.permission).toBe('unsupported');
    });
    expect(result.current.isSubscribed).toBe(false);
  });

  it('reports current permission and no existing subscription on mount', async () => {
    setNotificationPermission('granted');
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(pushManager.getSubscription).toHaveBeenCalled();
    });
    expect(result.current.permission).toBe('granted');
    expect(result.current.isSubscribed).toBe(false);
  });

  it('reports isSubscribed=true when a subscription already exists', async () => {
    currentSubscription = makeSubscription(
      'https://fcm.googleapis.com/fcm/send/xyz',
    );
    setNotificationPermission('granted');
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));
  });
});

describe('usePushSubscription: subscribe()', () => {
  it('completes the full handshake on happy path', async () => {
    setNotificationPermission('default');
    mockRequestPermission.mockResolvedValueOnce('granted');

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(pushManager.getSubscription).toHaveBeenCalled());

    await act(async () => {
      await result.current.subscribe();
    });

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/push/vapid-public-key',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
      }),
    );
    expect(result.current.isSubscribed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('sets error and skips subscribe when permission is denied', async () => {
    setNotificationPermission('default');
    mockRequestPermission.mockResolvedValueOnce('denied');

    const { result } = renderHook(() => usePushSubscription());
    await act(async () => {
      await result.current.subscribe();
    });

    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toMatch(/denied/i);
  });

  it('rolls back browser subscription when server returns an error', async () => {
    setNotificationPermission('granted');
    const fakeUnsub = vi.fn(async () => true);
    pushManager.subscribe.mockImplementationOnce(async () => {
      currentSubscription = {
        ...makeSubscription('https://fcm.googleapis.com/fcm/send/bad'),
        unsubscribe: fakeUnsub,
      };
      return currentSubscription;
    });

    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/push/vapid-public-key') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            publicKey:
              'ZmFrZS12YXBpZC1wdWJsaWMta2V5LTY1LWJ5dGVzLWV4YWN0bHktbG9uZy0wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMA',
          }),
        };
      }
      if (url === '/api/push/subscribe') {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { result } = renderHook(() => usePushSubscription());
    await act(async () => {
      await result.current.subscribe();
    });

    expect(fakeUnsub).toHaveBeenCalledTimes(1);
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toMatch(/Server refused/i);
  });

  it('sets error when the VAPID key fetch fails', async () => {
    setNotificationPermission('granted');
    mockFetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    const { result } = renderHook(() => usePushSubscription());
    await act(async () => {
      await result.current.subscribe();
    });

    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/VAPID/i);
    expect(result.current.isSubscribed).toBe(false);
  });

  it('reports unsupported when PushManager is absent', async () => {
    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: undefined,
    });

    const { result } = renderHook(() => usePushSubscription());
    await act(async () => {
      await result.current.subscribe();
    });
    expect(result.current.permission).toBe('unsupported');
    expect(result.current.error).toMatch(/not supported/i);
  });
});

describe('usePushSubscription: unsubscribe()', () => {
  it('calls the server then the browser and clears isSubscribed', async () => {
    const fakeUnsub = vi.fn(async () => true);
    currentSubscription = {
      ...makeSubscription('https://fcm.googleapis.com/fcm/send/zzz'),
      unsubscribe: fakeUnsub,
    };
    setNotificationPermission('granted');

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/push/unsubscribe',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fakeUnsub).toHaveBeenCalledTimes(1);
    expect(result.current.isSubscribed).toBe(false);
  });

  it('still clears browser state when server call fails', async () => {
    const fakeUnsub = vi.fn(async () => true);
    currentSubscription = {
      ...makeSubscription('https://fcm.googleapis.com/fcm/send/yyy'),
      unsubscribe: fakeUnsub,
    };
    setNotificationPermission('granted');
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/push/unsubscribe') {
        throw new Error('network down');
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(fakeUnsub).toHaveBeenCalledTimes(1);
    expect(result.current.isSubscribed).toBe(false);
  });

  it('no-ops when no subscription exists', async () => {
    currentSubscription = null;
    setNotificationPermission('granted');

    const { result } = renderHook(() => usePushSubscription());
    await act(async () => {
      await result.current.unsubscribe();
    });
    expect(mockFetch).not.toHaveBeenCalledWith(
      '/api/push/unsubscribe',
      expect.anything(),
    );
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('usePushSubscription: requestPermission()', () => {
  it('updates permission state after calling the native API', async () => {
    setNotificationPermission('default');
    mockRequestPermission.mockResolvedValueOnce('granted');

    const { result } = renderHook(() => usePushSubscription());
    await act(async () => {
      await result.current.requestPermission();
    });

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(result.current.permission).toBe('granted');
  });
});
