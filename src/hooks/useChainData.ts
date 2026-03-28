import { useState, useEffect, useCallback } from 'react';
import { POLL_INTERVALS } from '../constants';
import type { ChainResponse } from '../types/api';

export interface UseChainDataReturn {
  chain: ChainResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

async function fetchChain(): Promise<ChainResponse | null> {
  try {
    const res = await fetch('/api/chain');
    if (res.status === 401) return null; // public visitor
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function useChainData(enabled: boolean): UseChainDataReturn {
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    fetchChain().then((data) => {
      if (data?.error) {
        setError(data.error);
        setChain(null);
      } else if (data) {
        setChain(data);
        setError(null);
      }
      setLoading(false);
    });
  }, [enabled]);

  // Fetch on mount and every 60s during market hours
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const interval = setInterval(refresh, POLL_INTERVALS.CHAIN);
    return () => clearInterval(interval);
  }, [enabled, refresh]);

  return { chain, loading, error, refresh };
}
