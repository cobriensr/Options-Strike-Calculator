/**
 * useFuturesData — Fetches futures snapshot data from the API.
 *
 * Calls GET /api/futures/snapshot on mount.
 * No polling (data updates every 5 min via cron, user refreshes
 * manually). Exposes a refetch function for the refresh button.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getErrorMessage } from '../utils/error';

export interface FuturesSnapshot {
  symbol: string;
  price: number;
  change1hPct: number;
  changeDayPct: number;
  volumeRatio: number;
}

export type VxTermStructure =
  | 'CONTANGO'
  | 'FLAT'
  | 'BACKWARDATION';

export interface FuturesSnapshotResponse {
  snapshots: FuturesSnapshot[];
  vxTermSpread: number | null;
  vxTermStructure: VxTermStructure | null;
  esSpxBasis: number | null;
  updatedAt: string;
}

export interface FuturesDataState {
  snapshots: FuturesSnapshot[];
  vxTermSpread: number | null;
  vxTermStructure: VxTermStructure | null;
  esSpxBasis: number | null;
  updatedAt: string | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFuturesData(): FuturesDataState {
  const [snapshots, setSnapshots] = useState<FuturesSnapshot[]>([]);
  const [vxTermSpread, setVxTermSpread] = useState<number | null>(
    null,
  );
  const [vxTermStructure, setVxTermStructure] =
    useState<VxTermStructure | null>(null);
  const [esSpxBasis, setEsSpxBasis] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/futures/snapshot', {
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(
          `Failed to fetch futures data (HTTP ${res.status})`,
        );
      }

      const data: FuturesSnapshotResponse = await res.json();
      setSnapshots(data.snapshots ?? []);
      setVxTermSpread(data.vxTermSpread ?? null);
      setVxTermStructure(data.vxTermStructure ?? null);
      setEsSpxBasis(data.esSpxBasis ?? null);
      setUpdatedAt(data.updatedAt ?? null);
    } catch (err) {
      if (
        err instanceof DOMException &&
        err.name === 'AbortError'
      ) {
        return;
      }
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchData]);

  return {
    snapshots,
    vxTermSpread,
    vxTermStructure,
    esSpxBasis,
    updatedAt,
    loading,
    error,
    refetch: fetchData,
  };
}
