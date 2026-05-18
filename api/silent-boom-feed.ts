/**
 * GET /api/silent-boom-feed
 *
 * Read endpoint backing the SilentBoomSection component. Returns
 * recent silent-boom alerts from `silent_boom_alerts` with realized
 * peak/exit metrics when the enrich step has filled them in.
 *
 * Owner-or-guest. Same auth pattern as /api/lottery-finder.
 *
 * Query params: ?date= ?ticker= ?optionType= ?minVolOi= ?minSpikeRatio=
 *               ?sort= ?limit= ?offset=
 * Validated by `silentBoomFeedQuerySchema` in api/_lib/validation.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { silentBoomFeedQuerySchema } from './_lib/validation.js';
import { avgHoldMinutesFor } from './_lib/silent-boom-hold.js';
import { silentBoomScoreTier } from './_lib/silent-boom-score.js';
import { MIN_ALERT_ENTRY_PRICE } from './_lib/constants.js';
import { getETDateStr } from '../src/utils/timezone.js';

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbOptionType = 'C' | 'P';
type SilentBoomTier = 'tier1' | 'tier2' | 'tier3';
type SilentBoomTierOrNull = SilentBoomTier | null;

interface AlertRow {
  id: DbId;
  date: DbTimestamp;
  bucket_ct: DbTimestamp;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: DbOptionType;
  strike: DbNumeric;
  expiry: string;
  dte: number;
  spike_volume: number;
  baseline_volume: DbNumeric;
  spike_ratio: DbNumeric;
  ask_pct: DbNumeric;
  vol_oi: DbNumeric;
  entry_price: DbNumeric;
  open_interest: number;
  peak_ceiling_pct: DbNullableNumeric;
  minutes_to_peak: DbNullableNumeric;
  realized_30m_pct: DbNullableNumeric;
  realized_60m_pct: DbNullableNumeric;
  realized_120m_pct: DbNullableNumeric;
  realized_eod_pct: DbNullableNumeric;
  /**
   * Phase 2 trail-30/10 outcome (migration #150). Trailing-stop exit:
   * activate at +30% from entry, then exit at 10pp giveback from the
   * running peak; if peak never crosses +30%, hold to last tick (EoD).
   * Nullable because rows enriched before #150 have no trail computed;
   * backfill recovers historical fires from the EOD parquet stream.
   */
  realized_trail30_10_pct: DbNullableNumeric;
  enriched_at: DbTimestamp | null;
  score: number | null;
  score_tier: SilentBoomTierOrNull;
  direction_gated: boolean;
  mkt_tide_diff: DbNullableNumeric;
  zero_dte_diff: DbNullableNumeric;
  spx_spot_gamma_oi: DbNullableNumeric;
  underlying_price_at_spike: DbNullableNumeric;
  multi_leg_share: DbNullableNumeric;
  /** Migration #154 / spec round-trip-score-deduct-production-2026-05-16.md.
   *  See lottery-finder.ts for the bracket semantics — same brackets apply
   *  here. NULL until the evaluate-round-trip cron has run for the alert. */
  round_trip_net_pct: DbNullableNumeric;
  round_trip_score_deduct: number | null;
  /** Take-It calibrated win probability (migration #155, spec
   *  takeit-phase3-production-scoring-2026-05-16.md). NULL when the
   *  model bundle was unreachable at detect time (fail-open). */
  takeit_prob: DbNullableNumeric;
  /** SHAP top-3 green + top-3 red flags JSONB. NULL until the Phase 3d
   *  SHAP fill cron back-populates it. */
  takeit_top_features: unknown;
  /** Bundle version e.g. "v2026-05-23". NULL when no bundle was loaded. */
  takeit_model_version: string | null;
  inserted_at: DbTimestamp;

  // Ticker net flow snapshotted at bucket_ct via LATERAL.
  // NULL when the ws/REST tables hold no rows for this ticker at or
  // before the alert (older alerts pre-WS-daemon, or universes not yet
  // subscribed). The client uses these to detect flow-inversion vs.
  // the live snapshot from /api/ticker-net-flow-current.
  fire_time_cum_ncp: DbNullableNumeric;
  fire_time_cum_npp: DbNullableNumeric;
}

