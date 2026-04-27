/**
 * useAnomalyCrossAsset — polls /api/iv-anomalies-cross-asset every 30s
 * when market is open, returns cross-asset confluence context per
 * active compound key.
 *
 * Drives the Phase F pills in `AnomalyRow` (regime / tape align / DP
 * cluster / GEX zone / VIX direction). Strictly visual — no existing
 * entry/exit logic depends on the returned values, so a slow or
 * failing fetch degrades to the empty map (pills render as `unknown`)
 * without breaking the row.
 *
 * Owner-only — public visitors get an empty map.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { POLL_INTERVALS } from '../constants';
import { checkIsOwner } from '../utils/auth';
import { getErrorMessage } from '../utils/error';
import type {
  ActiveAnomaly,
  AnomalyCrossAssetContext,
} from '../components/IVAnomalies/types';

interface KeyPayload {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  alertTs: string;
}

interface CrossAssetResponse {
  contexts: Record<string, AnomalyCrossAssetContext>;
}

interface UseAnomalyCrossAssetReturn {
  contexts: Record<string, AnomalyCrossAssetContext>;
  loading: boolean;
  error: string | null;
}

/**
 * Build the request payload from the current ActiveAnomaly list. We use
 * `firstSeenTs` as `alertTs` because the regime / tape calculations
 * anchor on the first firing, not the most recent — that mirrors what
 * the ML scripts did when computing these features for the backfill.
 */
function buildKeys(anomalies: readonly ActiveAnomaly[]): KeyPayload[] {
  return anomalies.map((a) => ({
    ticker: a.ticker,
    strike: a.strike,
    side: a.side,
    expiry: a.expiry,
    alertTs: a.firstSeenTs,
  }));
}

/**
 * Stable string fingerprint of the keys list. Used to skip refetches
 * when the ActiveAnomaly array has new object identity but the same
 * compound keys (common — useIVAnomalies rebuilds the array each poll).
 */
function fingerprint(keys: readonly KeyPayload[]): string {
  const sorted = [...keys]
    .map((k) => `${k.ticker}:${k.strike}:${k.side}:${k.expiry}:${k.alertTs}`)
    .sort();
  return sorted.join('|');
}

export function useAnomalyCrossAsset(
  anomalies: readonly ActiveAnomaly[],
  marketOpen: boolean,
): UseAnomalyCrossAssetReturn {
  const isOwner = checkIsOwner();
  const [contexts, setContexts] = useState<
    Record<string, AnomalyCrossAssetContext>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const keys = useMemo(() => buildKeys(anomalies), [anomalies]);
  const fp = useMemo(() => fingerprint(keys), [keys]);

  // Stash the latest keys in a ref so the polling effect doesn't take a
  // dependency on the (object-identity-changing) array. The `fp` string
  // is the only value the effect uses to detect a real change.
  const keysRef = useRef(keys);
  keysRef.current = keys;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOwner || !marketOpen || keysRef.current.length === 0) {
      // Public visitor / market closed / no active anomalies: no fetch.
      // Don't reset contexts when market closes mid-session — last known
      // state is still informative for review.
      setLoading(false);
      return;
    }

    // Per-effect AbortController kills any in-flight fetch when the key set
    // changes (effect re-runs on `fp`) or the component unmounts. Without
    // this, a slow response keyed on the OLD set could overwrite state
    // already populated for the NEW set — race surfaced by code review.
    const ctrl = new AbortController();
    const effectFp = fp;

    const fetchContexts = async () => {
      const currentKeys = keysRef.current;
      if (currentKeys.length === 0) return;
      try {
        const res = await fetch('/api/iv-anomalies-cross-asset', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: currentKeys }),
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(5_000)]),
        });

        if (!mountedRef.current || ctrl.signal.aborted) return;

        if (!res.ok) {
          // 401 (not owner) is expected for guests; don't surface as error.
          if (res.status !== 401) setError('Cross-asset fetch failed');
          return;
        }

        const data = (await res.json()) as CrossAssetResponse;
        // Drop the response if the key set changed while we were waiting
        // OR the component unmounted. Belt-and-suspenders alongside the
        // AbortController above (network may complete before abort fires).
        if (
          !mountedRef.current ||
          ctrl.signal.aborted ||
          effectFp !== fingerprint(keysRef.current)
        ) {
          return;
        }
        setContexts(data.contexts ?? {});
        setError(null);
      } catch (err) {
        // Aborted fetches throw; that's expected on key-change/unmount.
        if (ctrl.signal.aborted) return;
        if (mountedRef.current) setError(getErrorMessage(err));
      } finally {
        if (mountedRef.current && !ctrl.signal.aborted) setLoading(false);
      }
    };

    setLoading(true);
    void fetchContexts();
    const id = setInterval(
      () => void fetchContexts(),
      POLL_INTERVALS.ANOMALY_CROSS_ASSET,
    );
    return () => {
      clearInterval(id);
      ctrl.abort();
    };
  }, [isOwner, marketOpen, fp]);

  return { contexts, loading, error };
}
