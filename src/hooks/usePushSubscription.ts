/**
 * usePushSubscription — manages the browser Web Push lifecycle.
 *
 * Single responsibility: subscribe / unsubscribe the current device to
 * the server's push delivery list (`push_subscriptions` table, managed
 * by `api/push/subscribe` + `api/push/unsubscribe`). The actual push
 * delivery is server-side (cron `monitor-regime-events`) — this hook
 * only owns the registration handshake.
 *
 * ## Lifecycle
 *
 * 1. On mount we detect support (`serviceWorker` + `PushManager`) and
 *    set `permission = 'unsupported'` if either is missing. Otherwise
 *    we query `Notification.permission` and check for an existing
 *    `PushSubscription` via `pushManager.getSubscription()`.
 * 2. `subscribe()` performs the full handshake:
 *      a. request permission (if not already granted),
 *      b. fetch the VAPID public key from the server,
 *      c. call `pushManager.subscribe()` with the decoded key,
 *      d. POST the resulting subscription to `/api/push/subscribe`.
 *    Every step is gated — if permission is denied we set the error
 *    field and return without ever touching the PushManager.
 * 3. `unsubscribe()`:
 *      a. look up the current subscription,
 *      b. POST `{endpoint}` to `/api/push/unsubscribe` (best-effort — we
 *         continue on error so the browser side still clears),
 *      c. call `subscription.unsubscribe()` on the browser side.
 *
 * All errors set the `error` field rather than throwing. A UI-stable
 * contract is more valuable than a rigorous one here — the caller is
 * a single settings panel that renders `error` if non-null.
 *
 * ## Why the permission request lives in subscribe()
 *
 * `Notification.requestPermission()` must be called from a user gesture
 * in every modern browser. Auto-prompting on mount is both user-hostile
 * and a Chrome abuse signal. The UI hooks `subscribe()` to a button
 * click; the hook never asks on its own.
 *
 * ## URL-safe base64 decode
 *
 * The VAPID public key is transmitted in URL-safe base64 (characters
 * `-` and `_` replace `+` and `/`, padding stripped). `pushManager.
 * subscribe` wants a Uint8Array of the raw key bytes. The helper below
 * is the canonical MDN snippet, adapted for TS types.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '../utils/error';

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface UsePushSubscriptionReturn {
  permission: PushPermission;
  isSubscribed: boolean;
  isSubscribing: boolean;
  error: string | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  requestPermission: () => Promise<void>;
}

interface VapidKeyResponse {
  publicKey: string;
}

/**
 * Convert a URL-safe base64 VAPID public key to an `ArrayBuffer` (the
 * `BufferSource` shape `PushManager.subscribe({ applicationServerKey })`
 * expects). Handles both missing padding and the `-_` alphabet variant;
 * throws on malformed input (fed via `atob`).
 *
 * Returns `ArrayBuffer` rather than `Uint8Array` so TS strict-mode
 * distinguishes `ArrayBuffer` from `SharedArrayBuffer` cleanly —
 * `PushSubscriptionOptionsInit.applicationServerKey` accepts the former
 * but not the latter.
 */
function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i += 1) {
    view[i] = rawData.charCodeAt(i);
  }
  return buffer;
}

/** True when the current runtime can handle Web Push. */
function isPushSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return false;
  }
  // Use truthy checks rather than `'key' in obj` — some test harnesses
  // stub these slots with `undefined`, which would otherwise look
  // "supported" despite having no usable API.
  const hasServiceWorker =
    (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker !=
    null;
  const hasPushManager =
    (window as Window & { PushManager?: unknown }).PushManager != null;
  const hasNotification = typeof Notification !== 'undefined';
  return hasServiceWorker && hasPushManager && hasNotification;
}

/** Coerce the native `Notification.permission` into our enum. */
function nativePermission(): PushPermission {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission as PushPermission;
}

