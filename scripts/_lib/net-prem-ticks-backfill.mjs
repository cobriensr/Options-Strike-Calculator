/**
 * The testable pieces of scripts/backfill-net-prem-ticks.mjs: the
 * (ticker, date) plan, the net-prem-ticks fetch and the batched INSERT.
 *
 * The generic pieces (the range flags, the market-hours refusal, the
 * trading days of a --from/--to range, the UW request throttle, the guarded
 * run loop and the per-day summary) live in backfill-cli.mjs and are
 * re-exported below under their old names, so the script and its tests
 * import them from here as before. `parseArgs` is backfill-cli.mjs's
 * parseRangeArgs: --from and --to go together, and --to can't be after
 * today. Both backfills fetch UW through uw-day-fetch.mjs.
 *
 * Spec: docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md (Phase 1).
 */

import { chunk, retryTransientDb } from './backfill-cli.mjs';
import { UW_BASE, fetchUwDayRows } from './uw-day-fetch.mjs';

export {
  UW_REQUESTS_PER_MINUTE,
  createRequestThrottle,
  marketHoursRefusal,
  parseRangeArgs as parseArgs,
  runTickerDays,
  selectDates,
  summarizeByDay,
  tradingDaysInRange,
} from './backfill-cli.mjs';

// ── Plan ───────────────────────────────────────────────────

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
