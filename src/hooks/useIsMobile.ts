/**
 * useIsMobile — small viewport-detection hook backed by `matchMedia`.
 *
 * Returns `true` when the viewport is at or below the mobile breakpoint
 * (max-width 767px, matching Tailwind's `md:` boundary). Subscribes via
 * `useSyncExternalStore` so component tree re-renders on viewport change.
 *
 * Used to switch between completely different render trees (table vs
 * card-flip) where Tailwind's `hidden md:block` isn't enough — JSDOM
 * doesn't apply CSS, so both branches would render in tests and break
 * `getByText` assertions. With this hook, only ONE branch renders at
 * any time; tests use JSDOM's default false return → desktop branch
 * always renders in tests, no test updates needed.
 *
 * `getServerSnapshot` returns `false` so SSR / pre-hydration matches
 * the desktop layout. The Vite SPA doesn't SSR, but the pattern is
 * forward-compatible if we ever add it.
 */

import { useSyncExternalStore } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

function subscribe(cb: () => void): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return () => {};
  }
  const m = window.matchMedia(MOBILE_QUERY);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

function getSnapshot(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
