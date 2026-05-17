/**
 * usePushSubscription — manages the browser's Web Push subscription
 * for SPXW Interval B/A alerts v2.
 *
 * Lifecycle:
 *   1. On mount, checks `serviceWorker.ready.pushManager.getSubscription()`
 *      to see if the user already has a live subscription (e.g. from a
 *      previous session). Updates `subscribed` accordingly.
 *   2. `subscribe()` runs the full grant + register + POST flow:
 *      a. `Notification.requestPermission()`
 *      b. `registration.pushManager.subscribe({...})`
 *      c. POST the subscription JSON to `/api/push/subscribe`
 *   3. `unsubscribe()` reverses the steps and notifies the server.
 *
 * `VITE_VAPID_PUBLIC_KEY` must be set in the build env for any of
 * this to work — when empty, `subscribe()` no-ops silently. That keeps
 * v2 dormant until the operator wires up VAPID keys on both
 * Vercel + the build pipeline, mirroring the Phase 1 `interval_ba_enabled`
 * pattern in uw-stream.
 *
 * Spec: docs/superpowers/specs/interval-ba-push-v2-2026-05-12.md (Phase 4e).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';

export interface PushSubscriptionState {
  /**
   * `null` while the initial check is in flight; `true` if a live
   * subscription exists on the browser; `false` if none / permission
   * denied / Web Push unsupported.
   */
  subscribed: boolean | null;
  /** User-clickable trigger that does the full grant + subscribe flow. */
  subscribe: () => Promise<void>;
  /** Reverse the subscription, notify the server. */
  unsubscribe: () => Promise<void>;
  /** Last error from a subscribe/unsubscribe call (display-only). */
  error: string | null;
}

/**
 * Convert URL-safe base64 (the VAPID public key wire format) to the
 * Uint8Array shape `pushManager.subscribe`'s `applicationServerKey`
 * expects. See https://www.rfc-editor.org/rfc/rfc8292#section-2.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Padded = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = globalThis.atob(base64Padded);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    out[i] = rawData.charCodeAt(i);
  }
  return out;
}

function hasPushSupport(): boolean {
  return (
    typeof Notification !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.serviceWorker != null &&
    'PushManager' in globalThis
  );
}

async function postSubscription(subscription: PushSubscription): Promise<void> {
  const body = subscription.toJSON();
  if (!body.endpoint || !body.keys) {
    throw new Error('Browser returned subscription without endpoint/keys');
  }
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: body.endpoint,
      keys: body.keys,
      user_agent: navigator.userAgent,
    }),
  });
  if (!res.ok) {
    throw new Error(`Server rejected subscription: ${res.status}`);
  }
}

async function postUnsubscribe(endpoint: string): Promise<void> {
  // Best-effort — the server-side row is mostly housekeeping; the
  // actual push delivery stops the moment subscription.unsubscribe()
  // succeeds in the browser. We surface server-side failures as a
  // hook error but the browser is already unsubscribed.
  const res = await fetch('/api/push/unsubscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) {
    throw new Error(`Server rejected unsubscribe: ${res.status}`);
  }
}

export function usePushSubscription(): PushSubscriptionState {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!hasPushSupport()) {
      setSubscribed(false);
      return;
    }
    navigator.serviceWorker.ready
      .then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        if (mountedRef.current) setSubscribed(sub != null);
      })
      .catch(() => {
        if (mountedRef.current) setSubscribed(false);
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const subscribe = useCallback(async () => {
    setError(null);
    try {
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!vapidKey) {
        // v2 dormant — VAPID not configured. Silent return so the
        // existing "Enable notifications" CTA stays functional for
        // the legacy in-tab Notification path (Phase 3).
        return;
      }
      if (!hasPushSupport()) {
        setError('Web Push not supported in this browser');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError(`Permission ${permission}`);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          // PushManager's TS def requires BufferSource (ArrayBufferView<
          // ArrayBuffer>). Uint8Array<ArrayBufferLike> is structurally
          // compatible at runtime but the strict lib types reject the
          // cast — pass the underlying buffer explicitly.
          applicationServerKey: urlBase64ToUint8Array(vapidKey)
            .buffer as ArrayBuffer,
        }));
      await postSubscription(subscription);
      if (mountedRef.current) setSubscribed(true);
    } catch (e) {
      Sentry.captureException(e, { tags: { context: 'push_subscription' } });
      const msg = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) setError(msg);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setError(null);
    try {
      if (!hasPushSupport()) {
        if (mountedRef.current) setSubscribed(false);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        if (mountedRef.current) setSubscribed(false);
        return;
      }
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await postUnsubscribe(endpoint);
      if (mountedRef.current) setSubscribed(false);
    } catch (e) {
      Sentry.captureException(e, { tags: { context: 'push_subscription' } });
      const msg = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) setError(msg);
    }
  }, []);

  return { subscribed, subscribe, unsubscribe, error };
}
