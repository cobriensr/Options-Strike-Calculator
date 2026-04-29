// @vitest-environment jsdom

/**
 * Tests for the custom service worker (src/sw.ts).
 *
 * The SW runs in `ServiceWorkerGlobalScope`, not in a normal window — so
 * jsdom's default `self` (a Window proxy) is replaced with a SW-shaped mock
 * before the module is imported. Top-level workbox calls (precaching, route
 * registration) are no-op'd; we focus on the four listeners that contain
 * non-trivial logic: `message`, `activate`, `push`, `notificationclick`,
 * and `pushsubscriptionchange`.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Workbox mocks — allow the SW module to import without side effects ──
vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(() => 'mock-handler'),
  precacheAndRoute: vi.fn(),
}));

vi.mock('workbox-routing', () => ({
  NavigationRoute: vi.fn(),
  registerRoute: vi.fn(),
}));

vi.mock('workbox-strategies', () => ({
  CacheFirst: vi.fn(),
  NetworkOnly: vi.fn(),
  StaleWhileRevalidate: vi.fn(),
}));

vi.mock('workbox-cacheable-response', () => ({
  CacheableResponsePlugin: vi.fn(),
}));

vi.mock('workbox-expiration', () => ({
  ExpirationPlugin: vi.fn(),
}));

// ── ServiceWorkerGlobalScope mock ───────────────────────────────────────

interface CapturedListener {
  (event: unknown): void | Promise<void>;
}

const listeners = new Map<string, CapturedListener>();
const skipWaiting = vi.fn();
const clientsClaim = vi.fn().mockResolvedValue(undefined);
const matchAll = vi.fn();
const openWindow = vi.fn().mockResolvedValue(undefined);
const showNotification = vi.fn().mockResolvedValue(undefined);
const pushSubscribe = vi.fn();
const fetchMock = vi.fn();

const mockSelf = {
  __WB_MANIFEST: [] as Array<{ url: string; revision: string }>,
  addEventListener: vi.fn((type: string, fn: CapturedListener) =>
    listeners.set(type, fn),
  ),
  skipWaiting,
  clients: {
    claim: clientsClaim,
    matchAll,
    openWindow,
  },
  registration: {
    showNotification,
    pushManager: { subscribe: pushSubscribe },
  },
};

beforeAll(async () => {
  vi.stubGlobal('self', mockSelf);
  vi.stubGlobal('fetch', fetchMock);
  // Dynamic import after the global is stubbed — top-level workbox calls
  // and listener registrations run as a side effect of this import.
  await import('../sw.js');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  skipWaiting.mockClear();
  clientsClaim.mockClear();
  matchAll.mockReset();
  openWindow.mockReset().mockResolvedValue(undefined);
  showNotification.mockReset().mockResolvedValue(undefined);
  pushSubscribe.mockReset();
  fetchMock.mockReset();
});

// ── Helper: build a mock ExtendableEvent that captures waitUntil() ──────
function makeExtendableEvent(extra: Record<string, unknown> = {}) {
  let waited: Promise<unknown> | null = null;
  return {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      waited = p;
    }),
    /** Resolve whatever was passed to waitUntil — used to await side effects. */
    flush: () => waited ?? Promise.resolve(),
    ...extra,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('sw — module load', () => {
  it('registers all five lifecycle listeners on self', () => {
    expect(listeners.has('message')).toBe(true);
    expect(listeners.has('activate')).toBe(true);
    expect(listeners.has('push')).toBe(true);
    expect(listeners.has('notificationclick')).toBe(true);
    expect(listeners.has('pushsubscriptionchange')).toBe(true);
  });
});

