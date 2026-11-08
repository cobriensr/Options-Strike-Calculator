/**
 * The pure rules of scripts/backfill-zero-gamma.ts: its arguments, and the
 * guard that keeps it from adding a second row per ladder to a date that
 * already has zero_gamma_levels rows.
 *
 * Why a guard: a backfilled row is keyed on its source ladder
 * (`zeroGammaLabelTs`, the end of the ladder's 5-minute bucket), the same key
 * the live cron uses since P0.4, so a re-run of the script is idempotent and a
 * ladder the cron already stored is a no-op. But the cron wrote its rows
 * before that change at the compute time (`NOW()`), and those keys never
 * match. For a date that has them, a default run would insert a second row
 * per ladder, about a minute off the first: around 7,000 duplicates over the
 * default 30 days. A date with rows this run would not write is therefore
 * skipped, unless `--allow-existing` says the duplicates are wanted.
 *
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.4, F8).
 */

import type { getDb } from '../../api/_lib/db.js';

type Sql = ReturnType<typeof getDb>;

export interface BackfillArgs {
  /** Weekdays to go back from today. */
  days: number;
  /** Write a date even when it already has rows this run would not write. */
  allowExisting: boolean;
}

/**
 * `[DAYS] [--allow-existing]`. Throws, naming the problem, on anything else:
 * an unknown flag, a DAYS that is not a whole number of at least 1, or two
 * DAYS.
 */
export function parseArgs(argv: readonly string[]): BackfillArgs {
  let days: number | undefined;
  let allowExisting = false;
  for (const arg of argv) {
    if (arg === '--allow-existing') {
      allowExisting = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      if (days !== undefined) {
        throw new Error(`DAYS given twice (${days} and ${arg})`);
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `DAYS must be a whole number of at least 1, got ${arg}`,
        );
      }
      days = n;
    }
  }
  return { days: days ?? 30, allowExisting };
}

/**
 * How many `zero_gamma_levels` rows of `ticker` fall on the ET calendar day
 * `date` (`YYYY-MM-DD`) with a `ts` that is not one of `labels` (the keys this
 * run would write). The ET-day bounds are ET midnight to the next ET midnight,
 * built through `::timestamp AT TIME ZONE` so they are right across the EDT and
 * EST offsets and do not depend on the session time zone.
 */
export async function countForeignRows(
  sql: Sql,
  ticker: string,
  date: string,
  labels: readonly string[],
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM zero_gamma_levels
    WHERE ticker = ${ticker}
      AND ts >= (${date}::date::timestamp AT TIME ZONE 'America/New_York')
      AND ts < ((${date}::date + 1)::timestamp AT TIME ZONE 'America/New_York')
      AND ts <> ALL(${labels}::timestamptz[])
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export type DateGuard = { write: true } | { write: false; reason: string };

/**
 * Whether to write one (ticker, date). `foreignRows` is the count of
 * zero_gamma_levels rows on that ET date whose `ts` is not one this run would
 * write.
 */
export function guardDate(
  foreignRows: number,
  allowExisting: boolean,
): DateGuard {
  if (foreignRows === 0 || allowExisting) return { write: true };
  return {
    write: false,
    reason:
      `${foreignRows} existing row${foreignRows === 1 ? '' : 's'} with a ts this run would not write ` +
      `(the cron stamped them with its compute time). Writing would add a second row per ladder. ` +
      `Delete them first (spec P2.2, needs owner approval), or pass --allow-existing`,
  };
}