export function usePushSubscription(): UsePushSubscriptionReturn {
  const [permission, setPermission] = useState<PushPermission>(() =>
    nativePermission(),
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Initial state probe ────────────────────────────────────
  useEffect(() => {
    if (!isPushSupported()) {
      setPermission('unsupported');
      setIsSubscribed(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (cancelled || !mountedRef.current) return;
        setIsSubscribed(sub !== null);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setError(getErrorMessage(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Explicit permission request ────────────────────────────
  // The caller wires this to a button click — see AlertConfig.tsx. We
  // guard against auto-calling by exposing it as its own method rather
  // than collapsing it into subscribe().
  const requestPermission = useCallback(async (): Promise<void> => {
    if (!isPushSupported()) {
      setPermission('unsupported');
      return;
    }
    setError(null);
    try {
      const result = await Notification.requestPermission();
      if (!mountedRef.current) return;
      setPermission(result as PushPermission);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    }
  }, []);

  // ── Subscribe flow ─────────────────────────────────────────
  const subscribe = useCallback(async (): Promise<void> => {
    if (!isPushSupported()) {
      setPermission('unsupported');
      setError('Web Push is not supported on this browser.');
      return;
    }
    setError(null);
    setIsSubscribing(true);
    try {
      // 1. Ensure permission. We always call requestPermission here —
      //    Chrome and Firefox both treat repeat calls as no-ops when the
      //    state is already `granted` or `denied`, so this is safe and
      //    matches the "must be user-initiated" constraint.
      let effectivePermission: PushPermission = nativePermission();
      if (effectivePermission === 'default') {
        effectivePermission = (await Notification.requestPermission()) as PushPermission;
        if (mountedRef.current) setPermission(effectivePermission);
      }
      if (effectivePermission !== 'granted') {
        if (mountedRef.current) {
          setError(
            effectivePermission === 'denied'
              ? 'Notification permission was denied.'
              : 'Notification permission is required to subscribe.',
          );
        }
        return;
      }

      // 2. Fetch the VAPID public key.
      const keyRes = await fetch('/api/push/vapid-public-key', {
        credentials: 'same-origin',
      });
      if (!keyRes.ok) {
        if (keyRes.status === 401) {
          throw new Error(
            'Log in first — push subscription is owner-only.',
          );
        }
        if (keyRes.status === 500) {
          throw new Error(
            'Push not configured on the server (VAPID keys missing).',
          );
        }
        throw new Error(`Failed to load VAPID key (${keyRes.status})`);
      }
      const { publicKey } = (await keyRes.json()) as VapidKeyResponse;

      // 3. Ask the browser to subscribe.
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(publicKey),
      });

      // 4. Register the subscription server-side. If the server errors
      //    we unwind the browser subscription so both sides stay in sync
      //    — otherwise the browser would be pushing to a server that
      //    won't deliver.
      const subRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!subRes.ok) {
        try {
          await subscription.unsubscribe();
        } catch {
          // Best-effort cleanup — ignore.
        }
        if (subRes.status === 401) {
          throw new Error(
            'Log in first — push subscription is owner-only.',
          );
        }
        throw new Error(`Server refused subscription (${subRes.status})`);
      }

      if (mountedRef.current) setIsSubscribed(true);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setIsSubscribing(false);
    }
  }, []);

  // ── Unsubscribe flow ───────────────────────────────────────
  const unsubscribe = useCallback(async (): Promise<void> => {
    if (!isPushSupported()) {
      setPermission('unsupported');
      return;
    }
    setError(null);
    setIsSubscribing(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        if (mountedRef.current) setIsSubscribed(false);
        return;
      }

      const { endpoint } = subscription;

      // Best-effort server-side delete — if the row is already gone or
      // the network is flaky we still want the browser-side unsubscribe
      // to run so the UI state clears.
      try {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
      } catch {
        // swallowed — continue to browser-side unsubscribe
      }

      await subscription.unsubscribe();
      if (mountedRef.current) setIsSubscribed(false);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setIsSubscribing(false);
    }
  }, []);

  return {
    permission,
    isSubscribed,
    isSubscribing,
    error,
    subscribe,
    unsubscribe,
    requestPermission,
  };
}
