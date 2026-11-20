/**
 * usePinSetupStatus — fetches /api/pin-setup-status with optional date.
 *
 * Live mode (no date): polls every PIN_SETUP interval during market
 * hours, otherwise issues a single fetch on mount. Historical mode
 * (caller passes a YYYY-MM-DD date): one-shot fetch, no polling.
 *
 * Access: the endpoint is owner-or-guest tier. For a public visitor
 * (`getAccessMode() === 'public'`, read at every render) the hook makes no
 * request of any kind (mount, date pick, poll or `refresh()`), schedules no
 * poll whatever `marketOpen` its caller passes, and returns no data, error or
 * loading flag, so the tile never shows an "HTTP 401". The picked `date`
 * is kept, so a visitor who signs in without a reload fetches it. An
 * owner or guest fetches as before, and a switch between those two does not
 * refetch.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { z } from 'zod';
import { POLL_INTERVALS } from '../constants';
import {
  claimReport,
  INVALID_SHAPE_ERROR,
  NOT_JSON_ERROR,
  summarizeZodIssues,
} from '../lib/response-guard';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getAccessMode } from '../utils/auth';
import { getErrorMessage } from '../utils/error';
import { usePolling } from './usePolling';

// Runtime schemas are the single source of truth for the
// /api/pin-setup-status response (PinSetupStatusResponse in
// api/pin-setup-status.ts). A 200 whose body doesn't match is handled like
// a failed fetch, so PinSetupTile never renders a status without `state`,
// `conditions` or `trajectory`. The exported types derive from the schemas
// via `z.infer`. Fields the tile never reads are optional, so drift in them
// can't blank it; the `state` and `bias` enums stay strict.
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
  netGammaThresholdM: z.number().optional(),
  netGammaMet: z.boolean().optional(),
  magnetStrike: z.number().nullable(),
  isRound50: z.boolean().optional(),
  distanceToMagnet: z.number().nullable(),
  distanceThreshold: z.number().optional(),
  distanceMet: z.boolean().optional(),
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
  snapshotTs: z.string().nullable().optional(),
  staleMinutes: z.number().nullable(),
  state: z.enum(PIN_SETUP_STATES),
  conditions: pinSetupConditionsSchema,
  spot: z.number().nullable(),
  bias: z.enum(PIN_SETUP_BIASES),
  recommendedTradeTypes: z.array(z.string()),
  avoidedTradeTypes: z.array(z.string()).optional(),
  trajectory: z.array(pinSetupTrajectoryPointSchema),
  outcome: pinSetupOutcomeSchema.nullable(),
  asOf: z.string().optional(),
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
  // /api/pin-setup-status is owner-or-guest. Read at render, never frozen in a
  // ref, so signing in with a guest key (no reload) starts the fetch and
  // dropping to public stops it.
  const isPublic = getAccessMode() === 'public';

  const [data, setData] = useState<PinSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  // In-flight request. A new fetch aborts it, so a late live poll can't
  // overwrite the historical date that replaced it (and vice versa).
  const abortRef = useRef<AbortController | null>(null);
  // Key of the request whose bad body was last reported (see claimReport).
  const reportedKeyRef = useRef<string | null>(null);

  const doFetch = useCallback(
    async (currentDate: string | null) => {
      abortRef.current?.abort();
      // The one request gate: the mount fetch, a date pick, the poll tick and
      // refresh() all land here. A public visitor draws no 401, and a request
      // from before they dropped to public is aborted, so its late reply
      // can't write state.
      if (isPublic) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);

      // A bad 2xx body is handled like a failed fetch: last-good `data`
      // stays, nothing malformed is stored. It's reported once per request,
      // not once per poll.
      const rejectBody = (
        message: string,
        report: Error,
        detail: Record<string, unknown>,
      ) => {
        if (claimReport(reportedKeyRef, currentDate ?? 'live')) {
          captureUnlessAuth(report, {
            contexts: { pinSetupStatus: { date: currentDate, ...detail } },
          });
        }
        setError(message);
      };

      try {
        const url = currentDate
          ? `/api/pin-setup-status?date=${encodeURIComponent(currentDate)}`
          : '/api/pin-setup-status';
        const res = await fetch(url, {
          credentials: 'include',
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let body: unknown;
        try {
          body = await res.json();
        } catch (err) {
          if (ctrl.signal.aborted) return;
          // A 2xx that isn't JSON (an HTML error page, a truncated body).
          rejectBody(
            NOT_JSON_ERROR,
            new Error('pin-setup-status response was not JSON'),
            { detail: getErrorMessage(err) },
          );
          return;
        }
        if (ctrl.signal.aborted) return;
        const parsed = pinSetupStatusSchema.safeParse(body);
        if (!parsed.success) {
          rejectBody(
            INVALID_SHAPE_ERROR,
            new Error('pin-setup-status response failed schema validation'),
            summarizeZodIssues(parsed.error.issues),
          );
          return;
        }
        // A good response re-arms the report latch.
        reportedKeyRef.current = null;
        setData(parsed.data);
        setError(null);
      } catch (err) {
        // Superseded by a newer fetch, or unmounted: nothing to update.
        if (ctrl.signal.aborted) return;
        setError(getErrorMessage(err));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [isPublic],
  );

  const refresh = useCallback(() => {
    void doFetch(date);
  }, [doFetch, date]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // A change of access mode drops what the hook holds: data or an error kept
  // from before a drop to public must not be what a visitor who signs back in
  // sees until the new fetch lands.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [isPublic]);

  // Eager fetch on mount / date change. usePolling only schedules the
  // recurring tick — never the initial fetch.
  useEffect(() => {
    void doFetch(date);
  }, [date, doFetch]);

  // Poll only in live mode while the cash session is open and the visitor is
  // an owner or guest.
  const pollLive = useCallback(() => {
    void doFetch(null);
  }, [doFetch]);
  usePolling(pollLive, POLL_INTERVALS.PIN_SETUP, [
    date == null,
    marketOpen,
    !isPublic,
  ]);

  // A public visitor is shown nothing: not data or an error left in memory
  // from before they dropped to public (the first render after the drop
  // commits before the reset effect above runs), and not the "Loading…" of a
  // request that will never be sent.
  return {
    data: isPublic ? null : data,
    loading: isPublic ? false : loading,
    error: isPublic ? null : error,
    date,
    setDate,
    refresh,
  };
}
