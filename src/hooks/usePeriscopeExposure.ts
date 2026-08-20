/**
 * usePeriscopeExposure — fetches the Periscope MM-attributed exposure
 * view for the panel. Routes between two endpoints based on whether the
 * user is in live or historical mode:
 *
 *   - LIVE (no date/time picker): /api/periscope-map — GEXBot 1-min,
 *     deterministic view computed from `gexbot_api_capture`. No Claude.
 *   - HISTORICAL (any picker set): /api/periscope-exposure — reads
 *     `periscope_snapshots`, which has the full ~6-month back-catalog
 *     (the adapter cron `populate-periscope-from-gexbot` writes the
 *     10-min slices).
 *
 * Owner or guest. Mirrors the live-polling pattern from `useNopeIntraday`.
 * Polls at POLL_INTERVALS.PERISCOPE (60s) during RTH; pauses outside
 * market hours.
 *
 * Returns the structured view + loading + error + asOf timestamp.
 * The view is null when GEXBot has no fresh capture for today's expiry
 * yet — the panel renders a "no GEXBot capture for today yet"
 * placeholder rather than crashing.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';
import { usePolling } from './usePolling';

// RankedRow, RankedRowSimple, PeriscopeView lifted to src/types/periscope.ts
// (Phase 3C). Re-exported here so existing callers keep working.
export type {
  RankedRow,
  RankedRowSimple,
  PeriscopeView,
} from '../types/periscope.js';

import type {
  PeriscopeView,
  RankedRow,
  RankedRowSimple,
} from '../types/periscope.js';

/**
 * Reason the server gives for a null view: `no_spot` (SPX spot not
 * available yet) or `no_slot` (no capture for the requested slot).
 * `null` when the view is populated or the server didn't say.
 */
export type PeriscopeEmptyReason = 'no_spot' | 'no_slot' | null;

// ── Validation ──────────────────────────────────────────────────────
// Mirrors `validateSpike` (useVegaSpikes) and `parseDarkPoolResponse`
// (useDarkPoolLevels). The view is consumed by DERIVED COMPUTATION
// before anything renders — `computeTradePlan(view)` reads
// `breaches.find(...)` / `gamma.ceiling`, `PeriscopePanel` formats
// `view.capturedAt` through `Intl.DateTimeFormat` and prints
// `view.spot.toFixed(2)` — so a shapeless body used to throw
// (`RangeError: Invalid time value`, `Cannot read properties of
// undefined (reading 'find')`) before any empty state could render.
//
// REQUIRED (missing/wrong type ⇒ view rejected ⇒ the hook's existing
// error path, last-known-good view untouched):
//   `capturedAt` (a PARSEABLE ISO string — an unparseable one throws
//   inside Intl), `expiry`, `spot` (finite, > 0 — a price level), and
//   the `gamma` / `charm` / `vanna` objects plus the `signFlips` /
//   `breaches` arrays. `computePeriscopeView` in
//   api/_lib/periscope-format.ts emits all of them on every non-null
//   `data`.
//
// DEGRADED (invalid ⇒ safe default, view survives):
//   `priorCapturedAt` → null; `gamma.ceiling` / `gamma.floor` → null
//   (the analyzer already has a no-wall path); every ranked-row array →
//   the valid rows only; charm tallies → 0 (reads as "flat" charm, the
//   neutral branch); `charmZeroStrike` → null; `cone` → null.
//
// Numerics are checked for type/finiteness only: a gamma/charm/vanna
// value of exactly 0 is legitimate, as is a 0 charm tally. Only `spot`
// and a ranked row's `strike` are additionally required to be positive,
// because those are price levels.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A string that `new Date()` can parse. Anything else detonates the
 *  `Intl.DateTimeFormat` calls in PeriscopePanel / SlotPicker. */
function isIsoTimestamp(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function validateRankedRowSimple(raw: unknown): RankedRowSimple | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw.strike) || raw.strike <= 0) return null;
  if (!isFiniteNumber(raw.value)) return null;
  return { strike: raw.strike, value: raw.value };
}

function validateRankedRow(raw: unknown): RankedRow | null {
  const simple = validateRankedRowSimple(raw);
  if (simple == null) return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.ptsFromSpot)) return null;
  return { ...simple, ptsFromSpot: r.ptsFromSpot };
}

/** Filter an unknown array down to its valid rows. A non-array (or a
 *  missing field) yields an empty list rather than a fatal. */
function validateRows<T>(
  raw: unknown,
  validate: (row: unknown) => T | null,
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const candidate of raw) {
    const row = validate(candidate);
    if (row != null) out.push(row);
  }
  return out;
}

