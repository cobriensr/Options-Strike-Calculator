/**
 * Zod schemas for API request validation.
 *
 * Validates req.body at system boundaries before data reaches
 * the Anthropic API or Postgres. Rejects malformed payloads
 * early with clear error messages.
 */

import { z } from 'zod';
import { STRIKE_IV_TICKERS } from './constants.js';

// ============================================================
// /api/auth/guest-key
// ============================================================

/**
 * POST /api/auth/guest-key body.
 *
 * `key` is the shared access key generated locally (e.g. via
 * `openssl rand -base64 24`) and stored comma-separated in the
 * `GUEST_ACCESS_KEYS` env var. Min 8 / max 128 chars to discourage
 * trivial brute-force and bound the request payload.
 */
export const guestKeySchema = z.object({
  key: z.string().min(8).max(128),
});

export type GuestKeyBody = z.infer<typeof guestKeySchema>;

// ============================================================
// /api/spot-gex-history
// ============================================================

/**
 * Query params for GET /api/spot-gex-history.
 *
 * `date` is optional — when omitted the endpoint defaults to the latest
 * ET trading date that has rows in `spot_exposures`. When present it
 * must be a YYYY-MM-DD calendar date so we never feed arbitrary strings
 * into the SQL `date = $1` parameter.
 */
export const spotGexHistoryQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type SpotGexHistoryQuery = z.infer<typeof spotGexHistoryQuerySchema>;

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
 */
export const greekFlowQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type GreekFlowQuery = z.infer<typeof greekFlowQuerySchema>;

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
// /api/gamma-squeezes
// ============================================================

/**
 * Validation for `GET /api/gamma-squeezes` — sibling of the IV anomaly
 * endpoint. `ticker` narrows to one watchlist symbol; `limit` caps the
 * history depth. No history mode (per-strike replay) — gamma squeezes
 * are inherently a board view, not a per-strike chart.
 *
 * `at` enables point-in-time replay: when set, the handler returns
 * squeezes whose `ts` falls in the 24h window ending at `at` (mirrors
 * the IV anomalies replay window). When omitted, defaults to live
 * (`NOW() - 24h`). Format is ISO 8601 with offset.
 */
export const gammaSqueezesQuerySchema = z.object({
  ticker: z.enum(STRIKE_IV_TICKERS).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  at: z.string().datetime({ offset: true }).optional(),
});

export type GammaSqueezesQuery = z.infer<typeof gammaSqueezesQuerySchema>;

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
// /api/options-flow/otm-heavy
// ============================================================

/**
 * Query params for GET /api/options-flow/otm-heavy.
 *
 * Serves the OTM SPXW Flow Alerts dashboard widget — rolling-window view
 * of far-OTM flow where premium is dominated by ask-lifts or bid-hits.
 *
 * - Both live and historical modes read from `flow_alerts` (no UW proxy —
 *   the ingest cron keeps the table fresh).
 * - `window_minutes` is a fixed set (UI slider options); refine rather
 *   than enum to keep coercion from the string query value.
 * - Thresholds mirror the component sliders: 0.50–0.95 for side ratios,
 *   0.001–0.02 (= 0.1%–2%) for distance, $10K–$∞ for premium floor.
 * - `as_of requires date` — historical mode is date-anchored; `as_of`
 *   alone without a calendar context is rejected.
 */
