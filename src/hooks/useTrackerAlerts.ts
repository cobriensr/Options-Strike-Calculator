/**
 * useTrackerAlerts — polls GET /api/tracker/alerts/unread every 30s
 * while `enabled` is true. New alerts (i.e. ids not seen in the
 * previous poll) fire a Sonner-style toast via the project's
 * `useToast()` bridge. Clicking the toast scrolls the matching
 * contract row into view and acks the alert server-side.
 *
 * The toast handler is opt-in: pass `onToast` to override the default
 * implementation (used by the section to scroll-to-row, and by the
 * tests to assert behavior without coupling to the real Toast portal).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TrackerAlert } from '../components/Tracker/types.js';
import { buildAlertToast } from '../components/Tracker/helpers.js';
import { useToast } from './useToast.js';
import { usePolling } from './usePolling.js';
import { getErrorMessage } from '../utils/error.js';

const POLL_INTERVAL_MS = 30_000;

interface UnreadResponse {
  alerts: TrackerAlert[];
  count: number;
}

export interface UseTrackerAlertsArgs {
  enabled?: boolean;
  /**
   * When false, the hook performs ONE initial fetch on mount (so the
   * seen-id set seeds correctly) but skips the recurring 30s poll.
   * Re-enabling flips polling back on without re-seeding. The project
   * convention is to gate polling on the parent market-open flag —
   * the refresh-tracker cron only fires during RTH, so off-hours polls
   * are wasted requests.
   */
  marketOpen?: boolean;
  /**
   * Called when the user clicks a fired-alert toast. The default
   * implementation in `TrackerSection` scrolls the matching contract
   * row into view; tests pass a spy.
   */
  onSelectContract?: (contractId: number) => void;
}

export interface UseTrackerAlertsState {
  data: TrackerAlert[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  refetch: () => Promise<void>;
  ack: (id: number) => Promise<void>;
}

/**
 * Acknowledge an alert via POST /api/tracker/alerts/:id/ack. Failures
 * are swallowed (logged via console.warn) — the user's click should
 * not raise a UI error if the network drops.
 */
async function ackAlert(id: number): Promise<void> {
  try {
    const res = await fetch(`/api/tracker/alerts/${String(id)}/ack`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      console.warn(`tracker-alerts ack failed: HTTP ${String(res.status)}`);
    }
  } catch (err) {
    console.warn('tracker-alerts ack threw', err);
  }
}

export function useTrackerAlerts({
  enabled = true,
  marketOpen = false,
  onSelectContract,
}: UseTrackerAlertsArgs = {}): UseTrackerAlertsState {
  const toast = useToast();
  const [data, setData] = useState<TrackerAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  // Track which alert ids we've already shown a toast for. Without
  // this, every 30s poll would re-fire the same toasts until the user
  // acks each one.
  const seenIdsRef = useRef<Set<number>>(new Set());
  // First fetch is "initial population" — we don't fire toasts for
  // alerts that already existed before the user opened the app.
  const isFirstFetchRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // Snapshot the callback so the polling effect doesn't tear down on
  // every parent re-render.
  const onSelectRef = useRef(onSelectContract);
  useEffect(() => {
    onSelectRef.current = onSelectContract;
  }, [onSelectContract]);

  // Forward-ref to ack(). The toast onClick fires asynchronously (after
  // user interaction), so by the time it runs the real `ack` callback
  // has been defined. Using a ref avoids the TDZ on the initial render.
  const ackRef = useRef<((id: number) => Promise<void>) | null>(null);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/tracker/alerts/unread', {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as UnreadResponse;
      if (ctrl.signal.aborted) return;
      const incoming = json.alerts;

      if (isFirstFetchRef.current) {
        // Seed the seen-set with the initial server state so we don't
        // spam the user with toasts for alerts that fired before they
        // opened the tab.
        for (const a of incoming) seenIdsRef.current.add(a.id);
        isFirstFetchRef.current = false;
      } else {
        // Subsequent polls — fire a toast for every id not in the
        // seen-set. Order newest-first so the latest pops on top.
        for (const a of incoming) {
          if (seenIdsRef.current.has(a.id)) continue;
          seenIdsRef.current.add(a.id);
          const { message, type } = buildAlertToast(a);
          // Clicking "Open" scrolls the matching row into view AND acks
          // the alert server-side. The optimistic local drop happens
          // inside `ack()`, so the next poll won't re-fire it.
          toast.show(message, type, {
            actionLabel: 'Open',
            onClick: () => {
              onSelectRef.current?.(a.contract_id);
              // ack() already swallows its own errors; ignore the
              // returned promise without `void` (sonarjs/void-use).
              ackRef.current?.(a.id).catch(() => {});
            },
          });
        }
      }

      setData(incoming);
      setError(null);
      setFetchedAt(Date.now());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [toast]);

  // Eager mount fetch — seeds the seen-id set even off-hours so toasts
  // don't fire for alerts that existed before the user opened the tab.
  // usePolling only schedules the recurring tick.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refetch();
  }, [enabled, refetch]);

  // Off-hours: skip the recurring poll. Project convention from CLAUDE.md
  // — the refresh cron only fires during RTH, so polling outside RTH
  // would just re-return the same payload every 30s.
  usePolling(refetch, POLL_INTERVAL_MS, [enabled, marketOpen]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ack = useCallback(async (id: number) => {
    await ackAlert(id);
    // Optimistically drop the row so the next poll doesn't re-fire it.
    setData((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Wire the ref so the toast onClick (defined inside refetch) can call
  // the latest `ack` without a circular useCallback dependency.
  useEffect(() => {
    ackRef.current = ack;
  }, [ack]);

  return useMemo(
    () => ({ data, loading, error, fetchedAt, refetch, ack }),
    [data, loading, error, fetchedAt, refetch, ack],
  );
}
