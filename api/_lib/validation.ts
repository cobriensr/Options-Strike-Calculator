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
// /api/alerts-ack
// ============================================================

export const alertAckSchema = z.object({
  id: z.number().int().positive().finite(),
});

export type AlertAckBody = z.infer<typeof alertAckSchema>;

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
    mode: z.enum(['pre_trade', 'intraday', 'debrief']),
    images: z
      .array(periscopeImageSchema)
      .min(1, 'At least one image is required')
      .max(
        3,
        'Maximum 3 images allowed (chart + GEX heat map + charm heat map)',
      ),
    parentId: z.number().int().positive().finite().nullable().optional(),
    /**
     * The trading date the read is FOR (ISO YYYY-MM-DD). The backend
     * uses this to anchor the SPX spot lookup against
     * `index_candles_1m`. Distinct from `captured_at` which the server
     * stamps at request arrival.
     */
    read_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'read_date must be ISO YYYY-MM-DD'),
    /**
     * The wall-clock time the read is FOR, HH:MM 24-hour CT. The
     * backend converts (read_date, read_time, CT) into a TIMESTAMPTZ
     * for `read_time` persistence and queries `index_candles_1m` for
     * the matching SPX bar.
     */
    read_time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'read_time must be HH:MM (24-hour CT)'),
    /**
     * Legacy alias for `read_date` retained for the existing back-read
     * UI override. Optional and additive.
     */
    tradingDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'tradingDate must be ISO YYYY-MM-DD')
      .optional(),
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
  })
  .refine((body) => body.mode !== 'intraday' || body.parentId != null, {
    message:
      "Intraday mode requires a parent read id (today's pre-trade or the last intraday).",
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
// /api/periscope-chat-image
// ============================================================

/**
 * Query schema for GET /api/periscope-chat-image. Replaces the prior
 * ad-hoc regex validation in the handler with a single Zod schema for
 * consistency with sibling endpoints (Phase 6E folded fix).
 */
export const periscopeChatImageQuerySchema = z
  .object({
    id: z.coerce.number().int().positive().finite(),
    kind: z.enum(['chart', 'gex', 'charm']),
  })
  .strict();

export type PeriscopeChatImageQuery = z.infer<
  typeof periscopeChatImageQuerySchema
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
// /api/periscope-lessons-update
// ============================================================

/**
 * POST body for the LessonLibrary panel's promote / archive / unarchive
 * actions. Mirrors the manual SQL workflow that shipped pre-MVP:
 *
 *   - `promote`   — proposed/active row → status='active' + promoted_at=now()
 *   - `archive`   — any non-archived row → status='archived' + archived_at=now()
 *   - `unarchive` — archived row → status='proposed', clear both timestamps
 *
 * The endpoint enforces the state-machine guards in handler logic
 * (Zod just validates the action enum + the id shape).
 */
export const periscopeLessonsUpdateBodySchema = z.object({
  id: z.number().int().positive(),
  action: z.enum(['promote', 'archive', 'unarchive']),
});

export type PeriscopeLessonsUpdateBody = z.infer<
  typeof periscopeLessonsUpdateBodySchema
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
  // Pagination.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // Sort: newest (bucket_ct DESC), spike_ratio DESC, vol_oi DESC, peak DESC.
  sort: z.enum(['newest', 'spike_ratio', 'vol_oi', 'peak']).default('newest'),
});

export type SilentBoomFeedQuery = z.infer<typeof silentBoomFeedQuerySchema>;

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