export const otmHeavyQuerySchema = z
  .object({
    window_minutes: z.coerce
      .number()
      .int()
      .refine((v) => [5, 15, 30, 60].includes(v), {
        message: 'window_minutes must be 5, 15, 30, or 60',
      })
      .default(30),
    min_ask_ratio: z.coerce.number().min(0.5).max(0.95).default(0.6),
    min_bid_ratio: z.coerce.number().min(0.5).max(0.95).default(0.6),
    min_distance_pct: z.coerce.number().min(0.001).max(0.02).default(0.005),
    min_premium: z.coerce.number().int().min(10_000).default(50_000),
    sides: z.enum(['ask', 'bid', 'both']).default('both'),
    type: z.enum(['call', 'put', 'both']).default('both'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    as_of: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .refine((v) => !(v.as_of && !v.date), {
    message: 'as_of requires date',
    path: ['as_of'],
  });

export type OtmHeavyQuery = z.infer<typeof otmHeavyQuerySchema>;

// ============================================================
// /api/max-pain-current
// ============================================================

/**
 * Query params for GET /api/max-pain-current.
 *
 * `date` is optional — when omitted the endpoint resolves the live UW
 * max-pain value for today ET. When present it must be a YYYY-MM-DD
 * calendar date; if it equals today ET the handler falls through to the
 * live path, and if it's a past date the handler computes max-pain from
 * the `oi_per_strike` table rather than hitting UW.
 */
export const maxPainCurrentQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type MaxPainCurrentQuery = z.infer<typeof maxPainCurrentQuerySchema>;

// ============================================================
// /api/alerts-ack
// ============================================================

export const alertAckSchema = z.object({
  id: z.number().int().positive().finite(),
});

export type AlertAckBody = z.infer<typeof alertAckSchema>;

// ============================================================
// /api/push/subscribe + /api/push/unsubscribe
// ============================================================

/**
 * Body schema for POST /api/push/subscribe.
 *
 * Matches the JSON shape produced by the browser's
 * `PushSubscription.toJSON()`. `endpoint` is the push-service URL,
 * `keys.p256dh` / `keys.auth` are the per-device public cryptographic
 * material web-push requires to encrypt a payload for this subscription.
 * `userAgent` is an optional self-reported device tag — trimmed to
 * prevent storage bloat from pathological UA strings.
 */
const httpsEndpoint = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), {
    message: 'endpoint must use https',
  });

export const PushSubscribeBodySchema = z.object({
  endpoint: httpsEndpoint,
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export type PushSubscribeBody = z.infer<typeof PushSubscribeBodySchema>;

/**
 * Body schema for POST /api/push/unsubscribe. Idempotent — callers
 * pass the exact endpoint they previously subscribed with.
 */
export const PushUnsubscribeBodySchema = z.object({
  endpoint: httpsEndpoint,
});

export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBodySchema>;

// ============================================================
// /api/push/recent-events
// ============================================================

/**
 * Query params for GET /api/push/recent-events.
 *
 * `limit` is optional — when omitted the endpoint returns the last 20
 * rows from `regime_events`. When present it must coerce to a positive
 * integer 1..100 so the response never balloons past the budget. The
 * raw value arrives as a string in `req.query`, so we coerce before
 * validating.
 */
export const PushRecentEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type PushRecentEventsQuery = z.infer<typeof PushRecentEventsQuerySchema>;

// ============================================================
// /api/positions (POST — thinkorswim CSV upload)
// ============================================================

const MAX_CSV_BYTES = 1_024_000; // 1MB

export const positionCsvSchema = z.object({
  csv: z
    .string()
    .min(1, 'CSV body is empty')
    .refine((v) => v.length <= MAX_CSV_BYTES, 'CSV too large. Maximum 1MB.'),
});

export type PositionCsvBody = z.infer<typeof positionCsvSchema>;

// ============================================================
// /api/analyze
// ============================================================

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB in base64 chars

export const analyzeImageSchema = z.object({
  data: z
    .string()
    .min(1, 'Image data is required')
    .max(MAX_IMAGE_SIZE, 'Image too large. Maximum 5MB per image.'),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  label: z.string().optional(),
});

export const analyzeBodySchema = z.object({
  images: z
    .array(analyzeImageSchema)
    .min(1, 'At least one image is required')
    .max(2, 'Maximum 2 images allowed'),
  context: z.record(z.string(), z.unknown()),
});

export type AnalyzeBody = z.infer<typeof analyzeBodySchema>;

// ============================================================
// /api/periscope-chat
// ============================================================

// Periscope images can be larger than analyze images because the heat
// maps capture wider strike ranges and the screenshots aren't always
// aggressively compressed. Per spec: 10MB per image, 30MB combined.
const MAX_PERISCOPE_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB in base64 chars
const MAX_PERISCOPE_TOTAL_SIZE = 30 * 1024 * 1024; // 30MB combined

export const periscopeImageSchema = z.object({
  kind: z.enum(['chart', 'gex', 'charm']),
  data: z
    .string()
    .min(1, 'Image data is required')
    .max(MAX_PERISCOPE_IMAGE_SIZE, 'Image too large. Maximum 10MB per image.'),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
});

export const periscopeChatBodySchema = z
  .object({
    mode: z.enum(['read', 'debrief']),
    images: z
      .array(periscopeImageSchema)
      .min(1, 'At least one image is required')
      .max(
        3,
        'Maximum 3 images allowed (chart + GEX heat map + charm heat map)',
      ),
    parentId: z.number().int().positive().finite().nullable().optional(),
  })
  .refine(
    (body) => {
      const total = body.images.reduce((sum, img) => sum + img.data.length, 0);
      return total <= MAX_PERISCOPE_TOTAL_SIZE;
    },
    { message: 'Combined image size exceeds 30MB' },
  )
  .refine((body) => body.mode !== 'debrief' || body.parentId != null, {
    message:
      'Debrief mode requires a parent read id. Run a morning read first, then click "Debrief this" on it.',
    path: ['parentId'],
  });

export type PeriscopeChatBody = z.infer<typeof periscopeChatBodySchema>;

// ============================================================
// /api/periscope-chat-list
// ============================================================

/**
 * GET /api/periscope-chat-list?limit=N&before=ID&date=YYYY-MM-DD.
 *
 * Cursor pagination on BIGSERIAL id (descending). `limit` defaults to
 * 20 and is capped at 100 so an unbounded request can't lock the
 * connection. `before` is optional — when omitted, the most recent N
 * rows. `date` is optional — when set, returns ALL rows for that
 * trading_date (still capped by `limit`), used by the history picker
 * to populate per-date time/run subpickers.
 */
export const periscopeChatListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.number().int().positive().finite().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type PeriscopeChatListQuery = z.infer<
  typeof periscopeChatListQuerySchema
>;

// ============================================================
// /api/periscope-chat-detail
// ============================================================

export const periscopeChatDetailQuerySchema = z.object({
  id: z.coerce.number().int().positive().finite(),
});

export type PeriscopeChatDetailQuery = z.infer<
  typeof periscopeChatDetailQuerySchema
>;

// ============================================================
// /api/periscope-chat-update
// ============================================================

/**
 * PATCH/POST body for inline annotation edits. Both edit fields are
 * optional; the endpoint requires at least one set/clear directive to
 * be present.
 *
 * `calibration_quality` is the 1-5 star rating; `regime_tag` is the
 * fixed enum from the periscope skill (pin / drift-and-cap /
 * gap-and-rip / trap / cone-breach / chop / other).
 *
 * `clear` is an array of field names to explicitly null out. The
 * endpoint distinguishes "field omitted" (preserve existing) from
 * "field cleared" (set to null) via this list, since plain `null` in
 * JSON would round-trip ambiguously through Zod.
 */
export const periscopeChatUpdateBodySchema = z.object({
  calibration_quality: z.number().int().min(1).max(5).optional(),
  regime_tag: z
    .enum([
      'pin',
      'drift-and-cap',
      'gap-and-rip',
      'trap',
      'cone-breach',
      'chop',
      'other',
    ])
    .optional(),
  clear: z
    .array(z.enum(['regime_tag', 'calibration_quality']))
    .max(2)
    .optional(),
});

export type PeriscopeChatUpdateBody = z.infer<
  typeof periscopeChatUpdateBodySchema
>;

// ============================================================
// /api/pre-market
// ============================================================

export const preMarketBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  globexHigh: z.number(),
  globexLow: z.number(),
  globexClose: z.number(),
  globexVwap: z.number().nullable().optional(),
  straddleConeUpper: z.number().nullable().optional(),
  straddleConeLower: z.number().nullable().optional(),
  savedAt: z.string().nullable().optional(),
});

export type PreMarketBody = z.infer<typeof preMarketBodySchema>;

// ============================================================
// /api/snapshot
// ============================================================

// Helper: fields from ComputedSignals are often `T | null`, and
// JSON.stringify preserves null (unlike undefined). Accept both.
const num = z.number().nullable().optional();
const str = z.string().nullable().optional();
const bool = z.boolean().nullable().optional();

export const snapshotBodySchema = z.object({
  date: z.string().min(1, 'date is required'),
  entryTime: z.string().min(1, 'entryTime is required'),

  // Prices
  spx: num,
  spy: num,
  spxOpen: num,
  spxHigh: num,
  spxLow: num,
  prevClose: num,

  // Volatility
  vix: num,
  vix1d: num,
  vix9d: num,
  vvix: num,

  // Calculator
  sigma: num,
  sigmaSource: str,
  tYears: num,
  hoursRemaining: num,
  skewPct: num,

  // Regime
  regimeZone: str,
  clusterMult: num,
  dowMultHL: num,
  dowMultOC: num,
  dowLabel: str,

  // Delta guide
  icCeiling: num,
  putSpreadCeiling: num,
  callSpreadCeiling: num,
  moderateDelta: num,
  conservativeDelta: num,

  // Range thresholds
  medianOcPct: num,
  medianHlPct: num,
  p90OcPct: num,
  p90HlPct: num,
  p90OcPts: num,
  p90HlPts: num,

  // Opening range
  openingRangeAvailable: bool,
  openingRangeHigh: num,
  openingRangeLow: num,
  openingRangePctConsumed: num,
  openingRangeSignal: str,

  // Term structure
  vixTermSignal: str,

  // Overnight
  overnightGap: num,

  // Strikes (keyed by delta, e.g. "5", "10", "15")
  strikes: z
    .record(
      z.string(),
      z.object({
        put: z.number(),
        call: z.number(),
        putPct: z.number(),
        callPct: z.number(),
      }),
    )
    .nullable()
    .optional(),

  // Events
  isEarlyClose: bool,
  isEventDay: bool,
  eventNames: z.array(z.string()).nullable().optional(),

  isBacktest: bool,
});

export type SnapshotBody = z.infer<typeof snapshotBodySchema>;

// ============================================================
// Analysis response schema (structured output for Claude)
// ============================================================

const chartConfidenceEntry = z.object({
  signal: z.string(),
  confidence: z.enum(['HIGH', 'MODERATE', 'LOW']),
  note: z.string(),
});

const entryStep = z.object({
  timing: z.string(),
  condition: z.string(),
  sizePercent: z.number(),
  delta: z.number(),
  structure: z.string(),
  note: z.string(),
});

export const analysisResponseSchema = z.object({
  mode: z.enum(['entry', 'midday', 'review']),
  structure: z.enum([
    'IRON CONDOR',
    'PUT CREDIT SPREAD',
    'CALL CREDIT SPREAD',
    'SIT OUT',
  ]),
  confidence: z.enum(['HIGH', 'MODERATE', 'LOW']),
  suggestedDelta: z.number().nullable(),
  reasoning: z.string(),
  chartConfidence: z.object({
    marketTide: chartConfidenceEntry,
    spxNetFlow: chartConfidenceEntry,
    spyNetFlow: chartConfidenceEntry,
    qqqNetFlow: chartConfidenceEntry,
    periscope: chartConfidenceEntry,
    netCharm: chartConfidenceEntry,
    aggregateGex: chartConfidenceEntry,
    periscopeCharm: chartConfidenceEntry,
    darkPool: chartConfidenceEntry,
    ivTermStructure: chartConfidenceEntry,
    spxCandles: chartConfidenceEntry,
    overnightGap: chartConfidenceEntry,
    vannaExposure: chartConfidenceEntry,
    pinRisk: chartConfidenceEntry,
    skew: chartConfidenceEntry,
    futuresContext: chartConfidenceEntry,
    nopeSignal: chartConfidenceEntry,
    deltaFlow: chartConfidenceEntry,
    zeroGamma: chartConfidenceEntry,
    netGexHeatmap: chartConfidenceEntry,
    marketInternals: chartConfidenceEntry,
    deltaPressure: chartConfidenceEntry.optional(),
    charmPressure: chartConfidenceEntry.optional(),
  }),
  observations: z.array(z.string()),
  strikeGuidance: z
    .object({
      putStrikeNote: z.string().nullable(),
      callStrikeNote: z.string().nullable(),
      straddleCone: z
        .object({
          upper: z.number().nullable(),
          lower: z.number().nullable(),
          priceRelation: z.string(),
        })
        .nullable(),
      adjustments: z.array(z.string()),
    })
    .nullable(),
  managementRules: z
    .object({
      profitTarget: z.string(),
      stopConditions: z.array(z.string()),
      timeRules: z.string(),
      flowReversalSignal: z.string().nullable(),
    })
    .nullable(),
  entryPlan: z
    .object({
      entry1: entryStep.nullable(),
      entry2: entryStep.nullable(),
      entry3: entryStep.nullable(),
      maxTotalSize: z.string(),
      noEntryConditions: z.array(z.string()),
    })
    .nullable(),
  directionalOpportunity: z
    .object({
      direction: z.enum(['LONG CALL', 'LONG PUT']),
      confidence: z.enum(['HIGH', 'MODERATE', 'LOW']),
      reasoning: z.string(),
      entryTiming: z.string(),
      stopLoss: z.string(),
      profitTarget: z.string(),
      keyLevels: z.object({
        support: z.string().nullable(),
        resistance: z.string().nullable(),
        vwap: z.string().nullable(),
      }),
      signals: z.array(z.string()),
    })
    .nullable()
    .optional(),
  risks: z.array(z.string()),
  hedge: z
    .object({
      recommendation: z.enum([
        'NO HEDGE',
        'PROTECTIVE LONG',
        'DEBIT SPREAD HEDGE',
        'REDUCED SIZE',
        'SKIP',
      ]),
      description: z.string(),
      rationale: z.string(),
      estimatedCost: z.string(),
    })
    .nullable(),
  periscopeNotes: z.string().nullable(),
  pressureAnalysis: z.string().nullable().optional(),
  structureRationale: z.string(),
  review: z
    .object({
      wasCorrect: z.boolean(),
      whatWorked: z.string(),
      whatMissed: z.string(),
      optimalTrade: z.string(),
      lessonsLearned: z.array(z.string()),
      recommendationChain: z
        .object({
          entry: z
            .object({
              time: z.string(),
              structure: z.enum([
                'IRON CONDOR',
                'PUT CREDIT SPREAD',
                'CALL CREDIT SPREAD',
                'SIT OUT',
              ]),
              verdict: z.enum(['CORRECT', 'WRONG_RESCUED', 'WRONG_UNRESCUED']),
              rationale: z.string(),
            })
            .nullable(),
          midday: z
            .object({
              time: z.string(),
              structure: z.enum([
                'IRON CONDOR',
                'PUT CREDIT SPREAD',
                'CALL CREDIT SPREAD',
                'SIT OUT',
              ]),
              verdict: z.enum(['CORRECT', 'WRONG_RESCUED', 'WRONG_UNRESCUED']),
              rationale: z.string(),
            })
            .nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  imageIssues: z.array(
    z.object({
      imageIndex: z.number(),
      label: z.string(),
      issue: z.string(),
      suggestion: z.string(),
    }),
  ),
});

export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
