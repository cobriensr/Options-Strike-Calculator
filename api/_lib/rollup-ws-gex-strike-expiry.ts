/**
 * Rolls one trading day's `ws_gex_strike_expiry` rows into the
 * persistent `strike_exposures` archive. Preserves per-minute
 * `ts_minute` values so the Greek Heatmap's historical view can render
 * the LIVE scrubber for every lottery ticker the WS captured.
 *
 * Spec: docs/superpowers/specs/ws-gex-strike-expiry-rollup-2026-05-17.md
 *       docs/superpowers/specs/ws-gex-rollup-chunking-2026-10-25.md
 *
 * One ticker per statement (2026-10-25). Until then the whole day was one
 * INSERT...SELECT of ~3M rows: a seq scan of the source (its ET-date
 * filter cast the column, so no index applied), every inserted id shipped
 * back to the function only to be counted, and one transaction over the
 * day. The runs for 10-15, 10-16, 10-19, 10-22 and 10-23 left no rows
 * and no Sentry event; 10-23's, at least, was killed before its statement
 * finished (the kill mechanism is unconfirmed). Now each ticker is its
 * own atomic, index-driven statement that counts in the database, a
 * failed ticker is reported and skipped, and no ticker starts after the
 * caller's deadline.
 *
 * Idempotent via the `(date, timestamp, ticker, strike, expiry)`
 * UNIQUE constraint on `strike_exposures` — re-running for the same
 * date is a no-op for rows already present.
 *
 * 0DTE-only filter: copies rows where `expiry` is the target ET date
 * and `ts_minute` falls inside that ET day. Future-expiry rows still in
 * `ws_gex_strike_expiry` (the daemon's 0DTE filter hasn't fully purged
 * them) are skipped — the heatmap is 0DTE-only. The ET day is the
 * half-open range [`$1::date::timestamp AT TIME ZONE 'America/New_York'`,
 * `($1::date + 1)::timestamp AT TIME ZONE 'America/New_York'`): tzdata
 * resolves DST, and the bare `ts_minute` comparison can use the
 * `(ticker, expiry, ts_minute)` index. It selects exactly the rows the
 * old `(ts_minute AT TIME ZONE 'America/New_York')::date = $1` filter did
 * (proved in rollup-ws-gex-strike-expiry-pglite.test.ts).
 *
 * The `::timestamp` is load-bearing. Without it, `date AT TIME ZONE`
 * resolves through date → timestamptz (the preferred cast), taken in the
 * SESSION time zone, and yields a timestamp without time zone. Under
 * Neon's UTC sessions that puts each bound 8 h (EDT) or 10 h (EST) before
 * ET midnight.
 *
 * Delta: WS payload has no `call_delta_oi` / `put_delta_oi`, so
 * rolled-up rows have NULL delta. REST-backfilled rows retain delta;
 * the heatmap does not read delta.
 *
 * SPX → SPXW remap: UW pushes 0DTE chain data with `ticker='SPX'` on
 * both `gex_strike_expiry:SPX` and `gex_strike_expiry:SPXW`
 * subscriptions (the chains have been unified since 2022 — all
 * dailies, including 0DTE, live on the SPXW symbol). The Greek
 * Heatmap dropdown only allows SPXW, and the lottery REST backfill
 * writes SPXW. We remap on copy so `strike_exposures` is uniformly
 * SPXW-labeled and the heatmap query path doesn't need a read-side
 * alias. Mirrors `resolveStoredTicker` in `db-gex-strike-expiry.ts`.
 * SPX is copied first because it feeds that SPXW heatmap.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

import { withDbRetry } from './db.js';
import logger from './logger.js';
import { Sentry } from './sentry.js';

/** The ticker copied before all others (it feeds the SPXW heatmap). */
const FIRST_TICKER = 'SPX';

const TICKER_LIST_SQL = `
  SELECT DISTINCT ticker
  FROM ws_gex_strike_expiry
  WHERE expiry = $1::date
    AND ts_minute >= ($1::date::timestamp AT TIME ZONE 'America/New_York')
    AND ts_minute < (($1::date + 1)::timestamp AT TIME ZONE 'America/New_York')
`;

const TICKER_INSERT_SQL = `
  WITH ins AS (
    INSERT INTO strike_exposures (
      date, timestamp, ticker, expiry, strike, price,
      call_gamma_oi, put_gamma_oi,
      call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
      call_charm_oi, put_charm_oi,
      call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
      call_delta_oi, put_delta_oi,
      call_vanna_oi, put_vanna_oi
    )
    SELECT
      (ts_minute AT TIME ZONE 'America/New_York')::date AS date,
      ts_minute AS timestamp,
      CASE WHEN ticker = 'SPX' THEN 'SPXW' ELSE ticker END AS ticker,
      expiry,
      strike,
      price,
      call_gamma_oi,
      put_gamma_oi,
      call_gamma_ask_vol  AS call_gamma_ask,
      call_gamma_bid_vol  AS call_gamma_bid,
      put_gamma_ask_vol   AS put_gamma_ask,
      put_gamma_bid_vol   AS put_gamma_bid,
      call_charm_oi,
      put_charm_oi,
      call_charm_ask_vol  AS call_charm_ask,
      call_charm_bid_vol  AS call_charm_bid,
      put_charm_ask_vol   AS put_charm_ask,
      put_charm_bid_vol   AS put_charm_bid,
      NULL::numeric AS call_delta_oi,
      NULL::numeric AS put_delta_oi,
      call_vanna_oi,
      put_vanna_oi
    FROM ws_gex_strike_expiry
    WHERE ticker = $2
      AND expiry = $1::date
      AND ts_minute >= ($1::date::timestamp AT TIME ZONE 'America/New_York')
      AND ts_minute < (($1::date + 1)::timestamp AT TIME ZONE 'America/New_York')
    ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int AS inserted FROM ins
`;

