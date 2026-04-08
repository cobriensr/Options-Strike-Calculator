/**
 * useVolumePerStrike — polls /api/volume-per-strike-0dte every 60 seconds.
 *
 * Returns the last 21 1-min snapshots of raw per-strike 0DTE volume for
 * the VolumePerStrike component. The component computes the top-5 magnet
 * rankings and 5-min / 20-min deltas from these raw snapshots using pure
 * helpers in `src/utils/volume-per-strike.ts`.
 *
 * Mirrors the shape of useGexMigration intentionally — both hooks pull
 * per-minute 0DTE snapshots from owner-gated UW-sourced tables. The
 * component layer can compose them side-by-side without impedance.
 *
 * Owner-only — skips polling for public visitors.
 *
 * Effect dispatch (in priority order):
 *   1. Not owner          → no fetch.
 *   2. Past date          → one-shot fetch for that date, no polling.
 *   3. Today, market open → fetch + poll every POLL_INTERVALS.GEX_STRIKE.
 *   4. Today, market closed → one-shot fetch (BACKTEST view of today).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { useIsOwner } from './useIsOwner';
import type {
  VolumePerStrikeSnapshot,
  VolumePerStrikeResponse,
} from '../types/api';

export interface UseVolumePerStrikeReturn {
  snapshots: VolumePerStrikeSnapshot[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useVolumePerStrike(
  marketOpen: boolean,
  selectedDate?: string,
): UseVolumePerStrikeReturn {
  const isOwner = useIsOwner();
  const [snapshots, setSnapshots] = useState<VolumePerStrikeSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Computed each render — flips the "today vs. past" branch naturally at
  // midnight Eastern without needing a state update.
  const todayET = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const isToday = !selectedDate || selectedDate === todayET;

  const fetchData = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (selectedDate) qs.set('date', selectedDate);
      const params = qs.size > 0 ? `?${qs}` : '';
      const res = await fetch(`/api/volume-per-strike-0dte${params}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (res.status !== 401) {
          setError('Failed to load volume per strike data');
        }
        return;
      }

      const data = (await res.json()) as VolumePerStrikeResponse;

      if (!mountedRef.current) return;

      setSnapshots([...data.snapshots]);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }

    // Past date: fetch once, no polling — the day's snapshots are fully
    // written, there's nothing to poll for.
    if (!isToday) {
      setLoading(true);
      fetchData();
      return;
    }

    // Today, market closed: one-shot fetch, no polling — no new snapshots
    // are being written.
    if (!marketOpen) {
      setLoading(true);
      fetchData();
      return;
    }

    // Today, market open → live polling. Each poll fetches the latest 21
    // snapshots for today, so the volume magnets and their sparklines
    // actually advance minute-by-minute.
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVALS.GEX_STRIKE);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, isToday, fetchData]);

  return { snapshots, loading, error, refresh: fetchData };
}
