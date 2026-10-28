/**
 * useOpeningFlowSignal — polls /api/opening-flow-signal during the
 * 08:25–08:50 CT signal window so the panel updates as slice-1 →
 * slice-2 → evaluation progresses.
 *
 * Outside the window, the hook returns the last known state (or null)
 * and stops polling.
 *
 * Historical mode: pass a `date` (YYYY-MM-DD) to fetch a prior trading
 * day's evaluator output from the persistent DB store. Historical
 * payloads are static — no polling happens when a date is supplied.
 *
 * Persistence: after every successful fetch we mirror the payload to
 * localStorage. The cache is keyed per-date so picking yesterday writes
 * to its own slot and never clobbers today's last-good payload:
 *
 *   - live (today)   → `openingFlowSignal.lastGood`
 *   - historical YYYY → `openingFlowSignal.lastGood:YYYY-MM-DD`
 *
 * `displayData` is what the UI should render. It prefers the fresh
 * fetch result (`data`) and falls back to the date-specific cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { POLL_INTERVALS } from '../constants/index.js';
import { captureUnlessAuth } from '../lib/sentry-helpers.js';
import { getCTTime } from '../utils/timezone.js';
import { getErrorMessage } from '../utils/error.js';
import { usePolling } from './usePolling.js';

// Runtime schemas are the single source of truth for the
// /api/opening-flow-signal response (api/_lib/opening-flow-evaluator.ts and
// the historical store in api/_lib/opening-flow-store.ts both return this
// shape). The fetch and the localStorage last-good cache are both checked
// against `openingFlowResponseSchema`, so the panel never renders a body
// that lacks `tickers` or its slices. The exported types derive from the
// schemas via `z.infer`.
const SIDES = ['call', 'put'] as const;

const WINDOW_STATUSES = [
  'before_open',
  'slice1',
  'slice2',
  'evaluating',
  'closed',
] as const;

const BLOCKED_REASONS = [
  'no_tickets',
  'top3_mixed',
  's2_below_60',
  'window_not_complete',
] as const;

const ticketSchema = z.object({
  strike: z.number(),
  side: z.enum(SIDES),
  premium: z.number(),
  volume: z.number(),
  avgFill: z.number(),
});

const slice1Schema = z.object({
  tickets: z.array(ticketSchema),
  callPremium: z.number(),
  putPremium: z.number(),
  biasSide: z.enum(SIDES).nullable(),
  biasRatio: z.number(),
  top3SameSide: z.boolean(),
});

const slice2Schema = z.object({
  totalPremium: z.number(),
  biasPremium: z.number(),
  biasShare: z.number().nullable(),
  confirms: z.boolean(),
});

const signalSchema = z.discriminatedUnion('fired', [
  z.object({
    fired: z.literal(true),
    side: z.enum(SIDES),
    contract: ticketSchema,
    entryPrice: z.number(),
  }),
  z.object({
    fired: z.literal(false),
    reason: z.enum(BLOCKED_REASONS),
  }),
]);

const tickerPayloadSchema = z.object({
  slice1: slice1Schema.nullable(),
  slice2: slice2Schema.nullable(),
  signal: signalSchema.nullable(),
});

const openingFlowResponseSchema = z.object({
  date: z.string(),
  windowStatus: z.enum(WINDOW_STATUSES),
  openUtc: z.string(),
  slice1EndUtc: z.string(),
  slice2EndUtc: z.string(),
  asOfUtc: z.string(),
  stopPct: z.number(),
  exitMinutesFromEntry: z.number(),
  tickers: z.record(z.string(), tickerPayloadSchema),
});

export type WindowStatus = (typeof WINDOW_STATUSES)[number];
export type OpeningFlowTicket = z.infer<typeof ticketSchema>;
export type OpeningFlowSlice1 = z.infer<typeof slice1Schema>;
export type OpeningFlowSlice2 = z.infer<typeof slice2Schema>;
export type OpeningFlowSignal = z.infer<typeof signalSchema>;
export type OpeningFlowTickerPayload = z.infer<typeof tickerPayloadSchema>;
export type OpeningFlowResponse = z.infer<typeof openingFlowResponseSchema>;

interface State {
  data: OpeningFlowResponse | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  data: null,
  loading: false,
  error: null,
  fetchedAt: null,
};

const STORAGE_KEY_LIVE = 'openingFlowSignal.lastGood';

/**
 * Per-date localStorage slot.
 *
 *   cacheKey()             → 'openingFlowSignal.lastGood'             (live)
 *   cacheKey('2026-05-13') → 'openingFlowSignal.lastGood:2026-05-13'  (historical)
 *
 * Each historical date writes to its own slot, so picking yesterday
 * leaves today's last-good payload untouched.
 */
function cacheKey(date?: string | null): string {
  if (date == null || date === '') return STORAGE_KEY_LIVE;
  return `${STORAGE_KEY_LIVE}:${date}`;
}

interface CachedEntry {
  data: OpeningFlowResponse;
  savedAt: string;
  date: string;
}

/**
 * A cached entry whose payload fails the schema (written by an older build,
 * or by an unvalidated malformed 200) is a miss, like an unparseable one.
 * The next good fetch overwrites the slot.
 */
function safeReadCache(date?: string | null): CachedEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey(date));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<
      Record<keyof CachedEntry, unknown>
    > | null;
    if (
      parsed == null ||
      typeof parsed.date !== 'string' ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    const data = openingFlowResponseSchema.safeParse(parsed.data);
    if (!data.success) return null;
    return { data: data.data, savedAt: parsed.savedAt, date: parsed.date };
  } catch {
    return null;
  }
}

