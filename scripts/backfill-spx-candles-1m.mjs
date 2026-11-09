#!/usr/bin/env node

/**
 * Backfill of index_candles_1m for SPX and NDX: Unusual Whales' 1-minute SPY
 * and QQQ bars (pre-market, regular and post-market, each tagged with its
 * market_time) times a per-day ratio, for a range of finished ET trading days.
 * This one script fills both symbols, like the live cron (the file keeps its
 * old SPX name; scripts/backfill-ndx-candles-1m.mjs is gone).
 *
 * Why SPY and QQQ: Cboe and Nasdaq prohibit distributing SPX and NDX prices,
 * so the cron fetches the ETF bars and scales them. The cron scales by the
 * live Schwab quote ratio. This backfill has no live quote, so the ratio is
 * the day's Schwab DAILY close of the index over the ETF's, for that date
 * (owner decision 2026-11-05):
 *     SPX bar = SPY bar × (SPX close ÷ SPY close)
 *     NDX bar = QQQ bar × (NDX close ÷ QQQ close)
 * All four closes come from Schwab /pricehistory daily candles, one call per
 * symbol over the range, so both closes of a ratio share a source. Never the
 * old constants (10 and 41). A date with no ratio (Schwab down, no close for
 * that date) fails that symbol's day by name and nothing is written for it.
 * The ratio table is printed before any day runs: read it.
 *
 * spx_schwab_price and ndx_schwab_price are left NULL (see toIndexRows in
 * _lib/candles-backfill.mjs for why). Rows are ON CONFLICT (symbol, date,
 * timestamp) DO NOTHING, so a re-run only adds what is missing and a day the
 * live cron half filled (2026-07-22) keeps its rows. Run
 * backfill-etf-candles-1m.mjs first: the dark-pool reader divides an index
 * bar by the matching ETF bar, and gets this ratio back only if both exist.
 *
 * Which days: --from and --to are required, inclusive, NYSE trading days from
 * src/data/marketHours.ts. --to must be before today (ET).
 *
 * Schwab: the token record is read from the PRODUCTION Upstash Redis and, when
 * it has run out, refreshed in place with a compare-and-set (never over a
 * re-login). So this script also refuses to start on a weekday 13:00–22:59 UTC,
 * when the Schwab crons run, and the market-hours guard below applies too;
 * --allow-market-hours lifts both (a market holiday). --dry-run still calls
 * Schwab and UW and writes nothing to Neon; it may refresh the Schwab token
 * record in Upstash (production).
 *
 * First run: the Schwab daily /pricehistory request shape (periodType=year with
 * startDate/endDate, $NDX included) is unconfirmed against the live API. Probe
 * Monday 2026-07-27 with --dry-run first: its padded Schwab window holds a
 * Monday, so the check that fails a daily candle stamped on a non-trading day
 * runs. A Thursday probe never exercises it. If Schwab answers 400, the ratio
 * table names it; the fallback request is in the plan's P3.1 as-built note.
 *
 * UW: at most UW_REQUESTS_PER_MINUTE (300) requests a minute, one retry after
 * 1 s on a 5xx, a 429, a network error or a timeout, limit=2500. A 4xx,
 * malformed answer, or one that reaches the cap fails that day. A day UW has
 * no bars for is listed as empty. A symbol whose ETF has no bars on a day that
 * otherwise has rows (SPX when SPY is empty) is named in a "partly empty days"
 * line at the end of the summary: listed, not failed, exit code unchanged.
 * Refuses 08:15–15:30 CT on a weekday and stops taking days when that window
 * opens mid-run (exit 3).
 *
 * Writes: ≤500 rows per INSERT. Runs against whatever DATABASE_URL points at
 * (.env.local = PRODUCTION).
 *
 * Usage (from the repo root; the keys are never printed):
 *   node --env-file=.env.local scripts/backfill-spx-candles-1m.mjs \
 *     --from 2026-07-22 --to 2026-09-04 [flags]
 *
 * Flags: as backfill-etf-candles-1m.mjs (--from, --to, --dry-run, --limit N,
 * --allow-market-hours).
 *
 * Environment: UW_API_KEY; DATABASE_URL (not for --dry-run);
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL /
 * KV_REST_API_TOKEN); SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET.
 *
 * Exit codes: 0 every day done, 1 a day failed (or a key is missing),
 * 2 bad flags, 3 a guard refused or stopped the run.
 *
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md (P3.1).
 */