interface SilentBoomAlertResponse {
  id: number;
  date: string;
  bucketCt: string;
  optionChainId: string;
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  strike: number;
  expiry: string;
  dte: number;
  spikeVolume: number;
  baselineVolume: number;
  spikeRatio: number;
  askPct: number;
  volOi: number;
  entryPrice: number;
  openInterest: number;
  /**
   * Effective conviction score = raw insert-time score + round-trip
   * deduct (Phase 2C of round-trip-score-deduct-production-2026-05-16.md).
   * Floored at 0 so a -3 deduct on a low-score row doesn't go negative.
   */
  score: number | null;
  /** Pre-deduct score as stored on the row. Same as `score` when no deduct. */
  rawScore: number | null;
  /** Migration #154. Post-fire (ask−bid)/total over a 60-min window. NULL
   *  until the evaluate-round-trip cron has run. Range [-1, +1]. */
  roundTripNetPct: number | null;
  /** Stepped bracket deduct (0 / -1 / -2 / -3). */
  roundTripScoreDeduct: number;
  /** 'tier1' | 'tier2' | 'tier3' — re-derived at read time from the
   *  effective score so the displayed tier matches the displayed score.
   *  Null only on legacy rows with no score. */
  scoreTier: SilentBoomTierOrNull;
  /**
   * Phase 4 direction gate (spec:
   * silent-boom-direction-gate-and-trail-ui-2026-05-14.md). TRUE when
   * the fire was counter-trend per Market Tide at fire time — the
   * detector demoted score_tier to 'tier3' on insert. UI renders a
   * "Gated" pill and exposes a "Hide counter-trend" filter.
   */
  directionGated: boolean;
  /** Market Tide NCP - NPP at the spike-bucket time (display-only). */
  mktTideDiff: number | null;
  /** zero_dte_greek_flow NCP - NPP at the spike-bucket time. */
  zeroDteDiff: number | null;
  /** SPX dealer gamma_oi at the spike-bucket time (sign indicator). */
  spxSpotGammaOi: number | null;
  /**
   * Underlying spot price at the spike bucket (migration #152). Null on
   * pre-#152 rows. Surfaced so the client can derive ITM/OTM moneyness
   * for the All / OTM / ITM chip group without re-querying.
   */
  underlyingPriceAtSpike: number | null;
  /**
   * Multi-leg share at the spike bucket (migration #146). Fraction of
   * spike-bucket size whose UW trade_code is a multi-leg sale code
   * (mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct). Surfaced so the UI can
   * render a "SPREAD-CONFIRMED" badge in the 10-50% sweet spot — EDA
   * 2026-05-15 found 2.08× win50 lift on that range. Null on rows
   * written before #146.
   */
  multiLegShare: number | null;
  /**
   * Ticker-level cumulative net call premium at bucket_ct, snapshotted
   * by the silent-boom-feed LATERAL join against
   * ws_net_flow_per_ticker + net_flow_per_ticker_history. Distinct from
   * mktTideDiff (which is SPY-wide market tide). Null when the ws/REST
   * tables held no rows for the ticker before the alert.
   */
  tickerCumNcpAtFire: number | null;
  /** Ticker-level cumulative net put premium at bucket_ct. */
  tickerCumNppAtFire: number | null;
  /**
   * Cohort-derived "typical exit window" hint (P75 of minutes-to-peak
   * among historical winners for the (tier, ticker) cohort). Always
   * populated. Falls back to tier3 default (224) when score_tier is
   * null on legacy rows. See api/_lib/silent-boom-hold.ts.
   */
  avgHoldMinutes: number;
  outcomes: {
    peakCeilingPct: number | null;
    minutesToPeak: number | null;
    realized30mPct: number | null;
    realized60mPct: number | null;
    realized120mPct: number | null;
    realizedEodPct: number | null;
    /**
     * Phase 2 trail-30/10 realized return (migration #150). Activate
     * trailing stop at +30%, exit at 10pp giveback from running peak;
     * if peak never crosses +30%, hold to last tick. Null on rows
     * enriched before #150 — backfilled by the nightly enrich pass.
     */
    realizedTrail3010Pct: number | null;
    enrichedAt: string | null;
  };
  insertedAt: string;
}

type SilentBoomTodEnum = 'AM_open' | 'MID' | 'LUNCH' | 'PM' | 'LATE';
type SilentBoomDteBucket = '0' | '1-3' | '4+';
type SilentBoomBurstColor = 'red' | 'yellow' | 'grey';
type SilentBoomAskPctBand = '70-80' | '80-90' | '90-95' | '95-99' | '100';

