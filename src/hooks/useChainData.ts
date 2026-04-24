import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import type { ChainResponse } from '../types/api';
import { getErrorMessage } from '../utils/error';

export interface UseChainDataReturn {
  chain: ChainResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface FetchChainResult {
  data: ChainResponse | null;
  networkError?: string;
}

async function fetchChain(): Promise<FetchChainResult> {
  try {
    const res = await fetch('/api/chain', {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { data: null }; // public visitor
    if (!res.ok)
      return { data: null, networkError: `Chain API error ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return {
      data: null,
      networkError: getErrorMessage(err),
    };
  }
}

export function useChainData(
  enabled: boolean,
  marketOpen: boolean,
): UseChainDataReturn {
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fail streak is STATE (not a ref) so the polling effect re-runs
  // when it crosses the backoff threshold and the new interval
  // actually takes effect. Mirrored on a ref so `refresh` (captured by
  // the effect) can read the latest value without being re-created
  // every time the streak changes.
  const [failStreak, setFailStreak] = useState(0);
  const failStreakRef = useRef(0);
  // Tracks whether the hook is still mounted. Flipped on unmount only —
  // per-effect cancellation uses local `cancelled` flags below.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    fetchChain().then((result) => {
      if (!mountedRef.current) return;
      setChain(result.data);
      if (result.networkError) {
        const next = failStreakRef.current + 1;
        failStreakRef.current = next;
        setFailStreak(next);
        setError(result.networkError);
      } else {
        if (failStreakRef.current !== 0) {
          failStreakRef.current = 0;
          setFailStreak(0);
        }
        setError(result.data?.error ?? null);
      }
      setLoading(false);
    });
  }, [enabled]);

  // Fetch once on mount when enabled.
  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  // Poll every 60s only during market hours (with backoff on failures).
  // Depending on `failStreak` ensures the effect re-runs when the streak
  // crosses the threshold, so the doubled interval is actually used.
  useEffect(() => {
    if (!enabled || !marketOpen) return;
    const backoff = failStreak >= 3 ? 2 : 1;
    const interval = setInterval(refresh, POLL_INTERVALS.CHAIN * backoff);
    return () => clearInterval(interval);
  }, [enabled, marketOpen, refresh, failStreak]);

  return { chain, loading, error, refresh };
}
