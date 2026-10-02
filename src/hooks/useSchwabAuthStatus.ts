/**
 * useSchwabAuthStatus — polls `GET /api/auth/schwab-status` for the header
 * countdown badge (`SchwabExpiryBadge`).
 *
 * Gates (R1): runs only while `enabled` (an owner session; the endpoint is
 * owner-only) AND the tab is visible. It is deliberately NOT gated on
 * market hours: the 7-day refresh-token clock runs around the clock and the
 * owner re-auths on weekends. It fetches when the gates open (mount, and each
 * time the tab comes back into view), then every 5 minutes while they stay
 * open. Every effect cleans up its listener, interval, and in-flight fetch.
 *
 * A failed or malformed response keeps the last known status rather than
 * blanking the badge; the badge's own clock keeps the countdown moving.
 * Failures are surfaced (R4): a malformed 2xx body, a non-JSON body, a
 * network error, or a timeout is captured as a warning. Aborts are expected
 * (a superseded fetch, a hidden tab, an unmount) and are not. A non-2xx
 * response is not captured here: the endpoint captures its own 5xx, and a
 * 401 is the auth interceptor's to handle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import type { SchwabAuthStatus } from '../utils/schwab-expiry';
import { usePolling } from './usePolling';

const STATUS_URL = '/api/auth/schwab-status';
/** Matches the badge's coarsest change (the 24 h / 2 h tier boundaries). */
const POLL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const CAPTURE_OPTIONS = {
  level: 'warning',
  tags: { context: 'schwab_status_fetch' },
} as const;

const EXPIRY_STATES = new Set(['active', 'expiring', 'expired']);

function isSchwabAuthStatus(body: unknown): body is SchwabAuthStatus {
  if (typeof body !== 'object' || body === null) return false;
  const { state, refreshExpiresAt } = body as Record<string, unknown>;
  if (state === 'logged_out' || state === 'unknown') return true;
  return (
    typeof state === 'string' &&
    EXPIRY_STATES.has(state) &&
    typeof refreshExpiresAt === 'number' &&
    Number.isFinite(refreshExpiresAt)
  );
}

function isTabVisible(): boolean {
  return document.visibilityState === 'visible';
}

export function useSchwabAuthStatus(enabled: boolean): SchwabAuthStatus | null {
  const [status, setStatus] = useState<SchwabAuthStatus | null>(null);
  const [visible, setVisible] = useState(isTabVisible);
  // Aborts the previous fetch when a new one starts, and the in-flight one
  // when the gates close or the component unmounts. Every await below
  // re-checks it, so a superseded response can never overwrite a newer one.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const onVisibilityChange = () => setVisible(isTabVisible());
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(STATUS_URL, {
        credentials: 'same-origin',
        signal: AbortSignal.any([
          ctrl.signal,
          AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ]),
      });
      if (ctrl.signal.aborted || !res.ok) return;
      const body: unknown = await res.json();
      if (ctrl.signal.aborted) return;
      if (!isSchwabAuthStatus(body)) {
        captureUnlessAuth(
          new Error('schwab-status: malformed response body'),
          CAPTURE_OPTIONS,
        );
        return;
      }
      setStatus(body);
    } catch (err) {
      // Our own abort (superseded, hidden, unmounted) is expected. A
      // timeout is a TimeoutError, not an AbortError, so it is captured.
      if (ctrl.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      captureUnlessAuth(err, CAPTURE_OPTIONS);
    }
  }, []);

  const active = enabled && visible;

  useEffect(() => {
    if (!active) return;
    void load();
    return () => abortRef.current?.abort();
  }, [active, load]);

  usePolling(() => void load(), POLL_MS, [active]);

  return status;
}
