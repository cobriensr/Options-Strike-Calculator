/**
 * Thin UW client + session-range computation for stock 1-min OHLC.
 *
 * Used by `detect-lottery-fires` and `scripts/backfill-range-pos.mjs`
 * to compute each lottery fire's position within its underlying's
 * session range at trigger time — the "Range Kill" signal from the
 * 2026-05-15 cross-section EDA.
 *
 * UW endpoint: GET /stock/{ticker}/ohlc/1m?date=YYYY-MM-DD
 */

import { uwFetch } from './api-helpers.js';

export interface UWStockCandle {
  /** ISO timestamp at the start of the 1-min bucket. */
  start_time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: number;
}

/**
 * Fetch 1-min OHLC for one stock × date. `[]` means UW has no candles
 * for that day; every failure throws instead:
 *   - non-2xx → uwFetch's `UW API <status>: <body>`, where the body is
 *     UW's JSON error: an empty key (sent as `Bearer `) gets a 401
 *     `{"code":"authentication_required",…,"reason":"malformed_token"}`,
 *     an index ticker a 422 with code `cboe_index_access_missing`
 *   - network / timeout → the fetch error
 *   - a 200 whose body isn't JSON → the SyntaxError from `res.json()`
 *   - `data` not an array of candles → `UW stock candles malformed: …`
 *
 * A null or missing `data` comes back as [] (uwFetch coalesces both,
 * and Sentry-flags a missing one), so it reads as an empty day, which
 * detect-lottery-fires reports on its own.
 *
 * This used to catch everything and return [], which hid a keyless
 * 401 on every lottery fire for months (spec
 * range-pos-fix-and-backfill-2026-10-28.md). A caller that must not
 * fail on a candle error (detect-lottery-fires) catches, counts and
 * reports it.
 */
export async function fetchStockCandles1m(
  apiKey: string,
  ticker: string,
  date: string,
): Promise<UWStockCandle[]> {
  // uwFetch returns `body.data` uncast, so check the shape here: a
  // non-array would otherwise reach computeRangePos and turn into a
  // silent null.
  const rows: unknown = await uwFetch<unknown>(
    apiKey,
    `/stock/${ticker}/ohlc/1m?date=${date}`,
  );
  if (!Array.isArray(rows)) {
    throw new Error(
      `UW stock candles malformed: data is ${typeof rows}, not an array`,
    );
  }
  const badIdx = rows.findIndex(
    (row: unknown) =>
      typeof row !== 'object' ||
      row === null ||
      typeof (row as { start_time?: unknown }).start_time !== 'string',
  );
  if (badIdx !== -1) {
    throw new Error(
      `UW stock candles malformed: candle ${badIdx} has no start_time`,
    );
  }
  return rows as UWStockCandle[];
}

/**
 * Compute (spot − low) / (high − low) over the prefix of candles
 * whose `start_time` is at or before `triggerTimeIso`. Returns null
 * when:
 *   - candles is empty
 *   - no candle's start_time is at or before the trigger time
 *   - session high ≤ session low (degenerate single-bar case)
 *
 * Clamped to [0, 1] — a spike print can briefly punch outside the
 * bar range, in which case range_pos saturates at 0 or 1 rather
 * than going negative or >1.
 */
export function computeRangePos(
  candles: UWStockCandle[],
  triggerTimeIso: string | Date,
  spotAtFirst: number,
): number | null {
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
