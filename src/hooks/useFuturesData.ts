/**
 * useFuturesData — Fetches futures snapshot data from the API.
 *
 * Calls GET /api/futures/snapshot on mount (live mode), or with an
 * optional `?at=<ISO>` query param when the caller supplies a historical
 * timestamp. Polls every `POLL_INTERVALS.FUTURES` (30s) while
 * `marketOpen === true` AND no historical `at` is set (a snapshot view
 * doesn't change). Aborts any in-flight request when `at` changes or
 * the component unmounts.
 *
 * The 30s cadence is 10× safer than the 5-min sidecar cron that writes
 * fresh ES/NQ/VX rows, so the panel picks up a new snapshot within
 * ≤30s of it landing in Postgres.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { getErrorMessage } from '../utils/error';
import { usePolling } from './usePolling.js';

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

export function useFuturesData(
  at?: string,
  marketOpen = false,
): FuturesDataState {
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

  // Recurring poll while live (no `at` snapshot) and market is open.
  // A historical `at` view is static — polling would waste bandwidth
  // re-fetching the same snapshot. Gating on `marketOpen` matches every
  // other polling hook in the app.
  usePolling(
    () => {
      void fetchData();
    },
    POLL_INTERVALS.FUTURES,
    [!at, marketOpen],
  );

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
