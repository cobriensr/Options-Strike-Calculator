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
 * The 30s cadence is 10× safer than the 5-min cron that writes fresh
 * futures rows, so the panel picks up a new snapshot within ≤30s of it
 * landing in Postgres. Each poll also refreshes the VIX/VIX3M term
 * structure, which the endpoint reads live (null for a historical `at`).
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

/** VIX / VIX3M band: CONTANGO ≤ 0.90 < FLAT < 1.00 ≤ BACKWARDATION. */
export type VixTermBand = 'CONTANGO' | 'FLAT' | 'BACKWARDATION';

export interface VixTermReading {
  vix: number;
  vix3m: number;
  /** VIX / VIX3M, 3 decimals. */
  ratio: number;
  band: VixTermBand;
}

export interface LiveVixTermReading extends VixTermReading {
  /** ISO time of the older of the two Schwab quotes. */
  asOf: string;
}

/** Mirrors `VixTermStructure` in api/_lib/vix-term-structure.ts. */
export interface VixTermStructureData {
  /** Intraday Schwab quotes; null when unavailable. */
  live: LiveVixTermReading | null;
  /** Latest daily close (Unusual Whales). */
  lastClose: VixTermReading | null;
  /** UW's daily label from the front two VIX futures. */
  futuresRegime: VixTermBand | null;
}

export interface FuturesSnapshotResponse {
  snapshots: FuturesSnapshot[];
  /** Null in historical (`at`) mode. */
  vixTermStructure: VixTermStructureData | null;
  esSpxBasis: number | null;
  updatedAt: string | null;
  oldestTs: string | null;
  requestedAt: string | null;
}

export interface FuturesDataState {
  snapshots: FuturesSnapshot[];
  vixTermStructure: VixTermStructureData | null;
  esSpxBasis: number | null;
  /**
   * Epoch milliseconds when the snapshot was produced server-side.
   * Canonical freshness field per the project's `fetchedAt` convention —
   * derived from the response's ISO `updatedAt` via `Date.parse` and
   * coerced to `null` when the parse yields a non-finite value.
   */
  fetchedAt: number | null;
  oldestTs: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useFuturesData(
  at?: string,
  marketOpen = false,
): FuturesDataState {
  const [snapshots, setSnapshots] = useState<FuturesSnapshot[]>([]);
  const [vixTermStructure, setVixTermStructure] =
    useState<VixTermStructureData | null>(null);
  const [esSpxBasis, setEsSpxBasis] = useState<number | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
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
      setVixTermStructure(data.vixTermStructure ?? null);
      setEsSpxBasis(data.esSpxBasis ?? null);
      // Convert the server's ISO timestamp into canonical epoch ms.
      // Bad input (missing field, unparseable string) yields NaN from
      // Date.parse — coalesce to null so consumers can render a clean
      // "no time" state instead of "Invalid Date".
      const parsedUpdatedAt = data.updatedAt
        ? Date.parse(data.updatedAt)
        : Number.NaN;
      setFetchedAt(Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null);
      setOldestTs(data.oldestTs ?? null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // A superseded request (a newer fetch already replaced abortRef) must
      // not surface its error — the latest request owns the UI state.
      if (abortRef.current === controller) {
        setError(getErrorMessage(err));
      }
    } finally {
      // Only the latest in-flight request may flip `loading` off. A
      // superseded request reaching `finally` would otherwise clear the
      // spinner while the newer fetch is still pending (cosmetic flicker).
      if (abortRef.current === controller) {
        setLoading(false);
      }
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
    vixTermStructure,
    esSpxBasis,
    fetchedAt,
    oldestTs,
    loading,
    error,
    refresh: fetchData,
  };
}