import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';

import {
  EXIT_BAD_ARGS,
  EXIT_FAILED,
  EXIT_GUARD_STOP,
  UW_REQUESTS_PER_MINUTE,
  createRequestThrottle,
  marketHoursRefusal,
  redact,
  runDays,
} from './_lib/backfill-cli.mjs';
import {
  INDEXES,
  loadSchwabCloses,
  planCandleDays,
  processIndexDay,
  ratioLines,
  summarizeCandleRun,
} from './_lib/candles-backfill.mjs';
import { readSchwabEnv, schwabCronsBusyRefusal } from './_lib/schwab-local.mjs';

let plan;
try {
  plan = planCandleDays(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(EXIT_BAD_ARGS);
}
const { args, dates } = plan;

const refusal =
  marketHoursRefusal(args) ??
  (args.allowMarketHours ? null : schwabCronsBusyRefusal());
if (refusal) {
  console.error(refusal);
  process.exit(EXIT_GUARD_STOP);
}

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const schwabEnv = readSchwabEnv();
if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY (run with --env-file=.env.local)');
  process.exit(EXIT_FAILED);
}
if (!args.dryRun && !DATABASE_URL) {
  console.error('Missing DATABASE_URL (or pass --dry-run to skip Neon writes)');
  process.exit(EXIT_FAILED);
}
if (schwabEnv.problem) {
  console.error(schwabEnv.problem);
  process.exit(EXIT_FAILED);
}

const secrets = { uwKey: UW_API_KEY, databaseUrl: DATABASE_URL };
const say = (line = '') => console.log(redact(line, secrets));

say(
  `Backfilling index_candles_1m (${INDEXES.map((i) => i.symbol).join(', ')}, ` +
    'scaled from SPY and QQQ)' +
    (args.dryRun
      ? ' (DRY RUN: no Neon writes; may refresh the Schwab token in Upstash)'
      : ''),
);
say(
  `  ${dates.length} trading days, ${dates[0]} → ${dates.at(-1)}` +
    (args.limit == null ? '' : ` (--limit ${args.limit})`),
);

let exitCode;
try {
  // The ratios first, once for the range. A failure here is not fatal: it
  // fails the days that needed it, by name (ratioFor).
  const closes = await loadSchwabCloses(
    new Redis({ url: schwabEnv.redisUrl, token: schwabEnv.redisToken }),
    { clientId: schwabEnv.clientId, clientSecret: schwabEnv.clientSecret },
    dates[0],
    dates.at(-1),
  );
  say();
  for (const line of ratioLines(closes, dates)) say(line);
  say();

  const ctx = {
    apiKey: UW_API_KEY,
    sql: args.dryRun ? null : neon(DATABASE_URL),
    dryRun: args.dryRun,
    waitForSlot: createRequestThrottle(UW_REQUESTS_PER_MINUTE),
    closes,
  };
  const run = await runDays(
    dates,
    { allowMarketHours: args.allowMarketHours, secrets },
    (date) => processIndexDay(date, ctx),
  );
  const report = summarizeCandleRun(run, INDEXES.length, 'symbols');
  for (const line of report.lines) say(line);
  if (args.dryRun)
    say('(dry run: stored is 0 by design; kept is what would go in)');
  exitCode = report.exitCode;
} catch (err) {
  console.error(redact(`backfill aborted: ${err?.message ?? err}`, secrets));
  exitCode = EXIT_FAILED;
}
process.exitCode = exitCode;
