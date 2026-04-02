/**
 * useDarkPoolLevels — polls /api/darkpool-levels every 60 seconds.
 *
 * Returns today's dark pool cluster data for the DarkPoolLevels widget.
 * Owner-only — skips polling for public visitors.
 * Gated on marketOpen to avoid unnecessary requests outside hours.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { useIsOwner } from './useIsOwner';

export interface DarkPoolLevel {
  spxApprox: number;
  spyPriceLow: number;
  spyPriceHigh: number;
  totalPremium: number;
  tradeCount: number;
  totalShares: number;
  buyerInitiated: number;
  sellerInitiated: number;
  neutral: number;
  latestTime: string | null;
  updatedAt: string;
  direction: 'BUY' | 'SELL' | 'MIXED';
}

export interface UseDarkPoolLevelsReturn {
  levels: DarkPoolLevel[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
}

export function useDarkPoolLevels(
  marketOpen: boolean,
): UseDarkPoolLevelsReturn {
  const isOwner = useIsOwner();
  const [levels, setLevels] = useState<DarkPoolLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchLevels = useCallback(async () => {
    try {
      const res = await fetch('/api/darkpool-levels', {
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
    } catch {
      if (mountedRef.current) setError('Network error');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOwner || !marketOpen) {
      setLoading(false);
      return;
    }

    fetchLevels();

    const id = setInterval(fetchLevels, POLL_INTERVALS.DARK_POOL);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, fetchLevels]);

  return { levels, loading, error, updatedAt };
}
