/**
 * useRegime0dte — polls /api/regime-0dte during the 08:30–15:00 CT regular
 * session so the "0DTE Gamma Regime" panel updates as the gamma gate sets,
 * the IV surface breaks, and the down-only triggers latch through the day.
 *
 * Thin wrapper over `usePolledWindowSignal` — that primitive owns the polling,
 * window-gating, abort-per-fetch, and last-good cache machinery. This file
 * supplies only the regime-specific config: the endpoint URL, the cache slot,
 * the 45s cadence, the 08:30–15:00 CT window predicate, the CT "today"
 * staleness key, and the payload shape validator (run by the primitive on
 * both the fetch parse and the cache read — see "Validation" below). The
 * exported `Regime0dteResponse` type and the window bounds stay local.
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

// ── Validation ─────────────────────────────────────────────
//
// Shape validation for the GET /api/regime-0dte envelope
// (client-shape-hardening-2026-08-20, final straggler). Mirrors what the
// handler actually emits: `{ date, ...Regime0dteState }` plus the optional
// viz series (`gexStrikes` / `spot` / `putIv` / `candles30` / `bandPct` /
// `persistEndCtMin`). The graded scalars + triggers are REQUIRED — a miss
// there is a shapeless envelope and returns `null` (the primitive surfaces
// its error state). The viz series are optional: malformed rows are dropped,
// and a present-but-malformed field degrades to the same absent/null shape
// the panel already renders as a placeholder — never fatal.

const GATES: readonly Gate[] = ['calm', 'big_move', 'lean_down', 'unknown'];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}

function isGate(v: unknown): v is Gate {
  return (GATES as readonly unknown[]).includes(v);
}

function validateMostlyRed(
  raw: unknown,
): Regime0dteTriggers['mostlyRed'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.fired !== 'boolean' ||
    !isNullableFiniteNumber(r.atCtMin) ||
    !isFiniteNumber(r.green) ||
    !isFiniteNumber(r.red)
  ) {
    return null;
  }
  return { fired: r.fired, atCtMin: r.atCtMin, green: r.green, red: r.red };
}

function validateIvBreak(raw: unknown): Regime0dteTriggers['ivBreak'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.fired !== 'boolean' ||
    !isNullableFiniteNumber(r.atCtMin) ||
    !isNullableFiniteNumber(r.magPct) ||
    !isNullableFiniteNumber(r.refHi)
  ) {
    return null;
  }
  return {
    fired: r.fired,
    atCtMin: r.atCtMin,
    magPct: r.magPct,
    refHi: r.refHi,
  };
}

function validateMiddayDeepNeg(
  raw: unknown,
): Regime0dteTriggers['middayDeepNeg'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.fired !== 'boolean' ||
    !isNullableFiniteNumber(r.atCtMin) ||
    !isNullableFiniteNumber(r.gexMid)
  ) {
    return null;
  }
  return { fired: r.fired, atCtMin: r.atCtMin, gexMid: r.gexMid };
}

/**
 * The triggers block is required and strict: `Regime0dteTriggers` has no
 * nullable slots, and fabricating a `{ fired: false }` default for a
 * malformed trigger would present "no data" as a genuine not-fired read —
 * dangerous for down-side confirmation lights. Malformed → whole envelope
 * rejected.
 */
function validateTriggers(raw: unknown): Regime0dteTriggers | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const mostlyRed = validateMostlyRed(r.mostlyRed);
  const ivBreak = validateIvBreak(r.ivBreak);
  const middayDeepNeg = validateMiddayDeepNeg(r.middayDeepNeg);
  if (mostlyRed == null || ivBreak == null || middayDeepNeg == null) {
    return null;
  }
  return { mostlyRed, ivBreak, middayDeepNeg };
}

function validateGexStrike(
  raw: unknown,
): { strike: number; netGex: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.strike) || !isFiniteNumber(r.netGex)) return null;
  return { strike: r.strike, netGex: r.netGex };
}

function validateIvPoint(raw: unknown): { ctMin: number; iv: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.ctMin) || !isFiniteNumber(r.iv)) return null;
  return { ctMin: r.ctMin, iv: r.iv };
}

function validateCandle30(
  raw: unknown,
): { ctMin: number; open: number; close: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.ctMin) ||
    !isFiniteNumber(r.open) ||
    !isFiniteNumber(r.close)
  ) {
    return null;
  }
  return { ctMin: r.ctMin, open: r.open, close: r.close };
}

/**
 * Row-drop validator for the optional viz series: a non-array degrades to
 * `undefined` (the field's absent shape — the panel falls back to its empty
 * placeholder), and malformed rows inside an array are dropped, never fatal.
 */
function validateRows<R>(
  raw: unknown,
  validateRow: (item: unknown) => R | null,
): R[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: R[] = [];
  for (const item of raw) {
    const row = validateRow(item);
    if (row != null) rows.push(row);
  }
  return rows;
}

/**
 * Validate the full envelope against what GET /api/regime-0dte actually
 * emits. Returns the typed response on success, or `null` on any
 * envelope-level shape mismatch (`usePolledWindowSignal` surfaces its
 * normal error state). Runs on the fetch parse AND the localStorage
 * last-good read.
 */
function validateRegime0dteResponse(raw: unknown): Regime0dteResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const triggers = validateTriggers(r.triggers);
  if (
    typeof r.date !== 'string' ||
    !isFiniteNumber(r.asOfCtMin) ||
    !isGate(r.gate) ||
    !isNullableFiniteNumber(r.gexNearSpot) ||
    !isNullableFiniteNumber(r.gexAtOpen) ||
    !isNullableFiniteNumber(r.flipStrike) ||
    !isNullableFiniteNumber(r.flipMinusOpenPct) ||
    triggers == null ||
    typeof r.note !== 'string'
  ) {
    return null;
  }
  return {
    date: r.date,
    asOfCtMin: r.asOfCtMin,
    gate: r.gate,
    gexNearSpot: r.gexNearSpot,
    gexAtOpen: r.gexAtOpen,
    flipStrike: r.flipStrike,
    flipMinusOpenPct: r.flipMinusOpenPct,
    triggers,
    note: r.note,
    // Optional viz series — row-level drop for lists; a present-but-
    // malformed scalar degrades to the absent/null shape the panel
    // already handles (`??` fallbacks), never fatal.
    gexStrikes: validateRows(r.gexStrikes, validateGexStrike),
    spot: isNullableFiniteNumber(r.spot) ? r.spot : null,
    putIv: validateRows(r.putIv, validateIvPoint),
    candles30: validateRows(r.candles30, validateCandle30),
    bandPct: isFiniteNumber(r.bandPct) ? r.bandPct : undefined,
    persistEndCtMin: isFiniteNumber(r.persistEndCtMin)
      ? r.persistEndCtMin
      : undefined,
  };
}

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
    validate: validateRegime0dteResponse,
  });
}
