/**
 * Opening Flow Signal — historical snapshot store.
 *
 * Reads previously captured per-(date, ticker) rows from the
 * `opening_flow_signals` table (migration #173) and reconstructs an
 * `OpeningFlowEvaluationResult` byte-compatible with what
 * `evaluateOpeningFlow()` produces. This is the durable-history path
 * for the OFS endpoint: the cron writes after the 09:30–09:40 ET
 * window closes (see `cron/capture-opening-flow-signal.ts`), and the
 * endpoint reads from here for any historical date so the panel keeps
 * working past the `ws_option_trades` 2-day retention horizon.
 *
 * Phase 4 of docs/superpowers/specs/opening-flow-signal-historical-persistence-2026-05-19.md
 */
import { getDb, withDbRetry } from './db.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';
import {
  InvalidTradingDateError,
  type OpeningFlowEvaluationResult,
  type PerTickerPayload,
  type WindowStatus,
} from './opening-flow-evaluator.js';
import type {
  Slice1Result,
  Slice2Result,
  SignalResult,
} from './opening-flow.js';

/**
 * Raw shape of one row coming back from Neon. Neon's HTTP driver
 * returns:
 *   - DATE columns as JS `Date` objects
 *   - TIMESTAMPTZ columns as ISO strings
 *   - NUMERIC columns as strings (precision is preserved by passing
 *     them through as text)
 *   - JSONB columns as already-parsed JS objects
 */
interface OpeningFlowSignalRow {
  date: string | Date;
  ticker: string;
  window_status: string;
  slice1: Slice1Result | null;
  slice2: Slice2Result | null;
  signal: SignalResult | null;
  as_of_utc: string | Date;
  stop_pct: string | number;
  exit_minutes_from_entry: number | string;
}

function toIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function toNumber(v: string | number): number {
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Read all stored snapshots for a single trading date and reassemble
 * them into the endpoint's response shape. Returns `null` when no row
 * exists — the endpoint then falls back to live compute (which may
 * itself return empty if the raw trades have aged out, a documented
 * limit).
 *
 * Both SPY and QQQ rows for a given date share `window_status`,
 * `as_of_utc`, `stop_pct`, and `exit_minutes_from_entry` because the
 * cron writes them in a single evaluator pass. We pick those scalars
 * from the first row and assert the per-ticker payloads from the
 * remaining columns.
 */
export async function readOpeningFlowSnapshot(
  date: string,
): Promise<OpeningFlowEvaluationResult | null> {
  // Reconstruct the wall-clock anchors from the requested date. The
  // cron persists window_status / as_of_utc but NOT openUtc /
  // slice1EndUtc / slice2EndUtc — the latter are deterministic from
  // the trading date alone (09:30 / 09:35 / 09:40 ET, DST-safe).
  // Validate BEFORE touching the DB so a malformed date (e.g.
  // month 13) short-circuits to the same `InvalidTradingDateError`
  // path the evaluator uses, keeping the endpoint's 400 mapping
  // intact regardless of which branch handles the request.
  const openIso = etWallClockToUtcIso(date, 9 * 60 + 30);
  const slice1EndIso = etWallClockToUtcIso(date, 9 * 60 + 35);
  const slice2EndIso = etWallClockToUtcIso(date, 9 * 60 + 40);
  if (openIso === null || slice1EndIso === null || slice2EndIso === null) {
    throw new InvalidTradingDateError(date);
  }

  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT
        date,
        ticker,
        window_status,
        slice1,
        slice2,
        signal,
        as_of_utc,
        stop_pct,
        exit_minutes_from_entry
      FROM opening_flow_signals
      WHERE date = ${date}::date
    `,
    2,
    10000,
  )) as OpeningFlowSignalRow[];

  if (rows.length === 0) return null;

  const first = rows[0]!;
  const tickers: Record<string, PerTickerPayload> = {};
  for (const r of rows) {
    tickers[r.ticker] = {
      slice1: r.slice1,
      slice2: r.slice2,
      signal: r.signal,
    };
  }

  return {
    date,
    windowStatus: first.window_status as WindowStatus,
    openUtc: openIso,
    slice1EndUtc: slice1EndIso,
    slice2EndUtc: slice2EndIso,
    asOfUtc: toIso(first.as_of_utc),
    stopPct: toNumber(first.stop_pct),
    exitMinutesFromEntry: toNumber(first.exit_minutes_from_entry),
    tickers,
  };
}
