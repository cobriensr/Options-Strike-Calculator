#!/usr/bin/env node

/**
 * Backfill of flow_data's Net Flow (cumulative net call and put premium and
 * net volume): source spx_flow, spy_flow and qqq_flow, from Unusual Whales
 * /stock/{SPX,SPY,QQQ}/net-prem-ticks?date=, for a range of finished ET trading
 * days. Three UW requests a day.
 *
 * Mirrors api/cron/fetch-net-flow.ts: UW sends the change for each minute; the
 * ticks are added up in time order (they are sorted first, UW does not promise
 * an order), the running total is kept at the last tick of each 5-minute
 * window and stamped at the window start, ON CONFLICT (date, timestamp,
 * source) DO NOTHING (the unique key of migration #4). A re-run only adds what
 * is missing. A tick for another ET day is left out before anything is added
 * up. A tick whose premium is not a number stays in the sums as a premium of 0
 * with its volumes, like the live cron's `|| 0` (leaving it out would shift
 * every later net_volume). Both are counted ("dropped").
 *
 * 07-22 and the live rows: the live cron's morning rows are totals of the
 * ticks as they stood that morning; this script's rows for the rest of the day
 * are totals of the day's ticks as UW has them now, after the close. DO NOTHING
 * keeps the live rows, so a small step in the running total where the two
 * meet is possible (UW is known to restate some per-minute aggregates after
 * the close; this endpoint is suspected of it, not verified).
 *
 * Which days: --from and --to are required, inclusive, NYSE trading days from
 * src/data/marketHours.ts (holidays skipped). --to must be before today (ET):
 * the live cron fills today. There is no lookback default, no positional N and
 * no ticker list any more (to fill one ticker, run all three: the writes are
 * DO NOTHING).
 *
 * UW: at most UW_REQUESTS_PER_MINUTE (300) requests a minute, one retry
 * after 1 s on a 5xx, a 429, a network error or a timeout, an explicit
 * User-Agent. A 4xx or malformed answer fails that day (exit 1); a day UW has
 * no ticks for is listed as empty, not failed. A ticker with no ticks on a day
 * that otherwise has some is named in a "partly empty days" line at the end of
 * the summary: listed, not failed, exit code unchanged. A ticker whose ticks
 * are all unusable for the day (UW answered another ET day), or that has ten or
 * more rows with every premium zero, fails the day (`malformed`) and writes
 * nothing. A database error fails the day too: nothing is only warned about.
 * Refuses to start 08:15–15:30 CT
 * on a weekday, and stops taking days (exit 3) when that window opens mid-run:
 * its calls skip the shared Redis semaphore and compete with the production
 * crons.
 *
 * Writes: ≤500 rows per INSERT. Runs against whatever DATABASE_URL points at
 * (.env.local = PRODUCTION).
 *
 * Usage (from the repo root; the key and URL are never printed):
 *   node --env-file=.env.local scripts/backfill-netflow.mjs \
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
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md (P3.2).
 */

import { NET_FLOW, runFlowScript } from './_lib/flow-data-backfill.mjs';

await runFlowScript(NET_FLOW);
