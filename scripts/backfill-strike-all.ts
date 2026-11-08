/**
 * Local backfill of per-strike Greek exposure across ALL expirations for past
 * dates (SPX, stored in strike_exposures with the expiry sentinel
 * '1970-01-01'). Task R1 of docs/superpowers/plans/2026-10-23-uw-rest-fixes.md;
 * spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.3).
 *
 *   npx tsx --env-file=.env.local scripts/backfill-strike-all.ts \
 *     --from 2026-09-25 --to 2026-10-22 --limit 1 --dry-run
 *
 * It runs the live cron's code for a date: the spot is fetchUwSpot(key,
 * 'SPX', date), the ladder is fetchStrikeAllLadder (windowed spot ± 200,
 * paged at exactly 500 rows, 10-page stop), and planDateStore
 * (scripts/_lib/strike-all-backfill.ts) decides what is stored. This file
 * keeps only the UW reads and the SQL. It stops at the first error: a UW
 * error, a spot or ladder from a different ET day than the date asked, an
 * empty, all-zero or out-of-window ladder, a failed insert. A date's insert is
 * one transaction, so a date is all in or all out.
 *
 * Only UW's end-of-day board is recoverable for a past date, not the
 * intraday snapshots the cron stores. ON CONFLICT DO NOTHING keeps a re-run
 * idempotent, but it also keeps any row already stored for that bucket, so a
 * date that already holds the wrong ladder needs those rows deleted first.
 *
 * WARNING: .env.local points at the PRODUCTION Neon branch (and the
 * production Upstash Redis the UW limiter uses). Run it with --dry-run first;
 * a dry run needs UW_API_KEY only, builds no database client and writes
 * nothing. It refuses to start 08:15-15:30 CT on a weekday (the live crons
 * share the key's concurrency cap).
 *
 * Options:
 *   [DAYS]                     the old positional lookback: the last DAYS
 *                              weekdays ending today (default 30)
 *   --from YYYY-MM-DD --to YYYY-MM-DD   NYSE trading days, inclusive (both)
 *   --limit N                  only the first N of those days
 *   --dry-run                  fetch and check everything, insert nothing
 *   --allow-market-hours       start inside the guard window (a market holiday)
 *
 * Exit codes: 0 done, 1 an error or missing environment, 2 bad arguments,
 * 3 refused to start in the market-hours window.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

import {
  STRIKE_ALL_ATM_RANGE,
  fetchStrikeAllLadder,
  type StrikeAllRow,
} from '../api/_lib/strike-all-fetch.js';
import { fetchUwSpot } from '../api/_lib/uw-spot.js';
import {
  EXIT_BAD_ARGS,
  EXIT_FAILED,
  EXIT_GUARD_STOP,
  EXIT_OK,
  marketHoursRefusal,
  parseRangeArgs,
  redact,
  selectDates,
} from './_lib/backfill-cli.mjs';
import { planDateStore, type DatePlan } from './_lib/strike-all-backfill.js';

const ALL_EXPIRY_SENTINEL = '1970-01-01';

type Sql = NeonQueryFunction<false, false>;

/** One transaction per date: all of its strikes land or none do. */
async function insertDate(
  sql: Sql,
  date: string,
  plan: Extract<DatePlan, { ok: true }>,
): Promise<number> {
  const { rows, price, timestamp } = plan;
  const results = await sql.transaction((txn) =>
    rows.map(
      (row) => txn`
        INSERT INTO strike_exposures (
          date, timestamp, ticker, expiry, strike, price,
          call_gamma_oi, put_gamma_oi,
          call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
          call_charm_oi, put_charm_oi,
          call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
          call_delta_oi, put_delta_oi,
          call_vanna_oi, put_vanna_oi
        )
        VALUES (
          ${date}, ${timestamp}, 'SPX', ${ALL_EXPIRY_SENTINEL}, ${row.strike}, ${price},
          ${row.call_gamma_oi}, ${row.put_gamma_oi},
          ${row.call_gamma_ask}, ${row.call_gamma_bid},
          ${row.put_gamma_ask}, ${row.put_gamma_bid},
          ${row.call_charm_oi}, ${row.put_charm_oi},
          ${row.call_charm_ask}, ${row.call_charm_bid},
          ${row.put_charm_ask}, ${row.put_charm_bid},
          ${row.call_delta_oi}, ${row.put_delta_oi},
          ${row.call_vanna_oi}, ${row.put_vanna_oi}
        )
        ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
        RETURNING id
      `,
    ),
  );
  return results.filter((r) => r.length > 0).length;
}

