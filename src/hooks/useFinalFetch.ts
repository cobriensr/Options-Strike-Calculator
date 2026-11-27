/**
 * useFinalFetch: the one fetch a GEXBot panel makes after the close, plus the
 * retries that follow a transient failure.
 *
 * While `enabled`, the hook arms a single timeout for 3 minutes past the next
 * close (`nextFinalFetchMs`) and calls `run` when it fires. A timer is not
 * enough on its own: a sleeping laptop or a frozen background tab can sit past
 * the armed instant with the timer unfired, so a visible tab, a `pageshow` or
 * a window `focus` also fires `run` once the armed instant has passed.
 *
 * Whichever path fires first clears the timer and re-arms from
 * max(now, armed) before `run` is awaited. Max, not now: a timer that fires a
 * millisecond early by `Date.now()` would otherwise re-arm for the instant it
 * just served. Re-arming before the await keeps a focus event that lands
 * mid-fetch from firing a second run.
 *
 * Retries: a `'transient'` outcome from `run`, or one the consumer reports for
 * its own failed fetch through the returned `retryAfterFailure`, starts a
 * series that calls `run` every CLOSED_RETRY_MS, at most CLOSED_MAX_RETRIES
 * times. The series ends on `'ok'`, on `'failed'` or when the retries run out.
 * Only one series runs at a time: a report that arrives while one runs is
 * ignored, and does not reset its count.
 *
 * Nothing here depends on `usePolling`, which never fires on mount or on a
 * gate flip.
 *
 * `enabled` is not the market gate. Keep it true through the open session as
 * well as after the close: the armed instant is what a tab that slept through
 * the close wakes up to, and a hook that was disabled while the market was open
 * has none. Pass `false` only for a read that has no final fetch at all.
 */

import { useCallback, useEffect, useRef } from 'react';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { nextFinalFetchMs } from '../utils/closed-session';

export type FinalFetchOutcome = 'ok' | 'transient' | 'failed';

export const CLOSED_RETRY_MS = 30_000;
export const CLOSED_MAX_RETRIES = 5;

export function useFinalFetch(
  run: () => Promise<FinalFetchOutcome>,
  enabled: boolean,
): (outcome: FinalFetchOutcome) => void {
  // Latest `run`, so a fresh closure each render needs no re-arm (usePolling's
  // pattern).
  const runRef = useRef(run);
  runRef.current = run;

  // The live effect's report function; null while disabled or unmounted.
  const reportRef = useRef<((outcome: FinalFetchOutcome) => void) | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;

    let disposed = false;
    let armedAt: number | null = null;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let seriesRunning = false;
    let retries = 0;

    /**
     * `run`, with a rejection read as a failed fetch and reported. It never
     * rejects, so callers chain on it without a catch.
     */
    async function execute(): Promise<FinalFetchOutcome> {
      try {
        return await runRef.current();
      } catch (err) {
        captureUnlessAuth(err);
        return 'failed';
      }
    }

    function endSeries(): void {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      seriesRunning = false;
      retries = 0;
    }

    function scheduleRetry(): void {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        retries += 1;
        execute().then(settleRetry);
      }, CLOSED_RETRY_MS);
    }

    /** A retry's own outcome: the one report that a running series accepts. */
    function settleRetry(outcome: FinalFetchOutcome): void {
      if (disposed) return;
      if (outcome === 'transient' && retries < CLOSED_MAX_RETRIES) {
        scheduleRetry();
      } else {
        endSeries();
      }
    }

    /** A report from outside a series: it starts one, or is ignored. */
    function report(outcome: FinalFetchOutcome): void {
      if (disposed || seriesRunning || outcome !== 'transient') return;
      seriesRunning = true;
      retries = 0;
      scheduleRetry();
    }

    function arm(after: number): void {
      clearTimeout(finalTimer);
      armedAt = nextFinalFetchMs(new Date(after));
      finalTimer =
        armedAt == null
          ? undefined
          : setTimeout(fire, Math.max(0, armedAt - Date.now()));
    }

    function fire(): void {
      arm(Math.max(Date.now(), armedAt ?? 0));
      execute().then(report);
    }

    /** A wake-up: fire if the armed instant has passed, else do nothing. */
    function wake(): void {
      if (armedAt != null && Date.now() >= armedAt) fire();
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') wake();
    }

    arm(Date.now());
    reportRef.current = report;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);

    return () => {
      disposed = true;
      clearTimeout(finalTimer);
      clearTimeout(retryTimer);
      reportRef.current = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('focus', wake);
    };
  }, [enabled]);

  return useCallback((outcome: FinalFetchOutcome) => {
    reportRef.current?.(outcome);
  }, []);
}
