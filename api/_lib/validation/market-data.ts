/**
 * Zod schemas for the UW / market-flow query endpoints (zero-gamma,
 * greek-flow, gex-strike-expiry, dealer-regime, IV anomalies + cross
 * asset, strike-trade-volume, net-flow-history, ticker-candles).
 */

import { z } from 'zod';
import { STRIKE_IV_TICKERS } from '../constants.js';

// ============================================================
// /api/zero-gamma
// ============================================================

/**
 * Query params for GET /api/zero-gamma.
 *
 * `ticker` is optional — defaults to 'SPX' (the MVP scope of the zero-gamma
 * cron). Uppercase [A-Z] only, 1-5 chars, so an arbitrary string can't be
 * used to probe the table for unexpected rows.
 *
 * `date` is optional — when provided, the endpoint returns only the rows
 * whose `ts` (after conversion to America/New_York) matches the requested
 * ET calendar date. When omitted, returns the most recent 100 rows.
 * Used by the frontend ZeroGammaPanel to scrub historical days.
 */
export const zeroGammaQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,5}$/, 'ticker must be 1-5 uppercase letters')
    .optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type ZeroGammaQuery = z.infer<typeof zeroGammaQuerySchema>;

// ============================================================
// /api/greek-flow
// ============================================================

/**
 * Query params for GET /api/greek-flow.
 *
 * Returns the SPY+QQQ session of UW Greek flow with Postgres-computed
 * cumulative columns plus derived metrics (slope / flip / cliff /
 * divergence). `date` defaults to the latest ET trading date present
 * in `vega_flow_etf` when omitted.
 *
 * `scope` selects which expiry slice to read:
 *   - `0dte` (default) — only rows where `expiry = date` (today's expiry).
 *   - `all`            — only rows where `expiry IS NULL` (all-expiries
 *                        aggregate from the unfiltered greek-flow endpoint).
 *
 * The two scopes are stored as separate rows in `vega_flow_etf` (added in
 * migration #129) so cumulative window-function output never blends them.
 */
export const greekFlowQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  scope: z.enum(['0dte', 'all']).default('0dte'),
});

export type GreekFlowQuery = z.infer<typeof greekFlowQuerySchema>;
export type GreekFlowScope = GreekFlowQuery['scope'];

// ============================================================
// /api/gex-strike-expiry
// ============================================================

/**
 * Query params for GET /api/gex-strike-expiry — backs the Strike
 * Battle Map panel. `expiry` is required because the underlying table
 * has rows for many expiries; we always pin one. `at` is optional
 * (used by the historical scrubber to snapshot mid-session).
 */
export const gexStrikeExpiryQuerySchema = z.object({
  ticker: z.enum(['SPY', 'QQQ', 'SPX', 'NDX']),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be YYYY-MM-DD'),
  at: z.string().datetime({ offset: true }).optional(),
});

export type GexStrikeExpiryQuery = z.infer<typeof gexStrikeExpiryQuerySchema>;

// ============================================================
// /api/dealer-regime
// ============================================================

/**
 * Query params for GET /api/dealer-regime — backs the Dealer Regime
 * Tile (Phase 2 of strike-battle-map). Both params are optional:
 *   - `date=YYYY-MM-DD` filters to a specific ET calendar date
 *   - `at=<ISO timestamp>` returns the latest row per ticker at-or-before
 *     this timestamp (used by the historical scrubber)
 * No params ⇒ latest row per ticker (live mode). Strict object so any
 * unknown query key produces a clean 400 instead of being silently
 * ignored.
 */
export const dealerRegimeQuerySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type DealerRegimeQuery = z.infer<typeof dealerRegimeQuerySchema>;

// ============================================================
// /api/pin-setup-status
// ============================================================

/**
 * GET /api/pin-setup-status query params.
 *
 * Two modes:
 *   - Live (no params): evaluates the latest 0DTE snapshot available.
 *   - Historical (`date=YYYY-MM-DD`): evaluates the snapshot at the
 *     first row >= 09:30 CT on that date and attaches an `outcome`
 *     field carrying the day's settle and delta-to-magnet.
 *
 * Strict object — unknown params produce a clean 400.
 */
export const pinSetupQuerySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
  })
  .strict();

export type PinSetupQuery = z.infer<typeof pinSetupQuerySchema>;

// ============================================================
// /api/iv-anomalies
// ============================================================

/**
 * Query params for GET /api/iv-anomalies.
 *
 * Two modes, distinguished by the presence of `strike`/`side`/`expiry`:
 *
 *  1. **List mode** (no strike): returns `{ latest, history }` grouped by
 *     ticker. `ticker` narrows to a single ticker; omitting it returns
 *     every ticker in STRIKE_IV_TICKERS. `limit` caps `history` length
 *     (default 100, max 500) and serves as an upper bound across all
 *     tickers when no ticker is supplied.
 *
 *  2. **Per-strike history mode** (strike + side + expiry present): returns
 *     the per-strike IV time series from `strike_iv_snapshots` for the last
 *     `limit` samples. Feeds the Phase 3 StrikeIVChart.
 *
 * `ticker` is gated to STRIKE_IV_TICKERS — the only tickers ingested by
 * `fetch-strike-iv`. Anything else would guarantee an empty response
 * and is rejected here to surface client bugs early.
 *
 * `expiry` is a YYYY-MM-DD calendar date; the column is `DATE` so we
 * keep the string shape pinned rather than parsing into a Date.
 *
 * `side` is required whenever `strike` is present — a strike isn't
 * addressable without call/put.
 */
