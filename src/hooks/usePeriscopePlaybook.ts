/**
 * usePeriscopePlaybook — fetches /api/periscope-playbook for the panel's
 * Claude-generated trading playbook (Phase 4 of
 * docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md).
 *
 * Distinct from `usePeriscopeExposure` (the deterministic structural
 * read of `periscope_snapshots`): this hook delivers the latest
 * auto-generated `panel_payload` produced by the scraper-triggered
 * Claude call. The panel renders this when status='complete'; falls
 * back to the deterministic view when no playbook exists yet (Risk
 * R14 in the spec).
 *
 * Polling: 60s during RTH (matches usePeriscopeExposure cadence so a
 * fresh slot's playbook lands within ≤1 min of the auto-playbook
 * completion UPDATE). Pauses entirely when a historical date is
 * selected — past playbooks are immutable.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';

/**
 * Lifecycle states a playbook row can be in. Mirrors the DB CHECK on
 * `periscope_analyses.status` (migration #142).
 */
export type PlaybookStatus =
  | 'in_progress'
  | 'complete'
  | 'failed'
  | 'truncated';

/**
 * Mode the playbook was generated for. Pre-market and post-close slots
 * are skipped by the auto-playbook endpoint (422), so we only see these
 * three values in `data.mode`.
 */
export type PlaybookMode = 'pre_trade' | 'intraday' | 'debrief';

/**
 * Structured panel JSON the renderer consumes. Shape mirrors what the
 * runner's `mapStructuredToPanelPayload` writes (Phase 2b). All fields
 * are nullable because Claude may omit any field — the renderer
 * surfaces nulls as placeholders rather than crashing.
 */
export interface PlaybookPanelPayload {
  spot: number | null;
  cone: { lower: number; upper: number } | null;
  longTrigger: number | null;
  shortTrigger: number | null;
  regime: string | null;
  bias: string | null;
  recommended: string[];
  avoid: string[];
  futuresPlan: string | null;
  gammaFloor: number | null;
  gammaCeiling: number | null;
  magnet: number | null;
  charmZero: number | null;
  expectedDealerBehavior: string | null;
  confidence: string | null;
  confidenceBasis: string | null;
  narrative: string;
}

/**
 * Row returned by GET /api/periscope-playbook when a completed entry
 * exists for the date. `panelPayload` is null when Zod validation
 * rejected the Claude output server-side — the panel falls back to the
 * deterministic exposure render in that case.
 */
export interface PlaybookRow {
  id: number;
  mode: PlaybookMode;
  status: PlaybookStatus;
  slotCapturedAt: string;
  readTime: string;
  spot: number;
  panelPayload: PlaybookPanelPayload | null;
  parentId: number | null;
  model: string | null;
  failureReason: string | null;
  durationMs: number | null;
  createdAt: string;
}

interface PlaybookResponse {
  marketOpen: boolean;
  asOf: string;
  data: PlaybookRow | null;
  latestInProgress: boolean;
  reason?: 'no_playbook';
}

export interface UsePeriscopePlaybookReturn {
  /** Latest complete playbook row for the picked date, or null. */
  data: PlaybookRow | null;
  /** True when a newer slot is mid-flight than what `data` represents.
   *  Even when `data` is null (no completed playbook today yet), this
   *  may be true if the first scrape just fired and Claude is reading. */
  latestInProgress: boolean;
  /** ISO timestamp of the server's response. Drives the staleness
   *  indicator on the panel ("Updated N min ago"). */
  asOf: string | null;
  isLoading: boolean;
  error: string | null;
  /** Reason `data` is null, when known. */
  emptyReason: 'no_playbook' | null;
  refresh: () => void;
}

interface UsePeriscopePlaybookOptions {
  marketOpen: boolean;
  /** When set, fetch the historical playbook for that CT trading date
   *  and pause polling. When null (default), fetch today's latest. */
  selectedDate?: string | null;
  /** When set, pin the playbook lookup to the exact `slot_captured_at`
   *  ISO timestamp. The panel passes the rendered exposure slot's
   *  capturedAt so the playbook lane updates as the user time-travels.
   *  When null (default), the server returns the latest complete row
   *  for the date — correct for Live mode. */
  selectedSlotCapturedAt?: string | null;
}

export function usePeriscopePlaybook({
  marketOpen,
  selectedDate,
  selectedSlotCapturedAt,
}: UsePeriscopePlaybookOptions): UsePeriscopePlaybookReturn {
  // Same posture as /api/periscope-exposure: owner OR guest can read.
  const accessMode = getAccessMode();
  const canFetch = accessMode === 'owner' || accessMode === 'guest';

  const [data, setData] = useState<PlaybookRow | null>(null);
  const [latestInProgress, setLatestInProgress] = useState(false);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<'no_playbook' | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isHistorical = selectedDate != null;

  const fetchPlaybook = useCallback(async () => {
    if (!canFetch) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedDate != null) params.set('date', selectedDate);
      if (selectedSlotCapturedAt != null)
        params.set('slot', selectedSlotCapturedAt);
      const qs = params.toString();
      const url = qs
        ? `/api/periscope-playbook?${qs}`
        : '/api/periscope-playbook';
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PlaybookResponse;
      if (!mountedRef.current) return;
      setData(body.data);
      setLatestInProgress(body.latestInProgress);
      setAsOf(body.asOf);
      setEmptyReason(body.reason ?? null);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [canFetch, selectedDate, selectedSlotCapturedAt]);

  // Initial fetch + refetch when selected date changes.
  useEffect(() => {
    if (!canFetch) return;
    void fetchPlaybook();
  }, [canFetch, fetchPlaybook]);

  // Polling — RTH only AND only when on Live (no selectedDate). When
  // viewing a historical date the data is immutable; polling is wasted.
  useEffect(() => {
    if (!canFetch || !marketOpen || isHistorical) return;
    const id = setInterval(() => {
      void fetchPlaybook();
    }, POLL_INTERVALS.PERISCOPE);
    return () => clearInterval(id);
  }, [canFetch, marketOpen, isHistorical, fetchPlaybook]);

  return {
    data,
    latestInProgress,
    asOf,
    emptyReason,
    isLoading,
    error,
    refresh: () => {
      void fetchPlaybook();
    },
  };
}
