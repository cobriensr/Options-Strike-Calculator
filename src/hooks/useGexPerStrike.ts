/**
 * useGexPerStrike — polls /api/gex-per-strike every 60 seconds.
 *
 * Returns per-strike 0DTE GEX data for the GexPerStrike widget.
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

export interface GexStrikeLevel {
  strike: number;
  price: number;
  // Gamma — OI (standing position)
  callGammaOi: number;
  putGammaOi: number;
  netGamma: number;
  // Gamma — volume (today's flow)
  callGammaVol: number;
  putGammaVol: number;
  netGammaVol: number;
  // Vol vs OI reinforcement signal
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral';
  // Gamma — directionalized (bid/ask)
  callGammaAsk: number;
  callGammaBid: number;
  putGammaAsk: number;
  putGammaBid: number;
  // Charm
  callCharmOi: number;
  putCharmOi: number;
  netCharm: number;
  // Delta (DEX)
  callDeltaOi: number;
  putDeltaOi: number;
  netDelta: number;
  // Vanna
  callVannaOi: number;
  putVannaOi: number;
  netVanna: number;
}

export interface UseGexPerStrikeReturn {
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  timestamp: string | null;
  refresh: () => void;
}

export function useGexPerStrike(
  marketOpen: boolean,
  selectedDate?: string,
  selectedTime?: string,
): UseGexPerStrikeReturn {
  const isOwner = useIsOwner();
  const [strikes, setStrikes] = useState<GexStrikeLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const hasExplicitDate = selectedDate != null;

  const fetchData = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (selectedDate) qs.set('date', selectedDate);
      if (selectedTime) qs.set('time', selectedTime);
      const params = qs.size > 0 ? `?${qs}` : '';
      const res = await fetch(`/api/gex-per-strike${params}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (res.status !== 401) setError('Failed to load GEX data');
        return;
      }

      const data = (await res.json()) as {
        strikes: GexStrikeLevel[];
        timestamp: string | null;
      };

      if (!mountedRef.current) return;

      setStrikes(data.strikes);
      setTimestamp(data.timestamp);
      setError(null);
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
      fetchData();
      return;
    }

    // No date selected: poll only while market is open
    if (!marketOpen) {
      setLoading(false);
      return;
    }

    fetchData();

    const id = setInterval(fetchData, POLL_INTERVALS.GEX_STRIKE);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, hasExplicitDate, fetchData]);

  return { strikes, loading, error, timestamp, refresh: fetchData };
}
