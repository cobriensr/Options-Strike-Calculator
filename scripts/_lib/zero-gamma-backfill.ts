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
