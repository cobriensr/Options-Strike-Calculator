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

const mockSelf = {
  __WB_MANIFEST: [] as Array<{ url: string; revision: string }>,
  addEventListener: vi.fn((type: string, fn: CapturedListener) =>
    listeners.set(type, fn),
  ),
  skipWaiting,
  clients: {
    claim: clientsClaim,
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
  it('registers message and activate lifecycle listeners on self', () => {
    expect(listeners.has('message')).toBe(true);
    expect(listeners.has('activate')).toBe(true);
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
