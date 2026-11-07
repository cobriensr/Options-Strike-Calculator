#!/usr/bin/env node

/**
 * Backfill of flow_data's ETF Tide (options flow on the holdings of an ETF,
 * not on the ETF itself): source spy_etf_tide and qqq_etf_tide, from Unusual
 * Whales /market/{SPY,QQQ}/etf-tide?date=, for a range of finished ET trading
 * days. Two UW requests a day.
 *
 * Mirrors api/cron/fetch-etf-tide.ts: UW sends one cumulative row a minute;
 * the last row of each 5-minute window is kept, stamped at the window start,
 * ON CONFLICT (date, timestamp, source) DO NOTHING (the unique key of
 * migration #4). A re-run only adds what is missing, and a day the live cron
 * already filled keeps its rows. Differences from the old script and the cron:
 * the rows are put in time order before the last of a window is picked, and a
 * row whose premium is not a number is left out and counted ("dropped")
 * instead of being stored as 0.
 *
 * Which days: --from and --to are required, inclusive, NYSE trading days from
 * src/data/marketHours.ts (holidays skipped). --to must be before today (ET):
 * the live cron fills today (and notes that UW answers ?date=<today> with
 * zeros). There is no lookback default, no positional N and no ticker list
 * any more (to fill one ticker, run both: the writes are DO NOTHING).
 *
 * UW: at most UW_REQUESTS_PER_MINUTE (300) requests a minute, one retry
 * after 1 s on a 5xx, a 429, a network error or a timeout, an explicit
 * User-Agent. A 4xx or malformed answer fails that day (exit 1); a day UW has
 * no rows for is listed as empty, not failed. A ticker with no rows on a day
 * that otherwise has rows is named in a "partly empty days" line at the end of
 * the summary: listed, not failed, exit code unchanged.
 *
 * Rows left out and counted ("dropped"): a row for another ET day, or with a
 * premium or net volume that is not a number or does not fit its column (ncp
 * and npp DECIMAL(14,2), net_volume INTEGER). A ticker whose rows are all
 * unusable for the day (UW answered another ET day), or that has ten or more
 * rows with every premium zero, fails the day (`malformed`) and writes
 * nothing for that ticker; the day's other ticker still writes. A database
 * error fails the day too: nothing is only warned about.
 *
 * Refuses to start 08:15–15:30 CT on a weekday, and stops taking days
 * (exit 3) when that window opens mid-run: its calls skip the shared Redis
 * semaphore and compete with the production crons.
 *
 * Writes: ≤500 rows per INSERT. Runs against whatever DATABASE_URL points at
 * (.env.local = PRODUCTION).
 *
 * Usage (from the repo root; the key and URL are never printed):
 *   node --env-file=.env.local scripts/backfill-etf-tide.mjs \
 *     --from 2026-07-22 --to 2026-09-04 [flags]
 *
 * Flags:
 *   --from YYYY-MM-DD     first trading date (inclusive), required
 *   --to YYYY-MM-DD       last trading date (inclusive), required
 *   --dry-run             fetch and map, write nothing; needs no DATABASE_URL
 *   --limit N             only the first N trading days of the range
 *   --allow-market-hours  start even inside the 08:15–15:30 CT window
 *
 * Exit codes: 0 every day done, 1 a day failed (or a key is missing),
 * 2 bad flags, 3 the market-hours guard refused or stopped the run.
 *
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md
 * (P3.2).
 */

import { ETF_TIDE, runFlowScript } from './_lib/flow-data-backfill.mjs';

await runFlowScript(ETF_TIDE);
