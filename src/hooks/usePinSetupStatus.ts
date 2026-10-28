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
import { z } from 'zod';
import { POLL_INTERVALS } from '../constants';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getErrorMessage } from '../utils/error';
import { usePolling } from './usePolling';

// Runtime schemas are the single source of truth for the
// /api/pin-setup-status response (PinSetupStatusResponse in
// api/pin-setup-status.ts). A 200 whose body doesn't match is handled like
// a failed fetch, so PinSetupTile never renders a status without `state`,
// `conditions` or `trajectory`. The exported types derive from the schemas
// via `z.infer`.
const PIN_SETUP_STATES = ['ARMED', 'WATCH', 'NOT_TRIGGERED'] as const;
const PIN_SETUP_BIASES = [
  'fade-rips',
  'fade-dips',
  'full-pin',
  'no-signal',
] as const;

const pinSetupOutcomeSchema = z.object({
  settle: z.number(),
  settleVsMagnet: z.number(),
});

const pinSetupConditionsSchema = z.object({
  netGammaAtMagnetM: z.number(),
  netGammaThresholdM: z.number(),
  netGammaMet: z.boolean(),
  magnetStrike: z.number().nullable(),
  isRound50: z.boolean(),
  distanceToMagnet: z.number().nullable(),
  distanceThreshold: z.number(),
  distanceMet: z.boolean(),
});

const pinSetupTrajectoryPointSchema = z.object({
  ts: z.string(),
  gammaDirM: z.number(),
  spot: z.number().nullable(),
});

const pinSetupStatusSchema = z.object({
  evaluatedAt: z.string(),
  date: z.string().nullable(),
  mode: z.enum(['live', 'historical']),
  snapshotTs: z.string().nullable(),
  staleMinutes: z.number().nullable(),
  state: z.enum(PIN_SETUP_STATES),
  conditions: pinSetupConditionsSchema,
  spot: z.number().nullable(),
  bias: z.enum(PIN_SETUP_BIASES),
  recommendedTradeTypes: z.array(z.string()),
  avoidedTradeTypes: z.array(z.string()),
  trajectory: z.array(pinSetupTrajectoryPointSchema),
  outcome: pinSetupOutcomeSchema.nullable(),
  asOf: z.string(),
});

export type PinSetupState = (typeof PIN_SETUP_STATES)[number];
export type PinSetupBias = (typeof PIN_SETUP_BIASES)[number];
export type PinSetupOutcome = z.infer<typeof pinSetupOutcomeSchema>;
export type PinSetupConditions = z.infer<typeof pinSetupConditionsSchema>;
export type PinSetupTrajectoryPoint = z.infer<
  typeof pinSetupTrajectoryPointSchema
>;
export type PinSetupStatus = z.infer<typeof pinSetupStatusSchema>;

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
      const body: unknown = await res.json();
      if (!mountedRef.current) return;
      const parsed = pinSetupStatusSchema.safeParse(body);
      if (!parsed.success) {
        // Backend contract drift: report the Zod issues with the requested
        // date, then handle it like a failed fetch. Last-good `data` stays;
        // nothing malformed is stored.
        captureUnlessAuth(
          new Error('pin-setup-status response failed schema validation'),
          {
            contexts: {
              pinSetupStatus: {
                date: currentDate,
                issues: parsed.error.issues,
              },
            },
          },
        );
        setError('invalid response shape');
        return;
      }
      setData(parsed.data);
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
