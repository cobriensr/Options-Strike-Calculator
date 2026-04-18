/**
 * useFuturesData — Fetches futures snapshot data from the API.
 *
 * Calls GET /api/futures/snapshot on mount (live mode), or with an
 * optional `?at=<ISO>` query param when the caller supplies a historical
 * timestamp. No polling (data updates every 5 min via cron; the caller
 * refreshes manually via the returned `refetch`). Aborts any in-flight
 * request when `at` changes or the component unmounts.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getErrorMessage } from '../utils/error';

export interface FuturesSnapshot {
  symbol: string;
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
  volumeRatio: number | null;
}

export type VxTermStructure = 'CONTANGO' | 'FLAT' | 'BACKWARDATION';

export interface FuturesSnapshotResponse {
  snapshots: FuturesSnapshot[];
  vxTermSpread: number | null;
  vxTermStructure: VxTermStructure | null;
  esSpxBasis: number | null;
  updatedAt: string;
  oldestTs: string | null;
  requestedAt: string | null;
}

export interface FuturesDataState {
  snapshots: FuturesSnapshot[];
  vxTermSpread: number | null;
  vxTermStructure: VxTermStructure | null;
  esSpxBasis: number | null;
  updatedAt: string | null;
  oldestTs: string | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useFuturesData(at?: string): FuturesDataState {
  const [snapshots, setSnapshots] = useState<FuturesSnapshot[]>([]);
  const [vxTermSpread, setVxTermSpread] = useState<number | null>(null);
  const [vxTermStructure, setVxTermStructure] =
    useState<VxTermStructure | null>(null);
  const [esSpxBasis, setEsSpxBasis] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [oldestTs, setOldestTs] = useState<string | null>(null);
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
      // Build URL cleanly — only append `?at=` when caller supplied a value.
      // Identical to the previous `/api/futures/snapshot` string when `at`
      // is absent (no trailing `?`).
      let url = '/api/futures/snapshot';
      if (at) {
        const qs = new URLSearchParams({ at });
        url = `${url}?${qs.toString()}`;
      }

      const res = await fetch(url, {
        signal: controller.signal,
      });

      if (!res.ok) {
        // Try to surface the backend's error string (e.g. Zod validation
        // message or "at must not be in the future"). Fall back to a
        // generic label if the body isn't JSON or the shape is unexpected.
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const reason =
          body && typeof body.error === 'string'
            ? body.error
            : 'Failed to fetch futures data';
        const msg = `${reason} (HTTP ${res.status})`;
        throw new Error(msg);
      }

      const data: FuturesSnapshotResponse = await res.json();
      setSnapshots(data.snapshots ?? []);
      setVxTermSpread(data.vxTermSpread ?? null);
      setVxTermStructure(data.vxTermStructure ?? null);
      setEsSpxBasis(data.esSpxBasis ?? null);
      setUpdatedAt(data.updatedAt ?? null);
      setOldestTs(data.oldestTs ?? null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [at]);

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
    oldestTs,
    loading,
    error,
    refetch: fetchData,
  };
}
