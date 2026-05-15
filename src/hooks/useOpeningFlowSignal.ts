/**
 * useOpeningFlowSignal — polls /api/opening-flow-signal during the
 * 09:25–09:50 CT signal window so the panel updates as slice-1 →
 * slice-2 → evaluation progresses.
 *
 * Outside the window, the hook returns the last known state (or null)
 * and stops polling.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { getCTTime } from '../utils/timezone.js';
import { getErrorMessage } from '../utils/error.js';

export type WindowStatus =
  | 'before_open'
  | 'slice1'
  | 'slice2'
  | 'evaluating'
  | 'closed';

export interface OpeningFlowTicket {
  strike: number;
  side: 'call' | 'put';
  premium: number;
  volume: number;
  avgFill: number;
}

export interface OpeningFlowSlice1 {
  tickets: OpeningFlowTicket[];
  callPremium: number;
  putPremium: number;
  biasSide: 'call' | 'put' | null;
  biasRatio: number;
  top3SameSide: boolean;
}

export interface OpeningFlowSlice2 {
  totalPremium: number;
  biasPremium: number;
  biasShare: number | null;
  confirms: boolean;
}

export type OpeningFlowSignal =
  | {
      fired: true;
      side: 'call' | 'put';
      contract: OpeningFlowTicket;
      entryPrice: number;
    }
  | {
      fired: false;
      reason:
        | 'no_tickets'
        | 'top3_mixed'
        | 's2_below_60'
        | 'window_not_complete';
    };

export interface OpeningFlowTickerPayload {
  slice1: OpeningFlowSlice1 | null;
  slice2: OpeningFlowSlice2 | null;
  signal: OpeningFlowSignal | null;
}

export interface OpeningFlowResponse {
  date: string;
  windowStatus: WindowStatus;
  openUtc: string;
  slice1EndUtc: string;
  slice2EndUtc: string;
  asOfUtc: string;
  stopPct: number;
  exitMinutesFromEntry: number;
  tickers: Record<string, OpeningFlowTickerPayload>;
}

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

export function useOpeningFlowSignal(): State & {
  refetch: () => void;
  isWindowOpen: boolean;
} {
  const [state, setState] = useState<State>(INITIAL_STATE);
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
      const res = await fetch('/api/opening-flow-signal', {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as OpeningFlowResponse;

      if (ctrl.signal.aborted) return;
      setState({
        data: json,
        loading: false,
        error: null,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
  }, []);

  // Tick every 30s to (a) re-check the window predicate and (b) refetch
  // when we're inside the window. Outside the window we still tick to
  // notice when it opens, but we skip the fetch.
  useEffect(() => {
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const open = inPollingWindow(new Date());
      setIsWindowOpen(open);
      if (open) void fetchOnce();
    };

    tick();
    const id = setInterval(tick, POLL_INTERVALS.OPENING_FLOW);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchOnce]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(
    () => ({ ...state, refetch: fetchOnce, isWindowOpen }),
    [state, fetchOnce, isWindowOpen],
  );
}
