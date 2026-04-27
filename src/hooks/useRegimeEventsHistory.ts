/**
 * useRegimeEventsHistory — fetches `/api/push/recent-events` for the
 * FuturesGammaPlaybook ServerEventsStrip.
 *
 * Returns the last 20 rows of `regime_events` (server-detected alert
 * edges, emitted by the monitor-regime-events cron). Owner-only —
 * stops polling as soon as we see a 401.
 *
 * Polling policy: mirrors `useSpotGexHistory`:
 *   - Live, market open, document visible → poll every 60s (matches
 *     the cron cadence of 1/min; faster would return identical rows
 *     from the edge cache anyway).
 *   - Market closed                        → poll every 5 min so a
 *     late-settling event from the final cron firing still lands in
 *     the UI without a refresh.
 *   - Document hidden                      → pause polling; resume on
 *     visibility.
 *
 * Independent of `isLive` / scrub state — the history strip is a
 * server-side timeline of fired alerts, not a derived view of the
 * snapshot the scrubber lands on. Rendering the strip while the user
 * scrubs back through an old day is deliberate: it lets them see what
 * alerts actually fired in real time, regardless of what intraday
 * state they're currently inspecting.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { checkIsOwner } from '../utils/auth';
import { getErrorMessage } from '../utils/error';

const POLL_INTERVAL_LIVE_MS = 60_000;
const POLL_INTERVAL_CLOSED_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 20;

export interface RegimeEventRow {
  id: number;
  ts: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  deliveredCount: number;
}

export interface UseRegimeEventsHistoryReturn {
  events: RegimeEventRow[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

interface RawRow {
  id: number;
  ts: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  delivered_count: number;
}

interface ResponseShape {
  events: RawRow[];
}

/**
 * Fetch the recent server-fired regime events with visibility-gated
 * polling. `marketOpen` is a cadence hint — we poll regardless of its
 * value, just at a faster tempo when the market is live.
 *
 * `limit` bumps the server-side cap (max 100). Default of 20 matches
 * the existing `ServerEventsStrip` usage; `TodaysFiredStrip` passes 100
 * so a full day of edges fits in one page with headroom.
 */
export function useRegimeEventsHistory(
  marketOpen: boolean,
  limit: number = DEFAULT_LIMIT,
): UseRegimeEventsHistoryReturn {
  const isOwner = checkIsOwner();
  const [events, setEvents] = useState<RegimeEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const unauthorizedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchData = useCallback(
    async (externalSignal: AbortSignal) => {
      if (!isOwner || unauthorizedRef.current) {
        if (mountedRef.current) setLoading(false);
        return;
      }

      try {
        const signal = AbortSignal.any([
          externalSignal,
          AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ]);

        const res = await fetch(`/api/push/recent-events?limit=${limit}`, {
          credentials: 'same-origin',
          signal,
        });

        if (!mountedRef.current) return;

        if (res.status === 401) {
          unauthorizedRef.current = true;
          setError(new Error('Unauthorized — owner session required.'));
          setLoading(false);
          return;
        }

        if (!res.ok) {
          setError(new Error(`Failed to load recent events (${res.status})`));
          setLoading(false);
          return;
        }

        const data = (await res.json()) as ResponseShape;
        if (!mountedRef.current) return;

        setEvents(
          (data.events ?? []).map((r) => ({
            id: r.id,
            ts: r.ts,
            type: r.type,
            severity: r.severity,
            title: r.title,
            body: r.body,
            deliveredCount: r.delivered_count,
          })),
        );
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mountedRef.current) setError(new Error(getErrorMessage(err)));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [isOwner, limit],
  );

  useEffect(() => {
    if (!isOwner || unauthorizedRef.current) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    setLoading(true);
    void fetchData(signal);

    const interval = marketOpen
      ? POLL_INTERVAL_LIVE_MS
      : POLL_INTERVAL_CLOSED_MS;

    let pollId: ReturnType<typeof setInterval> | undefined;

    const startPoll = () => {
      if (pollId != null) return;
      pollId = setInterval(() => {
        void fetchData(signal);
      }, interval);
    };

    const stopPoll = () => {
      if (pollId != null) {
        clearInterval(pollId);
        pollId = undefined;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchData(signal);
        startPoll();
      } else {
        stopPoll();
      }
    };

    if (document.visibilityState === 'visible') startPoll();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      controller.abort();
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isOwner, marketOpen, fetchData, refreshTick]);

  const refresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  return { events, loading, error, refresh };
}
