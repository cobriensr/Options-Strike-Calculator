/**
 * usePeriscopeStrikes — fetches MM-attributed per-strike gamma + charm
 * from /api/periscope-strikes (Phase 1 of the GEX Landscape MM swap —
 * docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md).
 *
 * Returns the latest slot's per-strike rows PLUS three lookback slots
 * (10m / 20m / 30m prior) computed by walking back through the
 * `availableSlots` array. The lookback fetches feed the GEX Landscape's
 * Δ% columns so they populate on first paint (no client-side buffer
 * warmup needed; the slot history lives in `periscope_snapshots`).
 *
 * Live mode (no `at`): polls every POLL_INTERVALS.STRIKE_BATTLE_MAP
 * during market hours. The scraper produces a new slot every 10 min,
 * so polling more frequently than 30s just hits the 30s endpoint cache.
 *
 * Snapshot mode (`at='YYYY-MM-DDTHH:mm:ssZ'`): one-shot at-or-before
 * resolution, used by the historical scrubber. No polling.
 *
 * Owner-or-guest: matches the API endpoint's auth tier. Public
 * visitors get 401 and the hook stays idle without surfacing an error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getAccessMode } from '../utils/auth';
import { getErrorMessage } from '../utils/error';
import { usePolling } from './usePolling';

export interface PeriscopeStrikeRow {
  strike: number;
  gamma: number;
  charm: number;
}

export interface PeriscopeStrikesResponse {
  marketOpen: boolean;
  asOf: string;
  capturedAt: string | null;
  priorCapturedAt: string | null;
  spot: number | null;
  strikes: PeriscopeStrikeRow[];
  /** Ascending ISO timestamps of every captured slot for the trading date. */
  availableSlots: string[];
}

export interface UsePeriscopeStrikesReturn {
  /** Latest slot (or scrubbed slot when `at` provided). `null` until first fetch. */
  latest: PeriscopeStrikesResponse | null;
  /** Strike-keyed gamma at the 1-slot-prior captured_at, or `null` when unavailable. */
  prior10m: Map<number, number> | null;
  /**
   * Strike-keyed gamma at the 3-slot-prior captured_at, or `null` when
   * unavailable. Phase 3 of the spec adds `prior20m` (2-slot diff)
   * alongside this when StrikeTable wires the 20m column — added here
   * then to avoid shipping a computed-but-unread field in Phase 2.
   */
  prior30m: Map<number, number> | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * ISO timestamp → CT HH:MM (24h). The endpoint takes CT wall-clock for
 * the `?time` param; we round seconds away to match its end-of-minute
 * resolution semantics so a slot whose captured_at is HH:MM:48Z is hit
 * by ?time=HH:MM.
 */
function isoToCtHhMm(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  // Intl returns "24" for midnight in some locales; clamp to "00".
  return `${h === '24' ? '00' : h}:${m}`;
}

/** ISO → CT date string (YYYY-MM-DD). en-CA locale gives ISO format directly. */
function isoToCtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

async function fetchLatest(
  expiry: string,
  at: string | null,
  signal: AbortSignal,
): Promise<PeriscopeStrikesResponse | null> {
  const qs = new URLSearchParams({ date: expiry });
  if (at) qs.set('time', isoToCtHhMm(at));
  const res = await fetch(`/api/periscope-strikes?${qs.toString()}`, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  });
  if (!res.ok) {
    if (res.status === 401) return null;
    throw new Error(`periscope-strikes: HTTP ${res.status}`);
  }
  return (await res.json()) as PeriscopeStrikesResponse;
}

/**
 * Fetch a specific historical slot identified by its captured_at ISO.
 * Used for the 3 lookback slots that feed the Δ% maps. Uses the same
 * endpoint with `?date` + `?time` derived from the captured_at — the
 * endpoint's at-or-before resolution lands on that exact slot.
 */
