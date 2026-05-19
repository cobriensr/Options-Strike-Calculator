/**
 * useVegaSpikes — polls /api/vega-spikes for recent Dir Vega Spike events.
 *
 * Phase 4 of the Dir Vega Spike Monitor feature. Surfaces qualifying spike
 * events written by the `monitor-vega-spike` cron — the kind of single-bar
 * `dir_vega_flow` outliers in SPY/QQQ that often lead price by minutes.
 *
 * Three view ranges:
 *   - 'today' (default): polls every 60s while marketOpen — matches the
 *     1-min cadence of the writer cron with no extra latency budget.
 *   - '7d' / '30d' (historical browse): one-shot fetch on mount/range
 *     change. No polling — historical rows don't change.
 *
 * Public-for-guests data: no `checkIsOwner` gate. The endpoint already
 * enforces owner-or-guest at the edge.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { usePolling } from './usePolling';

// ── Types ──────────────────────────────────────────────────

export interface VegaSpike {
  id: number;
  ticker: string;
  date: string;
  timestamp: string;
  dirVegaFlow: number;
  zScore: number;
  vsPriorMax: number;
  priorMax: number;
  baselineMad: number;
  barsElapsed: number;
  confluence: boolean;
  fwdReturn5m: number | null;
  fwdReturn15m: number | null;
  fwdReturn30m: number | null;
  fwdReturnEoD: number | null;
  insertedAt: string;
}

export type VegaSpikeRange = 'today' | '7d' | '30d';

export interface VegaSpikesState {
  spikes: VegaSpike[];
  loading: boolean;
  error: string | null;
  range: VegaSpikeRange;
  setRange: (range: VegaSpikeRange) => void;
}

// ── Validation ─────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}

/**
 * Validate a single spike row from the API. Returns the typed spike on
 * success, or null on any field-shape mismatch (caller drops it). Resilient
 * to backend drift — a malformed row never poisons the whole feed.
 */
function validateSpike(raw: unknown): VegaSpike | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.id) ||
    typeof r.ticker !== 'string' ||
    typeof r.date !== 'string' ||
    typeof r.timestamp !== 'string' ||
    !isFiniteNumber(r.dirVegaFlow) ||
    !isFiniteNumber(r.zScore) ||
    !isFiniteNumber(r.vsPriorMax) ||
    !isFiniteNumber(r.priorMax) ||
    !isFiniteNumber(r.baselineMad) ||
    !isFiniteNumber(r.barsElapsed) ||
    typeof r.confluence !== 'boolean' ||
    !isNullableFiniteNumber(r.fwdReturn5m) ||
    !isNullableFiniteNumber(r.fwdReturn15m) ||
    !isNullableFiniteNumber(r.fwdReturn30m) ||
    !isNullableFiniteNumber(r.fwdReturnEoD) ||
    typeof r.insertedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: r.id,
    ticker: r.ticker,
    date: r.date,
    timestamp: r.timestamp,
    dirVegaFlow: r.dirVegaFlow,
    zScore: r.zScore,
    vsPriorMax: r.vsPriorMax,
    priorMax: r.priorMax,
    baselineMad: r.baselineMad,
    barsElapsed: r.barsElapsed,
    confluence: r.confluence,
    fwdReturn5m: r.fwdReturn5m,
    fwdReturn15m: r.fwdReturn15m,
    fwdReturn30m: r.fwdReturn30m,
    fwdReturnEoD: r.fwdReturnEoD,
    insertedAt: r.insertedAt,
  };
}

// ── Hook ───────────────────────────────────────────────────

export function useVegaSpikes(marketOpen: boolean): VegaSpikesState {
  const [spikes, setSpikes] = useState<VegaSpike[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRangeState] = useState<VegaSpikeRange>('today');
  const mountedRef = useRef(true);
  // Stash spikes.length in a ref so the polling effect can decide whether
  // to flip `loading` true on a poll without taking spikes as a dependency.
  // We only want the loading spinner on the FIRST load (empty list);
  // subsequent polls update silently.
  const hasDataRef = useRef(false);
  hasDataRef.current = spikes.length > 0;
  // Per-range AbortController. A new controller is installed on every
  // range change (and on unmount); the prior one is aborted so a slow
  // response from the OLD range can't overwrite state already populated
  // for the NEW range, or fire setState after unmount. Pattern matches
  // useAnomalyCrossAsset (race surfaced by code review).
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchSpikes = useCallback(async () => {
    const ctrl = abortRef.current;
    if (!ctrl) return;
    // Only show the spinner on the very first load — keep silent on polls.
    if (!hasDataRef.current) setLoading(true);
    try {
      const res = await fetch(
        `/api/vega-spikes?range=${encodeURIComponent(range)}`,
        {
          credentials: 'same-origin',
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(5_000)]),
        },
      );

      if (!mountedRef.current || ctrl.signal.aborted) return;

      if (!res.ok) {
        setError(`Request failed (${res.status})`);
        return;
      }

      const data: unknown = await res.json();
      if (!mountedRef.current || ctrl.signal.aborted) return;

      if (
        typeof data !== 'object' ||
        data === null ||
        !('spikes' in data) ||
        !Array.isArray((data as { spikes: unknown }).spikes)
      ) {
        setError('Unexpected response shape');
        return;
      }

      const rawSpikes = (data as { spikes: unknown[] }).spikes;
      const validated: VegaSpike[] = [];
      for (const raw of rawSpikes) {
        const spike = validateSpike(raw);
        if (spike) validated.push(spike);
      }

      setSpikes(validated);
      setError(null);
    } catch (err) {
      // Aborted fetches throw; that's expected on range-change/unmount.
      if (ctrl.signal.aborted) return;
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    } finally {
      if (mountedRef.current && !ctrl.signal.aborted) setLoading(false);
    }
  }, [range]);

  // Eager fetch on mount / range change. Installs a fresh AbortController
  // and aborts the previous one — usePolling only schedules the recurring
  // tick.
  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void fetchSpikes();
    return () => ctrl.abort();
  }, [fetchSpikes]);

  // Polling — only for 'today' while market is open. Historical ranges
  // are static, so we just fetch once on mount/range-change.
  usePolling(fetchSpikes, POLL_INTERVALS.VEGA_SPIKES, [
    range === 'today',
    marketOpen,
  ]);

  const setRange = useCallback((next: VegaSpikeRange) => {
    setRangeState(next);
  }, []);

  return { spikes, loading, error, range, setRange };
}
