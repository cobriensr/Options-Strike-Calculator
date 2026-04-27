/**
 * useNopeIntraday — fetches /api/nope-intraday for the PriceChart NOPE overlay.
 *
 * Owner-only. Mirrors the live-polling pattern from useGexTarget but with a
 * smaller surface: no scrub, no modes, no historical date browsing — just
 * "give me today's NOPE points and keep them fresh."
 *
 * Polling cadence matches the fetch-nope cron (every minute during market
 * hours). Outside market hours we keep the last-known points but don't poll.
 *
 * Returns `{ points: [] }` shape even on error so the chart can render the
 * candles unchanged when NOPE is unavailable.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { checkIsOwner } from '../utils/auth';

export interface NopePoint {
  /** ISO 8601 UTC timestamp at minute resolution. */
  timestamp: string;
  /** Latest-delta NOPE score. */
  nope: number;
  /** Fill-delta NOPE score (uses delta at transaction time). */
  nope_fill: number;
}

interface NopeIntradayResponse {
  ticker: string;
  date: string | null;
  availableDates: string[];
  points: NopePoint[];
}

export interface UseNopeIntradayReturn {
  points: NopePoint[];
  date: string | null;
  isLoading: boolean;
  error: string | null;
}

interface UseNopeIntradayOptions {
  /**
   * Whether the cash session is currently open. Polling only runs while
   * true; outside hours we keep the last-known points and stop fetching.
   */
  marketOpen: boolean;
}

const EMPTY_POINTS: NopePoint[] = [];

export function useNopeIntraday({
  marketOpen,
}: UseNopeIntradayOptions): UseNopeIntradayReturn {
  const isOwner = checkIsOwner();
  const [points, setPoints] = useState<NopePoint[]>(EMPTY_POINTS);
  const [date, setDate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Avoid setting state after unmount.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchPoints = useCallback(async () => {
    if (!isOwner) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/nope-intraday', { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as NopeIntradayResponse;
      if (!mountedRef.current) return;
      setPoints(body.points);
      setDate(body.date);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [isOwner]);

  // Initial fetch when ownership resolves.
  useEffect(() => {
    if (!isOwner) return;
    void fetchPoints();
  }, [isOwner, fetchPoints]);

  // Live polling — only while market is open. Outside hours we keep the
  // last-known points and stop firing requests.
  useEffect(() => {
    if (!isOwner || !marketOpen) return;
    const id = setInterval(() => {
      void fetchPoints();
    }, POLL_INTERVALS.NOPE); // 60s — matches the fetch-nope cron cadence
    return () => clearInterval(id);
  }, [isOwner, marketOpen, fetchPoints]);

  return { points, date, isLoading, error };
}
