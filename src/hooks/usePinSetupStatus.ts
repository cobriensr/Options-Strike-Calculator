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
      const body = (await res.json()) as PinSetupStatus;
      if (!mountedRef.current) return;
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

  useEffect(() => {
    void doFetch(date);

    // Poll only in live mode while the cash session is open.
    if (date != null || !marketOpen) return;

    const id = setInterval(() => {
      void doFetch(null);
    }, POLL_INTERVALS.PIN_SETUP);
    return () => clearInterval(id);
  }, [date, marketOpen, doFetch]);

  return { data, loading, error, date, setDate, refresh };
}
