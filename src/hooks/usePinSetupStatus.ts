/**
 * usePinSetupStatus — fetches /api/pin-setup-status with optional date.
 *
 * Live mode (no date): polls every PIN_SETUP interval during market
 * hours, otherwise issues a single fetch on mount. Historical mode
 * (caller passes a YYYY-MM-DD date): one-shot fetch, no polling.
 *
 * The endpoint is owner-or-guest tier; this hook does not gate on
 * ownership — the server returns 401 for unauthorized callers and we
 * surface the error in `error`.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { usePolling } from './usePolling';

export type PinSetupState = 'ARMED' | 'WATCH' | 'NOT_TRIGGERED';
export type PinSetupBias = 'fade-rips' | 'fade-dips' | 'full-pin' | 'no-signal';

export interface PinSetupOutcome {
  settle: number;
  settleVsMagnet: number;
}

export interface PinSetupConditions {
  netGammaAtMagnetM: number;
  netGammaThresholdM: number;
  netGammaMet: boolean;
  magnetStrike: number | null;
  isRound50: boolean;
  distanceToMagnet: number | null;
  distanceThreshold: number;
  distanceMet: boolean;
}

export interface PinSetupTrajectoryPoint {
  ts: string;
  gammaDirM: number;
  spot: number | null;
}

export interface PinSetupStatus {
  evaluatedAt: string;
  date: string | null;
  mode: 'live' | 'historical';
  snapshotTs: string | null;
  staleMinutes: number | null;
  state: PinSetupState;
  conditions: PinSetupConditions;
  spot: number | null;
  bias: PinSetupBias;
  recommendedTradeTypes: string[];
  avoidedTradeTypes: string[];
  trajectory: PinSetupTrajectoryPoint[];
  outcome: PinSetupOutcome | null;
  asOf: string;
}

// ── Validation ─────────────────────────────────────────────
//
// Row-level validation at the parse (client-shape-hardening-2026-08-20,
// Phase A). A shapeless envelope ({}, an HTML error body loosely parsed,
// a 5xx JSON blob) previously reached the render pass as-is and crashed
// the tile at `data.state.replace`. Invalid envelope → the hook's error
// state; invalid trajectory points / trade-type entries are dropped,
// never fatal; a malformed `outcome` degrades to `null`.

const PIN_SETUP_STATES: readonly PinSetupState[] = [
  'ARMED',
  'WATCH',
  'NOT_TRIGGERED',
];

const PIN_SETUP_BIASES: readonly PinSetupBias[] = [
  'fade-rips',
  'fade-dips',
  'full-pin',
  'no-signal',
];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isPinSetupState(v: unknown): v is PinSetupState {
  return (PIN_SETUP_STATES as readonly unknown[]).includes(v);
}

function isPinSetupBias(v: unknown): v is PinSetupBias {
  return (PIN_SETUP_BIASES as readonly unknown[]).includes(v);
}

function isPinSetupMode(v: unknown): v is PinSetupStatus['mode'] {
  return v === 'live' || v === 'historical';
}

function validateTrajectoryPoint(raw: unknown): PinSetupTrajectoryPoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.ts !== 'string' ||
    !isFiniteNumber(r.gammaDirM) ||
    !isNullableFiniteNumber(r.spot)
  ) {
    return null;
  }
  return { ts: r.ts, gammaDirM: r.gammaDirM, spot: r.spot };
}

function validateConditions(raw: unknown): PinSetupConditions | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.netGammaAtMagnetM) ||
    !isFiniteNumber(r.netGammaThresholdM) ||
    typeof r.netGammaMet !== 'boolean' ||
    !isNullableFiniteNumber(r.magnetStrike) ||
    typeof r.isRound50 !== 'boolean' ||
    !isNullableFiniteNumber(r.distanceToMagnet) ||
    !isFiniteNumber(r.distanceThreshold) ||
    typeof r.distanceMet !== 'boolean'
  ) {
    return null;
  }
  return {
    netGammaAtMagnetM: r.netGammaAtMagnetM,
    netGammaThresholdM: r.netGammaThresholdM,
    netGammaMet: r.netGammaMet,
    magnetStrike: r.magnetStrike,
    isRound50: r.isRound50,
    distanceToMagnet: r.distanceToMagnet,
    distanceThreshold: r.distanceThreshold,
    distanceMet: r.distanceMet,
  };
}

function validateOutcome(raw: unknown): PinSetupOutcome | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.settle) || !isFiniteNumber(r.settleVsMagnet)) {
    return null;
  }
  return { settle: r.settle, settleVsMagnet: r.settleVsMagnet };
}

/**
 * Validate the full envelope. Returns the typed status on success, or
 * `null` on any envelope-level shape mismatch (caller surfaces the
 * error state). Invalid rows (trajectory points, trade-type entries)
 * are dropped, never fatal.
 */
