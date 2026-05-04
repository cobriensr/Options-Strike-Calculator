/**
 * GET /api/net-flow-history
 *
 * Owner-or-guest read endpoint backing the per-fire Net Flow panel
 * inside LotteryFinderRow. Returns the ticker's per-tick deltas
 * (NCP / NCV / NPP / NPV) for the requested trading day plus the
 * cumulative series computed at read time via
 * `SUM(...) OVER (PARTITION BY ticker, date ORDER BY ts)`.
 *
 * Query params: ?ticker= ?date= ?from= ?to=
 * Validated by `netFlowHistoryQuerySchema` in api/_lib/validation.ts.
 *
 * Why server-side cumsum: each row in `ws_net_flow_per_ticker` is a
 * per-tick delta (the daemon stores raw values). Computing the
 * cumulative line in SQL keeps the truth single-sourced and bounds
 * payload size — clients receive both delta and cumulative columns
 * in the same response and can render either.
 *
 * Sources: UNIONs `ws_net_flow_per_ticker` (live WS daemon) and
 * `net_flow_per_ticker_history` (REST backfill, ~90-day history).
 * On (ts) collision, WS wins via DISTINCT ON priority — WS is the
 * authoritative live stream; REST fills history pre-daemon.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { netFlowHistoryQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';
import { ctSessionBounds } from '../src/components/LotteryFinder/ct-window.js';

type DbNumeric = string | number;
type DbTimestamp = string | Date;

interface NetFlowRow {
  ts: DbTimestamp;
  net_call_prem: DbNumeric;
  net_call_vol: number;
  net_put_prem: DbNumeric;
  net_put_vol: number;
  cum_ncp: DbNumeric;
  cum_ncv: number;
  cum_npp: DbNumeric;
  cum_npv: number;
}

const toIso = (v: DbTimestamp): string =>
  typeof v === 'string' ? v : v.toISOString();

const num = (v: DbNumeric): number => Number(v);

/**
 * Convert an HH:MM CT wall-clock string on the given date to a UTC
 * ISO timestamp. Reuses the same helper that anchors the LotteryRow
 * scrubber bounds, so the from/to params here speak the same TZ
 * vocabulary as the slider.
 */
function ctHmToUtc(date: string, hm: string): string {
  const [hh, mm] = hm.split(':').map((n) => Number(n));
  // Cheap path: ctSessionBounds gives us the right offset for the
  // date, but we want arbitrary hh:mm not just 08:30 / 15:00. Borrow
  // the offset from the session min and apply.
  const sessionMinUtc = Date.parse(ctSessionBounds(date).min);
  // sessionMinUtc represents 08:30 CT. Compute offset minutes from
  // 08:30 to (hh, mm), positive = forward.
  const targetMinutes = (hh ?? 0) * 60 + (mm ?? 0);
  const sessionStartMinutes = 8 * 60 + 30;
  const deltaMin = targetMinutes - sessionStartMinutes;
  return new Date(sessionMinUtc + deltaMin * 60_000).toISOString();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = netFlowHistoryQuerySchema.safeParse(req.query);
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
    const { ticker, date, from, to } = parsed.data;
    const targetDate = date ?? getETDateStr(new Date());

    // Default window covers the regular session. `from` / `to` allow
    // narrowing for chart pre-fetches (e.g. just the 30-min window
    // around a fire time).
    const session = ctSessionBounds(targetDate);
    const fromTs = from ? ctHmToUtc(targetDate, from) : session.min;
    const toTs = to ? ctHmToUtc(targetDate, to) : session.max;

    const db = getDb();
    // Union both sources; DISTINCT ON (ts) with priority=1 for WS keeps
    // the live row whenever both tables hold the same minute. REST fills
    // gaps for historical fires that pre-date the WS daemon.
    const rows = (await db`
      WITH unified AS (
        SELECT DISTINCT ON (ts)
          ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol
        FROM (
          SELECT ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
            1 AS priority
          FROM ws_net_flow_per_ticker
          WHERE ticker = ${ticker}
            AND ts >= ${fromTs}::timestamptz
            AND ts <= ${toTs}::timestamptz
          UNION ALL
          SELECT ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
            2 AS priority
          FROM net_flow_per_ticker_history
          WHERE ticker = ${ticker}
            AND ts >= ${fromTs}::timestamptz
            AND ts <= ${toTs}::timestamptz
        ) combined
        ORDER BY ts, priority
      )
      SELECT
        ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
        SUM(net_call_prem) OVER (ORDER BY ts) AS cum_ncp,
        SUM(net_call_vol) OVER (ORDER BY ts) AS cum_ncv,
        SUM(net_put_prem) OVER (ORDER BY ts) AS cum_npp,
        SUM(net_put_vol) OVER (ORDER BY ts) AS cum_npv
      FROM unified
      ORDER BY ts ASC
    `) as NetFlowRow[];

    const series = rows.map((r) => ({
      ts: toIso(r.ts),
      ncp: num(r.net_call_prem),
      ncv: Number(r.net_call_vol),
      npp: num(r.net_put_prem),
      npv: Number(r.net_put_vol),
      cumNcp: num(r.cum_ncp),
      cumNcv: Number(r.cum_ncv),
      cumNpp: num(r.cum_npp),
      cumNpv: Number(r.cum_npv),
    }));

    // 30s cache — the daemon ingest is sub-second on busy tickers but
    // the chart reads are heavy enough that a brief CDN reuse is cheap
    // for the user. Live mode in the React hook bypasses the cache via
    // the per-poll URL param shift in any case.
    setCacheHeaders(res, 30, 30);
    res.status(200).json({
      ticker,
      date: targetDate,
      from: fromTs,
      to: toTs,
      count: series.length,
      series,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'net-flow-history error');
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
