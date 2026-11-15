/**
 * The per-ticker prior-session win rates, kept in Upstash for one ET day.
 *
 * Take-It scores a fire with the ticker's mean daily win rate over the
 * earlier sessions (`priorSessionWinRatesForDay`, takeit-detect.ts). Loading
 * it is a parallel sequential scan of the whole `lottery_finder_fires` table,
 * 44-60 s on Neon, and its answer changes only with the ET date. The detect
 * crons kept it in module state, so every new Vercel instance paid the scan
 * again, and the Take-It prefetch's 5 s deadline passed each time (28 events
 * from 2026-10-29, 16 of them from instances started mid-session).
 *
 * Here the answer is stored once per alert type and ET day, so an instance
 * that finds the key skips the scan, and so does every later one. Only
 * lottery uses it (priorSessionWinRatesForDay, takeit-detect.ts): silent
 * boom's scan is small and loads from Neon directly.
 *
 *   key  takeit:winrates:v1:<alertType>:<YYYY-MM-DD ET>
 *   TTL  26 h. A key is read only on its own ET date, so any write on that
 *        date outlives it (a write at 08:25 ET lasts to 10:25 ET the next
 *        day); the next day's key is a different one. One key a day for
 *        lottery, so nothing piles up.
 *
 * Idempotent (R6): the key comes from the alert type and the date, never
 * from the clock, and two instances that both missed write the same value.
 * Best effort: a Redis failure reads as a miss and a write failure is
 * dropped, each with a warning, because Neon can always answer instead.
 * `limiterRedis` is the fail-fast client (one attempt, 1.5 s): a read that
 * hangs must not eat the prefetch's 5 s deadline.
 *
 * No module state here, so nothing outlives a request (R1).
 */

import { z } from 'zod';

import logger from './logger.js';
import { limiterRedis } from './redis.js';
import type { AlertType } from './takeit-features.js';

// Bump `v1` whenever the win-rate query or the row shape changes (a new
// column, a different aggregation, a new unit). A key outlives a deploy by up
// to 26 h, and a new deploy would otherwise read the old query's rows as its
// own for the rest of the day. A bump orphans the old keys, which expire.
const KEY_PREFIX = 'takeit:winrates:v1';
const TTL_SECONDS = 26 * 60 * 60;

// The rows `priorSessionWinRatesForDay` hands out (PriorWinRateRow in
// takeit-detect.ts). A payload that is not exactly this is not trusted: an
// empty list is refused too, because nothing writes one (see
// writeWinRateCache) and an answer of "no ticker has a win rate" would turn
// every Take-It win-rate feature into a missing value for the day. A win
// rate is a share of fires, so it lies in 0-1 (the same bound as
// lottery-weights-schema.ts's win_rate): a value outside it is a corrupt
// row, and one cached row would feed the scorer a number it never saw for
// the whole day.
const WinRateRowsSchema = z
  .array(
    z.object({
      underlying_symbol: z.string(),
      win_rate: z.number().min(0).max(1).nullable(),
    }),
  )
  .min(1);

export type CachedWinRateRows = z.infer<typeof WinRateRowsSchema>;

export function winRateCacheKey(alertType: AlertType, day: string): string {
  return `${KEY_PREFIX}:${alertType}:${day}`;
}

/**
 * The day's cached rows, or null on a miss. A Redis failure or a payload that
 * does not parse is a miss too, with a warning; the caller loads from Neon.
 * Never throws.
 */
export async function readWinRateCache(
  alertType: AlertType,
  day: string,
): Promise<CachedWinRateRows | null> {
  const key = winRateCacheKey(alertType, day);
  let cached: unknown;
  try {
    cached = await limiterRedis.get<unknown>(key);
  } catch (err) {
    logger.warn(
      { err, key },
      'takeit win-rate cache: read failed; loading from Neon',
    );
    return null;
  }
  if (cached == null) return null;
  const parsed = WinRateRowsSchema.safeParse(cached);
  if (!parsed.success) {
    logger.warn(
      { key, issues: parsed.error.issues.slice(0, 3) },
      'takeit win-rate cache: unusable payload; loading from Neon',
    );
    return null;
  }
  return parsed.data;
}

/**
 * Keep the day's rows for the other instances. Writes nothing for an empty
 * answer: a load that came back empty may be a gap, and a cached `[]` would
 * stand for the whole day. A failure is logged and dropped; the caller
 * already has its rows. Never throws.
 */
export async function writeWinRateCache(
  alertType: AlertType,
  day: string,
  rows: CachedWinRateRows,
): Promise<void> {
  if (rows.length === 0) return;
  const key = winRateCacheKey(alertType, day);
  try {
    await limiterRedis.set(key, rows, { ex: TTL_SECONDS });
  } catch (err) {
    logger.warn(
      { err, key },
      'takeit win-rate cache: write failed; the next instance will load from Neon',
    );
  }
}