async function main(): Promise<number> {
  // A leading bare number is the old DAYS lookback; everything else is a flag.
  const argv = process.argv.slice(2);
  const legacyDays =
    argv[0] !== undefined && !argv[0].startsWith('--')
      ? argv.shift()
      : undefined;

  let args;
  let dates: string[];
  try {
    args = parseRangeArgs(argv);
    ({ dates } = selectDates(args, Number.parseInt(legacyDays ?? '30', 10)));
    if (args.limit != null) dates = dates.slice(0, args.limit);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_BAD_ARGS;
  }

  const refusal = marketHoursRefusal(args);
  if (refusal) {
    console.error(refusal);
    return EXIT_GUARD_STOP;
  }

  const uwKey = process.env.UW_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  const secrets = { uwKey, databaseUrl };
  const say = (line: string) => console.log(redact(line, secrets));

  if (!uwKey) {
    console.error('Missing UW_API_KEY (run with --env-file=.env.local)');
    return EXIT_FAILED;
  }
  if (!args.dryRun && !databaseUrl) {
    console.error('Missing DATABASE_URL (or pass --dry-run to skip writes)');
    return EXIT_FAILED;
  }
  // A dry run builds no client at all.
  const sql: Sql | null = args.dryRun ? null : neon(databaseUrl!);

  say(
    `Backfilling SPX all-expiry strike exposure${args.dryRun ? ' (DRY RUN: nothing is inserted)' : ''}`,
  );
  say(`Days: ${dates.length} (${dates[0]} to ${dates.at(-1)})\n`);

  let totalStored = 0;
  try {
    for (const date of dates) {
      await new Promise((r) => setTimeout(r, 400));

      const spot = await fetchUwSpot(uwKey, 'SPX', date);
      if (spot === null) {
        throw new Error(
          `${date}: no usable SPX spot, refusing to guess a strike window`,
        );
      }
      const rows = await fetchStrikeAllLadder<StrikeAllRow>(
        uwKey,
        spot.price,
        date,
      );

      const plan = planDateStore(rows, spot, date);
      if (!plan.ok) throw new Error(plan.message);

      const stored = sql === null ? 0 : await insertDate(sql, date, plan);
      totalStored += stored;
      const inserted = sql === null ? 'dry run, not inserted' : `${stored} new`;
      say(
        `  ${date}: ${rows.length} rows -> ${plan.rows.length} in ±${STRIKE_ALL_ATM_RANGE} ` +
          `(${inserted}) | ` +
          `strikes ${plan.strikeMin}-${plan.strikeMax} | SPX ${plan.price} | ${plan.timestamp}`,
      );
    }
  } catch (err) {
    console.error(
      redact(
        `Backfill failed, stopping at the first error: ${err instanceof Error ? err.message : String(err)}`,
        secrets,
      ),
    );
    return EXIT_FAILED;
  }

  say('\nDone!');
  say(
    args.dryRun
      ? '  Dry run: nothing was inserted.'
      : `  Total strike rows stored: ${totalStored}`,
  );
  return EXIT_OK;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const secrets = {
      uwKey: process.env.UW_API_KEY,
      databaseUrl: process.env.DATABASE_URL,
    };
    console.error(
      redact(err instanceof Error ? err.message : String(err), secrets),
    );
    process.exit(EXIT_FAILED);
  },
);
