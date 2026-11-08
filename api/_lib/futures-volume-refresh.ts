/**
 * Brings one root's `futures_contract_volume` up to date from UW's daily
 * candles, shared by the gap cron (`api/cron/backfill-futures-gaps.ts`) and
 * the scripts that decide front months. Plan:
 * `docs/superpowers/specs/2026-11-06-futures-session-front-month.md`.
 *
 * A front-month decision is made once, from the previous session's volume,
 * and never changed, so the volume it reads has to be complete when it is
 * made. `refreshFrontMonthVolumes` is the step to run first:
 *
 *   1. The incumbent is the root's latest decision of the last 30 days, else
 *      the listing-cycle seed for the current trade date.
 *   2. Daily candles for the incumbent and the next two contracts of its
 *      cycle (it comes first even where it is not itself a cycle contract,
 *      such as a GC odd month, so its volume is always read).
 *   3. Faults, named with the root, before anything is stored:
 *        - no candle at all for the incumbent: it has traded every session of
 *          the month, and UW answers a fault with an empty body;
 *        - a stale feed (the freshness check below).
 *   4. The rows for trade dates before the current one go to
 *      `insertContractVolumes` (DO NOTHING, so a session uw-stream tallied
 *      keeps its tally). The running session's row is dropped: its volume is
 *      partial and the next decision reads this table.
 *
 * Freshness: UW may not have filed the last finished session's candle when
 * a decision is made, and the decision would then be made from the session
 * before it, for good. So the incumbent's newest candle before the current
 * trade date must reach the last session the root has bars for: the trade
 * date of its latest `futures_bars` row before the current session opened.
 * That date, not the calendar, is the yardstick, so a weekend or a holiday
 * needs no allowance: Monday's last session is Friday. A root with no bars
 * before the current session has nothing to measure against; the check is
 * skipped and logged.
 *
 * Errors from UW, the daily-candle parser and the database pass through
 * unchanged; the ones raised here name the root. Nothing is stored for a
 * root that fails.
 */

import { getDb, withDbRetry } from './db.js';
import {
  cmeTradeDate,
  nullSeedContract,
  parseContract,
  type FuturesRoot,
} from './futures-contracts.js';
import {
  cycleContracts,
  fetchDailyContractVolumes,
} from './futures-daily-candles.js';
import {
  fetchStoredFrontMonths,
  insertContractVolumes,
} from './futures-front-month.js';
import logger from './logger.js';

// How far back from the current trade date the incumbent is looked for.
const INCUMBENT_LOOKBACK_DAYS = 30;
// The contracts read per root: the incumbent and the next two in its cycle,
// searched within this many months after the incumbent's month.
const REFRESH_CONTRACTS = 3;
const REFRESH_SPAN_MONTHS = 12;

const DAY_MS = 86_400_000;

/** What one refresh read and stored. */
export interface VolumeRefresh {
  /** The contracts whose candles were read, the incumbent first. */
  contracts: string[];
  /** Rows given to `insertContractVolumes`: sessions before the current one. */
  offered: number;
  /** Rows it inserted; the rest were already stored. */
  inserted: number;
}

/** `date` (`YYYY-MM-DD`) moved by whole days. */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The incumbent and the next contracts of its cycle, `REFRESH_CONTRACTS` in
 * all: the cycle contracts from the incumbent's contract month to
 * `REFRESH_SPAN_MONTHS` later.
 */
function refreshContracts(
  root: FuturesRoot,
  incumbent: string,
  tradeDate: string,
): string[] {
  const expiry = parseContract(root, incumbent, tradeDate);
  if (expiry == null) {
    throw new Error(`the incumbent ${incumbent} is not an outright ${root}`);
  }
  const month = expiry.year * 12 + expiry.month - 1;
  const label = (index: number) =>
    `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  const cycle = cycleContracts(
    root,
    label(month),
    label(month + REFRESH_SPAN_MONTHS),
  );
  return [incumbent, ...cycle.filter((c) => c !== incumbent)].slice(
    0,
    REFRESH_CONTRACTS,
  );
}

/**
 * The instant the session of `tradeDate` opens: 17:00 CT the evening before,
 * 22:00Z while Chicago is on daylight time and 23:00Z on standard time.
 */
function sessionOpen(tradeDate: string): string {
  const evening = shiftDate(tradeDate, -1);
  const summer = `${evening}T22:00:00.000Z`;
  return cmeTradeDate(summer) === tradeDate
    ? summer
    : `${evening}T23:00:00.000Z`;
}

/**
 * The trade date of the root's latest bar before the session of
 * `tradeDate` opened, or null when it has none. One indexed read on
 * (symbol, ts).
 */
async function lastSessionWithBars(
  root: FuturesRoot,
  tradeDate: string,
): Promise<string | null> {
  const sql = getDb();
  const open = sessionOpen(tradeDate);
  const rows = (await withDbRetry(
    () => sql`
      SELECT ts
      FROM futures_bars
      WHERE symbol = ${root} AND ts < ${open}::timestamptz
      ORDER BY ts DESC
      LIMIT 1
    `,
    2,
    10_000,
  )) as Array<{ ts: Date | string }>;
  const latest = rows[0]?.ts;
  return latest == null ? null : cmeTradeDate(new Date(latest).toISOString());
}

/**
 * Reads `root`'s daily candles over `range` (a value UW accepts, such as
 * `1m`) for the incumbent and the next two contracts of its cycle and
 * stores the finished sessions' volume. Returns what was read and stored.
 *
 * Throws, naming the root, when the incumbent is no outright of it, when no
 * candle comes back for the incumbent, and when the incumbent's newest candle
 * is older than the root's last session (see the module comment). UW, parser
 * and database errors pass through. Nothing is stored for a root that throws.
 */
export async function refreshFrontMonthVolumes(
  apiKey: string,
  root: FuturesRoot,
  range: string,
): Promise<VolumeRefresh> {
  const current = cmeTradeDate(new Date().toISOString());
  const stored = await fetchStoredFrontMonths(
    root,
    shiftDate(current, -INCUMBENT_LOOKBACK_DAYS),
    current,
  );
  // Oldest first, so the last entry is the latest decision.
  const incumbent =
    [...stored.values()].at(-1) ?? nullSeedContract(root, current);
  const contracts = refreshContracts(root, incumbent, current);

  const candles = await fetchDailyContractVolumes(
    apiKey,
    root,
    contracts,
    range,
  );
  const held = candles.filter((c) => c.contract === incumbent);
  if (held.length === 0) {
    throw new Error(
      `UW returned no daily candles for the ${root} incumbent ${incumbent}`,
    );
  }

  const finished = candles.filter((c) => c.tradeDate < current);
  const newest = held
    .map((c) => c.tradeDate)
    .filter((d) => d < current)
    .sort()
    .at(-1);
  const lastSession = await lastSessionWithBars(root, current);
  if (lastSession == null) {
    logger.info(
      { root, tradeDate: current },
      'Daily-candle freshness check skipped: the root has no bars before the current trade date',
    );
  } else if (newest == null || newest < lastSession) {
    throw new Error(
      `stale daily candles for ${root}: the newest ${incumbent} candle is ${newest ?? 'missing'}, the last session with bars is ${lastSession}`,
    );
  }

  const inserted = await insertContractVolumes(
    finished.map((c) => ({
      product: root,
      tradeDate: c.tradeDate,
      contract: c.contract,
      volume: c.volume,
    })),
  );
  return { contracts, offered: finished.length, inserted };
}
