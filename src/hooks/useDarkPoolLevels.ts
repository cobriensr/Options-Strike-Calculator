/**
 * useDarkPoolLevels — polls /api/darkpool-levels every 60 seconds.
 *
 * Returns dark pool strike levels for the DarkPoolLevels widget.
 * Owner-only — skips polling for public visitors.
 *
 * Behavior:
 *   - Live mode (no selectedDate): polls every 60s while marketOpen.
 *   - Explicit date (today or past): fetches once (data is in DB).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { useIsOwner } from './useIsOwner';

export interface DarkPoolLevel {
  spxLevel: number;
  totalPremium: number;
  tradeCount: number;
  totalShares: number;
  latestTime: string | null;
  updatedAt: string;
}

export interface UseDarkPoolLevelsReturn {
  levels: DarkPoolLevel[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
  refresh: () => void;
}

export function useDarkPoolLevels(
  marketOpen: boolean,
  selectedDate?: string,
  selectedTime?: string,
): UseDarkPoolLevelsReturn {
  const isOwner = useIsOwner();
  const [levels, setLevels] = useState<DarkPoolLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const hasExplicitDate = selectedDate != null;

  const fetchLevels = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (selectedDate) qs.set('date', selectedDate);
      if (selectedTime) qs.set('time', selectedTime);
      const params = qs.size > 0 ? `?${qs}` : '';
      const res = await fetch(`/api/darkpool-levels${params}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (res.status !== 401) setError('Failed to load dark pool data');
        return;
      }

      const data = (await res.json()) as {
        levels: DarkPoolLevel[];
        date: string;
      };

      if (!mountedRef.current) return;

      setLevels(data.levels);
      setError(null);

      if (data.levels.length > 0) {
        setUpdatedAt(data.levels[0]!.updatedAt);
      }
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedDate, selectedTime]);

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

    // Explicit date (today or past): fetch once, no polling.
    if (hasExplicitDate) {
      setLoading(true);
      fetchLevels();
      return;
    }

    // No date selected: poll only while market is open
    if (!marketOpen) {
      setLoading(false);
      return;
    }

    fetchLevels();

    const id = setInterval(fetchLevels, POLL_INTERVALS.DARK_POOL);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, hasExplicitDate, fetchLevels]);

  return { levels, loading, error, updatedAt, refresh: fetchLevels };
}