interface SilentBoomFeedResponse {
  date: string;
  filters: {
    ticker?: string;
    optionType?: 'C' | 'P';
    minVolOi: number;
    minSpikeRatio: number;
    minScore: number | null;
    tod: SilentBoomTodEnum | null;
    dte: SilentBoomDteBucket | null;
    minDte: number | null;
    minPremium: number | null;
    burst: SilentBoomBurstColor | null;
    askPctBand: SilentBoomAskPctBand | null;
    sort: 'newest' | 'spike_ratio' | 'vol_oi' | 'peak';
    aggressivePremium: boolean;
  };
  count: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  alerts: SilentBoomAlertResponse[];
}

function toIso(v: DbTimestamp | null | undefined): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

function toIsoOrNull(v: DbTimestamp | null | undefined): string | null {
  if (v == null) return null;
  return toIso(v);
}

function toNum(v: DbNumeric): number {
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

function toNumOrNull(v: DbNullableNumeric): number | null {
  if (v == null) return null;
  return toNum(v);
}

function toDateIso(v: DbTimestamp): string {
  // Server-side DATE columns come back as Date with UTC midnight; the
  // calendar date is what we want.
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  const parsed = silentBoomFeedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid query',
      details: parsed.error.issues,
    });
    return;
  }
  const q = parsed.data;
  const date = q.date ?? getETDateStr(new Date());

  // TOD bucket → CT minute-of-day range. Boundaries mirror
  // silentBoomTodFromMinuteCt in api/_lib/silent-boom-score.ts.
  // Returns half-open [lo, hi) on the CT day. Null when no TOD filter.
  const todRange = (() => {
    if (q.tod === 'AM_open') return { lo: 0, hi: 10 * 60 };
    if (q.tod === 'MID') return { lo: 10 * 60, hi: 12 * 60 };
    if (q.tod === 'LUNCH') return { lo: 12 * 60, hi: 13 * 60 };
    if (q.tod === 'PM') return { lo: 13 * 60, hi: 15 * 60 };
    if (q.tod === 'LATE') return { lo: 15 * 60, hi: 24 * 60 };
    return null;
  })();
  const todLo = todRange?.lo ?? null;
  const todHi = todRange?.hi ?? null;

  // DTE filter: numeric `minDte` takes precedence over the legacy
  // enum bucket. When both are present we ignore the bucket. The SQL
  // uses BETWEEN with a 100k upper-bound sentinel so the same template
  // serves all three modes (none, bucket, min-only).
  const dteRange = (() => {
    if (q.minDte != null && q.minDte > 0) {
      return { lo: q.minDte, hi: 100_000 };
    }
    if (q.dte === '0') return { lo: 0, hi: 0 };
    if (q.dte === '1-3') return { lo: 1, hi: 3 };
    if (q.dte === '4+') return { lo: 4, hi: 100_000 };
    return null;
  })();
  const dteLo = dteRange?.lo ?? null;
  const dteHiBound = dteRange?.hi ?? 100_000;
  // Premium floor — entry_price * spike_volume * 100, in dollars.
  // null = no floor. Filtered server-side so pagination reflects the
  // post-filter count.
  const minPremium =
    q.minPremium != null && q.minPremium > 0 ? q.minPremium : null;
  // Hide alerts whose bucket_ct (in CT) is at or after 14:30. When
  // active, this is a server-side filter so pagination accurately
  // reflects the visible count — was previously client-side which
  // emptied pages whose entire 50-item slice fell after the cutoff.
  // Encoded as the CT minute-of-day boundary 14*60 + 30 = 870.
  const hideLatePm = q.hideLatePm === true;

  // Burst color category → spike_ratio range. Mirrors the
  // SilentBoomRow spike badge: red >= 50×, yellow 20-50×, grey < 20×.
  // Detector floor is 5× so 'grey' lands 5–20×. Same sentinel pattern
  // as DTE — "no upper bound" red collapses to a 1M sentinel.
  const burstRange = (() => {
    if (q.burst === 'red') return { lo: 50, hi: 1_000_000 };
    if (q.burst === 'yellow') return { lo: 20, hi: 50 };
    if (q.burst === 'grey') return { lo: 0, hi: 20 };
    return null;
  })();
  const burstLo = burstRange?.lo ?? null;
  const burstHiBound = burstRange?.hi ?? 1_000_000;

  // Ask% band → [askLo, askHi). The '100' band is exact equality
  // ask_pct = 1.0; expressed here as [1.0, 1.001) so the half-open
  // gate matches uniformly with the other bands. Bands derive from
  // docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md.
  const askPctRange = (() => {
    if (q.askPctBand === '70-80') return { lo: 0.7, hi: 0.8 };
    if (q.askPctBand === '80-90') return { lo: 0.8, hi: 0.9 };
    if (q.askPctBand === '90-95') return { lo: 0.9, hi: 0.95 };
    if (q.askPctBand === '95-99') return { lo: 0.95, hi: 1.0 };
    if (q.askPctBand === '100') return { lo: 1.0, hi: 1.001 };
    return null;
  })();
  const askPctLo = askPctRange?.lo ?? null;
  const askPctHiBound = askPctRange?.hi ?? 1.001;

  // Aggressive Premium filter (#152 + chip spec). Single boolean
  // toggles the trader's UW filter: premium ≥ $100K, DTE ≤ 8,
  // vol/OI > 1, single-leg, OTM. Each clause is folded into a single
  // OR-gated composite below so the SQL is identical when the flag is
  // off (the IS NOT TRUE branch matches every row).
  const aggressivePremium = q.aggressivePremium === true;

  try {
    const db = getDb();

    // Build the WHERE clause incrementally — using neon-serverless
    // tagged template requires us to execute one of a few precomposed
    // queries based on the active filters. Mirrors the lottery-finder
    // pattern (avoid string-concat SQL).
    const tickerUpper = q.ticker?.toUpperCase();

    // Total count for pagination.
    const totalRow = (await withDbRetry(
      () => db`
      SELECT COUNT(*)::int AS n
      FROM silent_boom_alerts
      WHERE date = ${date}::date
        AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
        AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
        AND vol_oi >= ${q.minVolOi}::numeric
        AND spike_ratio >= ${q.minSpikeRatio}::numeric
        AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
        AND (${todLo}::int IS NULL OR (
          EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
          EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
        ) >= ${todLo}::int)
        AND (${todHi}::int IS NULL OR (
          EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
          EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
        ) < ${todHi}::int)
        AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
        AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
        AND (${askPctLo}::numeric IS NULL OR (ask_pct >= ${askPctLo}::numeric AND ask_pct < ${askPctHiBound}::numeric))
        AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
        AND (${minPremium}::numeric IS NULL OR entry_price * spike_volume * 100 >= ${minPremium}::numeric)
        AND (
          ${hideLatePm}::boolean IS NOT TRUE
          OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < 870
        )
        AND (
          ${aggressivePremium}::boolean IS NOT TRUE
          OR (
            entry_price * spike_volume * 100 >= 100000
            AND dte <= 8
            AND vol_oi > 1.0
            AND COALESCE(multi_leg_share, 0) < 0.10
            AND underlying_price_at_spike IS NOT NULL
            AND (
              (option_type = 'C' AND strike > underlying_price_at_spike)
              OR (option_type = 'P' AND strike < underlying_price_at_spike)
            )
          )
        )
    `,
      2,
      10000,
    )) as { n: number }[];
    const total = totalRow[0]?.n ?? 0;

    // Sort clause — neon tagged-template doesn't support unsafe()
    // identifier interpolation, so we route via a switch on the
    // validated enum.
    let rows: AlertRow[];
    if (q.sort === 'spike_ratio') {
      rows = (await withDbRetry(
        () => db`
        SELECT
          s.*,
          s.cum_ncp_at_fire AS fire_time_cum_ncp,
          s.cum_npp_at_fire AS fire_time_cum_npp
        FROM silent_boom_alerts s
        WHERE s.date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
          AND (${askPctLo}::numeric IS NULL OR (ask_pct >= ${askPctLo}::numeric AND ask_pct < ${askPctHiBound}::numeric))
          AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          AND (${minPremium}::numeric IS NULL OR entry_price * spike_volume * 100 >= ${minPremium}::numeric)
        AND (
          ${hideLatePm}::boolean IS NOT TRUE
          OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < 870
        )
          AND (
            ${aggressivePremium}::boolean IS NOT TRUE
            OR (
              entry_price * spike_volume * 100 >= 100000
              AND dte <= 8
              AND vol_oi > 1.0
              AND COALESCE(multi_leg_share, 0) < 0.10
              AND underlying_price_at_spike IS NOT NULL
              AND (
                (option_type = 'C' AND strike > underlying_price_at_spike)
                OR (option_type = 'P' AND strike < underlying_price_at_spike)
              )
            )
          )
        ORDER BY spike_ratio DESC, bucket_ct DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `,
        2,
        10000,
      )) as AlertRow[];
    } else if (q.sort === 'vol_oi') {
      rows = (await withDbRetry(
        () => db`
        SELECT
          s.*,
          s.cum_ncp_at_fire AS fire_time_cum_ncp,
          s.cum_npp_at_fire AS fire_time_cum_npp
        FROM silent_boom_alerts s
        WHERE s.date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
          AND (${askPctLo}::numeric IS NULL OR (ask_pct >= ${askPctLo}::numeric AND ask_pct < ${askPctHiBound}::numeric))
          AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          AND (${minPremium}::numeric IS NULL OR entry_price * spike_volume * 100 >= ${minPremium}::numeric)
        AND (
          ${hideLatePm}::boolean IS NOT TRUE
          OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < 870
        )
          AND (
            ${aggressivePremium}::boolean IS NOT TRUE
            OR (
              entry_price * spike_volume * 100 >= 100000
              AND dte <= 8
              AND vol_oi > 1.0
              AND COALESCE(multi_leg_share, 0) < 0.10
              AND underlying_price_at_spike IS NOT NULL
              AND (
                (option_type = 'C' AND strike > underlying_price_at_spike)
                OR (option_type = 'P' AND strike < underlying_price_at_spike)
              )
            )
          )
        ORDER BY vol_oi DESC, bucket_ct DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `,
        2,
        10000,
      )) as AlertRow[];
    } else if (q.sort === 'peak') {
      rows = (await withDbRetry(
        () => db`
        SELECT
          s.*,
          s.cum_ncp_at_fire AS fire_time_cum_ncp,
          s.cum_npp_at_fire AS fire_time_cum_npp
        FROM silent_boom_alerts s
        WHERE s.date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
          AND (${askPctLo}::numeric IS NULL OR (ask_pct >= ${askPctLo}::numeric AND ask_pct < ${askPctHiBound}::numeric))
          AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          AND (${minPremium}::numeric IS NULL OR entry_price * spike_volume * 100 >= ${minPremium}::numeric)
        AND (
          ${hideLatePm}::boolean IS NOT TRUE
          OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < 870
        )
          AND (
            ${aggressivePremium}::boolean IS NOT TRUE
            OR (
              entry_price * spike_volume * 100 >= 100000
              AND dte <= 8
              AND vol_oi > 1.0
              AND COALESCE(multi_leg_share, 0) < 0.10
              AND underlying_price_at_spike IS NOT NULL
              AND (
                (option_type = 'C' AND strike > underlying_price_at_spike)
                OR (option_type = 'P' AND strike < underlying_price_at_spike)
              )
            )
          )
        ORDER BY peak_ceiling_pct DESC NULLS LAST, bucket_ct DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `,
        2,
        10000,
      )) as AlertRow[];
    } else {
      // 'newest' — default
      rows = (await withDbRetry(
        () => db`
        SELECT
          s.*,
          s.cum_ncp_at_fire AS fire_time_cum_ncp,
          s.cum_npp_at_fire AS fire_time_cum_npp
        FROM silent_boom_alerts s
        WHERE s.date = ${date}::date
          AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
          AND vol_oi >= ${q.minVolOi}::numeric
          AND spike_ratio >= ${q.minSpikeRatio}::numeric
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
          AND (${todLo}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) >= ${todLo}::int)
          AND (${todHi}::int IS NULL OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < ${todHi}::int)
          AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
          AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
          AND (${askPctLo}::numeric IS NULL OR (ask_pct >= ${askPctLo}::numeric AND ask_pct < ${askPctHiBound}::numeric))
          AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          AND (${minPremium}::numeric IS NULL OR entry_price * spike_volume * 100 >= ${minPremium}::numeric)
        AND (
          ${hideLatePm}::boolean IS NOT TRUE
          OR (
            EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
            EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
          ) < 870
        )
          AND (
            ${aggressivePremium}::boolean IS NOT TRUE
            OR (
              entry_price * spike_volume * 100 >= 100000
              AND dte <= 8
              AND vol_oi > 1.0
              AND COALESCE(multi_leg_share, 0) < 0.10
              AND underlying_price_at_spike IS NOT NULL
              AND (
                (option_type = 'C' AND strike > underlying_price_at_spike)
                OR (option_type = 'P' AND strike < underlying_price_at_spike)
              )
            )
          )
        ORDER BY bucket_ct DESC, id DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `,
        2,
        10000,
      )) as AlertRow[];
    }

    const alerts: SilentBoomAlertResponse[] = rows.map((r) => {
      // Round-trip score deduct (migration #154 / spec
      // round-trip-score-deduct-production-2026-05-16.md). Same brackets
      // as Lottery. Silent boom stores `score_tier` on insert, so we
      // re-derive the effective tier from (score + deduct) at read time.
      // direction_gated still overrides to tier3 — that gate is
      // independent of round-trip and runs first in the override chain.
      const rawScore = r.score;
      const rtDeduct =
        r.round_trip_score_deduct == null
          ? 0
          : Number(r.round_trip_score_deduct);
      const effectiveScore =
        rawScore == null ? null : Math.max(0, rawScore + rtDeduct);
      const directionGated = r.direction_gated === true;
      const tierFromScore = silentBoomScoreTier(effectiveScore);
      const effectiveTier: SilentBoomTierOrNull = directionGated
        ? 'tier3'
        : (tierFromScore as SilentBoomTierOrNull);
      return {
        id: Number(r.id),
        date: toDateIso(r.date),
        bucketCt: toIso(r.bucket_ct),
        optionChainId: r.option_chain_id,
        underlyingSymbol: r.underlying_symbol,
        optionType: r.option_type,
        strike: toNum(r.strike),
        expiry: r.expiry,
        dte: r.dte,
        spikeVolume: r.spike_volume,
        baselineVolume: toNum(r.baseline_volume),
        spikeRatio: toNum(r.spike_ratio),
        askPct: toNum(r.ask_pct),
        volOi: toNum(r.vol_oi),
        entryPrice: toNum(r.entry_price),
        openInterest: r.open_interest,
        score: effectiveScore,
        rawScore,
        roundTripNetPct: toNumOrNull(r.round_trip_net_pct),
        roundTripScoreDeduct: rtDeduct,
        takeitProb: toNumOrNull(r.takeit_prob),
        takeitTopFeatures:
          r.takeit_top_features == null
            ? null
            : (r.takeit_top_features as Record<string, unknown>),
        takeitModelVersion: r.takeit_model_version,
        scoreTier: effectiveTier,
        directionGated,
        mktTideDiff: toNumOrNull(r.mkt_tide_diff),
        zeroDteDiff: toNumOrNull(r.zero_dte_diff),
        spxSpotGammaOi: toNumOrNull(r.spx_spot_gamma_oi),
        underlyingPriceAtSpike: toNumOrNull(r.underlying_price_at_spike),
        multiLegShare: toNumOrNull(r.multi_leg_share),
        // Ticker-level flow snapshot at bucket_ct. Distinct from
        // mktTideDiff (which is SPY-wide market tide) — these are the
        // cumulative NCP / NPP for THIS ticker through the alert.
        tickerCumNcpAtFire: toNumOrNull(r.fire_time_cum_ncp),
        tickerCumNppAtFire: toNumOrNull(r.fire_time_cum_npp),
        avgHoldMinutes: avgHoldMinutesFor({
          tier: effectiveTier,
          ticker: r.underlying_symbol,
        }),
        outcomes: {
          peakCeilingPct: toNumOrNull(r.peak_ceiling_pct),
          minutesToPeak: toNumOrNull(r.minutes_to_peak),
          realized30mPct: toNumOrNull(r.realized_30m_pct),
          realized60mPct: toNumOrNull(r.realized_60m_pct),
          realized120mPct: toNumOrNull(r.realized_120m_pct),
          realizedEodPct: toNumOrNull(r.realized_eod_pct),
          realizedTrail3010Pct: toNumOrNull(r.realized_trail30_10_pct),
          enrichedAt: toIsoOrNull(r.enriched_at),
        },
        insertedAt: toIso(r.inserted_at),
      };
    });

    const response: SilentBoomFeedResponse = {
      date,
      filters: {
        ...(tickerUpper ? { ticker: tickerUpper } : {}),
        ...(q.optionType ? { optionType: q.optionType } : {}),
        minVolOi: q.minVolOi,
        minSpikeRatio: q.minSpikeRatio,
        minScore: q.minScore ?? null,
        tod: q.tod ?? null,
        dte: q.dte ?? null,
        minDte: q.minDte ?? null,
        minPremium: q.minPremium ?? null,
        burst: q.burst ?? null,
        askPctBand: q.askPctBand ?? null,
        sort: q.sort,
        aggressivePremium,
      },
      count: alerts.length,
      total,
      limit: q.limit,
      offset: q.offset,
      hasMore: q.offset + alerts.length < total,
      alerts,
    };

    setCacheHeaders(res, 30, 60);
    res.status(200).json(response);
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'silent-boom-feed: unexpected error');
    res.status(500).json({ error: 'Internal error' });
  }
}
