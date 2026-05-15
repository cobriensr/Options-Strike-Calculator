/**
 * Zod schema for GET /api/greek-heatmap — per-ticker Greek heatmap
 * data (ATM ± 50 strikes + top-5 by |net gamma OI| + net flow) for
 * the chosen 0DTE expiry date.
 *
 * Restricts `ticker` to the alerts universe (V3 + EXTENDED, deduped)
 * so an unknown symbol fails fast with a clear 400 instead of
 * returning silent empty data. The universe must stay in sync with
 * the uw-stream `_LOTTERY_TICKERS` frozenset (uw-stream/src/config.py).
 *
 * Optional `date` param (YYYY-MM-DD) drives historical lookups. The
 * 90-day floor matches the REST backfill window — older dates have no
 * data so we reject up front rather than returning silent empty.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md.
 */

import { z } from 'zod';

import {
  LOTTERY_EXTENDED_TICKERS,
  LOTTERY_V3_TICKERS,
} from '../lottery-finder.js';

const HEATMAP_TICKER_UNIVERSE = new Set<string>([
  ...LOTTERY_V3_TICKERS,
  ...LOTTERY_EXTENDED_TICKERS,
]);

// 90-day floor for historical lookups. Aligns with the one-shot REST
// backfill (scripts/backfill-strike-exposure-lottery.mjs) and the
// recurring 5-min cron's retention. Beyond this, no data exists.
const MAX_HISTORICAL_DAYS = 90;

function isWithin90Days(dateStr: string): boolean {
  const picked = new Date(`${dateStr}T12:00:00Z`);
  const oldest = new Date();
  oldest.setUTCDate(oldest.getUTCDate() - MAX_HISTORICAL_DAYS);
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return picked >= oldest && picked <= tomorrow;
}

export const greekHeatmapQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters')
    .refine((t) => HEATMAP_TICKER_UNIVERSE.has(t), {
      message: 'ticker is not in the alerts universe',
    }),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .refine(isWithin90Days, {
      message: 'date must be within the last 90 days',
    })
    .optional(),
});

export type GreekHeatmapQuery = z.infer<typeof greekHeatmapQuerySchema>;