type DbHandle = NeonQueryFunction<false, false> & {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

export interface TickerCopy {
  /** Source ticker (`SPX`, not the stored `SPXW`). */
  ticker: string;
  /** Rows this ticker's statement inserted (conflicts excluded). */
  inserted: number;
}

export interface RollupResult {
  /** Every source ticker for the date, in processing order. */
  tickers: string[];
  /** Tickers whose statement committed, in processing order. */
  copied: TickerCopy[];
  /** Tickers whose statement failed (each already sent to Sentry). */
  failed: string[];
  /** Tickers not started because the deadline had passed. */
  deferred: string[];
  /** Total rows inserted across `copied`. */
  inserted: number;
  durationMs: number;
}

/** SPX first, then the rest alphabetically. */
function processingOrder(tickers: string[]): string[] {
  return [...tickers].sort((a, b) => {
    if (a === b) return 0;
    if (a === FIRST_TICKER) return -1;
    if (b === FIRST_TICKER) return 1;
    return a.localeCompare(b);
  });
}

async function listTickers(db: DbHandle, date: string): Promise<string[]> {
  const rows = (await withDbRetry(() => db.query(TICKER_LIST_SQL, [date]))) as {
    ticker: string;
  }[];
  return processingOrder(rows.map((r) => r.ticker));
}

/**
 * Copy one ticker and return the rows it inserted. Transient errors are
 * retried (withDbRetry's default attempts and backoff): the statement is
 * atomic and ON CONFLICT DO NOTHING, so a retry after a lost response
 * inserts nothing twice. No per-attempt timeout on purpose: a timeout that
 * wins the race leaves the statement running server-side, and the retry
 * would queue behind its row locks.
 */
async function copyTicker(
  db: DbHandle,
  date: string,
  ticker: string,
): Promise<number> {
  const rows = (await withDbRetry(() =>
    db.query(TICKER_INSERT_SQL, [date, ticker]),
  )) as { inserted?: unknown }[];
  const inserted = rows[0]?.inserted;
  // count(*) always yields exactly one row; anything else is a broken
  // response, not "0 rows copied".
  if (typeof inserted !== 'number') {
    throw new TypeError(
      `rollup ${ticker} ${date}: INSERT returned no row count ` +
        `(got ${JSON.stringify(rows[0] ?? null)})`,
    );
  }
  return inserted;
}

/**
 * Roll the 0DTE rows for one ET date from `ws_gex_strike_expiry` into
 * `strike_exposures`, one ticker per INSERT...SELECT. Postgres does the
 * scan, write and count; only the count comes back.
 *
 * Both statements retry transient DB errors. A ticker that still fails
 * (or returns no count) is captured to Sentry (tagged `rollup.ticker`)
 * and the loop moves on; the caller decides the run status from `failed`.
 * A ticker list failure throws (nothing can be copied without it).
 *
 * @param db         Neon SQL handle (must support `.query(text, params)`).
 * @param date       YYYY-MM-DD ET date string.
 * @param deadlineMs Epoch ms at or after which no further ticker starts;
 *                   the rest are returned in `deferred`.
 */
export async function rollupWsGexToStrikeExposures(
  db: DbHandle,
  date: string,
  deadlineMs: number,
): Promise<RollupResult> {
  const startedAt = Date.now();
  const tickers = await listTickers(db, date);
  const copied: TickerCopy[] = [];
  const failed: string[] = [];
  let deferred: string[] = [];

  for (const [index, ticker] of tickers.entries()) {
    if (Date.now() >= deadlineMs) {
      deferred = tickers.slice(index);
      break;
    }
    try {
      const inserted = await copyTicker(db, date, ticker);
      copied.push({ ticker, inserted });
    } catch (err) {
      // Reported as it happens, not after the loop: a run killed later
      // still leaves this failure in Sentry.
      failed.push(ticker);
      logger.error(
        { err, date, ticker },
        'ws_gex_strike_expiry rollup: ticker failed',
      );
      Sentry.captureException(err, {
        tags: {
          'cron.job': 'rollup-ws-gex-strike-expiry',
          'rollup.ticker': ticker,
        },
        extra: { date },
      });
    }
  }

  return {
    tickers,
    copied,
    failed,
    deferred,
    inserted: copied.reduce((sum, c) => sum + c.inserted, 0),
    durationMs: Date.now() - startedAt,
  };
}
