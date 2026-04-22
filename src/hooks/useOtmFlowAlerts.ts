/**
 * useOtmFlowAlerts — scrolling window of SPXW OTM heavy-flow alerts.
 *
 * Fetches /api/options-flow/otm-heavy. Two modes:
 *   - Live:       polls every POLL_INTERVALS.OTM_FLOW ms while market is open
 *                 AND the tab is visible AND mode === 'live'. Dedupes alerts
 *                 across polls; exposes `newlyArrived` (the diff vs the
 *                 previous successful poll) so the consuming component can
 *                 fire toasts / audio / notifications without re-firing on
 *                 rows it already saw.
 *   - Historical: one-shot fetch when the user changes date/time/threshold
 *                 settings. No polling.
 *
 * The hook is intentionally side-effect-free w.r.t. user-facing alerts —
 * the consuming component (OtmFlowAlerts.tsx) subscribes to `newlyArrived`
 * and owns the toast / audio / notification UX gated on user settings.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import type { OtmFlowAlert, OtmFlowSettings } from '../types/otm-flow';

// ── URL construction ──────────────────────────────────────────

/**
 * Build the CT wall-clock ISO timestamp for `date + time`, resolving the
 * correct UTC offset via Intl (handles CDT/CST transitions). Returns null
 * if inputs are malformed.
 *
 * Why this instead of `new Date('${date}T${time}')`: the native constructor
 * uses the browser's local timezone, which is the user's machine setting
 * — works correctly when the user is in CT but silently breaks if they
 * travel. Explicit CT resolution is worth the extra lines.
 */
function buildCtAsOfIso(date: string, time: string): string | null {
  // Strict shape + range checks. A loose regex like /^\d{2}:\d{2}$/ would
  // pass "25:99", which then falls through the candidate-hour loop and
  // emits a bogus CDT-fallback ISO. Gate here so corrupted localStorage
  // can never produce a silently-wrong URL param.
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  ) {
    return null;
  }

  const [y, m, d] = date.split('-').map((p) => Number.parseInt(p, 10));
  const [hh, mm] = time.split(':').map((p) => Number.parseInt(p, 10));
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d) ||
    !Number.isFinite(hh) ||
    !Number.isFinite(mm) ||
    m! < 1 ||
    m! > 12 ||
    d! < 1 ||
    d! > 31
  ) {
    return null;
  }

  // Try both candidate UTC hours (CDT = UTC-5, CST = UTC-6) and pick the
  // one whose CT round-trip lands on the requested wall-clock time.
  const ctFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });

  for (const offsetHours of [5, 6]) {
    const candidate = new Date(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1, hh! + offsetHours, mm ?? 0, 0, 0),
    );
    const parts: Record<string, string> = {};
    for (const { type, value } of ctFmt.formatToParts(candidate)) {
      parts[type] = value;
    }
    const ctHour = Number.parseInt(parts.hour ?? '-1', 10) % 24;
    const ctMin = Number.parseInt(parts.minute ?? '-1', 10);
    if (ctHour === hh && ctMin === mm) return candidate.toISOString();
  }
  // DST-edge fallback: assume CDT.
  return new Date(
    Date.UTC(y!, (m ?? 1) - 1, d ?? 1, hh! + 5, mm ?? 0, 0, 0),
  ).toISOString();
}

function buildUrl(settings: OtmFlowSettings, limit: number): string {
  const qs = new URLSearchParams({
    window_minutes: String(settings.windowMinutes),
    min_ask_ratio: String(settings.minAskRatio),
    min_bid_ratio: String(settings.minBidRatio),
    min_distance_pct: String(settings.minDistancePct),
    min_premium: String(settings.minPremium),
    sides: settings.sides,
    type: settings.type,
    limit: String(limit),
  });

  if (settings.mode === 'historical' && settings.historicalDate) {
    qs.append('date', settings.historicalDate);
    if (settings.historicalTime) {
      const asOf = buildCtAsOfIso(
        settings.historicalDate,
        settings.historicalTime,
      );
      if (asOf) qs.append('as_of', asOf);
    }
  }

  return `/api/options-flow/otm-heavy?${qs.toString()}`;
}

// ── Hook ──────────────────────────────────────────────────────

export interface UseOtmFlowAlertsOptions {
  settings: OtmFlowSettings;
  marketOpen: boolean;
  /** Response row limit. Default 100, capped server-side at 200. */
  limit?: number;
  /** Override polling interval (ms). Default POLL_INTERVALS.OTM_FLOW. */
  pollIntervalMs?: number;
}

