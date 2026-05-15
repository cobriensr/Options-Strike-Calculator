/**
 * Zod schema for GET /api/greek-heatmap — per-ticker 0DTE Greek
 * heatmap data (top-5 strikes by |net gamma OI|, plus net flow).
 *
 * Restricts `ticker` to the alerts universe (V3 + EXTENDED, deduped)
 * so an unknown symbol fails fast with a clear 400 instead of
 * returning silent empty data. The universe must stay in sync with
 * the uw-stream `_LOTTERY_TICKERS` frozenset (uw-stream/src/config.py)
 * — both lists feed the same heatmap.
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

export const greekHeatmapQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters')
    .refine((t) => HEATMAP_TICKER_UNIVERSE.has(t), {
      message: 'ticker is not in the alerts universe',
    }),
});

export type GreekHeatmapQuery = z.infer<typeof greekHeatmapQuerySchema>;
