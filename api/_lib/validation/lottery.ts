/**
 * Zod schemas for the /api/lottery-* and /api/silent-boom-* endpoint
 * families (LotteryFinder feed/export, SilentBoom feed/export, plus the
 * per-fire contract-tape view).
 */

import { z } from 'zod';

// ============================================================
// /api/lottery-finder
// ============================================================

/**
 * Query params for GET /api/lottery-finder.
 *
 * Backs the LotteryFinder feed component, the per-minute time
 * scrubber, and the paginated result set (50 per page by default).
 *
 * Time-window semantics (the slider can ask for either):
 *   - `minute` (ISO timestamp) — POINT-IN-TIME bucket. Returns fires
 *     whose `trigger_time_ct` falls inside `[minute, minute + 1 min)`.
 *     This is what the UI slider drives — drag to a minute, see what
 *     fired then.
 *   - `at` (ISO timestamp) — CUMULATIVE cutoff. Returns all fires
 *     with `trigger_time_ct <= at`. Kept for back-compat with the
 *     prior scrubber semantics; if both are provided, `minute` wins.
 *   - Neither set — returns the whole day (subject to filters + limit).
 *
 * Pagination:
 *   - `limit` defaults to 50 (one page). Max 200 — the UI uses
 *     prev/next buttons over `offset` rather than ever asking for
 *     thousands of rows in a single response.
 *   - `offset` is 0-based. UI computes `offset = pageIndex * limit`.
 *
 * Filters (each maps to a UI chip; all optional, all AND-combined):
 *   - `ticker` — single underlying symbol
 *   - `reload` / `cheapCallPm` — boolean discriminator flags
 *   - `mode` — Mode A (0DTE) or Mode B (DTE 1-3)
 *   - `optionType` — 'C' or 'P'
 *   - `tod` — time-of-day bucket (AM_open / MID / LUNCH / PM)
 */
export const lotteryFinderQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters')
    .optional(),
  reload: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) =>
      v === 'true' ? true : v === 'false' ? false : undefined,
    ),
  cheapCallPm: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) =>
      v === 'true' ? true : v === 'false' ? false : undefined,
    ),
  mode: z.enum(['A_intraday_0DTE', 'B_multi_day_DTE1_3']).optional(),
  optionType: z.enum(['C', 'P']).optional(),
  tod: z.enum(['AM_open', 'MID', 'LUNCH', 'PM']).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  // Cumulative cutoff (back-compat). When both `at` and `minute` are
  // present, the endpoint prefers `minute`.
  at: z.string().datetime({ offset: true }).optional(),
  // Point-in-time minute bucket — the UI slider drives this.
  minute: z.string().datetime({ offset: true }).optional(),
  // Pagination — 50 per page is the UI's default size.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Sort mode for the result set:
  //   - `chronological` (default, preserves prior behavior): ORDER BY
  //     trigger_time_ct DESC, id DESC
  //   - `score`: ORDER BY score DESC NULLS LAST, trigger_time_ct DESC
  //   - `peak`: ORDER BY peak_ceiling_pct DESC NULLS LAST, trigger_time_ct DESC
  sort: z.enum(['chronological', 'score', 'peak']).default('chronological'),
  // Minimum score floor (Tier 1 = 18). When set, the WHERE clause adds
  // `score >= minScore` so the High-Conviction filter can collapse the
  // visible feed.
  minScore: z.coerce.number().int().min(0).max(50).optional(),
  // Numeric premium floor in DOLLARS (entry_price * trigger_window_size * 100).
  // 0 = no floor. Server-side filter so pagination reflects the
  // post-filter count. Mirrors `minPremium` on /api/silent-boom-feed —
  // SilentBoom uses `spike_volume` for the window volume; the lottery
  // detector stamps the equivalent rolling window volume in
  // `trigger_window_size`. Multiplied by entry_price * 100 (contract
  // multiplier) yields the dollar premium deployed in the trigger
  // window.
  minPremium: z.coerce.number().min(0).max(1_000_000_000).optional(),
});

export type LotteryFinderQuery = z.infer<typeof lotteryFinderQuerySchema>;

// ============================================================
// /api/silent-boom-feed
// ============================================================

/**
 * Query params for GET /api/silent-boom-feed.
 *
 * Read endpoint backing the SilentBoomSection component. Filter
 * surface includes the `minScore` cut for the conviction-tier UX
 * — see api/_lib/silent-boom-score.ts.
 */
