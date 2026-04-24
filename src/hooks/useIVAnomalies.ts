/**
 * useIVAnomalies — polls `/api/iv-anomalies` and aggregates the raw
 * per-minute anomaly stream into a stable per-compound-key view.
 *
 * Two pipelines share one poll:
 *
 *   1. Display — raw rows are grouped by `${ticker}:${strike}:${side}:${expiry}`
 *      (the "compound key"). While the detector keeps firing a given strike
 *      the hook keeps ONE `ActiveAnomaly` entry on the board and updates
 *      its metrics in place. The display list is sorted by `lastFiredTs`
 *      DESC so the freshest entry is always at the top.
 *
 *   2. Alert — the banner store receives a push + the sound chime fires
 *      ONLY when a compound key transitions from "not active" to "active".
 *      If a strike is already active, subsequent firings update its
 *      metrics silently. If the strike has been silent for ≥
 *      ANOMALY_SILENCE_MS and then re-fires, that's treated as a NEW event
 *      and re-banners.
 *
 * Other responsibilities preserved from the earlier row-level impl:
 *
 *   - Fetch on mount + every POLL_INTERVALS.CHAIN ms while the market is
 *     open. Gated on `marketOpen` (matches `useChainData`).
 *   - Back off to 2× the base interval after 3 consecutive network fails.
 *   - First-poll priming: the first successful poll seeds the active map
 *     without firing banners (pre-existing anomalies from before page
 *     load are history, not new signals).
 *   - Eviction: each poll sweeps the active map for entries whose
 *     `lastFiredTs` is > ANOMALY_SILENCE_MS old (evaluated against
 *     `Date.now()`, which fake timers can control deterministically).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ANOMALY_SILENCE_MS, POLL_INTERVALS } from '../constants';
import {
  anomalyCompoundKey,
  type ActiveAnomaly,
  type IVAnomaliesListResponse,
  type IVAnomalyRow,
  type IVAnomalyTicker,
} from '../components/IVAnomalies/types';
import { ivAnomalyBannerStore } from '../components/IVAnomalies/banner-store';
import { playAnomalyChime } from '../utils/anomaly-sound';
import { getErrorMessage } from '../utils/error';

export interface UseIVAnomaliesReturn {
  /** Active compound keys, freshest first. */
  anomalies: ActiveAnomaly[];
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

function isKnownTicker(t: string): t is IVAnomalyTicker {
  return t === 'SPX' || t === 'SPY' || t === 'QQQ';
}

/**
 * Parse an ISO timestamp to epoch ms. Returns `fallback` if parsing fails
 * or yields NaN so downstream math never silently misbehaves.
 */
function tsMs(iso: string, fallback: number): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface ReconcileResult {
  nextMap: ReadonlyMap<string, ActiveAnomaly>;
  /** Rows that represent a "new event" — banner + chime consumers. */
  rowsToBanner: IVAnomalyRow[];
  /** Updated set of already-processed detector row ids. */
  nextSeenIds: Set<number>;
}

/**
 * Core aggregation — pure function so it's safe to call without worrying
 * about Strict Mode double-invocation or stale setState closures. Given
 * the existing map, the set of previously-processed row ids, and an
 * incoming batch of raw rows, produces the next map plus the list of
 * rows that should banner.
 *
 * The `seenIds` guard is load-bearing: the API returns a rolling history
 * window, so poll N+1 re-sends every row from poll N. Without the guard
 * we'd re-count every row on every poll and inflate `firingCount`.
 *
 * Semantics (matches the spec):
 *   - Group rows by compound key (filtering rows we've already processed).
 *   - New compound key ⇒ add to map; banner UNLESS first poll (priming).
 *   - Existing compound key ⇒ update `latest` and `lastFiredTs`, bump
 *     `firingCount`. A silence gap of ≥ ANOMALY_SILENCE_MS between the
 *     existing `lastFiredTs` and the next row is treated as a NEW event
 *     (reset `firstSeenTs`, `firingCount = 1`, banner).
 *   - Eviction: after ingestion, drop any entry whose `lastFiredTs` is
 *     > ANOMALY_SILENCE_MS older than `Date.now()`.
 */
