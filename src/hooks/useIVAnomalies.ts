/**
 * useIVAnomalies — polls `/api/iv-anomalies` and emits new anomalies to the
 * global banner store.
 *
 * Responsibilities:
 *
 *   1. Fetch the list-mode payload on mount + every POLL_INTERVALS.CHAIN ms
 *      while the market is open. Gated on `marketOpen` — no polling off-hours
 *      (matches `useChainData`).
 *
 *   2. Back off to 2× the base interval after 3 consecutive network fails
 *      (same pattern as other polling hooks in this repo).
 *
 *   3. Dedup across polls. Track a "known-set" of anomaly IDs; the first
 *      time a new ID appears, push it to `ivAnomalyBannerStore` AND fire
 *      the sound chime. Subsequent polls that still include the same ID
 *      are silent — this is what prevents banner spam on every 60s tick.
 *
 *   4. Expose `{ anomalies, loading, error, refresh }` for the standalone
 *      `IVAnomaliesSection` to render the list view.
 *
 * Design note: the first poll populates the known-set without firing any
 * banners — we'd otherwise banner-spam every pre-existing anomaly on mount.
 * After that any new ID triggers the alert path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import type {
  IVAnomaliesListResponse,
  IVAnomalyRow,
} from '../components/IVAnomalies/types';
import { ivAnomalyBannerStore } from '../components/IVAnomalies/banner-store';
import { playAnomalyChime } from '../utils/anomaly-sound';
import { getErrorMessage } from '../utils/error';

export interface UseIVAnomaliesReturn {
  anomalies: IVAnomaliesListResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface FetchResult {
  data: IVAnomaliesListResponse | null;
  networkError?: string;
}

async function fetchAnomalies(): Promise<FetchResult> {
  try {
    const res = await fetch('/api/iv-anomalies', {
      signal: AbortSignal.timeout(10_000),
    });
    // Non-owner → 401. Treat as empty (feature is owner-gated).
    if (res.status === 401) return { data: null };
    if (!res.ok) {
      return {
        data: null,
        networkError: `IV anomalies API error ${res.status}`,
      };
    }
    const payload = (await res.json()) as unknown;
    if (
      typeof payload === 'object' &&
      payload != null &&
      (payload as { mode?: unknown }).mode === 'list'
    ) {
      return { data: payload as IVAnomaliesListResponse };
    }
    return { data: null, networkError: 'Unexpected response shape' };
  } catch (err) {
    return {
      data: null,
      networkError: getErrorMessage(err),
    };
  }
}

function collectRows(
  payload: IVAnomaliesListResponse,
): readonly IVAnomalyRow[] {
  return [
    ...payload.history.SPX,
    ...payload.history.SPY,
    ...payload.history.QQQ,
  ];
}

export function useIVAnomalies(
  enabled: boolean,
  marketOpen: boolean,
): UseIVAnomaliesReturn {
  const [anomalies, setAnomalies] = useState<IVAnomaliesListResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const consecutiveFailsRef = useRef(0);
  const knownIdsRef = useRef<Set<number>>(new Set());
  const primedRef = useRef(false);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    fetchAnomalies().then((result) => {
      if (result.networkError) {
        consecutiveFailsRef.current += 1;
        setError(result.networkError);
      } else {
        consecutiveFailsRef.current = 0;
      }

      if (result.data) {
        const rows = collectRows(result.data);

        if (!primedRef.current) {
          // First successful poll: seed the known-set without alerting.
          // Anomalies that existed before the user opened the page are
          // history, not new signals.
          for (const row of rows) knownIdsRef.current.add(row.id);
          primedRef.current = true;
        } else {
          // Every subsequent poll: anything not in the known-set is new.
          // Push to banner + fire chime once per new ID.
          let firedSound = false;
          for (const row of rows) {
            if (knownIdsRef.current.has(row.id)) continue;
            knownIdsRef.current.add(row.id);
            ivAnomalyBannerStore.push(row);
            if (!firedSound) {
              // Only trigger the chime once per poll — the sound util has
              // its own 3s throttle but calling it repeatedly in one tick
              // is wasteful.
              playAnomalyChime();
              firedSound = true;
            }
          }
        }

        setAnomalies(result.data);
      }
      setLoading(false);
    });
  }, [enabled]);

  // Fetch once on mount when enabled.
  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  // Poll on interval while the market is open. 2× backoff after 3+ fails.
  useEffect(() => {
    if (!enabled || !marketOpen) return;
    const backoff = consecutiveFailsRef.current >= 3 ? 2 : 1;
    const interval = setInterval(refresh, POLL_INTERVALS.CHAIN * backoff);
    return () => clearInterval(interval);
  }, [enabled, marketOpen, refresh]);

  return { anomalies, loading, error, refresh };
}
