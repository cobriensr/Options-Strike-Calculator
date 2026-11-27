/**
 * usePeriscopeExposure — fetches the Periscope exposure view for the
 * panel. Slices from before the 2026-05-26 cutover are UW Periscope's
 * market-maker position estimates; later ones are GEXBot values in
 * GEXBot's taker-side sign (`periscopeSourceAt`). Routes
 * between two endpoints based on whether the user is in live or
 * historical mode:
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
 *
 * After the close /api/periscope-map answers with the last session's map and
 * its capture time, `asOf` (null on `no_slot`, which no capture backs), with
 * the session's `availableSlots` (spec: gexbot-after-close-design). On the live
 * route only (no picked slot) the hook:
 *  - exposes `asOf`, checked to be an ISO timestamp (`asOfFrom`);
 *  - drops a response whose newest capture (its `asOf`, else its last listed
 *    slot) is before today's open once the market is open: a tab carried over
 *    from the closed view, an edge-cached closed reply, a client clock ahead of
 *    the server's. The drop is made at render, so a response held across the
 *    09:30 ET flip is gone on the flip's own render, before the refetch the
 *    flip starts has landed. What is left reads `no_slot`, with no slots;
 *  - fetches at once when the market opens (`marketOpen` false to true), since
 *    `usePolling` never fires on a gate flip;
 *  - keeps one final fetch armed for close + 3 min, re-armed daily
 *    (`useFinalFetch`), because polling is off after the close;
 *  - keeps the held view, with no error, when a fetch fails while the market is
 *    closed (the panel renders an error in place of the map), and retries a
 *    transient failure 5 times, 30 s apart. With no view held the error shows
 *    while the retries run.
 * A picked slot (/api/periscope-exposure) answers for a past slice and keeps
 * its old rules: no drop, no edge fetch, no final fetch, errors always shown.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import {
  asOfFrom,
  HttpStatusError,
  isCarriedOver,
  isTransientStatus,
} from '../utils/closed-session';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';
import { useFinalFetch, type FinalFetchOutcome } from './useFinalFetch';
import { usePolling } from './usePolling';

// RankedRow, RankedRowSimple, PeriscopeView lifted to src/types/periscope.ts
// (Phase 3C). Re-exported here so existing callers keep working.
export type {
  RankedRow,
  RankedRowSimple,
  PeriscopeView,
} from '../types/periscope.js';

import type { PeriscopeView } from '../types/periscope.js';

interface PeriscopeExposureResponse {
  marketOpen: boolean;
  /**
   * The capture time of the data (`data`, or `no_spot`'s freshest panel); null
   * on the live route's `no_slot`, which no capture backs. After the close it
   * is the last session's.
   */
  asOf: string | null;
  data: PeriscopeView | null;
  reason?: 'no_spot' | 'no_slot';
  availableSlots?: string[];
}

