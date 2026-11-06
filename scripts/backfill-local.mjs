#!/usr/bin/env node

/**
 * Backfill of flow_data's Market Tide: source market_tide (all-in) and
 * market_tide_otm (out-of-the-money only), from Unusual Whales
 * /market/market-tide?date=&interval_5m=true[&otm_only=true], for a range of
 * finished ET trading days. Two UW requests a day.
 *
 * Mirrors api/cron/fetch-flow.ts: the 5-minute rows as UW sends them (the
 * timestamp is not moved), the premiums and net volume as numbers,
 * ON CONFLICT (date, timestamp, source) DO NOTHING (the unique key of
 * migration #4). A re-run only adds what is missing, and a day the live cron
 * half filled (2026-07-22: 17 of 80 rows) keeps its rows.
 *
 * Which days: --from and --to are required, inclusive, NYSE trading days from
 * src/data/marketHours.ts (holidays skipped). --to must be before today (ET):
 * the live cron fills today. There is no lookback default and no positional N
 * any more: the old N counted weekdays back from today, holidays and the
 * unfinished day included, and could not target a gap.
 *
 * UW: at most UW_REQUESTS_PER_MINUTE (300) requests a minute, one retry
 * after 1 s on a 5xx, a 429, a network error or a timeout, an explicit
 * User-Agent. A 4xx or malformed answer fails that day (exit 1); a day UW has
 * no rows for is listed as empty, not failed. A source with no rows on a day
 * that otherwise has rows is named in a "partly empty days" line at the end of
 * the summary: listed, not failed, exit code unchanged. A row for another ET
 * day, or with a premium that is not a number, is left out and counted
 * ("dropped"). A database error fails the day too: nothing is only warned
 * about. Refuses to start 08:15–15:30 CT on a weekday, and stops taking days
 * (exit 3) when that window opens mid-run: its calls skip the shared Redis
 * semaphore and compete with the production crons.
 *
 * Writes: ≤500 rows per INSERT. Runs against whatever DATABASE_URL points at
 * (.env.local = PRODUCTION).
 *
 * Usage (from the repo root; the key and URL are never printed):
 *   node --env-file=.env.local scripts/backfill-local.mjs \
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

import { MARKET_TIDE, runFlowScript } from './_lib/flow-data-backfill.mjs';

await runFlowScript(MARKET_TIDE);
