#!/usr/bin/env node

/**
 * Backfill of etf_candles_1m: raw 1-minute SPY and QQQ bars (extended hours
 * included, as the live cron stores them) from Unusual Whales
 * /stock/{ticker}/ohlc/1m?date=, for a range of finished ET trading days.
 *
 * Mirrors api/cron/fetch-etf-candles-1m.ts: the prices as UW sends them,
 * ON CONFLICT (ticker, timestamp) DO NOTHING, so a re-run only adds what is
 * missing and a day the live cron half filled (2026-07-22) keeps its rows.
 * Run this before the SPX/NDX candles: those are scaled from the same bars,
 * and the dark-pool reader divides an index bar by the matching ETF bar.
 *
 * Which days: --from and --to are required, inclusive, NYSE trading days from
 * src/data/marketHours.ts (holidays skipped). --to must be before today (ET):
 * the live crons fill today. There is no lookback default and no positional N
 * any more (the old 30-day default could not reach a gap).
 *
 * UW: at most UW_REQUESTS_PER_MINUTE (300) requests a minute, one retry
 * after 1 s on a 5xx, a 429, a network error or a timeout. limit=2500 (UW's
 * cap; a full extended session is about 960 bars). A 4xx or malformed answer,
 * or one that reaches the cap, fails that day (exit 1); a day UW has no bars
 * for is listed as empty, not failed. Refuses to start 08:15–15:30 CT on a
 * weekday, and stops taking days (exit 3) when that window opens mid-run: its
 * calls skip the shared Redis semaphore and compete with the production
 * crons.
 *
 * Writes: ≤500 rows per INSERT. Runs against whatever DATABASE_URL points at
 * (.env.local = PRODUCTION).
 *
 * Usage (from the repo root; the key and URL are never printed):
 *   node --env-file=.env.local scripts/backfill-etf-candles-1m.mjs \
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
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md (P3.1).
 */

import { neon } from '@neondatabase/serverless';

import {
  EXIT_BAD_ARGS,
  EXIT_FAILED,
  EXIT_GUARD_STOP,
  UW_REQUESTS_PER_MINUTE,
  createRequestThrottle,
  formatRunSummary,
  marketHoursRefusal,
  redact,
  runDays,
  summarizeRun,
} from './_lib/backfill-cli.mjs';
import {
  ETF_TICKERS,
  planCandleDays,
  processEtfDay,
} from './_lib/candles-backfill.mjs';

let plan;
try {
  plan = planCandleDays(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(EXIT_BAD_ARGS);
}
const { args, dates } = plan;

const refusal = marketHoursRefusal(args);
if (refusal) {
  console.error(refusal);
  process.exit(EXIT_GUARD_STOP);
}

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY (run with --env-file=.env.local)');
  process.exit(EXIT_FAILED);
}
if (!args.dryRun && !DATABASE_URL) {
  console.error('Missing DATABASE_URL (or pass --dry-run to skip writes)');
  process.exit(EXIT_FAILED);
}

const secrets = { uwKey: UW_API_KEY, databaseUrl: DATABASE_URL };
const say = (line = '') => console.log(redact(line, secrets));

say(
  `Backfilling etf_candles_1m (${ETF_TICKERS.join(', ')}, raw prices)` +
    (args.dryRun ? ' (DRY RUN: no writes)' : ''),
);
say(
  `  ${dates.length} trading days, ${dates[0]} → ${dates.at(-1)}` +
    (args.limit == null ? '' : ` (--limit ${args.limit})`),
);

const ctx = {
  apiKey: UW_API_KEY,
  sql: args.dryRun ? null : neon(DATABASE_URL),
  dryRun: args.dryRun,
  waitForSlot: createRequestThrottle(UW_REQUESTS_PER_MINUTE),
};

let exitCode;
try {
  const run = await runDays(
    dates,
    { allowMarketHours: args.allowMarketHours, secrets },
    (date) => processEtfDay(date, ctx),
  );
  const summary = summarizeRun(run);
  say();
  for (const line of formatRunSummary(summary)) say(line);
  if (args.dryRun)
    say('(dry run: stored is 0 by design; kept is what would go in)');
  exitCode = summary.exitCode;
} catch (err) {
  console.error(redact(`backfill aborted: ${err?.message ?? err}`, secrets));
  exitCode = EXIT_FAILED;
}
process.exitCode = exitCode;