export interface UsePeriscopeExposureReturn {
  view: PeriscopeView | null;
  /** Reason the view is null, when known. Used by the panel for the
   *  "waiting for first slot" vs "no SPX spot yet" message. */
  emptyReason: 'no_spot' | 'no_slot' | null;
  /**
   * The capture time of the response, as an ISO timestamp: after the close, the
   * last session's. Null before the first response, for a `no_slot` (no
   * capture backs it), for an `asOf` that is not a timestamp, and for a live
   * response dropped as carried over from a closed session.
   */
  asOf: string | null;
  /** ISO captured_at timestamps for the picked date, ascending. Backs
   *  the prev/next stepper. Empty when the date has no slots. */
  availableSlots: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** A response as the hook holds it, with the route it came from. */
interface StoredExposure {
  view: PeriscopeView | null;
  emptyReason: 'no_spot' | 'no_slot' | null;
  asOf: string | null;
  availableSlots: string[];
  /** True when read from the live route (/api/periscope-map). */
  live: boolean;
}

/**
 * What the hook holds: the stored response and the error of the latest failed
 * fetch. One state, so a failure can look at the response it leaves in place.
 */
interface ExposureState {
  stored: StoredExposure | null;
  error: string | null;
}

/**
 * Pure: the response as stored. The body is an unchecked cast, so the fields
 * the hook reads are checked: an `asOf` that is no ISO timestamp reads as none
 * (`asOfFrom`, shared with the other GEXBot hooks), a slot list that is no
 * array as an empty one.
 */
function toStored(
  body: PeriscopeExposureResponse,
  live: boolean,
): StoredExposure {
  return {
    view: body.data ?? null,
    emptyReason: body.reason ?? null,
    asOf: asOfFrom(body.asOf),
    availableSlots: Array.isArray(body.availableSlots)
      ? body.availableSlots
      : [],
    live,
  };
}

/** True when the stored response is a live one that carries a view. */
function holdsLiveView(stored: StoredExposure | null): boolean {
  return stored != null && stored.live && stored.view != null;
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
  const [{ stored, error }, setState] = useState<ExposureState>({
    stored: null,
    error: null,
  });
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // marketOpen as of the last effect run, to catch the false to true edge.
  const wasMarketOpen = useRef(marketOpen);
  // marketOpen as of the latest render, for a fetch that fails after the
  // market flipped (usePolling's latest-value pattern).
  const marketOpenNow = useRef(marketOpen);
  marketOpenNow.current = marketOpen;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The live route follows the latest slot; a picked slot reads a past one.
  const isLive = selectedSlot == null;
  const selectedDate = selectedSlot?.date;
  const selectedTime = selectedSlot?.time;

  /**
   * One read. Resolves to what the request itself came to: 'ok' also for one a
   * newer read superseded (the newer one answers for itself), 'transient' for a
   * failure another try can clear, 'failed' for a refused request. It never
   * rejects.
   */
  const fetchOnce = useCallback(async (): Promise<FinalFetchOutcome> => {
    if (!canFetch) return 'ok';
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
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
      const baseRoute = isLive
        ? '/api/periscope-map'
        : '/api/periscope-exposure';
      const url = qs ? `${baseRoute}?${qs}` : baseRoute;
      const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) throw new HttpStatusError(res.status);
      const body = (await res.json()) as PeriscopeExposureResponse;
      if (!mountedRef.current || ctrl.signal.aborted) return 'ok';
      setState({ stored: toStored(body, isLive), error: null });
      return 'ok';
    } catch (err) {
      // A read a newer one superseded (or the unmount) answers for nothing.
      if (ctrl.signal.aborted) return 'ok';
      // A thrown HTTP status says whether another try can help; anything else
      // (no response, a body that is not JSON) counts as 0, which does.
      const status = err instanceof HttpStatusError ? err.status : 0;
      if (mountedRef.current) {
        const message = getErrorMessage(err);
        // After the close polling is off, so an error would stay up all
        // evening in place of a map that is still the session's last (the
        // panel renders an error before the map): hold it and say nothing. Not
        // for a picked slot, and not for a picked slot's view left in place by
        // leaving it: it is no live map.
        const closed = isLive && !marketOpenNow.current;
        setState((prev) => ({
          stored: prev.stored,
          error: closed && holdsLiveView(prev.stored) ? null : message,
        }));
      }
      return isTransientStatus(status) ? 'transient' : 'failed';
    } finally {
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
    }
  }, [canFetch, spotHint, selectedDate, selectedTime, isLive]);

  // The one final read after the close, and the retries of a transient failure
  // while closed (5 x 30 s). Live route only: a picked slot reads a past slice,
  // and a public visitor makes no request. It runs `fetchOnce` and takes that
  // read's own outcome, so only the hook's own reads below go through
  // `retryAfterFailure`. While disabled, `retryAfterFailure` does nothing.
  const retryAfterFailure = useFinalFetch(fetchOnce, isLive && canFetch);

  // The hook's own reads (mount, the open edge, a spot change, a poll tick,
  // refresh): a failure that lands while the market is closed starts the
  // retries, since no tick follows. While open the 60 s poll is the retry. A
  // read that comes back after the flip to closed counts as closed.
  const readNow = useCallback(async () => {
    const outcome = await fetchOnce();
    if (outcome !== 'ok' && !marketOpenNow.current) retryAfterFailure(outcome);
  }, [fetchOnce, retryAfterFailure]);

  // Initial fetch + refetch when selected slot changes.
  useEffect(() => {
    if (!canFetch) return;
    void readNow();
  }, [canFetch, readNow]);

  // The market opens (false to true): what the hook holds is the last session's
  // map, or a failure from a closed hour, and usePolling does not call fn on a
  // gate flip, so the first tick would be a full poll interval away. Read now;
  // the render drops the held map as carried over (see `shown`). Mounting open
  // is no edge: the effect above already read. A picked slot has no open edge.
  useEffect(() => {
    const opened = marketOpen && !wasMarketOpen.current;
    wasMarketOpen.current = marketOpen;
    if (!opened || !isLive || !canFetch) return;
    void readNow();
  }, [marketOpen, isLive, canFetch, readNow]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Polling — RTH only AND only when on Live (no selectedSlot). When
  // viewing a historical slot the data is immutable; polling is wasted
  // bandwidth.
  usePolling(
    () => {
      void readNow();
    },
    POLL_INTERVALS.PERISCOPE,
    [canFetch, marketOpen, isLive],
  );

  // Stable `refresh` identity — wraps `readNow` (which returns a
  // Promise) in a void-returning callback so the public signature stays
  // `() => void` and its identity only changes when `readNow` does.
  const refresh = useCallback(() => {
    void readNow();
  }, [readNow]);

  // What the panel reads from the stored response. The carried-over check
  // lives here, at render, with `marketOpen` in the deps: a response held
  // across the 09:30 ET flip is dropped on the flip's own render, before the
  // refetch the flip starts has landed, so the panel never shows the last
  // session's map as live. It applies to a response read from the live route
  // (a picked slot is a past slice by design), and the clock it reads only
  // matters at the edge, which re-evaluates it. A dropped response leaves
  // `no_slot` with no slots, the state before today's first capture; an
  // in-session `no_slot` keeps its slots, which are today's.
  const shown = useMemo(() => {
    if (stored == null) {
      return {
        view: null,
        emptyReason: null,
        asOf: null,
        availableSlots: [] as string[],
      };
    }
    const newestCapture = stored.asOf ?? stored.availableSlots.at(-1) ?? null;
    if (stored.live && isCarriedOver(newestCapture, marketOpen, new Date())) {
      return {
        view: null,
        emptyReason: 'no_slot' as const,
        asOf: null,
        availableSlots: [] as string[],
      };
    }
    return stored;
  }, [stored, marketOpen]);

  // Memoize the returned object so its identity is stable across renders
  // when no field changed. A parent `useMemo` (App.tsx panelMap) keyed on
  // this object then holds, avoiding ~30 panel re-renders every poll tick.
  return useMemo(
    () => ({
      view: shown.view,
      emptyReason: shown.emptyReason,
      asOf: shown.asOf,
      availableSlots: shown.availableSlots,
      loading,
      error,
      refresh,
    }),
    [shown, loading, error, refresh],
  );
}