function validateSignFlip(
  raw: unknown,
): PeriscopeView['signFlips'][number] | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw.strike) || raw.strike <= 0) return null;
  if (!isFiniteNumber(raw.from) || !isFiniteNumber(raw.to)) return null;
  return { strike: raw.strike, from: raw.from, to: raw.to };
}

function validateBreach(
  raw: unknown,
): PeriscopeView['breaches'][number] | null {
  if (!isRecord(raw)) return null;
  if (raw.direction !== 'upper' && raw.direction !== 'lower') return null;
  if (typeof raw.breachTime !== 'string') return null;
  if (!isFiniteNumber(raw.spotAtBreach)) return null;
  if (!isFiniteNumber(raw.ptsPastBound)) return null;
  return {
    direction: raw.direction,
    breachTime: raw.breachTime,
    spotAtBreach: raw.spotAtBreach,
    ptsPastBound: raw.ptsPastBound,
  };
}

function validateCone(raw: unknown): PeriscopeView['cone'] {
  if (!isRecord(raw)) return null;
  if (
    !isFiniteNumber(raw.coneUpper) ||
    !isFiniteNumber(raw.coneLower) ||
    !isFiniteNumber(raw.coneWidth) ||
    !isFiniteNumber(raw.asymmetryPts) ||
    !isFiniteNumber(raw.spotAtCalc)
  ) {
    return null;
  }
  return {
    coneUpper: raw.coneUpper,
    coneLower: raw.coneLower,
    coneWidth: raw.coneWidth,
    asymmetryPts: raw.asymmetryPts,
    spotAtCalc: raw.spotAtCalc,
  };
}

function validateView(raw: unknown): PeriscopeView | null {
  if (!isRecord(raw)) return null;
  if (!isIsoTimestamp(raw.capturedAt)) return null;
  if (typeof raw.expiry !== 'string') return null;
  if (!isFiniteNumber(raw.spot) || raw.spot <= 0) return null;
  if (!isRecord(raw.gamma) || !isRecord(raw.charm) || !isRecord(raw.vanna)) {
    return null;
  }
  if (!Array.isArray(raw.signFlips) || !Array.isArray(raw.breaches)) {
    return null;
  }

  const gamma = raw.gamma;
  const charm = raw.charm;
  const vanna = raw.vanna;

  return {
    capturedAt: raw.capturedAt,
    priorCapturedAt:
      typeof raw.priorCapturedAt === 'string' ? raw.priorCapturedAt : null,
    expiry: raw.expiry,
    spot: raw.spot,
    gamma: {
      ceiling: validateRankedRow(gamma.ceiling),
      floor: validateRankedRow(gamma.floor),
      accelTop: validateRows(gamma.accelTop, validateRankedRow),
      topByAbsNear: validateRows(gamma.topByAbsNear, validateRankedRowSimple),
    },
    charm: {
      tallyNear50: isFiniteNumber(charm.tallyNear50) ? charm.tallyNear50 : 0,
      tallyWide100: isFiniteNumber(charm.tallyWide100) ? charm.tallyWide100 : 0,
      topByAbs: validateRows(charm.topByAbs, validateRankedRowSimple),
      charmZeroStrike: isFiniteNumber(charm.charmZeroStrike)
        ? charm.charmZeroStrike
        : null,
    },
    vanna: { topByAbs: validateRows(vanna.topByAbs, validateRankedRowSimple) },
    signFlips: validateRows(raw.signFlips, validateSignFlip),
    cone: validateCone(raw.cone),
    breaches: validateRows(raw.breaches, validateBreach),
  };
}

interface ParsedPeriscopeResponse {
  view: PeriscopeView | null;
  reason: PeriscopeEmptyReason;
  asOf: string | null;
  availableSlots: string[];
}

/**
 * Validate the /api/periscope-map · /api/periscope-exposure envelope.
 * Returns the parsed payload on success, or `null` when the body isn't
 * an envelope at all (a JSON scalar, an array) or carries a `data`
 * block that isn't a readable view — the caller turns that into the
 * hook's normal error state.
 *
 * A `data` of `null` / absent is NOT a failure: that's the server's
 * documented "no slot / no spot yet" response, and the panel has an
 * empty state for it.
 */
function parsePeriscopeResponse(raw: unknown): ParsedPeriscopeResponse | null {
  if (!isRecord(raw)) return null;
  let view: PeriscopeView | null = null;
  if (raw.data != null) {
    view = validateView(raw.data);
    if (view == null) return null;
  }
  return {
    view,
    reason:
      raw.reason === 'no_spot' || raw.reason === 'no_slot' ? raw.reason : null,
    asOf: typeof raw.asOf === 'string' ? raw.asOf : null,
    // Every slot string is fed to `new Date()` by the SlotPicker option
    // list, so unparseable entries are dropped here rather than thrown
    // there.
    availableSlots: Array.isArray(raw.availableSlots)
      ? raw.availableSlots.filter(isIsoTimestamp)
      : [],
  };
}

