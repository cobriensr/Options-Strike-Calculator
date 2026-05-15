/**
 * GET /api/opening-flow-signal
 *
 * Live evaluation of the V4 opening-flow rule for SPY and QQQ.
 * Reads `ws_option_trades` (streamed in real-time by the
 * uw-stream Railway service) for the 09:30–09:40 ET window and
 * returns:
 *   - the slice-1 ticket breakdown ($1M+ premium aggregates)
 *   - the slice-2 bias-side share
 *   - whether the V4 signal fires
 *   - the contract to trade (highest-volume bias-side ticket)
 *
 * The endpoint is window-aware: before 09:30 ET it returns
 * `windowStatus='before_open'` and an empty per-ticker payload;
 * during slice 1 it reports partial slice-1 results; after 09:40 ET
 * it returns the locked-in signal decision.
 *
 * Auth: owner-or-guest, same gating as lottery-contract-tape.
 *
 * Spec: docs/superpowers/specs/opening-flow-signal-2026-05-14.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { openingFlowSignalQuerySchema } from './_lib/validation.js';
import { getETDateStr, etWallClockToUtcIso } from '../src/utils/timezone.js';
import {
  evaluateRule,
  OPENING_FLOW_CONSTANTS,
  type RawTrade,
  type SignalResult,
  type Slice1Result,
  type Slice2Result,
} from './_lib/opening-flow.js';

const TICKERS = ['SPY', 'QQQ'] as const;

type WindowStatus =
  | 'before_open'
  | 'slice1'
  | 'slice2'
  | 'evaluating'
  | 'closed';

interface DbTradeRow {
  executed_at: string | Date;
  strike: string | number;
  option_type: string;
  price: string | number;
  size: number | string;
}

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

interface PerTickerPayload {
  slice1: Slice1Result | null;
  slice2: Slice2Result | null;
  signal: SignalResult | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = openingFlowSignalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const requestedDate = parsed.data.date;
    const now = new Date();
    const targetDate = requestedDate ?? getETDateStr(now);

    // 09:30 ET = market open. Slice 1 = 09:30–09:35. Slice 2 = 09:35–09:40.
    // Use the DST-safe ET wall-clock converter.
    const openIso = etWallClockToUtcIso(targetDate, 9 * 60 + 30);
    const slice1EndIso = etWallClockToUtcIso(targetDate, 9 * 60 + 35);
    const slice2EndIso = etWallClockToUtcIso(targetDate, 9 * 60 + 40);
    if (openIso === null || slice1EndIso === null || slice2EndIso === null) {
      res.status(400).json({ error: `invalid trading date: ${targetDate}` });
      return;
    }
    const openMs = Date.parse(openIso);

    // For historical date replays, treat "now" as past the close so the
    // full signal evaluates. For today, use real wall-clock time.
    const effectiveNowMs =
      requestedDate && requestedDate !== getETDateStr(now)
        ? openMs + 60 * 60_000 // pretend an hour past open
        : now.getTime();
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
        // NOTE: backtest also filters `extended_hours` and
        // `contingent_trade` report_flags (see bulk_v4_exits.py). Those
        // flags aren't broken out as columns in ws_option_trades — they
        // live inside raw_payload JSONB. Inside the 09:30–09:40 ET RTH
        // window both flags are structurally rare, so we accept the
        // mismatch for now. If live signal diverges from walk-forward
        // expectations, add a `raw_payload->>'report_flags'` filter here.
        const slice1Rows = (await db`
          SELECT executed_at, strike, option_type, price, size
          FROM ws_option_trades
          WHERE ticker = ${ticker}
            AND canceled = FALSE
            AND expiry = ${targetDate}::date
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
              AND expiry = ${targetDate}::date
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

    // 15s CDN cache. Live data is fast-moving but the endpoint is
    // hot during the polling window — brief reuse keeps cost down.
    setCacheHeaders(res, 15, 15);
    res.status(200).json({
      date: targetDate,
      windowStatus,
      openUtc: openIso,
      slice1EndUtc: slice1EndIso,
      slice2EndUtc: slice2EndIso,
      asOfUtc: new Date(effectiveNowMs).toISOString(),
      stopPct: OPENING_FLOW_CONSTANTS.STOP_LOSS_PCT,
      exitMinutesFromEntry: OPENING_FLOW_CONSTANTS.EXIT_MINUTES_FROM_ENTRY,
      tickers: tickersOut,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'opening-flow-signal error');
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