export const silentBoomFeedQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters')
    .optional(),
  optionType: z.enum(['C', 'P']).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  // Vol/OI floor — filter to the more-actionable spikes. Default 0
  // returns everything; UI defaults to 0.5.
  minVolOi: z.coerce.number().min(0).max(100).default(0),
  // Spike-ratio floor — same shape.
  minSpikeRatio: z.coerce.number().min(0).max(1000).default(0),
  // Score floor — Tier 1 = 21, Tier 2 = 8 (see SILENT_BOOM_TIER_THRESHOLDS).
  // The full observed range is roughly -22 to +33; the schema bounds
  // are loose so we don't have to update them when weights are recalibrated.
  minScore: z.coerce.number().int().min(-100).max(100).optional(),
  // Time-of-day bucket — narrows to a specific session phase. Mapped
  // server-side via CT minute-of-day boundaries that mirror
  // silentBoomTodFromMinuteCt() in api/_lib/silent-boom-score.ts.
  tod: z.enum(['AM_open', 'MID', 'LUNCH', 'PM', 'LATE']).optional(),
  // Days-to-expiry bucket — legacy enum kept for back-compat with any
  // saved query strings. New UI sends `minDte` (numeric floor) instead.
  // If both are present, `minDte` wins.
  dte: z.enum(['0', '1-3', '4+']).optional(),
  // Numeric DTE floor — 0 = all DTEs, N = only alerts with dte >= N.
  // Replaces the enum bucket so the user can sweep a custom range
  // (e.g. "1+" to include 1-3D and 4D+ together).
  minDte: z.coerce.number().int().min(0).max(10_000).optional(),
  // Numeric premium floor in DOLLARS (entry_price * spike_volume * 100).
  // 0 = no floor. Server-side filter so pagination reflects the
  // post-filter count.
  minPremium: z.coerce.number().min(0).max(1_000_000_000).optional(),
  // Hide alerts whose 5-min bucket is at or after 14:30 CT. Server-side
  // so pagination reflects the post-filter count (the client-side
  // version emptied pages when every alert on the current page fell
  // after the cutoff). 14:30 cutoff matches the trader's discretionary
  // exit window — moves can't develop in <30 min before close.
  hideLatePm: z.coerce.boolean().optional(),
  // Burst color category — matches the spike-ratio badge in
  // SilentBoomRow: 'red' = ≥50×, 'yellow' = 20-50×, 'grey' = <20×.
  // Visual-intensity ordering (NOT empirical-lift ordering — see
  // audit; smaller ratios actually score better historically).
  burst: z.enum(['red', 'yellow', 'grey']).optional(),
  // Ask% band — analytical slice of the 5 ask_pct buckets that
  // motivated the saturation-penalty work in
  // docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md.
  // '100' is exact equality (ask_pct = 1.0) — that's the cliff bucket
  // where win > 0% drops from ≥99% to 77%. The other 4 are half-open
  // ranges. UI default is no filter.
  askPctBand: z.enum(['70-80', '80-90', '90-95', '95-99', '100']).optional(),
  // Aggressive Premium toggle — mirrors the trader's UW filter
  // (premium ≥ $100K, DTE ≤ 8, vol/OI > 1, single-leg, OTM).
  // When true, ALL of these constraints AND together with the other
  // filters on this schema. Rows without underlying_price_at_spike
  // (#152) are excluded from the OTM check. See spec
  // docs/superpowers/specs/aggressive-premium-chip-2026-05-15.md.
  aggressivePremium: z.coerce.boolean().optional(),
  // Pagination.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Sort: newest (bucket_ct DESC), spike_ratio DESC, vol_oi DESC, peak DESC.
  sort: z.enum(['newest', 'spike_ratio', 'vol_oi', 'peak']).default('newest'),
});

export type SilentBoomFeedQuery = z.infer<typeof silentBoomFeedQuerySchema>;

/**
 * Query params for GET /api/silent-boom-export.
 *
 * Owner-only EOD CSV / JSON dump of `silent_boom_alerts` for one
 * trading day. Same filter shape as the feed endpoint minus
 * pagination + sort (the spreadsheet always sorts chronologically
 * for top-to-bottom reading).
 */
export const silentBoomExportQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters')
    .optional(),
  optionType: z.enum(['C', 'P']).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  minVolOi: z.coerce.number().min(0).max(100).default(0),
  minSpikeRatio: z.coerce.number().min(0).max(1000).default(0),
  minScore: z.coerce.number().int().min(-100).max(100).optional(),
  tod: z.enum(['AM_open', 'MID', 'LUNCH', 'PM', 'LATE']).optional(),
  dte: z.enum(['0', '1-3', '4+']).optional(),
  burst: z.enum(['red', 'yellow', 'grey']).optional(),
  askPctBand: z.enum(['70-80', '80-90', '90-95', '95-99', '100']).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
});

export type SilentBoomExportQuery = z.infer<typeof silentBoomExportQuerySchema>;

// ============================================================
// /api/lottery-export
// ============================================================

/**
 * Query params for GET /api/lottery-export.
 *
 * Owner-only EOD CSV/JSON dump of `lottery_finder_fires` for one day.
 * Mirrors the filter surface of `lotteryFinderQuerySchema` so the UI
 * can pass the active feed filters straight through, but drops the
 * pagination / sort / scrubber knobs — exports always return every
 * matching row in chronological order.
 */
