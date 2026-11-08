/**
 * Types for the parts of scripts/_lib/backfill-cli.mjs that a TypeScript
 * script uses (scripts/backfill-strike-all.ts). Keep in step with the module.
 */

/** Every day ran and none failed. */
export const EXIT_OK: number;
/** A day failed, or a script's env is missing. */
export const EXIT_FAILED: number;
/** The flags did not parse. */
export const EXIT_BAD_ARGS: number;
/** The market-hours guard refused or stopped the run. */
export const EXIT_GUARD_STOP: number;

export interface RangeArgs {
  dryRun: boolean;
  allowMarketHours: boolean;
  limit: number | null;
  from: string | null;
  to: string | null;
}

/** --dry-run, --allow-market-hours, --limit N, and --from/--to together. Throws on a bad flag. */
export function parseRangeArgs(argv: string[]): RangeArgs;

/**
 * With --from/--to: the range's NYSE trading days (throws when it holds
 * none). Without: the last `lookbackDays` weekdays ending today.
 */
export function selectDates(
  args: { from: string | null; to: string | null },
  lookbackDays?: number,
): { mode: 'lookback' | 'range'; dates: string[] };

/** The refusal to print 08:15-15:30 CT on a weekday without the flag, else null. */
export function marketHoursRefusal(args: {
  allowMarketHours: boolean;
}): string | null;

/** Scrub the UW key, the database URL and its password from text before it is printed. */
export function redact(
  text: unknown,
  secrets: { uwKey?: string | undefined; databaseUrl?: string | undefined },
): string;
