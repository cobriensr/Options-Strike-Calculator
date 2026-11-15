/**
 * GET /api/ticker-net-flow-current
 *
 * Owner-or-guest batch read returning the latest cumulative
 * `(cum_ncp, cum_npp)` for each requested ticker on the requested
 * trading day. Backs the Flow Match / Flow Mismatch / Flow Inverted
 * badges on Lottery + SilentBoom rows so the section can render
 * directional context for every visible alert without a per-row chart
 * fetch.
 *
 * Query params: ?tickers=A,B,C&date=YYYY-MM-DD
 * Validated by `tickerNetFlowCurrentQuerySchema`.
 *
 * Sources: per ticker, `ws_net_flow_per_ticker` (live WS daemon) when the
 * ticker has any WS row in the session, else `net_flow_per_ticker_history`
 * (REST backfill). Never both: after the close the two hold the same flow at
 * different resolutions and a union counts it twice. See
 * api/_lib/ticker-flow-snapshot.ts and
 * docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md. The
 * window function then partitions by ticker and we take the last (max ts) row
 * per ticker.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { tickerNetFlowCurrentQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';
import { ctSessionBounds } from '../src/components/LotteryFinder/ct-window.js';

type DbNumeric = string | number;
type DbTimestamp = string | Date;

interface CurrentRow {
  ticker: string;
  ts: DbTimestamp;
  cum_ncp: DbNumeric;
  cum_npp: DbNumeric;
}

const toIso = (v: DbTimestamp): string =>
  typeof v === 'string' ? v : v.toISOString();

const num = (v: DbNumeric): number => Number(v);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = tickerNetFlowCurrentQuerySchema.safeParse(req.query);
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
    const { tickers, date } = parsed.data;
    const targetDate = date ?? getETDateStr(new Date());
    const session = ctSessionBounds(targetDate);

    const db = getDb();
    const readAt = new Date().toISOString();
    // Three stages: (1) one source per ticker-day, (2) compute running
    // cumulative per ticker, (3) take the latest row per ticker.
    //
    // (1) The WS table holds one row per tick (ts with milliseconds) and the
    // history table one row per minute; after the close they hold the same
    // flow, and DISTINCT ON (ticker, ts) never merges a millisecond stamp with
    // a minute stamp, so the old UNION ALL gave any past day about twice its
    // flow (2026-11-15). So each ticker reads WS rows when its session has
    // any (`has_ws`), else history. A history row is a whole minute and is
    // read only once the minute is complete (`ts + 60 s <= now`). History
    // keeps one row per minute across `source`.
    //
    // withDbRetry covers transient Neon HTTP failures (fetch failed,
    // ECONNRESET, socket hang up) — at 60s client polling cadence one
    // unretried blip surfaces as a fan-out of SENTRY-EMERALD-DESERT-90
    // events. 10s per-attempt timeout shields against hung connections.
    const rows = (await withDbRetry(
      () => db`
      WITH has_ws AS (
        SELECT requested.ticker
        FROM unnest(${tickers}::text[]) AS requested(ticker)
        WHERE EXISTS (
          SELECT 1
          FROM ws_net_flow_per_ticker w
          WHERE w.ticker = requested.ticker
            AND w.ts >= ${session.min}::timestamptz
            AND w.ts <= ${session.max}::timestamptz
        )
      ),
      unified AS (
        SELECT ticker, ts, net_call_prem, net_put_prem
        FROM ws_net_flow_per_ticker
        WHERE ticker = ANY(${tickers}::text[])
          AND ts >= ${session.min}::timestamptz
          AND ts <= ${session.max}::timestamptz
        UNION ALL
        SELECT ticker, ts, net_call_prem, net_put_prem
        FROM (
          SELECT DISTINCT ON (h.ticker, h.ts)
            h.ticker, h.ts, h.net_call_prem, h.net_put_prem
          FROM net_flow_per_ticker_history h
          WHERE h.ticker = ANY(${tickers}::text[])
            AND h.ts >= ${session.min}::timestamptz
            AND h.ts <= ${session.max}::timestamptz
            AND h.ts + INTERVAL '60 seconds' <= ${readAt}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM has_ws s WHERE s.ticker = h.ticker)
          ORDER BY h.ticker, h.ts, h.source
        ) minutes
      ),
      running AS (
        SELECT
          ticker, ts,
          SUM(net_call_prem) OVER (PARTITION BY ticker ORDER BY ts) AS cum_ncp,
          SUM(net_put_prem) OVER (PARTITION BY ticker ORDER BY ts) AS cum_npp
        FROM unified
      )
      SELECT DISTINCT ON (ticker)
        ticker, ts, cum_ncp, cum_npp
      FROM running
      ORDER BY ticker, ts DESC
    `,
      2,
      10000,
    )) as CurrentRow[];

    const snapshots = rows.map((r) => ({
      ticker: r.ticker,
      asOfTs: toIso(r.ts),
      cumNcp: num(r.cum_ncp),
      cumNpp: num(r.cum_npp),
    }));

    // 30s cache — matches /api/net-flow-history. Polling cadence on
    // the client is 60s so a 30s shared cache halves origin load
    // without ever showing stale-by->=60s data.
    setCacheHeaders(res, 30, 30);
    res.status(200).json({
      date: targetDate,
      requestedTickers: tickers,
      count: snapshots.length,
      snapshots,
    });
  } catch (err) {
    sendDbErrorResponse(res, err, {
      label: 'ticker_net_flow_current',
      serverErrorBody: { error: 'Internal error' },
    });
  }
}
