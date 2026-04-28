/**
 * Polling hook for the Gamma Squeeze board.
 *
 * Fetches `/api/gamma-squeezes` every 30s while the market is open and
 * aggregates rows by compound key (`ticker:strike:side:expiry`). Sibling
 * of `useIVAnomalies` but simpler: no per-strike chart, no banner store,
 * no exit-signal phase machine. Just "what's currently firing."
 *
 * Active-span eviction: a compound key drops off the board after
 * `SQUEEZE_SILENCE_MS` of no fresh firings. Matches the IV anomaly
 * silence convention.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActiveSqueeze,
  GammaSqueezeRow,
  GammaSqueezeTicker,
  GammaSqueezesResponse,
} from '../components/GammaSqueezes/types';
import { squeezeCompoundKey } from '../components/GammaSqueezes/types';

const POLL_MS = 30_000;
const SQUEEZE_SILENCE_MS = 8 * 60 * 1000; // 8 min — matches gamma-window cadence

interface UseGammaSqueezesArgs {
  readonly enabled?: boolean;
  readonly marketOpen: boolean;
}

interface UseGammaSqueezesResult {
  readonly active: readonly ActiveSqueeze[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useGammaSqueezes({
  enabled = true,
  marketOpen,
}: UseGammaSqueezesArgs): UseGammaSqueezesResult {
  const [activeMap, setActiveMap] = useState<Map<string, ActiveSqueeze>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const r = await fetch('/api/gamma-squeezes', {
        credentials: 'include',
      });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const data = (await r.json()) as GammaSqueezesResponse;
      // Stale-fetch guard: if a newer refresh fired while this awaited,
      // discard.
      if (seq !== fetchSeq.current) return;

      const next = new Map<string, ActiveSqueeze>();
      const now = Date.now();
      // Walk through every ticker's history and aggregate.
      for (const [tickerKey, rows] of Object.entries(data.history) as Array<
        [GammaSqueezeTicker, GammaSqueezeRow[]]
      >) {
        if (rows.length === 0) continue;
        // Group by compound key. Rows are DESC by ts.
        const byKey = new Map<string, GammaSqueezeRow[]>();
        for (const row of rows) {
          const key = squeezeCompoundKey(row);
          const bucket = byKey.get(key);
          if (bucket) bucket.push(row);
          else byKey.set(key, [row]);
        }
        for (const [key, group] of byKey) {
          const latest = group[0]!;
          const lastMs = Date.parse(latest.ts);
          if (!Number.isFinite(lastMs)) continue;
          // Silence eviction.
          if (now - lastMs > SQUEEZE_SILENCE_MS) continue;
          // First-seen = earliest ts in the active span. Walk back from
          // newest until we hit a gap > SQUEEZE_SILENCE_MS.
          let firstSeen = latest;
          for (let i = 1; i < group.length; i += 1) {
            const cur = group[i]!;
            const curMs = Date.parse(cur.ts);
            const prevMs = Date.parse(group[i - 1]!.ts);
            if (!Number.isFinite(curMs)) break;
            if (prevMs - curMs > SQUEEZE_SILENCE_MS) break;
            firstSeen = cur;
          }
          next.set(key, {
            compoundKey: key,
            ticker: tickerKey,
            strike: latest.strike,
            side: latest.side,
            expiry: latest.expiry,
            latest,
            firstSeenTs: firstSeen.ts,
            lastFiredTs: latest.ts,
            firingCount: group.length,
          });
        }
      }
      setActiveMap(next);
      setError(null);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, []);

  // Initial + polling.
  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !marketOpen) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, marketOpen, refresh]);

  const active = useMemo(() => {
    const list = [...activeMap.values()];
    // Sort: active first, then forming, then exhausted; within each,
    // most recent first.
    const phaseRank: Record<string, number> = {
      active: 0,
      forming: 1,
      exhausted: 2,
    };
    list.sort((a, b) => {
      const pa = phaseRank[a.latest.squeezePhase] ?? 3;
      const pb = phaseRank[b.latest.squeezePhase] ?? 3;
      if (pa !== pb) return pa - pb;
      return Date.parse(b.lastFiredTs) - Date.parse(a.lastFiredTs);
    });
    return list;
  }, [activeMap]);

  return { active, loading, error, refresh };
}
