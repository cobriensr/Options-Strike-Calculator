/**
 * V4 Opening Flow Signal evaluator — shared by:
 *   - GET /api/opening-flow-signal (live + historical reads)
 *   - cron/capture-opening-flow-signal (post-window snapshot writer)
 *
 * One canonical function so historical reads and live reads produce
 * byte-identical payloads. The endpoint and the cron both call
 * `evaluateOpeningFlow(date, { now? })` and get the same shape back.
 *
 * Source: extracted from api/opening-flow-signal.ts handler body
 * during Phase 2 of opening-flow-signal-historical-persistence-2026-05-19.
 *
 * The evaluator does its own ET wall-clock conversion and SQL queries.
 * On invalid date input it throws `InvalidTradingDateError` so the
 * endpoint can map it to a 400 and the cron can capture the failure
 * in Sentry without crashing the rest of the daily run.
 */

import { getDb } from './db.js';
import {
  evaluateRule,
  OPENING_FLOW_CONSTANTS,
  type RawTrade,
  type SignalResult,
  type Slice1Result,
  type Slice2Result,
} from './opening-flow.js';
import { getETDateStr, etWallClockToUtcIso } from '../../src/utils/timezone.js';

// ── Public types ──────────────────────────────────────────────────────────

export type WindowStatus =
  | 'before_open'
  | 'slice1'
  | 'slice2'
  | 'evaluating'
  | 'closed';

export interface PerTickerPayload {
  slice1: Slice1Result | null;
  slice2: Slice2Result | null;
  signal: SignalResult | null;
}

export interface OpeningFlowEvaluationResult {
  date: string;
  windowStatus: WindowStatus;
  openUtc: string;
  slice1EndUtc: string;
  slice2EndUtc: string;
  asOfUtc: string;
  stopPct: number;
  exitMinutesFromEntry: number;
  tickers: Record<string, PerTickerPayload>;
}

export interface EvaluateOpeningFlowOptions {
  /**
   * Override "now" — used by historical replays AND tests so the
   * evaluator's effective wall-clock can be deterministic. Defaults
   * to `new Date()`.
   *
   * For historical dates (where requested date differs from today CT)
   * the evaluator forces effectiveNow to be 1h past open so the full
   * signal evaluates regardless of when the caller invoked it.
   */
  now?: Date;
}

/**
 * Thrown when the requested date fails the ET wall-clock conversion
 * (malformed string, unsupported calendar). Callers should map this
 * to a 400.
 */
export class InvalidTradingDateError extends Error {
  constructor(date: string) {
    super(`invalid trading date: ${date}`);
    this.name = 'InvalidTradingDateError';
  }
}

// ── Tickers we evaluate. Keep narrow — V4 is SPY+QQQ only. ────────────────

const TICKERS = ['SPY', 'QQQ'] as const;

// ── Internal SQL row shape ───────────────────────────────────────────────