describe('sw — message handler (SKIP_WAITING)', () => {
  it('calls self.skipWaiting() when the page posts {type: "SKIP_WAITING"}', () => {
    const handler = listeners.get('message')!;
    handler({ data: { type: 'SKIP_WAITING' } });
    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it('ignores unknown message types', () => {
    const handler = listeners.get('message')!;
    handler({ data: { type: 'OTHER' } });
    expect(skipWaiting).not.toHaveBeenCalled();
  });

  it('safely ignores null/undefined event.data', () => {
    const handler = listeners.get('message')!;
    handler({ data: null });
    handler({ data: undefined });
    expect(skipWaiting).not.toHaveBeenCalled();
  });
});

describe('sw — activate handler', () => {
  it('calls self.clients.claim() inside waitUntil', async () => {
    const handler = listeners.get('activate')!;
    const event = makeExtendableEvent();
    handler(event);
    await event.flush();
    expect(clientsClaim).toHaveBeenCalledOnce();
  });
});

describe('sw — push handler', () => {
  it('renders the structured AlertEvent notification when payload is valid', async () => {
    const handler = listeners.get('push')!;
    const alert = {
      id: 'REGIME_FLIP::2026-04-29',
      title: 'Regime flip: POSITIVE → NEGATIVE',
      body: 'Severity escalated to urgent.',
    };
    const event = makeExtendableEvent({
      data: { json: () => alert },
    });
    handler(event);
    await event.flush();
    expect(showNotification).toHaveBeenCalledWith(
      alert.title,
      expect.objectContaining({
        body: alert.body,
        tag: alert.id,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: expect.objectContaining({ eventId: alert.id }),
      }),
    );
  });

  it('falls back to the generic notification when event.data is null', async () => {
    const handler = listeners.get('push')!;
    const event = makeExtendableEvent({ data: null });
    handler(event);
    await event.flush();
    expect(showNotification).toHaveBeenCalledWith(
      'New alert',
      expect.objectContaining({
        body: 'A new futures gamma playbook alert is available.',
        data: expect.objectContaining({ eventId: 'unknown' }),
      }),
    );
  });

  it('falls back when event.data.json() throws', async () => {
    const handler = listeners.get('push')!;
    const event = makeExtendableEvent({
      data: {
        json: () => {
          throw new Error('bad payload');
        },
      },
    });
    handler(event);
    await event.flush();
    expect(showNotification).toHaveBeenCalledWith(
      'New alert',
      expect.any(Object),
    );
  });
});

describe('sw — notificationclick handler', () => {
  it('focuses an existing client tab when one is open', async () => {
    const handler = listeners.get('notificationclick')!;
    const focus = vi.fn().mockResolvedValue(undefined);
    matchAll.mockResolvedValueOnce([{ focus }]);
    const close = vi.fn();
    const event = makeExtendableEvent({
      notification: { close, data: { url: '/#futures-gamma-playbook' } },
    });
    handler(event);
    await event.flush();
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window when no client is open', async () => {
    const handler = listeners.get('notificationclick')!;
    matchAll.mockResolvedValueOnce([]);
    const event = makeExtendableEvent({
      notification: {
        close: vi.fn(),
        data: { url: '/#some-deep-link' },
      },
    });
    handler(event);
    await event.flush();
    expect(openWindow).toHaveBeenCalledWith('/#some-deep-link');
  });

  it('falls back to the playbook URL when notification has no data', async () => {
    const handler = listeners.get('notificationclick')!;
    matchAll.mockResolvedValueOnce([]);
    const event = makeExtendableEvent({
      notification: { close: vi.fn(), data: undefined },
    });
    handler(event);
    await event.flush();
    expect(openWindow).toHaveBeenCalledWith('/#futures-gamma-playbook');
  });
});

describe('sw — pushsubscriptionchange handler', () => {
  it('exits silently when oldSubscription has no applicationServerKey', async () => {
    const handler = listeners.get('pushsubscriptionchange')!;
    const event = makeExtendableEvent({ oldSubscription: null });
    handler(event);
    await event.flush();
    expect(pushSubscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-subscribes and POSTs the new subscription on rotation', async () => {
    const handler = listeners.get('pushsubscriptionchange')!;
    const newSub = {
      endpoint: 'https://push/new',
      toJSON: () => ({ endpoint: 'https://push/new' }),
    };
    pushSubscribe.mockResolvedValueOnce(newSub);
    fetchMock.mockResolvedValueOnce({ ok: true });
    const event = makeExtendableEvent({
      oldSubscription: {
        endpoint: 'https://push/old',
        options: { applicationServerKey: new ArrayBuffer(8) },
      },
    });
    handler(event);
    await event.flush();
    expect(pushSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    );
    expect(body.rotatedFrom).toBe('https://push/old');
  });

  it('swallows fetch failures (Phase 2A.2 endpoint not yet deployed)', async () => {
    const handler = listeners.get('pushsubscriptionchange')!;
    const newSub = {
      endpoint: 'https://push/new',
      toJSON: () => ({ endpoint: 'https://push/new' }),
    };
    pushSubscribe.mockResolvedValueOnce(newSub);
    fetchMock.mockRejectedValueOnce(new Error('404 Not Found'));
    const event = makeExtendableEvent({
      oldSubscription: {
        endpoint: 'https://push/old',
        options: { applicationServerKey: new ArrayBuffer(8) },
      },
    });
    handler(event);
    // Should not reject — silent no-op
    await expect(event.flush()).resolves.toBeUndefined();
  });

  it('swallows re-subscription failures (frontend retries on next app open)', async () => {
    const handler = listeners.get('pushsubscriptionchange')!;
    pushSubscribe.mockRejectedValueOnce(new Error('permission denied'));
    const event = makeExtendableEvent({
      oldSubscription: {
        endpoint: 'https://push/old',
        options: { applicationServerKey: new ArrayBuffer(8) },
      },
    });
    handler(event);
    await expect(event.flush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
