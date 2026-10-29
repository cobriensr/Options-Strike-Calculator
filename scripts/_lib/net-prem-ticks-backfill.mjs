/**
 * The testable pieces of scripts/backfill-net-prem-ticks.mjs: argument
 * parsing, the market-hours refusal, the trading days of a --from/--to
 * range, the (ticker, date) plan, the UW request throttle, the
 * net-prem-ticks fetch, the batched INSERT, the guarded run loop and the
 * per-day summary.
 *
 * The flags, the market-hours window, the worker pool, the chunking, the
 * Neon retry and the report helpers are scripts/backfill-range-pos.mjs's,
 * imported from range-pos-backfill.mjs so the two backfills behave alike;
 * both fetch UW through uw-day-fetch.mjs.
 *
 * Spec: docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md (Phase 1).
 */

import { isTradingDay } from '../../src/data/marketHours.ts';
import {
  chunk,
  isMarketHoursCt,
  parseArgs as parseBackfillArgs,
  retryTransientDb,
  runPool,
} from './range-pos-backfill.mjs';
import { ctDateStr, getTradingDays } from './trading-days.mjs';
import { UW_BASE, fetchUwDayRows } from './uw-day-fetch.mjs';

/**
 * UW requests a minute, at most. The spec's ceiling: the live crons keep
 * the rest of the key's per-minute cap.
 */
export const UW_REQUESTS_PER_MINUTE = 300;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ── Arguments and dates ────────────────────────────────────

/**
 * Parse the CLI flags. They are the range-pos backfill's (--dry-run,
 * --allow-market-hours, --limit N ticker-days, --from, --to), plus two
 * rules of this script's: --from and --to go together (with neither, the
 * run keeps its original DAYS lookback), and --to can't be after today in
 * CT. Throws with a message naming the bad flag.
 */
export function parseArgs(argv) {
  const args = parseBackfillArgs(argv);
  if ((args.from == null) !== (args.to == null)) {
    throw new Error(
      '--from and --to go together: pass both for a date range, or ' +
        'neither for the DAYS lookback',
    );
  }
  const today = ctDateStr();
  if (args.to != null && args.to > today) {
    throw new Error(`--to ${args.to} is after today (${today} CT)`);
  }
  return args;
}

/**
 * The refusal to print when the run would start 08:15–15:30 CT on a weekday
 * without --allow-market-hours, else null. Same window and reason as the
 * range-pos backfill: these UW calls skip the shared Redis semaphore, so
 * they compete with the live crons for the key's concurrency cap.
 */
export function marketHoursRefusal({ allowMarketHours }) {
  if (allowMarketHours || !isMarketHoursCt()) return null;
  return (
    'Refusing to run 08:15–15:30 CT on a weekday: the backfill would compete ' +
    "with the live crons for UW's concurrency cap. Run after the close, or " +
    'pass --allow-market-hours (e.g. on a market holiday).'
  );
}

/**
 * NYSE trading days from `from` to `to` (YYYY-MM-DD), inclusive, ascending:
 * weekdays that src/data/marketHours.ts doesn't list as full closures. That
 * list covers 2025–2027; outside it a holiday reads as a trading day, and
 * UW's empty answer then shows up in the per-day summary.
 */
export function tradingDaysInRange(from, to) {
  const days = [];
  // UTC noon steps by exactly one day: UTC has no DST.
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let ms = Date.parse(`${from}T12:00:00Z`); ms <= end; ms += ONE_DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (isTradingDay(day)) days.push(day);
  }
  return days;
}

/**
 * The dates to fetch. With --from/--to: the range's trading days (throws
 * when it holds none). Without: the last `lookbackDays` weekdays ending
 * today, the script's original behavior (holidays included, as before).
 */
export function selectDates({ from, to }, lookbackDays) {
  if (from == null) {
    if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
      throw new Error(
        `DAYS must be a whole number of days, got ${lookbackDays}`,
      );
    }
    return { mode: 'lookback', dates: getTradingDays(lookbackDays) };
  }
  const dates = tradingDaysInRange(from, to);
  if (dates.length === 0) {
    throw new Error(`no trading days between --from ${from} and --to ${to}`);
  }
  return { mode: 'range', dates };
}

/**
 * The (ticker, date) pairs to fetch, date by date in `tickers` order.
 *
 * A lookback run keeps the original resume rule: skip a ticker's dates
 * before the newest date it already has (`maxDateByTicker`, YYYY-MM-DD),
 * unless `bypassResume`. A range run fetches every pair: that rule would
 * skip a whole past gap, and ON CONFLICT DO NOTHING makes a refetch safe.
 *
 * `limit` keeps the first N pairs; `planned` counts them all before it.
 */
export function planPairs({
  mode,
  dates,
  tickers,
  maxDateByTicker,
  bypassResume,
  limit,
}) {
  const all = [];
  let skipped = 0;
  for (const date of dates) {
    for (const ticker of tickers) {
      const maxDate = maxDateByTicker.get(ticker);
      if (
        mode === 'lookback' &&
        !bypassResume &&
        maxDate != null &&
        date < maxDate
      ) {
        skipped++;
        continue;
      }
      all.push({ ticker, date });
    }
  }
  return {
    pairs: limit == null ? all : all.slice(0, limit),
    planned: all.length,
    skipped,
  };
}

// ── Throttle ───────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A gate shared by every lane: each call resolves at least
 * ceil(60 000 / perMinute) ms after the previous one, so no 60 s window
 * [t, t + 60 s) holds more than `perMinute` starts. Await it before each
 * UW request, retries included. The slot is reserved before the first
 * await, so concurrent callers never share one.
 */
