/**
 * Pure pieces of scripts/backfill-range-pos.mjs, kept here so they can be
 * tested: the selection window, the UW candle fetch, range_pos row mapping
 * and the month report.
 *
 * The generic pieces (argument parsing, the market-hours guard, chunking, a
 * small concurrency pool, the Neon retry and the failure/redact helpers)
 * live in backfill-cli.mjs and are re-exported below under their old names,
 * so the script and its tests import them from here as before.
 *
 * Plain `node` can't import the TypeScript originals (their relative
 * `./x.js` imports only resolve under a bundler, and uwFetch pulls in the
 * Redis limiter), so two things are mirrored here. Each is pinned to its
 * source by range-pos-backfill.test.mjs:
 *   - computeRangePos  ← api/_lib/uw-stock-candles.ts
 *   - CASH_INDEX_ROOTS ← api/_lib/constants.ts
 *
 * Spec: docs/superpowers/specs/range-pos-fix-and-backfill-2026-10-28.md
 * (Phase 2).
 *
 * The UW GET itself is uw-day-fetch.mjs's fetchUwDayRows, shared with the
 * net-prem-ticks backfill.
 */

import { chunk } from './backfill-cli.mjs';
import { ctDateStr } from './trading-days.mjs';
import { UW_BASE, fetchUwDayRows } from './uw-day-fetch.mjs';

export {
  chunk,
  isMarketHoursCt,
  parseArgs,
  redact,
  retryTransientDb,
  runPool,
  summarizeFailures,
} from './backfill-cli.mjs';

// ── Mirrors of the TypeScript sources ─────────────────────

/**
 * Cash-settled index roots. UW refuses their OHLC with a 422 (code
 * `cboe_index_access_missing`), so their fires stay NULL by design.
 * Mirror of CASH_INDEX_ROOTS in api/_lib/constants.ts.
 */
export const CASH_INDEX_ROOTS = Object.freeze([
  'SPXW',
  'SPX',
  'NDXP',
  'NDX',
  'RUTW',
  'RUT',
]);

/**
 * Exact port of computeRangePos in api/_lib/uw-stock-candles.ts:
 * (spot − low) / (high − low) over the candles whose start_time is at or
 * before the trigger, clamped to [0, 1]. Null when there's no such
 * candle, the range is flat, or the trigger or spot isn't a number.
 */
export function computeRangePos(candles, triggerTimeIso, spotAtFirst) {
  const triggerMs =
    triggerTimeIso instanceof Date
      ? triggerTimeIso.getTime()
      : new Date(triggerTimeIso).getTime();
  if (!Number.isFinite(triggerMs)) return null;

  let high = -Infinity;
  let low = Infinity;
  let sawCandle = false;
  for (const c of candles) {
    const ms = new Date(c.start_time).getTime();
    if (!Number.isFinite(ms) || ms > triggerMs) continue;
    sawCandle = true;
    const h = Number.parseFloat(c.high);
    const l = Number.parseFloat(c.low);
    if (Number.isFinite(h) && h > high) high = h;
    if (Number.isFinite(l) && l < low) low = l;
  }
  if (!sawCandle) return null;
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
    return null;
  }
  const pos = (spotAtFirst - low) / (high - low);
  if (!Number.isFinite(pos)) return null;
  return Math.max(0, Math.min(1, pos));
}

// ── Selection ──────────────────────────────────────────────

/**
 * Date bounds for the run. `before` is today's CT date: the selection
 * stops short of it so today's in-progress session (still being written
 * by the cron) is never touched. A session's CT and ET dates are the
 * same day, so this matches the ET `date` the cron stamps on each fire.
 */
export function selectionWindow({ from, to }) {
  return { from, to, before: ctDateStr() };
}

// ── Row mapping and batching ───────────────────────────────

/**
 * Map one ticker-day's NULL fires to UPDATE arrays. `id` is BIGSERIAL,
 * which Neon returns as a string; it's passed through untouched.
 * `spot` comes from `spot_at_first::float8`; a NULL spot stays NULL.
 */
export function rangePosUpdates(fires, candles) {
  const ids = [];
  const positions = [];
  let leftNull = 0;
  for (const fire of fires) {
    const spot = fire.spot == null ? Number.NaN : Number(fire.spot);
    const pos = computeRangePos(candles, fire.trigger_time_ct, spot);
    if (pos == null) {
      leftNull++;
      continue;
    }
    ids.push(fire.id);
    positions.push(pos);
  }
  return { ids, positions, leftNull };
}

/**
 * Split the pending UPDATE rows into write chunks. Only full chunks are
 * taken until `final`, when the partial tail goes too. Pure: returns the
 * chunks and the rows left over, and doesn't touch `pending`.
 */
export function takeReadyChunks(pending, size, final) {
  const { ids, positions } = pending;
  if (ids.length !== positions.length) {
    throw new Error(
      `pending rows out of step: ${ids.length} ids but ${positions.length} positions`,
    );
  }
  const ready = final ? ids.length : ids.length - (ids.length % size);
  if (ready === 0) return { chunks: [], rest: pending };
  const idChunks = chunk(ids.slice(0, ready), size);
  const positionChunks = chunk(positions.slice(0, ready), size);
  return {
    chunks: idChunks.map((chunkIds, k) => ({
      ids: chunkIds,
      positions: positionChunks[k],
    })),
    rest: { ids: ids.slice(ready), positions: positions.slice(ready) },
  };
}

// ── Unusual Whales ─────────────────────────────────────────

/** Explicit UA: UW turns away some default client UAs (Python-urllib). */
export const UW_USER_AGENT = 'strike-calculator-range-pos-backfill (node)';

/**
 * One UW 1-min OHLC call for a ticker-day (fetchUwDayRows: retries once,
 * after 1 s, on a 5xx, a 429, a network error or a timeout; a definite 4xx
 * or a malformed body is final). Never throws:
 *   { kind: 'ok', candles } | { kind: 'empty' }
 *   | { kind: 'error', status: 'http_<n>' | 'network' | 'timeout' | 'malformed', detail }
 */
export async function fetchDayCandles(apiKey, ticker, date) {
  const url = `${UW_BASE}/stock/${encodeURIComponent(ticker)}/ohlc/1m?date=${date}`;
  const outcome = await fetchUwDayRows(url, apiKey, {
    rowField: 'start_time',
    rowLabel: 'candle',
    userAgent: UW_USER_AGENT,
  });
  return outcome.kind === 'ok'
    ? { kind: 'ok', candles: outcome.rows }
    : outcome;
}

// ── Report ─────────────────────────────────────────────────

/**
 * Line up the per-month counts taken before and after the run. `after`
 * is null on a dry run, which reads as nothing filled. Rows come from
 * `COUNT(...)::int`, so they're already numbers.
 */
export function mergeMonthCounts(before, after) {
  const afterByMonth = new Map((after ?? []).map((row) => [row.month, row]));
  return before.map((row) => {
    const nullAfter =
      after == null
        ? row.null_all
        : (afterByMonth.get(row.month)?.null_all ?? 0);
    return {
      month: row.month,
      fires: row.fires,
      nullBefore: row.null_all,
      nullAfter,
      filled: row.null_all - nullAfter,
      nullIndex: row.null_index,
    };
  });
}