export interface UsePeriscopeExposureReturn {
  view: PeriscopeView | null;
  /** Reason the view is null, when known. Used by the panel for the
   *  "waiting for first slot" vs "no SPX spot yet" message. */
  emptyReason: PeriscopeEmptyReason;
  asOf: string | null;
  /** ISO captured_at timestamps for the picked date, ascending. Backs
   *  the prev/next stepper. Empty when the date has no slots. */
  availableSlots: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Picked-slot override. When `null` the hook follows live (latest
 *  slot, polling on during RTH). When set, the hook fetches that
 *  specific (date, time) slot and pauses polling. */
export interface PeriscopeSelectedSlot {
  /** YYYY-MM-DD CT trading date. */
  date: string;
  /** HH:MM CT wall clock. */
  time: string;
}

interface UsePeriscopeExposureOptions {
  marketOpen: boolean;
  /** Optional fresher SPX spot to send as a query param. Falls back to
   *  the server-side `index_candles_1m` lookup when omitted. */
  spotHint?: number | null;
  /** When set, the hook fetches that specific historical slot instead
   *  of latest, and pauses polling. */
  selectedSlot?: PeriscopeSelectedSlot | null;
}

export function usePeriscopeExposure({
  marketOpen,
  spotHint,
  selectedSlot,
}: UsePeriscopeExposureOptions): UsePeriscopeExposureReturn {
  // Owner OR guest — periscope-exposure is a read-only data endpoint
  // gated by guardOwnerOrGuestEndpoint server-side. The previous
  // checkIsOwner() gate matched the useNopeIntraday pattern but
  // unnecessarily blocked guest keys from seeing the panel data.
  const accessMode = getAccessMode();
  const canFetch = accessMode === 'owner' || accessMode === 'guest';
  const [view, setView] = useState<PeriscopeView | null>(null);
  const [emptyReason, setEmptyReason] = useState<PeriscopeEmptyReason>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isHistorical = selectedSlot != null;
  const selectedDate = selectedSlot?.date;
  const selectedTime = selectedSlot?.time;

  const fetchView = useCallback(async () => {
    if (!canFetch) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (spotHint != null && Number.isFinite(spotHint) && spotHint > 0) {
        params.set('spot', String(spotHint));
      }
      if (selectedDate != null) params.set('date', selectedDate);
      if (selectedTime != null) params.set('time', selectedTime);
      const qs = params.toString();
      // Route: live "latest" reads (no date/time picker) hit the new
      // GEXBot-fed /api/periscope-map endpoint for 1-min freshness.
      // Historical replay (any date/time picker active) stays on
      // /api/periscope-exposure which reads periscope_snapshots and
      // has the full ~6-month back-catalog GEXBot capture doesn't.
      const isLive = selectedDate == null && selectedTime == null;
      const baseRoute = isLive
        ? '/api/periscope-map'
        : '/api/periscope-exposure';
      const url = qs ? `${baseRoute}?${qs}` : baseRoute;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      if (!mountedRef.current) return;
      const body = parsePeriscopeResponse(raw);
      // Shapeless body ({} is fine — a scalar / an unreadable `data`
      // block is not). Degrade exactly like a non-2xx: error state, and
      // the last-known-good view stays on screen underneath it.
      if (body == null) throw new Error('Unexpected response shape');
      setView(body.view);
      setEmptyReason(body.reason);
      setAsOf(body.asOf);
      setAvailableSlots(body.availableSlots);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [canFetch, spotHint, selectedDate, selectedTime]);

  // Initial fetch + refetch when selected slot changes.
  useEffect(() => {
    if (!canFetch) return;
    void fetchView();
  }, [canFetch, fetchView]);

  // Polling — RTH only AND only when on Live (no selectedSlot). When
  // viewing a historical slot the data is immutable; polling is wasted
  // bandwidth.
  usePolling(
    () => {
      void fetchView();
    },
    POLL_INTERVALS.PERISCOPE,
    [canFetch, marketOpen, !isHistorical],
  );

  // Stable `refresh` identity — wraps `fetchView` (which returns a
  // Promise) in a void-returning callback so the public signature stays
  // `() => void` and its identity only changes when `fetchView` does.
  const refresh = useCallback(() => {
    void fetchView();
  }, [fetchView]);

  // Memoize the returned object so its identity is stable across renders
  // when no field changed. A parent `useMemo` (App.tsx panelMap) keyed on
  // this object then holds, avoiding ~30 panel re-renders every poll tick.
  return useMemo(
    () => ({
      view,
      emptyReason,
      asOf,
      availableSlots,
      loading,
      error,
      refresh,
    }),
    [view, emptyReason, asOf, availableSlots, loading, error, refresh],
  );
}