export function createRequestThrottle(perMinute) {
  if (!Number.isInteger(perMinute) || perMinute < 1) {
    throw new Error(`perMinute must be a whole number, got ${perMinute}`);
  }
  const spacingMs = Math.ceil(60_000 / perMinute);
  let nextStart = -Infinity;
  return async function waitForSlot() {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + spacingMs;
    if (start > now) await sleep(start - now);
  };
}

// ── Unusual Whales ─────────────────────────────────────────

/** Explicit UA: UW turns away some default client UAs (Python-urllib). */
export const UW_USER_AGENT = 'strike-calculator-net-prem-ticks-backfill (node)';

/**
 * One UW GET /stock/{ticker}/net-prem-ticks?date= for a ticker-day, through
 * fetchUwDayRows (uw-day-fetch.mjs): `waitForSlot()` (the throttle) before
 * every attempt, one retry after 1 s on a 5xx, a 429, a network error or a
 * timeout. Never throws:
 *   { kind: 'ok', rows } | { kind: 'empty' }
 *   | { kind: 'error', status: 'http_<n>' | 'network' | 'timeout' | 'malformed', detail }
 * A 4xx is an error, never an empty day: a date outside the plan's window
 * answers 403 (historic_data_access_missing) and must not read as "no data".
 */
export async function fetchNetPremTicks(apiKey, ticker, date, waitForSlot) {
  const url = `${UW_BASE}/stock/${encodeURIComponent(ticker)}/net-prem-ticks?date=${date}`;
  return fetchUwDayRows(url, apiKey, {
    rowField: 'tape_time',
    rowLabel: 'tick',
    userAgent: UW_USER_AGENT,
    waitForSlot,
  });
}

// ── Neon ───────────────────────────────────────────────────

/** `source` of the rows this backfill writes. */
export const NET_FLOW_SOURCE = 'rest';

/**
 * INSERT parsed ticks (backfill-net-prem-ticks.mjs parseRow) into
 * net_flow_per_ticker_history, `batchSize` rows per statement (sql.query:
 * the tagged template can't express a variable VALUES list), ON CONFLICT
 * (ticker, ts, source) DO NOTHING. Returns how many rows were new; a dry
 * run writes nothing and returns rows.length.
 *
 * A transient Neon error is retried (retryTransientDb); anything else
 * rejects and aborts the run, as in the range-pos backfill. A retry after a
 * lost response finds its rows already stored, so the count can read low,
 * never the data.
 */
export async function storeBatch(sql, rows, { batchSize, dryRun }) {
  if (dryRun || rows.length === 0) return rows.length;
  let stored = 0;
  for (const part of chunk(rows, batchSize)) {
    const placeholders = [];
    const values = [];
    for (const r of part) {
      const first = values.length + 1;
      values.push(
        r.ticker,
        r.ts,
        r.netCallPrem,
        r.netCallVol,
        r.netPutPrem,
        r.netPutVol,
        r.callVolume,
        r.callVolumeAsk,
        r.callVolumeBid,
        r.putVolume,
        r.putVolumeAsk,
        r.putVolumeBid,
        NET_FLOW_SOURCE,
      );
      const params = [];
      for (let n = first; n <= values.length; n++) params.push(`$${n}`);
      placeholders.push(`(${params.join(',')})`);
    }
    const queryText = `
      INSERT INTO net_flow_per_ticker_history (
        ticker, ts,
        net_call_prem, net_call_vol,
        net_put_prem, net_put_vol,
        call_volume, call_volume_ask_side, call_volume_bid_side,
        put_volume, put_volume_ask_side, put_volume_bid_side,
        source
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (ticker, ts, source) DO NOTHING
      RETURNING id
    `;
    const result = await retryTransientDb(() => sql.query(queryText, values));
    stored += Array.isArray(result)
      ? result.length
      : (result.rows?.length ?? 0);
  }
  return stored;
}

// ── Run ────────────────────────────────────────────────────

/**
 * Run `processPair` over `pairs`, `concurrency` at a time (runPool),
 * checking the market-hours guard before each ticker-day unless
 * `allowMarketHours`: a run started at 08:05 CT stops taking new
 * ticker-days at 08:15 (in-flight ones finish). Returns the refusal that
 * stopped it, or null when every pair ran. A processPair rejection rejects.
 */
export async function runTickerDays(
  pairs,
  { concurrency, allowMarketHours },
  processPair,
) {
  let stoppedBy = null;
  await runPool(pairs, concurrency, async (pair) => {
    stoppedBy ??= marketHoursRefusal({ allowMarketHours });
    if (stoppedBy != null) return;
    await processPair(pair);
  });
  return stoppedBy;
}

// ── Report ─────────────────────────────────────────────────

/**
 * Per-date totals for the report, ascending by date. Each result is one
 * ticker-day: { date, kind: 'ok' | 'empty' | 'error', fetched, kept, stored }.
 */
export function summarizeByDay(results) {
  const byDate = new Map();
  for (const r of results) {
    let day = byDate.get(r.date);
    if (!day) {
      day = {
        date: r.date,
        tickers: 0,
        ok: 0,
        empty: 0,
        failed: 0,
        fetched: 0,
        kept: 0,
        stored: 0,
      };
      byDate.set(r.date, day);
    }
    day.tickers++;
    if (r.kind === 'error') day.failed++;
    else if (r.kind === 'empty') day.empty++;
    else day.ok++;
    day.fetched += r.fetched;
    day.kept += r.kept;
    day.stored += r.stored;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