interface DbTradeRow {
  executed_at: string | Date;
  strike: string | number;
  option_type: string;
  price: string | number;
  size: number | string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function num(v: string | number): number {
  return typeof v === 'string' ? Number(v) : v;
}

function mapRowsToTrades(rows: readonly DbTradeRow[]): RawTrade[] {
  return rows.map((r) => ({
    executedAt: r.executed_at,
    strike: num(r.strike),
    optionTypeChar: r.option_type === 'C' ? 'C' : 'P',
    price: num(r.price),
    size: Number(r.size),
  }));
}

function deriveWindowStatus(nowMs: number, openMs: number): WindowStatus {
  const slice1EndMs = openMs + 5 * 60_000;
  const slice2EndMs = openMs + 10 * 60_000;
  const closeMs = openMs + 15 * 60_000;
  if (nowMs < openMs) return 'before_open';
  if (nowMs < slice1EndMs) return 'slice1';
  if (nowMs < slice2EndMs) return 'slice2';
  if (nowMs < closeMs) return 'evaluating';
  return 'closed';
}

// ── Main entry point ──────────────────────────────────────────────────────

export async function evaluateOpeningFlow(
  date: string,
  opts: EvaluateOpeningFlowOptions = {},
): Promise<OpeningFlowEvaluationResult> {
  const now = opts.now ?? new Date();

  // 09:30 ET = market open. Slice 1 = 09:30–09:35. Slice 2 = 09:35–09:40.
  // Use the DST-safe ET wall-clock converter.
  const openIso = etWallClockToUtcIso(date, 9 * 60 + 30);
  const slice1EndIso = etWallClockToUtcIso(date, 9 * 60 + 35);
  const slice2EndIso = etWallClockToUtcIso(date, 9 * 60 + 40);
  if (openIso === null || slice1EndIso === null || slice2EndIso === null) {
    throw new InvalidTradingDateError(date);
  }
  const openMs = Date.parse(openIso);

  // For historical date replays, pretend the effective wall-clock is
  // 1h past open so the full signal always evaluates. For today, use
  // real wall-clock so we report partial slice progress mid-window.
  const isHistorical = date !== getETDateStr(now);
  const effectiveNowMs = isHistorical ? openMs + 60 * 60_000 : now.getTime();
  const windowStatus = deriveWindowStatus(effectiveNowMs, openMs);

  const tickersOut: Record<string, PerTickerPayload> = {};

  if (windowStatus === 'before_open') {
    for (const t of TICKERS) {
      tickersOut[t] = { slice1: null, slice2: null, signal: null };
    }
  } else {
    const db = getDb();
    const slice2Complete =
      windowStatus === 'evaluating' || windowStatus === 'closed';

    for (const ticker of TICKERS) {
      // Slice 1 trades — 09:30:00 to 09:35:00 ET (or up to now if mid-slice).
      const slice1Upper =
        windowStatus === 'slice1'
          ? new Date(effectiveNowMs).toISOString()
          : slice1EndIso;
      // NOTE: backtest also filters `extended_hours` and `contingent_trade`
      // report_flags. Those flags aren't broken out as columns in
      // ws_option_trades — they live inside raw_payload JSONB. Inside the
      // 09:30–09:40 ET RTH window both flags are structurally rare, so we
      // accept the mismatch for now. If live signal diverges from
      // walk-forward expectations, add a `raw_payload->>'report_flags'`
      // filter here.
      const slice1Rows = (await db`
        SELECT executed_at, strike, option_type, price, size
        FROM ws_option_trades
        WHERE ticker = ${ticker}
          AND canceled = FALSE
          AND expiry = ${date}::date
          AND executed_at >= ${openIso}::timestamptz
          AND executed_at < ${slice1Upper}::timestamptz
      `) as DbTradeRow[];

      // Slice 2 trades — 09:35:00 to 09:40:00 ET (or up to now if mid-slice).
      let slice2Rows: DbTradeRow[] = [];
      if (windowStatus !== 'slice1') {
        const slice2Upper =
          windowStatus === 'slice2'
            ? new Date(effectiveNowMs).toISOString()
            : slice2EndIso;
        slice2Rows = (await db`
          SELECT executed_at, strike, option_type, price, size
          FROM ws_option_trades
          WHERE ticker = ${ticker}
            AND canceled = FALSE
            AND expiry = ${date}::date
            AND executed_at >= ${slice1EndIso}::timestamptz
            AND executed_at < ${slice2Upper}::timestamptz
        `) as DbTradeRow[];
      }

      const evaluation = evaluateRule({
        slice1Trades: mapRowsToTrades(slice1Rows),
        slice2Trades: mapRowsToTrades(slice2Rows),
        slice2Complete,
      });

      tickersOut[ticker] = {
        slice1: evaluation.slice1,
        slice2: evaluation.slice2,
        signal: evaluation.signal,
      };
    }
  }

  return {
    date,
    windowStatus,
    openUtc: openIso,
    slice1EndUtc: slice1EndIso,
    slice2EndUtc: slice2EndIso,
    asOfUtc: new Date(effectiveNowMs).toISOString(),
    stopPct: OPENING_FLOW_CONSTANTS.STOP_LOSS_PCT,
    exitMinutesFromEntry: OPENING_FLOW_CONSTANTS.EXIT_MINUTES_FROM_ENTRY,
    tickers: tickersOut,
  };
}
