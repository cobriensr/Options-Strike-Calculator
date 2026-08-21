/**
 * usePeriscopeStrikes — fetches MM-attributed per-strike gamma + charm
 * from /api/periscope-strikes (Phase 1 of the GEX Landscape MM swap —
 * docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md).
 *
 * Sole consumer: the GexTarget panel (src/components/GexTarget/index.tsx),
 * which reads `latest.strikes` to build the Strike Board's MM gamma
 * overlay. The GEX Landscape moved off this hook to `useGexLandscapeData`
 * (/api/gex-landscape) and no longer reads from here.
 *
 * Returns the latest slot's per-strike rows only — exactly ONE request
 * per poll cycle. This hook used to fire two extra lookback round-trips
 * (10m / 30m prior, walked back through `availableSlots`) to build Δ%
 * gamma maps for the legacy GexLandscape StrikeTable; that consumer went
 * away and the maps were left computed-but-unread. Do not reintroduce a
 * lookback fetch without a consumer that reads it — at the 30s cadence
 * two extra calls is ~1,500 wasted requests per session day.
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
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ── Response validation ────────────────────────────────────────
//
// The parse here used to be an identity cast. A shapeless body (a 5xx
// JSON blob, a loosely-parsed HTML error page) then reached the GexTarget
// panel's MM-overlay memo and threw at
// `for (const s of periscopeStrikes.latest?.strikes ?? [])` — "not
// iterable" when `strikes` arrived as a plain object
// (src/components/GexTarget/index.tsx). Validation now happens at the
// parse (the `validateSpike` pattern in src/hooks/useVegaSpikes.ts):
// bad strike rows are dropped, a bad envelope throws into `runFetch`'s
// existing catch, which surfaces `error` and leaves the last-known-good
// `latest` in place.
//
// Faithfulness to `api/periscope-strikes.ts`: `strikes` and
// `availableSlots` are present on BOTH of the handler's 200 return paths
// (the no-slot early return sends `strikes: []` plus the slot list), so
// requiring them cannot reject a legitimate payload. The remaining fields
// are cosmetic for every current consumer and degrade to a default rather
// than rejecting the envelope.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateStrikeRow(raw: unknown): PeriscopeStrikeRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.strike) ||
    !isFiniteNumber(r.gamma) ||
    !isFiniteNumber(r.charm)
  ) {
    return null;
  }
  return { strike: r.strike, gamma: r.gamma, charm: r.charm };
}

function validateStrikesResponse(
  raw: unknown,
): PeriscopeStrikesResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.strikes) || !Array.isArray(r.availableSlots)) {
    return null;
  }
  const strikes: PeriscopeStrikeRow[] = [];
  for (const row of r.strikes) {
    const strike = validateStrikeRow(row);
    if (strike) strikes.push(strike);
  }
  return {
    marketOpen: r.marketOpen === true,
    asOf: typeof r.asOf === 'string' ? r.asOf : '',
    capturedAt: typeof r.capturedAt === 'string' ? r.capturedAt : null,
    priorCapturedAt:
      typeof r.priorCapturedAt === 'string' ? r.priorCapturedAt : null,
    spot: isFiniteNumber(r.spot) ? r.spot : null,
    strikes,
    availableSlots: r.availableSlots.filter(
      (s): s is string => typeof s === 'string',
    ),
  };
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
  const parsed = validateStrikesResponse(await res.json());
  if (parsed == null) {
    throw new Error('periscope-strikes: unexpected response shape');
  }
  return parsed;
}

export function usePeriscopeStrikes(
  marketOpen: boolean,
  expiry: string,
  at: string | null = null,
): UsePeriscopeStrikesReturn {
  const accessMode = getAccessMode();
  const [latest, setLatest] = useState<PeriscopeStrikesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid expiry/at changes.
  const abortRef = useRef<AbortController | null>(null);

  const runFetch = useCallback(async () => {
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
    void runFetch();
  }, [accessMode, runFetch]);

  // Snapshot mode (`at`) is static — no polling. Public access stays idle.
  usePolling(() => void runFetch(), POLL_INTERVALS.STRIKE_BATTLE_MAP, [
    accessMode !== 'public',
    marketOpen,
    !at,
  ]);

  const refresh = useCallback(() => {
    setLoading(true);
    void runFetch();
  }, [runFetch]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { latest, loading, error, refresh };
}
