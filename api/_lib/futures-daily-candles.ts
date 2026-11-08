/**
 * Per-session contract volume from UW's daily futures candles, shared by
 * the front-month history seed and the gap cron's volume refresh. Plan:
 * `docs/superpowers/specs/2026-11-06-futures-session-front-month.md`.
 *
 *   - `cycleContracts` lists a root's contracts for a span of contract
 *     months, as canonical names (`ESZ6`, never `ESZ26`) in expiry order.
 *   - `fetchDailyContractVolumes` reads `GET /futures/{contract}/candles?
 *     interval=1d&range=<range>` for each and returns one row per contract
 *     and trade date. A candle's `date` is the CME trade date: its session
 *     runs 17:00 CT the evening before to 17:00 CT on it, the same sessions
 *     `cmeTradeDate` gives. `v` is the session's volume. UW still serves
 *     expired months (ESU6 from 07-07), and an unknown contract answers
 *     with an empty array, which is a contract with no history here.
 *
 * `range` stays a parameter. UW's operation page for the candles
 * (`PublicApi.FuturesController.candles`, read 2026-11-07) lists these
 * values: 1d, 3d, 5d, 1w, 1m, 3m, 6m, 1y, 5y. The seed passes `6m`. The page
 * does not say what each one means for `interval=1d`.
 *
 * The result can include the running session, whose volume is partial: a
 * caller stores only the trade dates before the current one
 * (`insertContractVolumes` refuses the rest).
 */

import { z } from 'zod';

import {
  CONTRACT_CYCLE,
  MONTH_CODES,
  canonicalContract,
  type FuturesRoot,
} from './futures-contracts.js';
import { UW_CONCURRENCY_CAP } from './uw-concurrency.js';
import { mapWithConcurrency, uwFetch, withRetry } from './uw-fetch.js';

/**
 * A one-digit year names one of ten consecutive years (the window
 * [ref - 1, ref + 8] in `futures-contracts.ts`). A list that spans more
 * would name two contracts alike.
 */
const ONE_DIGIT_YEAR_SPAN = 10;

const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The months since year 0 of a `YYYY-MM` string; throws on any other. */
function monthIndex(label: string, value: string): number {
  const match = YEAR_MONTH.exec(value);
  if (match == null) {
    throw new Error(
      `cycleContracts: ${label} ${JSON.stringify(value)} is not a month as YYYY-MM`,
    );
  }
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/**
 * The root's `CONTRACT_CYCLE` contracts whose contract month is in
 * [`fromMonth`, `toMonth`] (`YYYY-MM`, both included), as canonical names in
 * expiry order: ES from `2026-07` to `2027-03` is `ESU6`, `ESZ6`, `ESH7`
 * (ESH7 is March 2027, so `2027-02` as the end leaves it out). Throws on a
 * month that is not `YYYY-MM`, on a from month after the to month, and on a
 * span of more than ten years, which one-digit year names cannot tell apart.
 */
export function cycleContracts(
  root: FuturesRoot,
  fromMonth: string,
  toMonth: string,
): string[] {
  const from = monthIndex('fromMonth', fromMonth);
  const to = monthIndex('toMonth', toMonth);
  if (from > to) {
    throw new Error(
      `cycleContracts: ${root} fromMonth ${fromMonth} is after toMonth ${toMonth}`,
    );
  }
  const firstYear = Math.floor(from / 12);
  const lastYear = Math.floor(to / 12);
  if (lastYear - firstYear >= ONE_DIGIT_YEAR_SPAN) {
    throw new Error(
      `cycleContracts: ${root} ${fromMonth} to ${toMonth} spans more than ${ONE_DIGIT_YEAR_SPAN} years, which a one-digit year cannot name`,
    );
  }

  const names: string[] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    for (const code of CONTRACT_CYCLE[root]) {
      const index = year * 12 + MONTH_CODES.indexOf(code);
      if (index >= from && index <= to) {
        names.push(`${root}${code}${year % 10}`);
      }
    }
  }
  return names;
}

export interface DailyContractVolume {
  /** The canonical name, such as `ESZ6`. */
  contract: string;
  /** The CME trade date, `YYYY-MM-DD`. */
  tradeDate: string;
  /** Whole contracts traded in that session, 0 or more. */
  volume: number;
}

/** The two fields of a daily candle that are read; the rest is ignored. */
const dailyCandleSchema = z.object({
  date: z.iso.date(),
  v: z.number().int().nonnegative(),
});

/** The rows of one contract's payload, oldest trade date first. */
function parseDailyCandles(
  root: FuturesRoot,
  contract: string,
  payload: unknown,
): DailyContractVolume[] {
  const where = `fetchDailyContractVolumes: UW daily candles for ${root} contract ${contract}`;
  if (!Array.isArray(payload)) {
    throw new Error(
      `${where}: expected an array, got ${payload === null ? 'null' : typeof payload}`,
    );
  }
  const rows: DailyContractVolume[] = [];
  const dates = new Set<string>();
  for (const [i, raw] of payload.entries()) {
    const parsed = dailyCandleSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join('.') ?? '';
      throw new Error(
        `${where}: row ${i} is malformed (${field}: ${issue?.message ?? 'invalid'})`,
      );
    }
    const { date, v } = parsed.data;
    if (dates.has(date)) {
      throw new Error(`${where}: trade date ${date} comes twice`);
    }
    dates.add(date);
    rows.push({ contract, tradeDate: date, volume: v });
  }
  return rows.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
}

/**
 * One row per contract and trade date from the daily candles of each of
 * `contracts` over `range` (a value UW accepts, such as `6m`): contracts in
 * the order given, each one's trade dates ascending, rows of volume 0 kept.
 * One `uwFetch` call per contract, under `withRetry`, at most
 * `UW_CONCURRENCY_CAP` at once. Every contract must already be a canonical
 * outright of `root`; otherwise it throws before any call, naming it.
 *
 * Throws, naming the root and the contract, when a payload is not an array,
 * when a row has no valid `date` (a calendar date, `YYYY-MM-DD`) or `v` (a
 * whole number, 0 or more), and when a trade date comes twice. UW errors
 * propagate after `withRetry`'s retries and fail the whole call.
 */
export async function fetchDailyContractVolumes(
  apiKey: string,
  root: FuturesRoot,
  contracts: readonly string[],
  range: string,
): Promise<DailyContractVolume[]> {
  // A one-digit name is its own canonical name against any reference, and
  // no other spelling is, so the clock does not change the verdict.
  const ref = new Date().toISOString();
  for (const contract of contracts) {
    if (canonicalContract(root, contract, ref) !== contract) {
      throw new Error(
        `fetchDailyContractVolumes: expected a canonical ${root} contract (such as ${root}Z6, never ${root}Z26), got ${JSON.stringify(contract)}`,
      );
    }
  }

  const perContract = await mapWithConcurrency(
    contracts,
    UW_CONCURRENCY_CAP,
    async (contract) => {
      const payload: unknown = await withRetry(() =>
        uwFetch<unknown>(
          apiKey,
          `/futures/${contract}/candles?interval=1d&range=${encodeURIComponent(range)}`,
        ),
      );
      return parseDailyCandles(root, contract, payload);
    },
  );
  return perContract.flat();
}