function validatePinSetupStatus(raw: unknown): PinSetupStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const conditions = validateConditions(r.conditions);
  if (
    typeof r.evaluatedAt !== 'string' ||
    !isNullableString(r.date) ||
    !isPinSetupMode(r.mode) ||
    !isNullableString(r.snapshotTs) ||
    !isNullableFiniteNumber(r.staleMinutes) ||
    !isPinSetupState(r.state) ||
    conditions == null ||
    !isNullableFiniteNumber(r.spot) ||
    !isPinSetupBias(r.bias) ||
    !Array.isArray(r.recommendedTradeTypes) ||
    !Array.isArray(r.avoidedTradeTypes) ||
    !Array.isArray(r.trajectory) ||
    typeof r.asOf !== 'string'
  ) {
    return null;
  }
  const trajectory: PinSetupTrajectoryPoint[] = [];
  for (const p of r.trajectory) {
    const point = validateTrajectoryPoint(p);
    if (point) trajectory.push(point);
  }
  return {
    evaluatedAt: r.evaluatedAt,
    date: r.date,
    mode: r.mode,
    snapshotTs: r.snapshotTs,
    staleMinutes: r.staleMinutes,
    state: r.state,
    conditions,
    spot: r.spot,
    bias: r.bias,
    recommendedTradeTypes: r.recommendedTradeTypes.filter(
      (t): t is string => typeof t === 'string',
    ),
    avoidedTradeTypes: r.avoidedTradeTypes.filter(
      (t): t is string => typeof t === 'string',
    ),
    trajectory,
    outcome: r.outcome == null ? null : validateOutcome(r.outcome),
    asOf: r.asOf,
  };
}

export interface UsePinSetupStatusReturn {
  data: PinSetupStatus | null;
  loading: boolean;
  error: string | null;
  /** Selected date (null = live). */
  date: string | null;
  setDate: (d: string | null) => void;
  refresh: () => void;
}

interface Options {
  /** Whether the cash session is currently open. Controls live polling. */
  marketOpen: boolean;
}

export function usePinSetupStatus({
  marketOpen,
}: Options): UsePinSetupStatusReturn {
  const [data, setData] = useState<PinSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const doFetch = useCallback(async (currentDate: string | null) => {
    setLoading(true);
    try {
      const url = currentDate
        ? `/api/pin-setup-status?date=${encodeURIComponent(currentDate)}`
        : '/api/pin-setup-status';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      if (!mountedRef.current) return;
      const body = validatePinSetupStatus(raw);
      if (body == null) {
        // Shapeless body ({} / loosely-parsed HTML / 5xx JSON blob) —
        // surface as a normal error state and keep any last-good `data`
        // on screen; never let the malformed payload reach render.
        setError('Unexpected response shape');
        return;
      }
      setData(body);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void doFetch(date);
  }, [doFetch, date]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Eager fetch on mount / date change. usePolling only schedules the
  // recurring tick — never the initial fetch.
  useEffect(() => {
    void doFetch(date);
  }, [date, doFetch]);

  // Poll only in live mode while the cash session is open.
  const pollLive = useCallback(() => {
    void doFetch(null);
  }, [doFetch]);
  usePolling(pollLive, POLL_INTERVALS.PIN_SETUP, [date == null, marketOpen]);

  return { data, loading, error, date, setDate, refresh };
}
