/**
 * useRegime0dte — polls /api/regime-0dte during the 08:30–15:00 CT regular
 * session so the "0DTE Gamma Regime" panel updates as the gamma gate sets,
 * the IV surface breaks, and the down-only triggers latch through the day.
 *
 * Thin wrapper over `usePolledWindowSignal` — that primitive owns the polling,
 * window-gating, abort-per-fetch, and last-good cache machinery. This file
 * supplies only the regime-specific config: the endpoint URL, the cache slot,
 * the 45s cadence, the 08:30–15:00 CT window predicate, and the CT "today"
 * staleness key. The exported `Regime0dteResponse` type and the window bounds
 * stay local.
 *
 * Outside the session window the hook does not fetch — it returns the last
 * known state (from localStorage, but only when that cache is dated *today* in
 * CT) and reports `isWindowOpen=false` so the panel can show a "waiting for
 * open" placeholder. A prior-session-day cache is never surfaced as live.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import { getCTTime, getCTDateStr } from '../utils/timezone.js';
import {
  usePolledWindowSignal,
  type PolledWindowSignalResult,
} from './usePolledWindowSignal.js';

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
 * Polling-window predicate. True during the 08:30–15:00 CT regular session
 * (the window over which the gamma gate, IV-break, and candle triggers are
 * meaningful). Outside this window the hook stops fetching.
 */
function inPollingWindow(now: Date): boolean {
  const { hour, minute } = getCTTime(now);
  const totalMinutes = hour * 60 + minute;
  const windowOpen = 8 * 60 + 30; // 08:30 CT
  const windowClose = 15 * 60; // 15:00 CT
  return totalMinutes >= windowOpen && totalMinutes < windowClose;
}

export function useRegime0dte(): PolledWindowSignalResult<Regime0dteResponse> {
  return usePolledWindowSignal<Regime0dteResponse>({
    url: '/api/regime-0dte',
    storageKey: STORAGE_KEY,
    pollMs: POLL_INTERVALS.REGIME_0DTE,
    inWindow: inPollingWindow,
    todayStr: () => getCTDateStr(new Date()),
  });
}
