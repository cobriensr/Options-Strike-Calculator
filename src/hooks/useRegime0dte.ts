/**
 * useRegime0dte — polls /api/regime-0dte during the regular session so the
 * "0DTE Gamma Regime" panel updates as the gamma gate sets, the IV surface
 * breaks, and the down-only triggers latch through the day. The session is
 * 08:30 CT to the close (15:00 CT, or 12:00 CT on a half-day), on trading days
 * only: no polling on weekends or NYSE holidays.
 *
 * Thin wrapper over `usePolledWindowSignal` — that primitive owns the polling,
 * window-gating, abort-per-fetch, and last-good cache machinery. This file
 * supplies only the regime-specific config: the endpoint URL, the cache slot,
 * the 45s cadence, the market-calendar window predicate, and the "today"
 * staleness key, the shared ET clock. The exported `Regime0dteResponse` type
 * and the window bounds stay local.
 *
 * Outside the session window the hook does not fetch — it returns the last
 * known state (the day's last payload or its localStorage copy, but only when
 * dated *today*) and reports `isWindowOpen=false` so the panel can show a
 * "waiting for open" placeholder. A prior-session-day payload, fetched or
 * cached, is never surfaced as live; it clears at ET midnight, and the first
 * fetch of a session day is made when the window opens.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import { isTradingDay, getMarketCloseHourET } from '../data/marketHours.js';
import { getAccessMode } from '../utils/auth.js';
import { getCTTime, getCTDateStr } from '../utils/timezone.js';
import {
  usePolledWindowSignal,
  type PolledWindowSignalResult,
} from './usePolledWindowSignal.js';
import { useETToday } from './useETToday.js';

export type Gate = 'calm' | 'big_move' | 'lean_down' | 'unknown';

export interface TriggerState {
  fired: boolean;
  atCtMin: number | null;
}

export interface Regime0dteTriggers {
  mostlyRed: TriggerState & { green: number; red: number };
  ivBreak: TriggerState & { magPct: number | null; refHi: number | null };
  middayDeepNeg: TriggerState & { gexMid: number | null };
}

/**
 * The GET /api/regime-0dte response shape. Mirrors `Regime0dteState` from
 * `api/_lib/regime-0dte.ts` (the endpoint spreads `{ date, ...state }`).
 * Defined locally — `src/` does not import api types directly, matching the
 * repo's frontend/backend boundary convention.
 */
export interface Regime0dteResponse {
  date: string;
  asOfCtMin: number;
  gate: Gate;
  gexNearSpot: number | null;
  gexAtOpen: number | null;
  flipStrike: number | null;
  flipMinusOpenPct: number | null;
  triggers: Regime0dteTriggers;
  note: string;
  /**
   * Raw series for the rich panel visuals. Optional so a stale last-good
   * cache written before Phase 3B (graded scalars only) still type-checks.
   */
  gexStrikes?: { strike: number; netGex: number }[];
  spot?: number | null;
  putIv?: { ctMin: number; iv: number }[];
  candles30?: { ctMin: number; open: number; close: number }[];
  bandPct?: number;
  persistEndCtMin?: number;
}

const STORAGE_KEY = 'regime0dte:lastgood';

/**
 * Polling-window predicate. True only on a trading day (not a weekend or NYSE
 * holiday), from 08:30 CT up to the day's close: 15:00 CT normally, 12:00 CT on
 * a half-day. This is the window over which the gamma gate, IV-break, and
 * candle triggers are meaningful. Outside it the hook stops fetching.
 *
 * `getMarketCloseHourET` is an ET hour; ET is always one hour ahead of CT, so
 * the close in CT minutes is `(closeHourET - 1) * 60`. A null close (a listed
 * holiday) is closed; a weekend has a normal close hour, so `isTradingDay` is
 * what rules it out.
 */
function inPollingWindow(now: Date): boolean {
  const ctDate = getCTDateStr(now);
  const closeHourET = getMarketCloseHourET(ctDate);
  if (closeHourET === null || !isTradingDay(ctDate)) return false;
  const { hour, minute } = getCTTime(now);
  const totalMinutes = hour * 60 + minute;
  const windowOpen = 8 * 60 + 30; // 08:30 CT
  const windowClose = (closeHourET - 1) * 60;
  return totalMinutes >= windowOpen && totalMinutes < windowClose;
}

/**
 * /api/regime-0dte is owner-or-guest, so the window is closed for a public
 * visitor: no mount fetch, no poll, no 401 for the panel to show as an alert.
 * The primitive routes all three through this predicate.
 */
function inLiveWindow(now: Date): boolean {
  return getAccessMode() !== 'public' && inPollingWindow(now);
}

export function useRegime0dte(): PolledWindowSignalResult<Regime0dteResponse> {
  // The staleness key is the shared ET clock (`useETToday`), read in render, so
  // the panel re-renders at ET midnight and a payload dated the day before is
  // dropped then, badge included. The payload's `date` is the CT date
  // (`api/regime-0dte.ts`). The two dates agree from 08:30 to 15:00 CT, the
  // only hours the hook fetches, and differ only from 23:00 to 24:00 CT, when
  // the window is closed: the day's last read clears an hour before CT midnight.
  const today = useETToday();
  return usePolledWindowSignal<Regime0dteResponse>({
    url: '/api/regime-0dte',
    storageKey: STORAGE_KEY,
    pollMs: POLL_INTERVALS.REGIME_0DTE,
    inWindow: inLiveWindow,
    todayStr: () => today,
  });
}
