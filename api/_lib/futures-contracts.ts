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
 *
 * `replayFrontMonth` then picks, minute by minute, the contract the live
 * handler would have written, so a repair lands on the same month.
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

/** One contract's activity in one minute. `ts` is an ISO minute in UTC. */
export interface ContractMinute {
  ts: string;
  volume: number;
}

/**
 * Replays the uw-stream front-month rule over per-contract minute rows
 * (candles in `backfill-futures-gaps`, trade-derived minutes in the order
 * flow repair): per minute, add every contract's volume to a UTC-day tally
 * (reset at each new UTC date), then emit the tally leader's row for that
 * minute if it has one. A minute where the leader has no row is left out,
 * never filled from another month, which trades at a carry basis. Ties go
 * to the larger contract symbol, matching Python's
 * `max(tally.items(), key=lambda kv: (kv[1], kv[0]))`.
 *
 * `ts` must be the `toISOString()` form: equal-length UTC strings sort
 * chronologically and their first 10 characters are the UTC date.
 */
export function replayFrontMonth<T extends ContractMinute>(
  byContract: ReadonlyMap<string, readonly T[]>,
): Array<{ contract: string; row: T }> {
  const byMinute = new Map<string, Map<string, T>>();
  for (const [contract, rows] of byContract) {
    for (const row of rows) {
      const minute = byMinute.get(row.ts) ?? new Map<string, T>();
      minute.set(contract, row);
      byMinute.set(row.ts, minute);
    }
  }

  const out: Array<{ contract: string; row: T }> = [];
  const tally = new Map<string, number>();
  let day = '';
  for (const ts of [...byMinute.keys()].sort()) {
    const minute = byMinute.get(ts)!;
    if (ts.slice(0, 10) !== day) {
      day = ts.slice(0, 10);
      tally.clear();
    }
    for (const [contract, row] of minute) {
      tally.set(contract, (tally.get(contract) ?? 0) + row.volume);
    }
    let leader = '';
    let leaderVolume = -1;
    for (const [contract, volume] of tally) {
      if (
        volume > leaderVolume ||
        (volume === leaderVolume && contract > leader)
      ) {
        leader = contract;
        leaderVolume = volume;
      }
    }
    const row = minute.get(leader);
    if (row) out.push({ contract: leader, row });
  }
  return out;
}