export const lotteryExportQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters')
    .optional(),
  reload: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) =>
      v === 'true' ? true : v === 'false' ? false : undefined,
    ),
  cheapCallPm: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) =>
      v === 'true' ? true : v === 'false' ? false : undefined,
    ),
  mode: z.enum(['A_intraday_0DTE', 'B_multi_day_DTE1_3']).optional(),
  optionType: z.enum(['C', 'P']).optional(),
  tod: z.enum(['AM_open', 'MID', 'LUNCH', 'PM']).optional(),
  minScore: z.coerce.number().int().min(0).max(50).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
});

export type LotteryExportQuery = z.infer<typeof lotteryExportQuerySchema>;

// ============================================================
// /api/lottery-contract-tape
// ============================================================

/**
 * Query params for GET /api/lottery-contract-tape.
 *
 * Backs the per-fire contract panel inside LotteryFinderRow.
 * Returns per-minute aggregated bid/ask/mid volume + price stats for
 * one OCC option chain on one date. Read from ws_option_trades.
 *
 * - `chain` is the OCC symbol — required, A-Z + digits only.
 * - `date` defaults to ET-today.
 * - `from` / `to` are optional HH:MM CT bounds.
 */
export const lotteryContractTapeQuerySchema = z.object({
  chain: z
    .string()
    .regex(/^[A-Z0-9]{1,32}$/, 'chain must be an OCC symbol (A-Z + digits)'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  from: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'from must be HH:MM CT')
    .optional(),
  to: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'to must be HH:MM CT')
    .optional(),
});

export type LotteryContractTapeQuery = z.infer<
  typeof lotteryContractTapeQuerySchema
>;

// ============================================================
// /api/silent-boom-ticker-counts
// ============================================================

/**
 * Query params for GET /api/silent-boom-ticker-counts.
 *
 * Backs the ticker-rollup chip strip above SilentBoomSection. Returns
 * one row per underlying with the count of matching alerts, the best
 * realized peak%, and the latest bucket time — across the whole day
 * regardless of pagination. The UI uses it to surface tickers that
 * fired on pages other than the current one.
 *
 * Filter surface mirrors `silentBoomFeedQuerySchema` minus `ticker`
 * (the chip strip is the ticker selector — passing one would collapse
 * the response to a single row), pagination, and `sort`.
 */
export const silentBoomTickerCountsQuerySchema = z.object({
  optionType: z.enum(['C', 'P']).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  minVolOi: z.coerce.number().min(0).max(100).default(0),
  minSpikeRatio: z.coerce.number().min(0).max(1000).default(0),
  minScore: z.coerce.number().int().min(-100).max(100).optional(),
  tod: z.enum(['AM_open', 'MID', 'LUNCH', 'PM', 'LATE']).optional(),
  dte: z.enum(['0', '1-3', '4+']).optional(),
  minDte: z.coerce.number().int().min(0).max(10_000).optional(),
  minPremium: z.coerce.number().min(0).max(1_000_000_000).optional(),
  hideLatePm: z.coerce.boolean().optional(),
  burst: z.enum(['red', 'yellow', 'grey']).optional(),
  askPctBand: z.enum(['70-80', '80-90', '90-95', '95-99', '100']).optional(),
});

export type SilentBoomTickerCountsQuery = z.infer<
  typeof silentBoomTickerCountsQuerySchema
>;

// ============================================================
// /api/lottery-finder-ticker-counts
// ============================================================

/**
 * Query params for GET /api/lottery-finder-ticker-counts.
 *
 * Same role as the silent-boom equivalent: chip strip data source.
 * Filter surface mirrors `lotteryFinderQuerySchema` minus `ticker`,
 * pagination, sort, and the time-window scrubber (`at` / `minute`) —
 * the strip is always whole-day so the user sees every ticker that
 * fired regardless of where the scrubber sits.
 *
 * Chain-day dedup applies: a chain that fires 250×TSLA-392.5C in one
 * day counts as 1 toward TSLA's total, matching the row-level dedup
 * in /api/lottery-finder so the chip count equals what the user sees.
 */
export const lotteryFinderTickerCountsQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  reload: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) =>
      v === 'true' ? true : v === 'false' ? false : undefined,
    ),
  cheapCallPm: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) =>
      v === 'true' ? true : v === 'false' ? false : undefined,
    ),
  mode: z.enum(['A_intraday_0DTE', 'B_multi_day_DTE1_3']).optional(),
  optionType: z.enum(['C', 'P']).optional(),
  tod: z.enum(['AM_open', 'MID', 'LUNCH', 'PM']).optional(),
  minScore: z.coerce.number().int().min(0).max(50).optional(),
  /** Dollar floor on premium = entry_price * trigger_window_size * 100.
   *  Mirrors the same filter on `lotteryFinderQuerySchema` so the chip
   *  ticker counts stay consistent with the filtered feed. */
  minPremium: z.coerce.number().min(0).max(1_000_000_000).optional(),
});

export type LotteryFinderTickerCountsQuery = z.infer<
  typeof lotteryFinderTickerCountsQuerySchema
>;