export const ivAnomaliesQuerySchema = z
  .object({
    ticker: z.enum(STRIKE_IV_TICKERS).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    strike: z.coerce.number().positive().finite().optional(),
    side: z.enum(['call', 'put']).optional(),
    expiry: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be YYYY-MM-DD')
      .optional(),
    /**
     * Replay anchor. When present, the endpoint filters list-mode
     * results to rows where `ts <= at AND ts >= at - 24h`. The hook
     * then re-runs aggregation against this timestamp instead of
     * `Date.now()` so the silence-eviction logic produces the exact
     * active-set the user would have seen at T.
     *
     * Spec: docs/superpowers/specs/iv-anomaly-replay-2026-04-25.md
     */
    at: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (v) => {
      // History mode requires all three: strike + side + expiry + ticker.
      const historyFields = [v.strike, v.side, v.expiry];
      const present = historyFields.filter((f) => f != null).length;
      if (present === 0) return true;
      if (present !== 3) return false;
      // A strike without a ticker is ambiguous across indices.
      return v.ticker != null;
    },
    {
      message:
        'strike+side+expiry+ticker must all be present for per-strike history',
      path: ['strike'],
    },
  );

export type IVAnomaliesQuery = z.infer<typeof ivAnomaliesQuerySchema>;

// ============================================================
// /api/strike-trade-volume
// ============================================================

/**
 * Query params for GET /api/strike-trade-volume.
 *
 * Serves the bid-side-surge exit signal in `useIVAnomalies`. Two modes:
 *   - Bulk: ticker + since → all strikes' tape data since timestamp
 *   - Single-key: ticker + strike + side + since → one compound key
 */
export const strikeTradeVolumeQuerySchema = z
  .object({
    ticker: z.enum(STRIKE_IV_TICKERS),
    since: z.string().datetime({ offset: true }),
    strike: z.coerce.number().positive().finite().optional(),
    side: z.enum(['call', 'put']).optional(),
  })
  .refine(
    (v) => {
      // Single-key mode requires both strike + side; bulk mode requires neither.
      const present = [v.strike, v.side].filter((f) => f != null).length;
      return present === 0 || present === 2;
    },
    {
      message: 'strike + side must both be present for single-key mode',
      path: ['strike'],
    },
  );

export type StrikeTradeVolumeQuery = z.infer<
  typeof strikeTradeVolumeQuerySchema
>;

// ============================================================
// /api/iv-anomalies/cross-asset
// ============================================================

/**
 * POST body for /api/iv-anomalies/cross-asset.
 *
 * Bulk endpoint — takes a list of compound keys + alert timestamps,
 * returns the cross-asset confluence context per key. Used by
 * `useAnomalyCrossAsset` to drive the regime / tape-align / DP-cluster /
 * GEX-zone / VIX-direction pills introduced in Phase F.
 *
 * Bulk shape avoids the N+1 fan-out that would otherwise hit our
 * Neon connection pool on a busy day.
 */
export const ivAnomaliesCrossAssetBodySchema = z.object({
  keys: z
    .array(
      z.object({
        ticker: z.enum(STRIKE_IV_TICKERS),
        strike: z.number().positive().finite(),
        side: z.enum(['call', 'put']),
        expiry: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be YYYY-MM-DD'),
        alertTs: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(200),
});

export type IVAnomaliesCrossAssetBody = z.infer<
  typeof ivAnomaliesCrossAssetBodySchema
>;

// ============================================================
// /api/net-flow-history
// ============================================================

/**
 * Query params for GET /api/net-flow-history.
 *
 * Backs the per-fire Net Flow panel inside LotteryFinderRow. Returns
 * the ticker's per-tick net call/put premium + volume time series
 * for the date plus the cumulative series computed via SQL
 * `SUM(...) OVER (PARTITION BY ticker, date ORDER BY ts)`.
 *
 * - `ticker` required, uppercase 1-8 chars. No universe enum — the
 *   daemon may subscribe to a superset later; an unknown ticker
 *   returns an empty rows array, not 400.
 * - `date` defaults to ET-today when omitted.
 * - `from` / `to` are optional HH:MM CT bounds inside the day.
 *   Default window is the full session 08:30 → 15:00 CT.
 */
export const netFlowHistoryQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters'),
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

export type NetFlowHistoryQuery = z.infer<typeof netFlowHistoryQuerySchema>;

// ============================================================
// /api/ticker-candles
// ============================================================

/**
 * Query params for GET /api/ticker-candles.
 *
 * Backs the per-fire Net Flow chart's stock-price overlay — given a
 * ticker + trading date, returns 1-minute regular-session candles
 * via Schwab pricehistory.
 *
 * - `ticker` required, uppercase 1-8 chars. Mirrors the net-flow
 *   schema; an unknown ticker may legitimately return an empty
 *   candles array (Schwab will 4xx, which we surface as 502).
 * - `date` defaults to ET-today when omitted.
 */
export const tickerCandlesQuerySchema = z.object({
  ticker: z
    .string()
    .regex(/^[A-Z]{1,8}$/, 'ticker must be 1-8 uppercase letters'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type TickerCandlesQuery = z.infer<typeof tickerCandlesQuerySchema>;
