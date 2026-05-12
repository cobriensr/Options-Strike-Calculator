// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { usePushSubscription } from '../hooks/usePushSubscription';

// ── Helpers ────────────────────────────────────────────────────

interface MockSubscription {
  endpoint: string;
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

function makeSubscription(
  endpoint = 'https://fcm.googleapis.com/fcm/send/abc',
): MockSubscription {
  return {
    endpoint,
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    toJSON: () => ({
      endpoint,
      keys: { p256dh: 'p256-key', auth: 'auth-key' },
    }),
  };
}

function mockServiceWorker(opts: {
  existing?: MockSubscription | null;
  subscribeResult?: MockSubscription;
}) {
  const getSubscription = vi.fn().mockResolvedValue(opts.existing ?? null);
  const subscribe = vi
    .fn()
    .mockResolvedValue(opts.subscribeResult ?? makeSubscription());
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription, subscribe },
      }),
    },
  });
  return { getSubscription, subscribe };
}

function setNotificationPermission(p: NotificationPermission): void {
  const requestPermission = vi.fn().mockResolvedValue(p);
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: Object.assign(
      function Notification() {
        /* stub */
      },
      { permission: p, requestPermission },
    ),
  });
}

function mockPushManager(): void {
  // Mark PushManager as present on globalThis so hasPushSupport returns true.
  Object.defineProperty(globalThis, 'PushManager', {
    configurable: true,
    value: function PushManager() {
      /* stub */
    },
  });
}

function mockFetch(ok = true): ReturnType<typeof vi.fn> {
  const fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue({}),
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

beforeEach(() => {
  import.meta.env.VITE_VAPID_PUBLIC_KEY = 'BJsxxx-test-vapid-pubkey-base64';
  setNotificationPermission('default');
  mockPushManager();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (import.meta.env as Record<string, unknown>).VITE_VAPID_PUBLIC_KEY;
});

describe('usePushSubscription mount check', () => {
  it('reports subscribed=false when no existing subscription', async () => {
    mockServiceWorker({ existing: null });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(false);
    });
  });

  it('reports subscribed=true when an existing subscription is found', async () => {
    mockServiceWorker({ existing: makeSubscription() });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(true);
    });
  });

  it('falls back to subscribed=false when serviceWorker is unsupported', async () => {
    // Remove the navigator.serviceWorker shim entirely.
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: undefined,
    });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(false);
    });
  });
});

describe('subscribe()', () => {
  it('runs grant + register + POST when permission granted', async () => {
    const newSub = makeSubscription();
    const { subscribe } = mockServiceWorker({
      existing: null,
      subscribeResult: newSub,
    });
    setNotificationPermission('default');
    const requestPermission = vi
      .fn()
      .mockResolvedValue('granted' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(requestPermission).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        userVisibleOnly: true,
        // Decoded VAPID key arrives as the underlying ArrayBuffer per
        // the BufferSource cast in usePushSubscription — see the
        // PushManager TS lib typing.
        applicationServerKey: expect.any(ArrayBuffer),
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result.current.subscribed).toBe(true);
  });

  it('sets error when permission is denied', async () => {
    mockServiceWorker({ existing: null });
    const requestPermission = vi
      .fn()
      .mockResolvedValue('denied' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(result.current.error).toContain('denied');
    expect(result.current.subscribed).toBe(false);
  });

  it('is a silent no-op when VITE_VAPID_PUBLIC_KEY is empty', async () => {
    import.meta.env.VITE_VAPID_PUBLIC_KEY = '';
    mockServiceWorker({ existing: null });
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('reuses an existing subscription without calling pushManager.subscribe()', async () => {
    const existing = makeSubscription();
    const { subscribe } = mockServiceWorker({ existing });
    const requestPermission = vi
      .fn()
      .mockResolvedValue('granted' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(true);
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(subscribe).not.toHaveBeenCalled(); // existing reused
    expect(result.current.subscribed).toBe(true);
  });

  it('reports server rejection as an error', async () => {
    mockServiceWorker({ existing: null });
    const requestPermission = vi
      .fn()
      .mockResolvedValue('granted' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    mockFetch(false); // server returns 500

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(result.current.error).toContain('500');
  });
});

describe('unsubscribe()', () => {
  it('calls browser.unsubscribe() and POSTs to server', async () => {
    const existing = makeSubscription();
    mockServiceWorker({ existing });
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(true);
    });

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      '/api/push/unsubscribe',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result.current.subscribed).toBe(false);
  });

  it('no-ops when no subscription exists', async () => {
    mockServiceWorker({ existing: null });
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(false);
    });

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.subscribed).toBe(false);
  });
});
