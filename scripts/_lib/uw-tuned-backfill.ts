/**
 * Shared guard for the two backfills of UW-tuned rules
 * (scripts/backfill-gamma-setup-fires.ts and
 * scripts/backfill-periscope-lottery-fires.ts).
 *
 * Owner decision D1 revised (2026-10-29): those rules were tuned on UW
 * Periscope data, and every row since PERISCOPE_GEXBOT_CUTOVER is GEXBot's
 * taker flow. So a backfill reads scraper-era rows only unless the owner
 * passes --include-gexbot, which prints a warning first.
 */

import { PERISCOPE_GEXBOT_CUTOVER } from '../../src/utils/periscope-source.js';

export const INCLUDE_GEXBOT_FLAG = '--include-gexbot';

export const GEXBOT_INCLUDE_WARNING =
  'WARNING: --include-gexbot reads Periscope rows from the GEXBot era. ' +
  'These rules were tuned on UW Periscope data (market-maker position); ' +
  'GEXBot rows are classified taker flow, so the fires they produce are ' +
  'not comparable to the tuned history.';

export function parseIncludeGexbot(argv: readonly string[]): boolean {
  return argv.includes(INCLUDE_GEXBOT_FLAG);
}

/**
 * Snapshots captured at or after this instant are excluded; null lifts the
 * bound. Bound into SQL as `(${c}::timestamptz IS NULL OR captured_at < ...)`.
 */
export function scraperEraCutoff(includeGexbot: boolean): string | null {
  return includeGexbot ? null : PERISCOPE_GEXBOT_CUTOVER;
}

/**
 * Everything a backfill needs from its args in one place: the opt-in flag,
 * the capped window and the snapshot cutoff to bind into SQL. The gamma
 * script passes `cutoff` straight to its snapshot loader.
 */
export function resolveBackfillScope(
  argv: readonly string[],
  from: string,
  to: string,
): {
  includeGexbot: boolean;
  from: string;
  to: string;
  clamped: boolean;
  cutoff: string | null;
} {
  const includeGexbot = parseIncludeGexbot(argv);
  return {
    includeGexbot,
    ...clampWindowToScraperEra(from, to, includeGexbot),
    cutoff: scraperEraCutoff(includeGexbot),
  };
}

/**
 * Cap a `--to` date at the cutover day (the day itself is mixed; the
 * snapshot loader drops its GEXBot slices by timestamp).
 */
export function clampWindowToScraperEra(
  from: string,
  to: string,
  includeGexbot: boolean,
): { from: string; to: string; clamped: boolean } {
  if (includeGexbot) return { from, to, clamped: false };
  const lastDay = PERISCOPE_GEXBOT_CUTOVER.slice(0, 10);
  if (to <= lastDay) return { from, to, clamped: false };
  return { from, to: lastDay, clamped: true };
}
