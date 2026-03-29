import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import type { ChainResponse } from '../types/api';

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
      networkError: err instanceof Error ? err.message : 'Network error',
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
  const consecutiveFailsRef = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    fetchChain().then((result) => {
      setChain(result.data);
      if (result.networkError) {
        consecutiveFailsRef.current += 1;
        setError(result.networkError);
      } else {
        consecutiveFailsRef.current = 0;
        setError(result.data?.error ?? null);
      }
      setLoading(false);
    });
  }, [enabled]);

  // Fetch once on mount when enabled
  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  // Poll every 60s only during market hours (with backoff on failures)
  useEffect(() => {
    if (!enabled || !marketOpen) return;
    const backoff = consecutiveFailsRef.current >= 3 ? 2 : 1;
    const interval = setInterval(refresh, POLL_INTERVALS.CHAIN * backoff);
    return () => clearInterval(interval);
  }, [enabled, marketOpen, refresh]);

  return { chain, loading, error, refresh };
}