export interface UseOtmFlowAlertsResult {
  alerts: OtmFlowAlert[];
  /** Alerts added since the previous successful poll (empty on first load). */
  newlyArrived: OtmFlowAlert[];
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;
  /** Echo of the active mode from the last response (not just settings). */
  mode: 'live' | 'historical' | null;
  refetch: () => void;
}

function alertKey(a: OtmFlowAlert): string {
  return `${a.option_chain}::${a.created_at}`;
}

export function useOtmFlowAlerts(
  opts: UseOtmFlowAlertsOptions,
): UseOtmFlowAlertsResult {
  const {
    settings,
    marketOpen,
    limit = 100,
    pollIntervalMs = POLL_INTERVALS.OTM_FLOW,
  } = opts;

  const [alerts, setAlerts] = useState<OtmFlowAlert[]>([]);
  const [newlyArrived, setNewlyArrived] = useState<OtmFlowAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [mode, setMode] = useState<'live' | 'historical' | null>(null);

  const seenKeysRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  // Fire a manual refetch when the caller asks — consumed by the polling
  // effect to avoid coupling the one-shot path to the interval setup.
  const [refetchNonce, setRefetchNonce] = useState(0);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;

    setLoading(true);
    try {
      const res = await fetch(buildUrl(settings, limit), {
        credentials: 'same-origin',
        signal: ctl.signal,
      });
      // Guard against stale responses. The mock `fetch` in tests doesn't
      // honor abort signals, and even in production a slow response
      // could race a newer fetchOnce — either case ends with a stale
      // response overwriting state we just wrote. `abortRef.current !== ctl`
      // means a later fetchOnce superseded ours; bail without touching state.
      if (ctl.signal.aborted || abortRef.current !== ctl) return;

      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as {
        alerts?: OtmFlowAlert[];
        last_updated?: string | null;
        mode?: 'live' | 'historical';
      };
      if (ctl.signal.aborted || abortRef.current !== ctl) return;

      const incoming = data.alerts ?? [];

      // Dedupe vs prior polls. seenKeysRef is reset on settings change by
      // the effect below, which covers mode switches as well (settings.mode
      // is in its dep list), so no per-fetch mode comparison is needed.
      const fresh = incoming.filter(
        (a) => !seenKeysRef.current.has(alertKey(a)),
      );
      for (const a of fresh) seenKeysRef.current.add(alertKey(a));

      setAlerts(incoming);
      setNewlyArrived(fresh);
      setLastUpdated(data.last_updated ?? null);
      setMode(data.mode ?? null);
      setError(null);
    } catch (e) {
      // Aborted requests are expected during re-renders / unmount; swallow.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      // Only clear loading if we're still the active fetch. Otherwise a
      // superseded fetch's finally would flicker aria-busy false while the
      // winning fetch is still mid-flight.
      if (abortRef.current === ctl) {
        setLoading(false);
      }
    }
  }, [settings, limit]);

  const refetch = useCallback(() => setRefetchNonce((n) => n + 1), []);

  // Reset dedupe state on thresholds changes — a threshold flip changes
  // which rows qualify, so stale "seen" flags would mislabel now-qualifying
  // rows as already-seen and suppress their "newly arrived" signal.
  useEffect(() => {
    seenKeysRef.current = new Set();
    setNewlyArrived([]);
  }, [
    settings.minAskRatio,
    settings.minBidRatio,
    settings.minDistancePct,
    settings.minPremium,
    settings.sides,
    settings.type,
    settings.windowMinutes,
    settings.mode,
    settings.historicalDate,
    settings.historicalTime,
  ]);

  useEffect(() => {
    // Live mode: gate on marketOpen + visibility, poll on interval.
    if (settings.mode === 'live') {
      if (!marketOpen) {
        setLoading(false);
        return;
      }

      let cancelled = false;
      const pollIfVisible = () => {
        if (cancelled) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        fetchOnce();
      };

      // Immediate fetch on mount / mode switch.
      pollIfVisible();
      const id = setInterval(pollIfVisible, pollIntervalMs);
      const visibilityHandler = () => {
        // Catch up when the tab becomes visible again.
        if (typeof document !== 'undefined' && !document.hidden)
          pollIfVisible();
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', visibilityHandler);
      }

      return () => {
        cancelled = true;
        clearInterval(id);
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', visibilityHandler);
        }
        abortRef.current?.abort();
      };
    }

    // Historical mode: one-shot on every settings/refetch change.
    fetchOnce();
    return () => {
      abortRef.current?.abort();
    };
  }, [settings.mode, marketOpen, pollIntervalMs, fetchOnce, refetchNonce]);

  return {
    alerts,
    newlyArrived,
    loading,
    error,
    lastUpdated,
    mode,
    refetch,
  };
}
