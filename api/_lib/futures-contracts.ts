/**
 * Front-month contract selection for the UW futures crons.
 *
 * `futures_bars` has no contract column: its rows are keyed by root
 * ('ES'), and the live uw-stream handler writes whichever contract leads
 * the root's session volume. The REST crons that read per-contract data
 * (`backfill-futures-gaps` for candles, `fetch-futures-session-stats` for
 * settlement and open interest) first need that root's active contracts.
 * Both select them here, the same way:
 *
 *   1. `GET /futures/contracts?days=5`, once per run: every active CME
 *      contract, volume summed over the last 5 sessions.
 *   2. Per root, keep rows whose `product` EQUALS the root (`q=ES` would
 *      also match MES and EST), drop spreads (a spread sym is its own
 *      symbol and can outtrade an outright), and take the top
 *      FRONT_MONTH_CANDIDATES by volume.
 */

import { uwFetch, withRetry } from './api-helpers.js';

/**
 * Mirrors `_TARGET_PRODUCTS` in the uw-stream futures_trades handler.
 * DX (ICE) and VX (Cboe CFE) have no UW source.
 */
export const FUTURES_ROOTS = ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'] as const;

export type FuturesRoot = (typeof FUTURES_ROOTS)[number];

/** Front + next month: the pair a roll moves between. */
const FRONT_MONTH_CANDIDATES = 2;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Every active contract, volume-ranked over 5 sessions (~365 rows, all
 * roots in one call). Throws on an upstream error or a non-array payload,
 * so a caller never selects from a list it didn't get.
 */
export async function fetchFuturesContracts(
  apiKey: string,
): Promise<unknown[]> {
  const contracts: unknown = await withRetry(() =>
    uwFetch<unknown>(apiKey, '/futures/contracts?days=5'),
  );
  if (!Array.isArray(contracts)) {
    throw new Error('UW /futures/contracts returned a non-array payload');
  }
  return contracts;
}

/**
 * Top candidates for a root, most active first (volume, then name). An
 * empty result means UW lists no outright for the root.
 */
export function frontMonthCandidates(
  contracts: unknown[],
  root: string,
): string[] {
  const rows: Array<{ name: string; volume: number }> = [];
  for (const c of contracts) {
    if (!isRecord(c) || c.product !== root || c.is_spread === true) continue;
    if (typeof c.name !== 'string' || c.name === '') continue;
    rows.push({
      name: c.name,
      volume: typeof c.volume === 'number' ? c.volume : 0,
    });
  }
  // Codepoint order on ties, like the uw-stream front-month rule (names are
  // unique).
  rows.sort((a, b) => b.volume - a.volume || (a.name < b.name ? 1 : -1));
  return rows.slice(0, FRONT_MONTH_CANDIDATES).map((r) => r.name);
}