function safeWriteCache(entry: CachedEntry, date?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(cacheKey(date), JSON.stringify(entry));
  } catch {
    // swallow: storage quota / private-mode / disabled
  }
}

/**
 * Read the cached payload on mount or whenever the `date` arg changes.
 *
 * Per-date keys: today's slot at `openingFlowSignal.lastGood` and
 * historical slots at `openingFlowSignal.lastGood:YYYY-MM-DD` are
 * fully independent. Picking yesterday does not evict today's cache.
 *
 * Last-good semantics (live slot only): the live cache survives across
 * CT-date rollovers and only gets overwritten when a fresh successful
 * fetch lands. Revisiting the panel at 12:30 AM CT Tuesday still shows
 * Monday's tickets until the next morning's slice-1 fetch arrives.
 */
function loadCache(date?: string | null): OpeningFlowResponse | null {
  const cached = safeReadCache(date);
  return cached?.data ?? null;
}

/**
 * Polling-window predicate. Returns true between 08:25 CT (5 min
 * before market open) and 08:50 CT (5 min after the evaluating
 * window closes) so the panel still shows the final result for a
 * few minutes after 8:45 CT.
 */
function inPollingWindow(now: Date): boolean {
  const { hour, minute } = getCTTime(now);
  const totalMinutes = hour * 60 + minute;
  const windowOpen = 8 * 60 + 25;
  const windowClose = 8 * 60 + 50;
  return totalMinutes >= windowOpen && totalMinutes < windowClose;
}

export function useOpeningFlowSignal(date?: string): State & {
  refresh: () => void;
  isWindowOpen: boolean;
  displayData: OpeningFlowResponse | null;
  isHistorical: boolean;
} {
  const effectiveDate: string | null =
    date != null && date !== '' ? date : null;

  const [state, setState] = useState<State>(INITIAL_STATE);
  const [cachedData, setCachedData] = useState<OpeningFlowResponse | null>(() =>
    loadCache(effectiveDate),
  );
  const [isWindowOpen, setIsWindowOpen] = useState<boolean>(() =>
    inPollingWindow(new Date()),
  );
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const url =
        effectiveDate != null
          ? `/api/opening-flow-signal?date=${encodeURIComponent(effectiveDate)}`
          : '/api/opening-flow-signal';
      const res = await fetch(url, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();

      if (ctrl.signal.aborted) return;
      const parsed = openingFlowResponseSchema.safeParse(body);
      if (!parsed.success) {
        // Backend contract drift: report the Zod issues with the requested
        // date, then handle it like a failed fetch. Last-good `data` and
        // the cache are left as they were; nothing malformed is stored.
        captureUnlessAuth(
          new Error('opening-flow-signal response failed schema validation'),
          {
            contexts: {
              openingFlowSignal: {
                date: effectiveDate,
                issues: parsed.error.issues,
              },
            },
          },
        );
        setState((prev) => ({
          ...prev,
          loading: false,
          error: 'invalid response shape',
        }));
        return;
      }
      const json = parsed.data;
      setState({
        data: json,
        loading: false,
        error: null,
        fetchedAt: Date.now(),
      });
      // Mirror the fresh payload into localStorage. Write to the slot
      // that matches the *response's* date — for live mode the
      // response.date is today's CT date (server-determined), for
      // historical mode it matches the requested date.
      const slotDate = effectiveDate == null ? null : json.date;
      safeWriteCache(
        {
          data: json,
          savedAt: new Date().toISOString(),
          date: json.date,
        },
        slotDate,
      );
      setCachedData(json);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
  }, [effectiveDate]);

  // Refresh cached payload when the date arg changes — historical
  // dates have their own LS slot and `cachedData` must reflect that
  // slot, not whatever the previous (live or historical) date had.
  useEffect(() => {
    setCachedData(loadCache(effectiveDate));
    // Reset the in-memory `data` so stale fetches from the previous
    // date don't bleed through as the new effective payload while the
    // fresh fetch is in flight.
    setState(INITIAL_STATE);
  }, [effectiveDate]);

  // Eager fetch on mount / date change. Live mode ALWAYS fetches once,
  // even outside the polling window — otherwise loading the page at 9 AM
  // (after the 08:50 CT window closes) would leave the panel empty until
  // tomorrow morning. The endpoint live-computes from ws_option_trades
  // for today's date, which still has this morning's prints inside its
  // 2-day retention. Historical mode (effectiveDate != null) is the same
  // shape — single fetch — but never polls below.
  useEffect(() => {
    if (effectiveDate == null) setIsWindowOpen(inPollingWindow(new Date()));
    void fetchOnce();
  }, [fetchOnce, effectiveDate]);

  // Live-mode polling. Tick every 30s to (a) re-check the window
  // predicate and (b) refetch when we're inside the window. Outside the
  // window we still tick to notice when it opens, but we skip the
  // recurring fetch — `usePolling` runs as long as we're in live mode,
  // and the callback gates the fetch on `inPollingWindow`.
  const tick = useCallback(() => {
    const open = inPollingWindow(new Date());
    setIsWindowOpen(open);
    if (open) void fetchOnce();
  }, [fetchOnce]);
  usePolling(tick, POLL_INTERVALS.OPENING_FLOW, [effectiveDate == null]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const displayData = state.data ?? cachedData;
  const isHistorical = effectiveDate != null;

  return useMemo(
    () => ({
      ...state,
      refresh: fetchOnce,
      isWindowOpen,
      displayData,
      isHistorical,
    }),
    [state, fetchOnce, isWindowOpen, displayData, isHistorical],
  );
}