async function fetchSlot(
  capturedAtIso: string,
  signal: AbortSignal,
): Promise<PeriscopeStrikesResponse | null> {
  const qs = new URLSearchParams({
    date: isoToCtDate(capturedAtIso),
    time: isoToCtHhMm(capturedAtIso),
  });
  const res = await fetch(`/api/periscope-strikes?${qs.toString()}`, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  });
  if (!res.ok) {
    if (res.status === 401) return null;
    throw new Error(`periscope-strikes lookback: HTTP ${res.status}`);
  }
  return (await res.json()) as PeriscopeStrikesResponse;
}

function rowsToGammaMap(
  resp: PeriscopeStrikesResponse | null,
): Map<number, number> | null {
  if (resp == null || resp.strikes.length === 0) return null;
  const m = new Map<number, number>();
  for (const row of resp.strikes) m.set(row.strike, row.gamma);
  return m;
}

export function usePeriscopeStrikes(
  marketOpen: boolean,
  expiry: string,
  at: string | null = null,
): UsePeriscopeStrikesReturn {
  const accessMode = getAccessMode();
  const [latest, setLatest] = useState<PeriscopeStrikesResponse | null>(null);
  const [prior10m, setPrior10m] = useState<Map<number, number> | null>(null);
  const [prior30m, setPrior30m] = useState<Map<number, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid expiry/at changes. Threaded through every
  // sub-fetch in fetchAll() so the lookback round-trips are killed too.
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const primary = await fetchLatest(expiry, at, ctrl.signal);
      if (!mountedRef.current) return;
      // Superseded by a newer fetch between resolve and parse — bail
      // before clobbering newer state.
      if (ctrl.signal.aborted) return;
      setLatest(primary);
      setError(null);

      if (primary == null || primary.capturedAt == null) {
        setPrior10m(null);
        setPrior30m(null);
        return;
      }

      // Walk the slot list backwards from the latest slot's index to
      // find the 10m + 30m lookbacks. indexOf returns -1 if the
      // captured_at isn't in availableSlots — shouldn't happen because
      // both arrays come from the same DB column serialized through
      // the same idiom, but the defensive short-circuit avoids any
      // chance of an out-of-bounds slots[idx] fetch.
      //
      // 20m is intentionally NOT fetched in Phase 2 because no
      // consumer reads it yet (the GexLandscape StrikeTable renders
      // 10m + 30m columns until Phase 3 wires 20m). Adding the third
      // window here without a consumer would be a wasted HTTP call.
      const slots = primary.availableSlots;
      const latestIdx = slots.indexOf(primary.capturedAt);
      if (latestIdx < 0) {
        setPrior10m(null);
        setPrior30m(null);
        return;
      }
      const lookbackPromises: ReadonlyArray<
        Promise<PeriscopeStrikesResponse | null>
      > = [1, 3].map((back) => {
        const idx = latestIdx - back;
        if (idx < 0) return Promise.resolve(null);
        const lookbackIso = slots[idx];
        if (lookbackIso == null) return Promise.resolve(null);
        return fetchSlot(lookbackIso, ctrl.signal);
      });
      const [p10, p30] = await Promise.all(lookbackPromises);
      if (!mountedRef.current) return;
      if (ctrl.signal.aborted) return;
      setPrior10m(rowsToGammaMap(p10 ?? null));
      setPrior30m(rowsToGammaMap(p30 ?? null));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      // Only clear loading if this fetch wasn't superseded — a newer
      // fetch owns loading=true until it itself resolves.
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
    }
  }, [expiry, at]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (accessMode === 'public') {
      setLoading(false);
      return;
    }
    void fetchAll();
  }, [accessMode, fetchAll]);

  // Snapshot mode (`at`) is static — no polling. Public access stays idle.
  usePolling(() => void fetchAll(), POLL_INTERVALS.STRIKE_BATTLE_MAP, [
    accessMode !== 'public',
    marketOpen,
    !at,
  ]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchAll();
  }, [fetchAll]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { latest, prior10m, prior30m, loading, error, refresh };
}
