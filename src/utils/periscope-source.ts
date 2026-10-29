/**
 * Which feed produced a Periscope slice: the UW Periscope scraper or GEXBot.
 * Shared by the API (populate cron, analyze formatter), the panels and the
 * `scripts/tag-periscope-source.mts` backfill. No imports, so `api/` can
 * pull it in under Node's strict ESM resolver.
 *
 * The two feeds measure different things (owner decision D1 revised,
 * 2026-10-29: per-strike Spearman between them ≈ +0.04 on 2026-05-26):
 * - 'scraper': UW Periscope's market-maker POSITION estimate (MM-signed).
 * - 'gexbot': GEXBot State, a classified taker FLOW imbalance in the
 *   vendor's taker-side sign. Positive = traders (takers) are net long that
 *   Greek at the strike, for gamma, charm and vanna alike.
 * Neither is converted into the other.
 */

/** `periscope_snapshots.source` values (migration #194). */
export const PERISCOPE_SOURCE = {
  scraper: 'scraper',
  gexbot: 'gexbot',
} as const;

export type PeriscopeSource =
  (typeof PERISCOPE_SOURCE)[keyof typeof PERISCOPE_SOURCE];

/**
 * The instant the GEXBot adapter cron replaced the UW Periscope scraper.
 * Measured on production 2026-10-28: the last scraper row was captured
 * 2026-05-26 17:13:26.475Z and the first GEXBot row 17:29:32.914Z (the
 * cron was committed at 17:13Z that day); no other day mixes the two, and
 * every row's timeframe label agrees (see scripts/_lib/tag-periscope-source.ts).
 * Any instant in between splits the eras.
 */
export const PERISCOPE_GEXBOT_CUTOVER = '2026-05-26T17:20:00Z';

const CUTOVER_MS = Date.parse(PERISCOPE_GEXBOT_CUTOVER);

/**
 * The feed behind a slice captured at `capturedAt`, or null when the
 * timestamp does not parse (callers then show a source-neutral label).
 */
export function periscopeSourceAt(
  capturedAt: string | Date,
): PeriscopeSource | null {
  const ms =
    capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(capturedAt);
  if (Number.isNaN(ms)) return null;
  return ms >= CUTOVER_MS ? PERISCOPE_SOURCE.gexbot : PERISCOPE_SOURCE.scraper;
}
