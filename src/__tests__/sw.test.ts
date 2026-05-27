// @vitest-environment jsdom

/**
 * Tests for the custom service worker (src/sw.ts).
 *
 * The SW runs in `ServiceWorkerGlobalScope`, not in a normal window — so
 * jsdom's default `self` (a Window proxy) is replaced with a SW-shaped mock
 * before the module is imported. Top-level workbox calls (precaching, route
 * registration) are no-op'd; we focus on the listeners with non-trivial
 * logic: `message` (SKIP_WAITING) and `activate` (clients.claim).
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
const showNotification = vi.fn().mockResolvedValue(undefined);

const mockSelf = {
  __WB_MANIFEST: [] as Array<{ url: string; revision: string }>,
  addEventListener: vi.fn((type: string, fn: CapturedListener) =>
    listeners.set(type, fn),
  ),
  skipWaiting,
  clients: {
    claim: clientsClaim,
  },
  registration: {
    showNotification,
  },
};

beforeAll(async () => {
  vi.stubGlobal('self', mockSelf);
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
  showNotification.mockClear();
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
  it('registers message, activate, and push lifecycle listeners on self', () => {
    expect(listeners.has('message')).toBe(true);
    expect(listeners.has('activate')).toBe(true);
    expect(listeners.has('push')).toBe(true);
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
  // Build a mock PushEvent whose .data.json() returns the given payload.
  // `dataJson` can throw to simulate a non-JSON push body — the handler
  // is contracted to fall through to the generic title in that case.
  function makePushEvent(dataJson: () => unknown) {
    return makeExtendableEvent({
      data: {
        json: dataJson,
      },
    });
  }

  it('shows notification with title, body, tag, requireInteraction from JSON payload', async () => {
    const handler = listeners.get('push')!;
    const event = makePushEvent(() => ({
      title: 'SPXW 7100C 90% ASK',
      body: '$415K premium / 2 trades',
      tag: 'interval-ba-9001',
      requireInteraction: true,
    }));
    handler(event);
    await event.flush();

    expect(showNotification).toHaveBeenCalledOnce();
    const [title, options] = showNotification.mock.calls[0]!;
    expect(title).toBe('SPXW 7100C 90% ASK');
    expect(options).toMatchObject({
      body: '$415K premium / 2 trades',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'interval-ba-9001',
      requireInteraction: true,
    });
  });

  it('falls back to "Strike Calculator alert" title when payload omits title', async () => {
    const handler = listeners.get('push')!;
    const event = makePushEvent(() => ({ body: 'no title given' }));
    handler(event);
    await event.flush();

    const [title, options] = showNotification.mock.calls[0]!;
    expect(title).toBe('Strike Calculator alert');
    expect(options.body).toBe('no title given');
    // Defaults the rest too — tag undefined, requireInteraction false.
    expect(options.tag).toBeUndefined();
    expect(options.requireInteraction).toBe(false);
  });

  it('defaults body to empty string when omitted', async () => {
    const handler = listeners.get('push')!;
    const event = makePushEvent(() => ({ title: 'Heads up' }));
    handler(event);
    await event.flush();
    const [, options] = showNotification.mock.calls[0]!;
    expect(options.body).toBe('');
  });

  it('falls back to defaults when the push body is non-JSON', async () => {
    const handler = listeners.get('push')!;
    const event = makePushEvent(() => {
      throw new SyntaxError('Unexpected token');
    });
    handler(event);
    await event.flush();

    const [title, options] = showNotification.mock.calls[0]!;
    expect(title).toBe('Strike Calculator alert');
    expect(options.body).toBe('');
  });

  it('falls back to defaults when event.data is absent (older push contract)', async () => {
    const handler = listeners.get('push')!;
    const event = makeExtendableEvent(); // no `data` field at all
    handler(event);
    await event.flush();

    expect(showNotification).toHaveBeenCalledOnce();
    const [title] = showNotification.mock.calls[0]!;
    expect(title).toBe('Strike Calculator alert');
  });

  it('passes explicit requireInteraction=true through to NotificationOptions', async () => {
    // ?? false leaves a present boolean alone — exercises the truthy
    // arm of the nullish coalescing separately from Test 2's omitted-
    // field branch (which exercises the fallback arm).
    const handler = listeners.get('push')!;
    const event = makePushEvent(() => ({
      title: 'X',
      requireInteraction: true,
    }));
    handler(event);
    await event.flush();
    const [, options] = showNotification.mock.calls[0]!;
    expect(options.requireInteraction).toBe(true);
  });
});
