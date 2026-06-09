/**
 * Polling hook for the per-ticker 0DTE Greek heatmap.
 *
 * Fetches `/api/greek-heatmap?ticker=X` on a 30s timer when both the
 * market is open AND the consumer says it's enabled (e.g. the section
 * is expanded). Outside those conditions, the hook does a single fetch
 * on mount/arg change and stops.
 *
 * Schedules the recurring poll via `usePolling`; the eager mount /
 * arg-change fetch lives in a sibling effect. AbortController on the
 * fetch keeps the polling cancel-safe across rapid ticker switches.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md
 * Phase 4 + the `/api/greek-heatmap` endpoint contract.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getErrorMessage } from '../utils/error';
import {
  fetchWithRetry,
  isTransientHttpStatus,
} from '../utils/fetchWithRetry';
import { usePolling } from './usePolling';

const POLL_INTERVAL_MS = 30_000;

/**
 * Carries the HTTP status from the not-ok branch to the catch so we can
 * derive the transient flag from the actual status (robust to message
 * reformat, and covers 502/504 as well as 503) instead of string-matching
 * the error message.
 */
class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/**
 * After this many CONSECUTIVE transient failures (~2 min at the 30s poll),
 * stop reporting the soft "Reconnecting" state and let the UI escalate to
 * the hard error card — a sustained outage is no longer a blip. Reset to 0
 * on any success or non-transient outcome.
 */
const MAX_TRANSIENT_RETRIES = 4;

// Single source of truth for the dealer-gamma regime literals: the Zod
// enum below derives from this, and so (via `z.infer`) does the exported
// `GreekHeatmapResponse['regime']` type. Keep both in lockstep here.
const REGIME_VALUES = ['Long Γ', 'Short Γ'] as const;

// Runtime schemas are the single source of truth for these shapes. The
// `/api/greek-heatmap` response is validated against `greekHeatmapResponseSchema`
// after `res.json()` so a malformed payload is routed through the error
// path instead of rendering as garbage. The exported TS types below are
// derived from the schemas via `z.infer` — there is no hand-maintained
// parallel interface to drift.
const topStrikeSchema = z.object({
  strike: z.number(),
  callGammaOi: z.number().nullable(),
  putGammaOi: z.number().nullable(),
  netGamma: z.number(),
  callCharmOi: z.number().nullable(),
  putCharmOi: z.number().nullable(),
  netCharm: z.number(),
  callVannaOi: z.number().nullable(),
  putVannaOi: z.number().nullable(),
  netVanna: z.number(),
});

const netFlowSchema = z.object({
  cumulativeCallPrem: z.number(),
  cumulativeCallVol: z.number(),
  cumulativePutPrem: z.number(),
  cumulativePutVol: z.number(),
  asOf: z.string(),
});

const intradayRangeSchema = z.object({
  min: z.string(),
  max: z.string(),
  count: z.number(),
});

const greekHeatmapResponseSchema = z.object({
  ticker: z.string(),
  date: z.string(),
  at: z.string().nullable(),
  asOf: z.string().nullable(),
  underlyingPrice: z.number().nullable(),
  atmStrike: z.number().nullable(),
  regime: z.enum(REGIME_VALUES).nullable(),
  netGexK: z.number().nullable(),
  chainStrikes: z.array(topStrikeSchema),
  topStrikes: z.array(topStrikeSchema),
  intradayRange: intradayRangeSchema.nullable(),
  netFlow: netFlowSchema.nullable(),
});

// Types derived from the schemas — single source of truth (D3). Other
// files import these names; the export identifiers must stay identical.
export type GreekHeatmapTopStrike = z.infer<typeof topStrikeSchema>;
export type GreekHeatmapNetFlow = z.infer<typeof netFlowSchema>;
export type GreekHeatmapIntradayRange = z.infer<typeof intradayRangeSchema>;
export type GreekHeatmapResponse = z.infer<typeof greekHeatmapResponseSchema>;

interface UseGreekHeatmapArgs {
  ticker: string;
  /**
   * Optional historical date (YYYY-MM-DD). Defaults to today on the
   * server side. Must fall within the 90-day backfill window.
   */
  date?: string;
  /**
   * Optional intraday scrub timestamp (ISO 8601 UTC). When omitted,
   * the response returns the latest snapshot ("live tip"). When set,
   * the snapshot is pinned to the latest row per strike where
   * `ts_minute <= at`.
   */
  at?: string;
  /**
   * When false, the hook fetches once on arg change but stops polling.
   * Typical usage: pass `marketOpen && viewing-today && live-tip`.
   */
  enabled: boolean;
}

interface State {
  data: GreekHeatmapResponse | null;
  loading: boolean;
  error: string | null;
  /**
   * True when the most recent failure was a transient server state
   * (HTTP 502/503/504 — `/api/greek-heatmap` returns 503 on a retryable
   * Neon timeout; 502/504 are gateway hiccups). Lets the UI show a soft
   * "Reconnecting" placeholder on first-load instead of the hard rose
   * error card. Derived from the response status (not the error message)
   * AND gated by a consecutive-transient counter: once more than
   * MAX_TRANSIENT_RETRIES failures stack up, this flips back to false so a
   * sustained outage escalates to the hard error card. Reset to false on
   * success and on every non-transient failure (network, generic HTTP, Zod).
   */
  transient: boolean;
}

const INITIAL_STATE: State = {
  data: null,
  loading: true,
  error: null,
  transient: false,
};

