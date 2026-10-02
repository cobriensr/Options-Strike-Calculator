/// <reference lib="webworker" />
/**
 * Custom service worker — `injectManifest` mode for vite-plugin-pwa.
 *
 * ## Preserved Workbox behavior (was in `vite.config.ts > workbox`)
 *
 * - `skipWaiting: true` / `clientsClaim: true` — handled by the `install`
 *   / `activate` listeners at the bottom of this file.
 * - `cleanupOutdatedCaches: true` — handled by `cleanupOutdatedCaches()`.
 * - `globPatterns: ['**\/*.{js,css,html,png,woff2}']` — now lives in
 *   `vite.config.ts > VitePWA > injectManifest.globPatterns`.
 * - `navigateFallback: '/index.html'` with denylist for `/api/` and the
 *   BotID challenge path — `createHandlerBoundToURL('/index.html')` +
 *   `NavigationRoute` with `denylist` below.
 * - Runtime `NetworkOnly` bypass for `/api/` (GET + POST) — prevents
 *   Chrome's 5-min SW fetch-event timeout from killing long-running
 *   Claude Opus analysis calls at 300s. Registered via `registerRoute`.
 * - `StaleWhileRevalidate` for `/vix-data.json` — served from
 *   `vix-data-cache`.
 * - `StaleWhileRevalidate` for `fonts.googleapis.com` stylesheets —
 *   `google-fonts-stylesheets` cache, 10 entries / 1 year.
 * - `CacheFirst` for `fonts.gstatic.com` webfonts — `google-fonts-webfonts`
 *   cache, 30 entries / 1 year.
 */

import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import {
  CacheFirst,
  NetworkOnly,
  StaleWhileRevalidate,
} from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope;

// ── Precache (globPatterns from injectManifest config) ──────────────
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── SPA navigation fallback ─────────────────────────────────────────
// Matches old workbox.navigateFallback + navigateFallbackDenylist.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/149e9513-01fa-4fb0-aad4-566afd725d1b\//],
  }),
);

// ── /api/ bypass ────────────────────────────────────────────────────
// Prevents Chrome's 5-min SW fetch-event timeout from killing long
// Claude Opus analysis calls at 300s. NetworkOnly short-circuits the
// SW's FetchEvent lifecycle entirely.
registerRoute(/^\/api\//, new NetworkOnly(), 'GET');
registerRoute(/^\/api\//, new NetworkOnly(), 'POST');

// ── /vix-data.json — StaleWhileRevalidate ───────────────────────────
registerRoute(
  /\/vix-data\.json$/,
  new StaleWhileRevalidate({ cacheName: 'vix-data-cache' }),
);

// ── Google Fonts stylesheets — StaleWhileRevalidate ─────────────────
registerRoute(
  /^https:\/\/fonts\.googleapis\.com\/.*/,
  new StaleWhileRevalidate({
    cacheName: 'google-fonts-stylesheets',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
    ],
  }),
);

// ── Google Fonts webfonts — CacheFirst ──────────────────────────────
registerRoute(
  /^https:\/\/fonts\.gstatic\.com\/.*/,
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
    ],
  }),
);

// ── Lifecycle ───────────────────────────────────────────────────────
// Switched from auto-skipWaiting (old `registerType: 'autoUpdate'`) to
// prompt-on-demand. A new SW now installs and stays in the `waiting`
// state until the page calls `updateSW(true)` (which posts SKIP_WAITING
// here). That gives the user a chance to finish what they were doing
// before the bundle reload yanks them out of context. clients.claim()
// stays so the new SW takes control of any open tabs immediately on
// activate, which fires the page's existing controllerchange listener.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Web Push handler ────────────────────────────────────────────────
// Server fan-out is `sendPushToOwner` in api/_lib/push.ts (Interval B/A
// alerts, Schwab re-auth reminders). The payload contract: { title: string,
// body: string, tag?: string, requireInteraction?: boolean, url?: string }.
// Malformed pushes fall back to a generic "Strike Calculator alert" title
// so a push never silently fails. `url` rides in the notification's `data`
// for the click handler below.
self.addEventListener('push', (event) => {
  type PushPayload = {
    title?: string;
    body?: string;
    tag?: string;
    requireInteraction?: boolean;
    url?: string;
  };
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload | undefined) ?? {};
  } catch {
    // Non-JSON push body — fall through to defaults.
  }

  const title = payload.title ?? 'Strike Calculator alert';
  const options: NotificationOptions = {
    body: payload.body ?? '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag,
    requireInteraction: payload.requireInteraction ?? false,
    data: { url: sameOriginPath(payload.url) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Reduce a push-supplied URL to a same-origin path ("/api/auth/init"), or
 * undefined. Resolving against our origin, rather than prefix-matching "/",
 * also rejects "//host" and "/\host", which browsers resolve off-site, so a
 * notification can never open another site.
 */
function sameOriginPath(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const resolved = new URL(url, self.location.origin);
    if (resolved.origin !== self.location.origin) return undefined;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return undefined;
  }
}

// ── Notification click ──────────────────────────────────────────────
// Open the notification's `data.url` (e.g. the Schwab re-auth flow), or the
// app root when it has none. A window already showing that page is focused
// instead of opening a duplicate. The url is re-checked here, since
// `data` may come from any `showNotification` caller, not only the push
// handler above.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const path = sameOriginPath(data?.url) ?? '/';
  event.waitUntil(focusOrOpen(path));
});

async function focusOrOpen(path: string): Promise<void> {
  const href = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const existing = windows.find((client) => client.url === href);
  if (existing) {
    await existing.focus();
    return;
  }
  await self.clients.openWindow(href);
}
