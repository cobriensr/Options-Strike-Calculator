// @vitest-environment jsdom

/**
 * Routing tests for the service worker (src/sw.ts), against the real Workbox.
 *
 * `/api/` requests must reach the browser without the worker answering them:
 * any answer goes through `event.respondWith()`, which keeps the request
 * inside the fetch event and its timeout, and `api/analyze` runs up to 780 s.
 * Workbox calls `respondWith` only when a route, or a default handler, takes
 * the request. So this file mocks no Workbox module, loads `../sw.js` and
 * drives the fetch listener Workbox really installed (the precache route, the
 * navigation route and every `registerRoute` included), then asserts that
 * `respondWith` is not called for an `/api/` request. A route, or a
 * `setDefaultHandler`, that answers `/api/` fails here. `Strategy.prototype.
 * handle` is spied so no handler runs and nothing touches the network.
 *
 * The listener and push tests, which mock Workbox, are in sw.test.ts.
 */

import { Strategy } from 'workbox-strategies';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Listener = (event: unknown) => void;

const listeners = new Map<string, Listener[]>();

const mockSelf = {
  // createHandlerBoundToURL('/index.html') in sw.ts needs it precached.
  __WB_MANIFEST: [
    { url: '/index.html', revision: 'a' },
    { url: '/assets/app.js', revision: null },
  ],
  addEventListener: vi.fn((type: string, fn: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  }),
  skipWaiting: vi.fn(),
  location: { origin: location.origin },
  clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn() },
  registration: { showNotification: vi.fn() },
};

const handle = vi.spyOn(Strategy.prototype, 'handle');

beforeAll(async () => {
  vi.stubGlobal('self', mockSelf);
  await import('../sw.js');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function fakeRequest(method: string, mode: string, path: string): Request {
  const request = Object.create(Request.prototype) as Request;
  Object.defineProperty(request, 'url', {
    value: new URL(path, location.href).href,
  });
  Object.defineProperty(request, 'method', { value: method });
  Object.defineProperty(request, 'mode', { value: mode });
  return request;
}

/** Fire a fetch event through every listener and report each `respondWith`. */
function fetchOutcome(method: string, mode: string, path: string) {
  handle.mockReset().mockResolvedValue(new Response(null));
  // Only whether it is called matters. The navigation fallback's handler
  // builds `new Request('/index.html')`, which Node rejects without a base
  // URL, so the promise it answers with can reject; swallow that.
  const respondWith = vi.fn((answer: Promise<unknown>) => {
    answer.catch(() => undefined);
  });
  const event = {
    request: fakeRequest(method, mode, path),
    respondWith,
    waitUntil: vi.fn(),
  };
  for (const listener of listeners.get('fetch') ?? []) listener(event);
  return { respondWith, handle };
}

describe('sw routing (real Workbox) — /api/ is left to the browser', () => {
  it('answers the requests it should (control for the cases below)', () => {
    expect(listeners.get('fetch')?.length).toBeGreaterThan(0);
    const answered = (method: string, mode: string, path: string) =>
      fetchOutcome(method, mode, path).respondWith.mock.calls.length > 0;
    expect(answered('GET', 'cors', '/vix-data.json'), 'vix-data').toBe(true);
    expect(
      answered('GET', 'cors', 'https://fonts.googleapis.com/css2?family=Inter'),
      'google fonts stylesheet',
    ).toBe(true);
    expect(answered('GET', 'navigate', '/'), 'navigation to /').toBe(true);
    expect(
      answered('GET', 'navigate', '/some/spa/route'),
      'navigation fallback',
    ).toBe(true);
    expect(answered('GET', 'cors', '/assets/app.js'), 'precached asset').toBe(
      true,
    );
  });

  it.each([
    ['GET', 'cors', '/api/analyze'],
    ['POST', 'cors', '/api/analyze'],
    ['GET', 'cors', '/api/ml/plots?limit=5'],
    ['POST', 'cors', '/api/journal'],
    ['GET', 'cors', '/api/'],
    // Opening the Schwab login in the tab is a navigation: the SPA fallback
    // must not answer it with index.html.
    ['GET', 'navigate', '/api/auth/init'],
    ['GET', 'navigate', '/api/auth/callback?code=abc'],
    ['GET', 'navigate', '/149e9513-01fa-4fb0-aad4-566afd725d1b/challenge'],
  ] as const)(
    'never calls respondWith for %s (%s) %s',
    (method, mode, path) => {
      const outcome = fetchOutcome(method, mode, path);
      expect(outcome.respondWith).not.toHaveBeenCalled();
      expect(outcome.handle).not.toHaveBeenCalled();
    },
  );
});