export function useGreekHeatmap({
  ticker,
  date,
  at,
  enabled,
}: UseGreekHeatmapArgs): State & {
  /**
   * True when we're showing the last-good `data` despite the most recent
   * fetch failing (`error !== null && data !== null`). Lets the UI badge
   * the grid as stale instead of blanking it during a transient outage.
   */
  stale: boolean;
  /**
   * True when the latest fetch failed with a transient server degrade
   * (HTTP 503). The UI uses this to render a soft, auto-retrying
   * placeholder on first-load instead of the hard error banner.
   */
  transient: boolean;
  refresh: () => void;
} {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // Count of consecutive transient (502/503/504) failures. Incremented on
  // each transient failure, reset to 0 on success or any non-transient
  // outcome. Drives the MAX_TRANSIENT_RETRIES escalation gate below.
  const transientCountRef = useRef(0);

  // Track unmount so the catch block can distinguish "aborted because
  // the component is gone" (silent return is correct) from "aborted
  // because the parent re-rendered and a new fetch is starting"
  // (must clear loading so the next fetch's setState can land cleanly).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState((s) => ({ ...s, loading: true }));
    try {
      const params = new URLSearchParams({ ticker });
      if (date) params.set('date', date);
      if (at) params.set('at', at);
      const res = await fetchWithRetry(`/api/greek-heatmap?${params}`, {
        credentials: 'include',
        signal: ctrl.signal,
        maxRetries: 2,
      });
      if (!res.ok) throw new HttpError(res.status);
      const json: unknown = await res.json();
      if (ctrl.signal.aborted) return;
      const parsed = greekHeatmapResponseSchema.safeParse(json);
      if (!parsed.success) {
        // Backend contract drift — capture the Zod issues to Sentry with
        // request context so a frozen grid becomes a triageable event
        // instead of silently surfacing a generic message (D4). Then route
        // through the same preserve-last-good path as a network error
        // instead of rendering garbage.
        captureUnlessAuth(
          new Error('greek-heatmap response failed schema validation'),
          {
            contexts: {
              greekHeatmap: {
                ticker,
                date: date ?? null,
                issues: parsed.error.issues,
              },
            },
          },
        );
        // A schema failure is a genuine (non-transient) outcome — reset the
        // consecutive-transient counter so a later real blip starts fresh.
        transientCountRef.current = 0;
        setState((s) => ({
          data: s.data,
          loading: false,
          error: 'invalid response shape',
          transient: false,
        }));
        return;
      }
      // Success — clear the consecutive-transient counter.
      transientCountRef.current = 0;
      setState({
        data: parsed.data,
        loading: false,
        error: null,
        transient: false,
      });
    } catch (err) {
      // AbortError on a still-mounted component means the parent
      // triggered a new fetch (rapid ticker/date switch); the new
      // fetch will set loading=false when it lands, so we can safely
      // ignore this abort. On unmount, also safely ignore — there's
      // no UI left to update. The previous version silently returned
      // in BOTH cases which, paired with React StrictMode's intentional
      // double-mount, occasionally left `loading: true` stuck on the
      // first mount's state until the second mount's fetch eventually
      // overwrote it.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (!mountedRef.current) return;
      const msg = getErrorMessage(err);
      // Derive transient from the HTTP status carried on HttpError (502/503/
      // 504 — 503 is the endpoint's retryable-Neon-timeout soft degrade,
      // 502/504 are gateway hiccups). Status-derived rather than message-
      // matched, so it's robust to message reformat and covers all three
      // codes. Network errors and abort-fallthrough are non-transient; the
      // Zod-failure path returns before reaching this catch (handled above).
      const statusTransient =
        err instanceof HttpError && isTransientHttpStatus(err.status);
      // Maintain the consecutive-transient counter. Increment BEFORE
      // computing the stored flag so the escalation gate sees this failure;
      // reset on any non-transient failure so a sustained-outage count can't
      // be inflated by interleaved network errors.
      if (statusTransient) {
        transientCountRef.current += 1;
      } else {
        transientCountRef.current = 0;
      }
      // Escalation gate: after more than MAX_TRANSIENT_RETRIES consecutive
      // transient failures (~2 min at the 30s poll), report transient=false
      // so the UI swaps the soft "Reconnecting" placeholder for the hard
      // error card — a sustained outage is no longer a blip.
      const transient =
        statusTransient && transientCountRef.current <= MAX_TRANSIENT_RETRIES;
      // Preserve last-good data on a transient error so one failed poll
      // doesn't blank the live grid (flicker-to-blank). Only set
      // `data: null` when there was no prior data to keep. Always
      // surface the error message.
      setState((s) => ({
        data: s.data,
        loading: false,
        error: msg,
        transient,
      }));
    }
  }, [ticker, date, at]);

  // Eager mount fetch — usePolling only schedules the recurring tick.
  // `enabled` stays in the dep array so a `false → true` flip triggers a
  // fresh fetch (matches the legacy single-effect behavior the tests
  // assert on).
  useEffect(() => {
    fetchOnce();
  }, [fetchOnce, enabled]);

  usePolling(fetchOnce, POLL_INTERVAL_MS, [enabled]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(
    () => ({
      ...state,
      stale: state.error !== null && state.data !== null,
      transient: state.transient,
      refresh: fetchOnce,
    }),
    [state, fetchOnce],
  );
}