function reconcile(
  prev: ReadonlyMap<string, ActiveAnomaly>,
  seenIds: ReadonlySet<number>,
  rows: readonly IVAnomalyRow[],
  isFirstPoll: boolean,
): ReconcileResult {
  const next = new Map(prev);
  const nowMs = Date.now();
  const rowsToBanner: IVAnomalyRow[] = [];
  // Guard per-poll idempotence — if the same detector row id shows up in
  // both the "new compound key" and the "re-banner after gap" paths
  // (should be impossible but cheap insurance) we only push once.
  const bannerIds = new Set<number>();
  const nextSeenIds = new Set(seenIds);

  // 1. Group previously-unseen rows by compound key.
  const byKey = new Map<string, IVAnomalyRow[]>();
  for (const row of rows) {
    if (!isKnownTicker(row.ticker)) continue;
    if (seenIds.has(row.id)) continue;
    nextSeenIds.add(row.id);
    const key = anomalyCompoundKey(row);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  // 2. Ingest each bucket.
  for (const [key, bucket] of byKey) {
    // Oldest → newest by ts so `latest` ends up as the freshest row
    // and firing bookkeeping matches chronological order.
    const sorted = [...bucket].sort((a, b) => tsMs(a.ts, 0) - tsMs(b.ts, 0));
    const existing = next.get(key);

    if (!existing) {
      const freshest = sorted.at(-1);
      const firstRow = sorted[0];
      if (!freshest || !firstRow) continue;
      const ticker = freshest.ticker;
      if (!isKnownTicker(ticker)) continue;
      next.set(key, {
        compoundKey: key,
        ticker,
        strike: freshest.strike,
        side: freshest.side,
        expiry: freshest.expiry,
        latest: freshest,
        firstSeenTs: firstRow.ts,
        lastFiredTs: freshest.ts,
        firingCount: sorted.length,
      });
      if (!isFirstPoll && !bannerIds.has(freshest.id)) {
        rowsToBanner.push(freshest);
        bannerIds.add(freshest.id);
      }
      continue;
    }

    let runLastFiredMs = tsMs(existing.lastFiredTs, nowMs);
    let runLastFiredIso = existing.lastFiredTs;
    let runFirstSeenIso = existing.firstSeenTs;
    let runFiringCount = existing.firingCount;
    let runLatest: IVAnomalyRow = existing.latest;
    let rebannerRow: IVAnomalyRow | null = null;

    for (const row of sorted) {
      const rowMs = tsMs(row.ts, nowMs);
      if (rowMs - runLastFiredMs >= ANOMALY_SILENCE_MS) {
        // Silence gap long enough to treat this firing as a new event.
        // Reset the active-span bookkeeping and remember the row so we
        // can banner it (unless priming).
        runFirstSeenIso = row.ts;
        runFiringCount = 1;
        rebannerRow = row;
      } else {
        runFiringCount += 1;
      }
      runLatest = row;
      runLastFiredIso = row.ts;
      runLastFiredMs = rowMs;
    }

    next.set(key, {
      ...existing,
      latest: runLatest,
      firstSeenTs: runFirstSeenIso,
      lastFiredTs: runLastFiredIso,
      firingCount: runFiringCount,
    });

    if (rebannerRow && !isFirstPoll && !bannerIds.has(rebannerRow.id)) {
      rowsToBanner.push(rebannerRow);
      bannerIds.add(rebannerRow.id);
    }
  }

  // 3. Eviction pass — drop anything that's been silent ≥ threshold.
  //    Runs even on the first poll so pre-existing-but-stale entries
  //    don't clutter the board on mount.
  for (const [key, entry] of next) {
    const lastMs = tsMs(entry.lastFiredTs, nowMs);
    if (nowMs - lastMs >= ANOMALY_SILENCE_MS) {
      next.delete(key);
    }
  }

  return { nextMap: next, rowsToBanner, nextSeenIds };
}

export function useIVAnomalies(
  enabled: boolean,
  marketOpen: boolean,
): UseIVAnomaliesReturn {
  // Aggregated active entries, keyed by compound key. We keep a map
  // internally for O(1) upsert and convert to a sorted array for the
  // return value. `activeMapRef` mirrors the React state so the async
  // refresh callback can read the current map without racing Strict Mode
  // double-invocation.
  const [activeMap, setActiveMap] = useState<
    ReadonlyMap<string, ActiveAnomaly>
  >(() => new Map());
  const activeMapRef = useRef<ReadonlyMap<string, ActiveAnomaly>>(new Map());
  // Rolling set of detector row ids we've already folded into the map.
  // The API re-sends recent rows across polls; without this guard we'd
  // re-ingest them and inflate firingCount on every poll.
  const seenIdsRef = useRef<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fail streak is STATE (not a ref) so the polling effect re-runs when
  // it crosses the backoff threshold. Mirrored on a ref so the captured
  // `refresh` closure can mutate it without being re-created.
  const [failStreak, setFailStreak] = useState(0);
  const failStreakRef = useRef(0);
  const primedRef = useRef(false);
  // Flipped on unmount so late-arriving fetch responses skip setState.
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
    fetchAnomalies().then((result) => {
      if (!mountedRef.current) return;
      if (result.networkError) {
        const next = failStreakRef.current + 1;
        failStreakRef.current = next;
        setFailStreak(next);
        setError(result.networkError);
      } else if (failStreakRef.current !== 0) {
        failStreakRef.current = 0;
        setFailStreak(0);
      }

      if (result.data) {
        const rows = collectRows(result.data);
        const isFirstPoll = !primedRef.current;
        primedRef.current = true;

        // Compute the next map + side-effect queue OUTSIDE setState so
        // Strict Mode double-invocation never double-pushes banners or
        // re-plays the chime. We use a ref to read the current map.
        const { nextMap, rowsToBanner, nextSeenIds } = reconcile(
          activeMapRef.current,
          seenIdsRef.current,
          rows,
          isFirstPoll,
        );

        activeMapRef.current = nextMap;
        seenIdsRef.current = nextSeenIds;
        setActiveMap(nextMap);

        if (rowsToBanner.length > 0) {
          for (const row of rowsToBanner) {
            ivAnomalyBannerStore.push(row);
          }
          // One chime per poll no matter how many new events landed —
          // the sound util also has a 3s throttle but this avoids
          // calling it needlessly.
          playAnomalyChime();
        }
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
  // Depends on `failStreak` so the effect re-runs and the doubled
  // interval actually takes effect when the threshold is crossed.
  useEffect(() => {
    if (!enabled || !marketOpen) return;
    const backoff = failStreak >= 3 ? 2 : 1;
    const interval = setInterval(refresh, POLL_INTERVALS.CHAIN * backoff);
    return () => clearInterval(interval);
  }, [enabled, marketOpen, refresh, failStreak]);

  // Freshest first: a user scanning the board cares about "what just fired"
  // more than "what started at 10:05 and is still grinding".
  const anomalies = useMemo<ActiveAnomaly[]>(() => {
    const arr = [...activeMap.values()];
    arr.sort((a, b) => tsMs(b.lastFiredTs, 0) - tsMs(a.lastFiredTs, 0));
    return arr;
  }, [activeMap]);

  return { anomalies, loading, error, refresh };
}
