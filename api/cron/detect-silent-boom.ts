/**
 * GET /api/cron/detect-silent-boom
 *
 * Runs every 5 min during market hours. Aggregates the last
 * SCAN_WINDOW_MIN of ws_option_trades into 5-min per-chain buckets in
 * SQL (size, ask/bid splits, vwap, last price, max OI), runs the
 * silent-boom detector, and INSERTs alerts into silent_boom_alerts
 * with ON CONFLICT DO NOTHING for idempotency. SQL-side aggregation is
 * load-bearing: raw-tick projection of the same window blew past the
 * Neon HTTP 64 MB response cap on busy days (Sentry
 * SENTRY-EMERALD-DESERT-5S, 2026-05-08).
 *
 * Cooldown across cron-tick boundaries: queries silent_boom_alerts
 * for prior fires on the same chain within the last 60 min and
 * passes that as `priorLastFireMs` to the detector. Same pattern as
 * detect-lottery-fires.ts.
 *
 * Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md
 */

import { getDb, withDbRetry, settleDegradable } from '../_lib/db.js';
import {
  detectSilentBoomFires,
  SILENT_BOOM_SPEC_V1,
  type ChainBucket,
} from '../_lib/silent-boom.js';
import {
  computeSilentBoomScore,
  silentBoomScoreTier,
  silentBoomTodFromMinuteCt,
  type SilentBoomScoreTier,
} from '../_lib/silent-boom-score.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { isPastCashOpen } from '../_lib/cron-helpers.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  loadTakeitDetectContext,
  scoreSilentBoom,
  type RecentCofireRow,
  type RecentFireRow,
} from '../_lib/takeit-detect.js';
import type { SilentBoomAlertRow } from '../_lib/takeit-features.js';
import {
  fetchTickerFlowSeries,
  flowAtFireTime,
  type TickerFlowSeries,
} from '../_lib/ticker-flow-snapshot.js';
import {
  classifyAlertMultileg,
  type MultilegClassifyCache,
} from '../_lib/multileg-classify-batch.js';
import {
  getLatestGexbotSnapshotAt,
  mapToGexbotTicker,
  type FireTimeGexbotSnapshot,
} from '../_lib/gexbot-queries.js';
import { TAKEIT_GATE_EXEMPT_MIN_PROB } from '../_lib/takeit-score.js';
import { withRetry } from '../_lib/uw-fetch.js';
import { Sentry } from '../_lib/sentry.js';

// 35-min scan window — needs at least baselineBuckets+1 buckets of
// history (4+1 = 5 buckets = 25 min) plus 10 min slack for cron jitter
// + late first ticks landing mid-bucket. Tight 30-min windows can drop
// chains whose first trade arrives ≥6 min into the window.
const SCAN_WINDOW_MIN = 35;

// Cooldown lookback for the per-chain priorLastFireMs seed. Detector
// cooldown is 60 min (12 buckets × 5min); we look back 70 min to
// absorb clock skew between cron invocations.
const PRIOR_FIRE_LOOKBACK_MIN = 70;

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;

// Aggregated 5-min bucket row from SQL — see query below. Aggregating
// in Postgres (rather than pulling raw ticks) avoids the Neon HTTP
// driver's 64 MB response cap: on busy days the raw-tick projection
// blew past it (Sentry SENTRY-EMERALD-DESERT-5S, 2026-05-08).
interface BucketRow {
  ticker: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: DbNumeric;
  expiry: string;
  bucket_ts: DbTimestamp;
  size: DbNumeric;
  ask_size: DbNumeric;
  bid_size: DbNumeric;
  multi_leg_size: DbNumeric;
  notional: DbNumeric;
  bucket_max_oi: number | null;
  last_price: DbNumeric;
  /** SUM(underlying_price * size) — paired with `size` to compute the
   *  volume-weighted underlying spot for the OTM filter (migration #152). */
  underlying_notional: DbNumeric | null;
  /** Volume-weighted gamma extracted from raw_payload->>'gamma' over
   *  the bucket. NULL when no tick carried a gamma value. Stored as
   *  silent_boom_alerts.gamma_at_trigger by migration #168. */
  bucket_gamma: DbNumeric | null;
  /** H2 in-bucket cadence: fraction of size landing in the first 60s
   *  of the 5-min bucket. NULL when bucket size is 0 (defensive).
   *  Stored as silent_boom_alerts.first_min_share by migration #171. */
  first_min_share: DbNullableNumeric;
  /** H5 in-bucket NBBO spread: size-weighted relative spread
   *  ((ask-bid)/mid) across the bucket. NULL when no print in the
   *  bucket had a usable NBBO. Stored as
   *  silent_boom_alerts.spread_in_bucket by migration #171. */
  spread_in_bucket: DbNullableNumeric;
}

/** OPRA-standard multi-leg sale condition codes — drop buckets whose
 *  size is dominated by these (spec: silent-boom-ask-100-demote-2026-05-12). */
const MULTI_LEG_TRADE_CODES = [
  'mlat',
  'mlet',
  'mlft',
  'mfto',
  'masl',
  'mesl',
  'mfsl',
  'mlct',
] as const;

interface ChainGroupBuilder {
  ticker: string;
  optionChain: string;
  optionType: 'C' | 'P';
  strike: number;
  expiry: string;
  buckets: ChainBucket[];
  oi: number;
}

/** Cash-index roots that trade on $5 strike increments. All other
 *  tickers use the $1 default. Matches the adjacent-strike co-fire
 *  detection in docs/tmp/sb-93d-peak-revisit-2026-05-17.py. */
const INDEX_COFIRE_ROOTS = new Set([
  'SPXW',
  'SPX',
  'NDXP',
  'NDX',
  'RUTW',
  'RUT',
]);
function adjCofireStrikeStep(ticker: string): number {
  return INDEX_COFIRE_ROOTS.has(ticker) ? 5.0 : 1.0;
}

/**
 * Minute-of-day (Central Time) for the silent-boom score's TOD bucket.
 * Intl-based so DST transitions are handled correctly without an
 * extra dependency. Returns 0–1439.
 */
const CT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});
function ctMinuteFromUtcMs(utcMs: number): number {
  const parts = CT_FORMATTER.formatToParts(new Date(utcMs));
  const h = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '0',
    10,
  );
  const m = Number.parseInt(
    parts.find((p) => p.type === 'minute')?.value ?? '0',
    10,
  );
  // 24-hour formatter sometimes emits hour=24 at midnight.
  return (h === 24 ? 0 : h) * 60 + m;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export default withCronInstrumentation(
  'detect-silent-boom',
  async (ctx): Promise<CronResult> => {
    const db = getDb();

    // Aggregate to 5-min buckets in SQL so the wire payload stays
    // bounded by chain-count, not tick-count. Raw-tick projection of
    // the same window can exceed the Neon HTTP 64 MB cap on busy days.
    // date_bin's 2000-01-01 origin is epoch-aligned at 5-min stride,
    // so bucket starts match the prior `Math.floor(ms / 300_000)` JS
    // bucketing exactly. ARRAY_AGG(... ORDER BY executed_at DESC)[1]
    // preserves the prior `lastPrice = final tick under ASC sort`
    // semantics.
    // withRetry covers transient Neon HTTP failures (ECONNRESET / fetch
    // failed / socket hang up) — see SENTRY-EMERALD-DESERT-8X (2026-05-18,
    // 2h Neon connectivity blip that silently zeroed out detect output
    // for hours 18-20 UTC).
    const bucketRows = (await withRetry(
      () => db`
      SELECT
        ticker,
        option_chain,
        option_type,
        strike,
        expiry::text AS expiry,
        date_bin(
          INTERVAL '5 minutes',
          executed_at,
          TIMESTAMPTZ '2000-01-01 00:00:00+00'
        ) AS bucket_ts,
        SUM(size) AS size,
        COALESCE(SUM(size) FILTER (WHERE side = 'ask'), 0) AS ask_size,
        COALESCE(SUM(size) FILTER (WHERE side = 'bid'), 0) AS bid_size,
        COALESCE(SUM(size) FILTER (
          WHERE raw_payload->>'trade_code' = ANY(${MULTI_LEG_TRADE_CODES as unknown as string[]}::text[])
        ), 0) AS multi_leg_size,
        SUM(price * size) AS notional,
        MAX(open_interest) AS bucket_max_oi,
        (ARRAY_AGG(price ORDER BY executed_at DESC))[1] AS last_price,
        SUM(underlying_price * size) FILTER (WHERE underlying_price IS NOT NULL) AS underlying_notional,
        -- Size-weighted gamma over the bucket. raw_payload->>'gamma'
        -- because ws_option_trades only promotes delta/iv to typed
        -- columns; gamma stays in the JSONB envelope. NULL when the
        -- bucket has zero non-null gamma weight. Migration #168
        -- added gamma_at_trigger as the storage column on
        -- silent_boom_alerts. The NULLIF coerces UW's occasional
        -- literal empty string (~0.3% of rows) to SQL NULL so the
        -- ::numeric cast never sees "" — and so the FILTER predicate
        -- excludes those rows from both numerator and denominator.
        SUM(NULLIF(raw_payload->>'gamma', '')::numeric * size)
          FILTER (WHERE NULLIF(raw_payload->>'gamma', '') IS NOT NULL)
          / NULLIF(
              SUM(size) FILTER (WHERE NULLIF(raw_payload->>'gamma', '') IS NOT NULL),
              0
            )
          AS bucket_gamma,
        -- H2 in-bucket cadence: fraction of size landing in the first
        -- 60s of the bucket. Migration #171 added first_min_share as
        -- the storage column. The bucket start aligns with date_bin's
        -- 5-min grid (2000-01-01 origin), so "first 60s" is
        -- executed_at < bucket_ts + INTERVAL '1 minute'.
        SUM(size) FILTER (
          WHERE executed_at <
            date_bin(
              INTERVAL '5 minutes',
              executed_at,
              TIMESTAMPTZ '2000-01-01 00:00:00+00'
            ) + INTERVAL '1 minute'
        )::numeric / NULLIF(SUM(size), 0) AS first_min_share,
        -- H5 in-bucket NBBO spread: size-weighted relative spread
        -- ((ask-bid)/mid) across the bucket. UW WS payload carries
        -- NBBO inside raw_payload (the uw-stream daemon doesn't
        -- promote those fields to typed columns). NULL when no print
        -- in the bucket has a usable NBBO. Migration #171 added
        -- spread_in_bucket as the storage column.
        SUM(
          (
            ((raw_payload->>'nbbo_ask')::numeric - (raw_payload->>'nbbo_bid')::numeric)
            / NULLIF(((raw_payload->>'nbbo_ask')::numeric + (raw_payload->>'nbbo_bid')::numeric) / 2, 0)
          ) * size
        ) FILTER (
          WHERE raw_payload->>'nbbo_ask' IS NOT NULL
            AND raw_payload->>'nbbo_bid' IS NOT NULL
            AND (raw_payload->>'nbbo_ask')::numeric > 0
            AND (raw_payload->>'nbbo_bid')::numeric > 0
        )
        / NULLIF(
          SUM(size) FILTER (
            WHERE raw_payload->>'nbbo_ask' IS NOT NULL
              AND raw_payload->>'nbbo_bid' IS NOT NULL
              AND (raw_payload->>'nbbo_ask')::numeric > 0
              AND (raw_payload->>'nbbo_bid')::numeric > 0
          ),
          0
        ) AS spread_in_bucket
      FROM ws_option_trades
      WHERE executed_at >= NOW() - (${SCAN_WINDOW_MIN}::int * INTERVAL '1 minute')
        AND canceled = FALSE
        AND price > 0
      GROUP BY
        ticker, option_chain, option_type, strike, expiry::text,
        date_bin(
          INTERVAL '5 minutes',
          executed_at,
          TIMESTAMPTZ '2000-01-01 00:00:00+00'
        )
      ORDER BY option_chain, bucket_ts ASC
    `,
    )) as BucketRow[];

    if (bucketRows.length === 0) {
      // We're inside the market-hours-gated handler, so an empty bucket
      // window is anomalous — ws_option_trades fills continuously during
      // open hours. Most likely cause: a Neon read failure that withRetry
      // exhausted, or upstream ws-stream daemon stalling. Capture as a
      // warning so the silent-skip pattern from 2026-05-18 (where hours
      // 18-20 UTC showed zero alerts with no Sentry event) can't recur
      // without surfacing.
      //
      // BUT: the cronGuard gate (isMarketHours) opens 5 min before the
      // cash open to catch the auction, and the scan window reaches back
      // into the pre-open minutes. An empty scan in that pre-open sliver
      // is normal, not a stall — gate the alarm on isPastCashOpen() (with
      // a 2-min grace for the tape to start printing) so we stop false-
      // paging at 8:25-8:31 CT while still catching real stalls once the
      // session is genuinely active.
      if (isPastCashOpen(2)) {
        Sentry.captureMessage(
          'detect-silent-boom: empty bucket scan during market hours',
          {
            level: 'warning',
            tags: {
              'cron.job': 'detect-silent-boom',
              'cron.anomaly': 'empty-window',
            },
          },
        );
      }
      return {
        status: 'skipped',
        message: 'no ticks in scan window',
        metadata: { bucketRows: 0 },
      };
    }

    // Group buckets by chain. SQL already orders by (option_chain,
    // bucket_ts), so each chain's buckets land time-sorted in one
    // linear pass — no per-chain re-sort needed. maxOi is the chain's
    // running max across buckets; patched onto each bucket after the
    // pass to match the detector's ChainBucket contract.
    const groups = new Map<string, ChainGroupBuilder>();
    for (const r of bucketRows) {
      let g = groups.get(r.option_chain);
      if (!g) {
        g = {
          ticker: r.ticker,
          optionChain: r.option_chain,
          optionType: r.option_type,
          strike: Number(r.strike),
          expiry: r.expiry,
          buckets: [],
          oi: 0,
        };
        groups.set(r.option_chain, g);
      }
      const size = Number(r.size);
      const notional = Number(r.notional);
      const underlyingNotional =
        r.underlying_notional != null ? Number(r.underlying_notional) : null;
      g.buckets.push({
        bucket: new Date(r.bucket_ts),
        size,
        askSize: Number(r.ask_size),
        bidSize: Number(r.bid_size),
        multiLegSize: Number(r.multi_leg_size),
        maxOi: 0, // patched below once chain-level max is known
        vwap: size > 0 ? notional / size : 0,
        lastPrice: Number(r.last_price),
        underlyingVwap:
          underlyingNotional != null && size > 0
            ? underlyingNotional / size
            : null,
        bucketGamma: r.bucket_gamma != null ? Number(r.bucket_gamma) : null,
        firstMinShare:
          r.first_min_share != null ? Number(r.first_min_share) : null,
        spreadInBucket:
          r.spread_in_bucket != null ? Number(r.spread_in_bucket) : null,
      });
      if (r.bucket_max_oi != null && r.bucket_max_oi > g.oi) {
        g.oi = r.bucket_max_oi;
      }
    }
    for (const g of groups.values()) {
      for (const b of g.buckets) b.maxOi = g.oi;
    }

    // Seed cooldown state from the DB so successive cron runs don't
    // re-fire within the cooldown window.
    const eligibleChainIds: string[] = [];
    for (const g of groups.values()) {
      if (g.buckets.length >= SILENT_BOOM_SPEC_V1.baselineBuckets + 1) {
        eligibleChainIds.push(g.optionChain);
      }
    }
    const priorByChain = new Map<string, number>();
    if (eligibleChainIds.length > 0) {
      const priorRows = (await withDbRetry(
        () => db`
          SELECT
            option_chain_id,
            EXTRACT(EPOCH FROM MAX(bucket_ct)) * 1000 AS last_ms
          FROM silent_boom_alerts
          WHERE option_chain_id = ANY(${eligibleChainIds}::text[])
            AND bucket_ct >= NOW() - (${PRIOR_FIRE_LOOKBACK_MIN}::int * INTERVAL '1 minute')
          GROUP BY option_chain_id
        `,
        2,
        10_000,
      )) as { option_chain_id: string; last_ms: DbNullableNumeric }[];
      for (const r of priorRows) {
        if (r.last_ms != null) {
          priorByChain.set(r.option_chain_id, Number(r.last_ms));
        }
      }
    }

    // Pre-fetch Take-It bundle + sequential context (3 queries, once per
    // cron tick). On any failure proceed without takeit_prob — heuristic
    // INSERT still lands.
    const takeitCtx = await loadTakeitDetectContext('silentboom', {
      fetchRecentSameType: async (lookbackMin) => {
        const rows = (await withDbRetry(
          () => db`
            SELECT bucket_ct AS fire_time, underlying_symbol, option_type
            FROM silent_boom_alerts
            WHERE bucket_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
          `,
          2,
          10_000,
        )) as Array<{
          fire_time: Date;
          underlying_symbol: string;
          option_type: 'C' | 'P';
        }>;
        return rows as RecentFireRow[];
      },
      fetchRecentOtherTypeByChain: async (lookbackMin) => {
        // Pulls underlying_symbol + option_type too so the same row set powers
        // both the chain-keyed cofire map AND the sibling-chain (ticker+dir)
        // cofire map. One round-trip.
        const rows = (await withDbRetry(
          () => db`
            SELECT
              option_chain_id,
              underlying_symbol,
              option_type,
              trigger_time_ct AS fire_time
            FROM lottery_finder_fires
            WHERE trigger_time_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
          `,
          2,
          10_000,
        )) as Array<{
          option_chain_id: string;
          underlying_symbol: string;
          option_type: 'C' | 'P';
          fire_time: Date;
        }>;
        return rows as RecentCofireRow[];
      },
      fetchPriorSessionWinRateByTicker: async () => {
        const rows = (await withDbRetry(
          () => db`
            SELECT underlying_symbol, AVG(daily_rate)::float AS win_rate
            FROM (
              SELECT underlying_symbol, date,
                     AVG((peak_ceiling_pct >= 20)::int::float) AS daily_rate
              FROM silent_boom_alerts
              WHERE peak_ceiling_pct IS NOT NULL
                AND date < ${ctx.today}::date
              GROUP BY underlying_symbol, date
            ) per_day
            GROUP BY underlying_symbol
          `,
          2,
          10_000,
        )) as Array<{ underlying_symbol: string; win_rate: number | null }>;
        return rows;
      },
    });

    // Pull macro snapshots across the scan window once. Each fire's
    // mkt_tide_diff / zero_dte_diff / spx_spot_gamma_oi is the latest
    // tick at or before the bucket time within 30 min — same window
    // lottery uses. Single round-trip per source vs. a per-fire LATERAL.
    //
    // The four series are INDEPENDENT, so fetch them in PARALLEL
    // (Promise.allSettled) rather than serially — worst case was ~4×10s.
    //
    // Fail-open is PER-QUERY and ALWAYS open: the macro fetch NEVER drops
    // alerts. Detection + INSERT proceed even when every series fails — the
    // affected series fall open to [] so their per-fire as-of (tideDiffAt
    // etc.) returns null, identical to "no ticks in window", and the row
    // lands with NULL macro for that source. What differs is HOW the failure
    // is signalled (classified per-query via `settleDegradable`):
    //   - A transient rejection (Neon blip; withDbRetry already retried and
    //     re-threw a TransientDbError) → degrade quietly: warning-level Sentry
    //     + a warn log. The handler returns 'partial' only when fires landed
    //     (a transient blip on a 0-fire tick has zero blast radius → stays
    //     'success').
    //   - A genuine, non-transient rejection (real SQL/schema bug — e.g. a
    //     renamed column) → page: error-level Sentry + an error log, and the
    //     handler returns 'error' REGARDLESS of inserted count. The alerts
    //     still land (no drop), but a permanent breakage must go red on the
    //     cron monitor (FIX #2 maps a returned 'error' → 'error' check-in)
    //     rather than degrading silently and indefinitely.
    //
    // Per-query (not whole-block) fail-open means the direction gate —
    // which needs only market_tide — survives a spot_exposures/zero_dte
    // outage, and vice versa. (Lottery's analogous fallback is per-FIRE,
    // a deliberately different granularity — do NOT extract a shared util.)
    type TideTick = { ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric };
    type GammaTick = { ts_ms: DbNumeric; gamma_oi: DbNumeric };

    const [tideSettled, tideOtmSettled, zeroDteSettled, spxGammaSettled] =
      await Promise.allSettled([
        withDbRetry(
          () => db`
          SELECT
            EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
            ncp, npp
          FROM flow_data
          WHERE source = 'market_tide'
            AND timestamp >= NOW() - (
              (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
            )
          ORDER BY timestamp ASC
        `,
          2,
          10_000,
        ) as Promise<TideTick[]>,
        // OTM variant of market_tide. Per the spec, the OTM data for
        // source='market_tide_otm' lives in the regular ncp/npp columns;
        // the otm_ncp/otm_npp columns on flow_data are vestigial and NULL
        // for this source. Same lookup window (30 min) as the all-in tide.
        withDbRetry(
          () => db`
          SELECT
            EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
            ncp, npp
          FROM flow_data
          WHERE source = 'market_tide_otm'
            AND timestamp >= NOW() - (
              (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
            )
          ORDER BY timestamp ASC
        `,
          2,
          10_000,
        ) as Promise<TideTick[]>,
        withDbRetry(
          () => db`
          SELECT
            EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
            ncp, npp
          FROM flow_data
          WHERE source = 'zero_dte_greek_flow'
            AND timestamp >= NOW() - (
              (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
            )
          ORDER BY timestamp ASC
        `,
          2,
          10_000,
        ) as Promise<TideTick[]>,
        withDbRetry(
          () => db`
          SELECT
            EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
            gamma_oi
          FROM spot_exposures
          WHERE ticker = 'SPX'
            AND timestamp >= NOW() - (
              (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
            )
          ORDER BY timestamp ASC
        `,
          2,
          10_000,
        ) as Promise<GammaTick[]>,
      ]);

    // Classify each settled series via the shared `settleDegradable` helper:
    // fulfilled → value; rejected → fall open to [] + a failure kind
    // ('transient' | 'genuine'). Nothing throws — the four series always
    // resolve to usable arrays so detection + INSERT proceed.
    const tideRes = settleDegradable(tideSettled, [] as TideTick[]);
    const tideOtmRes = settleDegradable(tideOtmSettled, [] as TideTick[]);
    const zeroDteRes = settleDegradable(zeroDteSettled, [] as TideTick[]);
    const spxGammaRes = settleDegradable(spxGammaSettled, [] as GammaTick[]);

    const tideTicks: TideTick[] = tideRes.value;
    const tideOtmTicks: TideTick[] = tideOtmRes.value;
    const zeroDteTicks: TideTick[] = zeroDteRes.value;
    const spxGammaTicks: GammaTick[] = spxGammaRes.value;

    const macroResults = [tideRes, tideOtmRes, zeroDteRes, spxGammaRes];
    const transientFailures = macroResults.filter(
      (r) => r.failure === 'transient',
    ).length;
    const genuineFailures = macroResults.filter(
      (r) => r.failure === 'genuine',
    ).length;
    const macroSeriesFailed = transientFailures + genuineFailures;
    const macroDegraded = macroSeriesFailed > 0;
    // ALL failed reasons (not just the last) for the Sentry `extra`.
    const macroReasons = macroResults
      .filter((r) => r.failure != null)
      .map((r) => r.reason);
    const firstGenuineReason = macroResults.find(
      (r) => r.failure === 'genuine',
    )?.reason;
    const firstTransientReason = macroResults.find(
      (r) => r.failure === 'transient',
    )?.reason;

    if (genuineFailures > 0) {
      // A genuine (non-retryable) macro error is a real bug — page. The
      // alerts STILL land (null macro for the broken series); the loudness
      // comes from the error-level capture + the handler returning 'error'
      // (which the cron monitor maps to a red check-in).
      ctx.logger.error(
        {
          err: firstGenuineReason,
          genuineFailures,
          transientFailures,
          macroSeriesFailed,
        },
        'detect-silent-boom macro-series fetch hit a GENUINE error ' +
          '(non-transient); alerts still insert with NULL macro, but the ' +
          'run reports status:error so the bug pages',
      );
      Sentry.captureException(firstGenuineReason, {
        level: 'error',
        tags: {
          cron: 'detect-silent-boom',
          stage: 'macro_fetch',
        },
        extra: { genuineFailures, transientFailures, reasons: macroReasons },
      });
    } else if (transientFailures > 0) {
      // Transient-only degradation: degrade quietly. The alerts insert with
      // NULL macro for the affected series; the handler returns 'partial'
      // only when fires actually landed (see the return block below).
      ctx.logger.warn(
        {
          err: firstTransientReason,
          transientFailures,
          macroSeriesFailed,
        },
        'detect-silent-boom macro-series fetch degraded (transient); ' +
          'affected series use empty tick arrays (null macro for those fires)',
      );
      Sentry.captureException(firstTransientReason, {
        level: 'warning',
        tags: {
          cron: 'detect-silent-boom',
          stage: 'macro_fetch',
        },
        extra: { transientFailures, genuineFailures, reasons: macroReasons },
      });
    }

    /** Generic "latest tick at or before targetMs within 30min" lookup.
     *  Sorted ascending; binary-search for the rightmost element with
     *  ts_ms ≤ targetMs. Returns null when no tick falls in the window. */
    const lookupAt = <T extends { ts_ms: DbNumeric }>(
      ticks: T[],
      targetMs: number,
    ): T | null => {
      if (ticks.length === 0) return null;
      let lo = 0;
      let hi = ticks.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const ms = Number(ticks[mid]!.ts_ms);
        if (ms <= targetMs) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (found < 0) return null;
      const tick = ticks[found]!;
      const tickMs = Number(tick.ts_ms);
      if (targetMs - tickMs > 30 * 60 * 1000) return null;
      return tick;
    };
    const tideDiffAt = (targetMs: number): number | null => {
      const tick = lookupAt(tideTicks, targetMs);
      return tick == null ? null : Number(tick.ncp) - Number(tick.npp);
    };
    const tideOtmDiffAt = (targetMs: number): number | null => {
      const tick = lookupAt(tideOtmTicks, targetMs);
      return tick == null ? null : Number(tick.ncp) - Number(tick.npp);
    };
    const zeroDteDiffAt = (targetMs: number): number | null => {
      const tick = lookupAt(zeroDteTicks, targetMs);
      return tick == null ? null : Number(tick.ncp) - Number(tick.npp);
    };
    const spxGammaAt = (targetMs: number): number | null => {
      const tick = lookupAt(spxGammaTicks, targetMs);
      return tick == null ? null : Number(tick.gamma_oi);
    };

    let totalFires = 0;
    let inserted = 0;
    let skippedShort = 0;
    let skippedNoOi = 0;
    // GexBot lookup counters (migration #180). Silent regression on the
    // lookup never throws — a successful-but-null return is the failure
    // mode — so without these counts we have no signal when the
    // freshness window starts missing.
    let gexHits = 0;
    let gexMisses = 0;
    let gexOutOfUniverse = 0;
    // Multileg classifier observability (Task 6 / Finding 0.2). The
    // matcher fail-open path returns null for: DB query failure, empty
    // window, oversized window, missing anchor trade, sidecar error.
    // Without per-tick counters, a sidecar regression (e.g. classifier
    // returning null for 95% of inputs) is silent: detect-cron logs
    // still report healthy `inserted` counts because alert insertion
    // does not depend on a populated classification. The hit/miss split
    // makes that regression observable and alertable; the Sentry capture
    // below fires when the ratio drops under 50% on a meaningful sample
    // (see threshold rationale next to the captureMessage call).
    let multilegHits = 0;
    let multilegMisses = 0;

    // Per-(ticker, date) cumulative net-flow series cache. Shared across
    // all chain groups so two TSLA chains in the same cron tick fetch
    // the TSLA series once. Spec:
    // docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md.
    const tickerFlowCache = new Map<string, TickerFlowSeries>();

    // Per-cron-tick multileg classification cache. Keyed inside the
    // helper by (ticker, optionChain, minute) so multiple alerts on the
    // same chain in the same minute reuse one sidecar call. Cleared
    // when the handler returns. Spec: migration #160 columns; sidecar
    // POST /takeit/multileg-classify (commit ced5ff10).
    const multilegCache: MultilegClassifyCache = new Map();

    // Pre-pass: detect fires across all groups + apply gate counters.
    // Splitting detection from scoring lets the score loop see ALL
    // fires in this cron-tick, which is required for intra-cron
    // adj_cofire detection (migration #170 / Phase B): two adjacent-
    // strike fires in the same bucket_ct each get their adj_cofire
    // flag flipped TRUE. Single-pass would not see the other side of
    // the pair yet.
    type FireRecord = {
      g: ChainGroupBuilder;
      f: ReturnType<typeof detectSilentBoomFires>[number];
      // Session day (ET YYYY-MM-DD) derived from THIS fire's bucket
      // timestamp — NOT ctx.today. On a late or retried run the cron-run
      // wall-clock ET date can differ from the bucket's ET day, which
      // would file the alert under the wrong day and skew dte by one
      // relative to what the read endpoints (which filter `date::date`)
      // expect. dte is computed from the same per-fire date.
      date: string;
      dte: number;
    };
    const allFires: FireRecord[] = [];
    for (const g of groups.values()) {
      if (g.buckets.length < SILENT_BOOM_SPEC_V1.baselineBuckets + 1) {
        skippedShort += 1;
        continue;
      }
      if (g.oi < SILENT_BOOM_SPEC_V1.minOi) {
        skippedNoOi += 1;
        continue;
      }

      const priorMs = priorByChain.get(g.optionChain) ?? null;
      const fires = detectSilentBoomFires(g.buckets, priorMs);
      if (fires.length === 0) continue;
      totalFires += fires.length;

      for (const f of fires) {
        const date = getETDateStr(f.bucketTs);
        allFires.push({ g, f, date, dte: daysBetween(date, g.expiry) });
      }
    }

    // Build the cofire keyset from ALL fires in this tick. Key
    // shape `${ticker}|${optionType}|${bucket_ts ISO}|${strike}`
    // matches the adjacent-strike lookup pattern used by the
    // 93-day peak-revisit analysis. Set is rebuilt every cron
    // invocation; intra-cron coverage is sufficient — adjacent-
    // strike fires almost always share the same bucket_ct and
    // therefore the same 5-min cron window.
    const cofireKeyset = new Set<string>();
    for (const { g, f } of allFires) {
      const k = `${g.ticker}|${g.optionType}|${f.bucketTs.toISOString()}|${g.strike}`;
      cofireKeyset.add(k);
    }

    // Pre-trade-count (migration #169): non-canceled, positive-price
    // trades on each fire's chain from session open (08:30 CT) to the
    // spike's bucket_ct. Fed into the score for the +4 heavy-activity
    // bonus (≥501 trades). Spec:
    //   docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md
    //
    // One grouped query for ALL fires instead of N per-fire COUNTs
    // (AUD-M7). The count window is determined by the
    // (option_chain, date, bucketTs) triple — both bounds vary per fire —
    // so we unnest those parallel arrays and LEFT JOIN ws_option_trades
    // per-key. LEFT JOIN + COUNT(t.*) yields 0 for a key with no matching
    // trades, identical to a per-fire COUNT returning 0. Postgres handles
    // the CT-to-UTC conversion via AT TIME ZONE so DST works without
    // explicit math (same predicate as the prior per-fire query).
    const preTradeCountByKey = new Map<string, number>();
    const ptcKey = (chain: string, date: string, bucketIso: string): string =>
      `${chain}|${date}|${bucketIso}`;
    if (allFires.length > 0) {
      // Dedupe the key triples so a chain that fires twice in the same
      // bucket_ct (adjacent-strike co-fires share bucketTs) is counted
      // once; the map lookup below resolves both fires to the same count.
      // `keys[i]` is the canonical app-side key string for unnest ordinal
      // i+1 — joining the grouped result back by WITH ORDINALITY avoids
      // any reliance on Postgres echoing date/timestamptz text in the
      // exact format the app-side key was built from.
      const keys: string[] = [];
      const chainArg: string[] = [];
      const dateArg: string[] = [];
      const bucketArg: string[] = [];
      const seenKeys = new Set<string>();
      for (const { g, f, date } of allFires) {
        const bucketIso = f.bucketTs.toISOString();
        const k = ptcKey(g.optionChain, date, bucketIso);
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        keys.push(k);
        chainArg.push(g.optionChain);
        dateArg.push(date);
        bucketArg.push(bucketIso);
      }
      const preTradeCountRows = (await withDbRetry(
        () => db`
            SELECT k.ord AS ord, COUNT(t.option_chain)::int AS cnt
              FROM unnest(
                     ${chainArg}::text[],
                     ${dateArg}::date[],
                     ${bucketArg}::timestamptz[]
                   ) WITH ORDINALITY AS k(chain, day, bts, ord)
              LEFT JOIN ws_option_trades t
                ON t.option_chain = k.chain
               AND t.canceled = FALSE
               AND t.price > 0
               AND t.executed_at >= (
                 (k.day + INTERVAL '8 hours 30 minutes')
                   AT TIME ZONE 'America/Chicago'
               )
               AND t.executed_at < k.bts
             GROUP BY k.ord
          `,
        2,
        10_000,
      )) as { ord: number; cnt: number }[];
      for (const row of preTradeCountRows) {
        const key = keys[Number(row.ord) - 1];
        if (key !== undefined) preTradeCountByKey.set(key, row.cnt);
      }
    }

    for (const { g, f, date, dte } of allFires) {
      // Score is deterministic from the fire payload + day context.
      // Computed inline so the row lands fully scored (no lazy
      // backfill / re-pass).
      const ctMinuteOfDay = ctMinuteFromUtcMs(f.bucketTs.getTime());
      const tod = silentBoomTodFromMinuteCt(ctMinuteOfDay);

      // Adjacent-strike co-fire (Phase B). +2 score bonus when an
      // SB alert exists at strike ± step on the same
      // (ticker, optionType, bucket_ct). Step = $5 for cash-index
      // roots (SPX/NDX/RUT), $1 otherwise.
      const cofireStep = adjCofireStrikeStep(g.ticker);
      const cofireTs = f.bucketTs.toISOString();
      const adjCofire =
        cofireKeyset.has(
          `${g.ticker}|${g.optionType}|${cofireTs}|${g.strike + cofireStep}`,
        ) ||
        cofireKeyset.has(
          `${g.ticker}|${g.optionType}|${cofireTs}|${g.strike - cofireStep}`,
        );

      // Pre-trade-count: looked up from the single grouped COUNT computed
      // above (keyed on the same (option_chain, date, bucketTs) window).
      // A missing key means zero matching trades — identical to the prior
      // per-fire COUNT returning 0.
      const preTradeCount =
        preTradeCountByKey.get(
          ptcKey(g.optionChain, date, f.bucketTs.toISOString()),
        ) ?? 0;

      const score = computeSilentBoomScore({
        dte,
        baselineVolume: f.baselineVolume,
        spikeRatio: f.spikeRatio,
        entryPrice: f.entryPrice,
        askPct: f.askPct,
        tod,
        optionType: g.optionType,
        tradingDay: date,
        preTradeCount,
        adjCofire,
        firstMinShare: f.firstMinShareAtSpike,
        spreadInBucket: f.spreadInBucketAtSpike,
      });
      const tier = silentBoomScoreTier(score);

      const targetMs = f.bucketTs.getTime();
      const mktTideDiff = tideDiffAt(targetMs);
      const mktTideOtmDiff = tideOtmDiffAt(targetMs);
      const zeroDteDiff = zeroDteDiffAt(targetMs);
      const spxSpotGammaOi = spxGammaAt(targetMs);

      // Snapshot ticker cumulative net call/put premium at spike-bucket
      // time. Replaces the per-row LATERAL the feed used to run
      // (caused ~30s page loads). Cached per (ticker, date).
      const flowCacheKey = `${g.ticker}_${date}`;
      let flowSeries = tickerFlowCache.get(flowCacheKey);
      if (flowSeries == null) {
        flowSeries = await fetchTickerFlowSeries(db, g.ticker, date);
        tickerFlowCache.set(flowCacheKey, flowSeries);
      }
      const { cumNcp: cumNcpAtFire, cumNpp: cumNppAtFire } = flowAtFireTime(
        flowSeries,
        f.bucketTs,
      );

      // Phase 2 multileg classification (spec: migration #160; sidecar
      // POST /takeit/multileg-classify, commit ced5ff10). Fail-open —
      // the helper returns null on sidecar errors, missing anchor
      // trade, or oversized windows, and the four columns stay NULL
      // on the row. Take-It feature pipeline already treats these as
      // optional (`?: T | null`).
      const multilegResult = await classifyAlertMultileg(
        db,
        multilegCache,
        g.ticker,
        g.optionChain,
        f.bucketTs,
      );
      // Hit/miss split observability (Task 6 / Finding 0.2). Null is a
      // legitimate fail-open return — we don't want to throw — but a
      // sustained spike in misses is the silent regression we need to
      // see. Logged in the structured payload below and Sentry-captured
      // when the ratio crosses the threshold for the tick.
      if (multilegResult === null) {
        multilegMisses += 1;
      } else {
        multilegHits += 1;
      }
      const inferredStructure = multilegResult?.inferredStructure ?? null;
      const isIsolatedLeg = multilegResult?.isIsolatedLeg ?? null;
      const matchConfidence = multilegResult?.matchConfidence ?? null;
      const patternGroupId = multilegResult?.patternGroupId ?? null;

      // Phase 4 direction gate (spec:
      // docs/superpowers/specs/silent-boom-direction-gate-and-trail-ui-2026-05-14.md).
      // Counter-trend fires get demoted to tier3 and flagged with
      // direction_gated=TRUE so the UI can render a "Gated" pill and
      // the user can filter them out. Threshold is the all-in
      // mkt_tide_diff (NCP - NPP across the whole tape) at fire time.
      // STRICT > / < per spec — exactly ±T is NOT gated.
      const DIRECTION_GATE_T = 100_000_000;
      const directionGated = (() => {
        if (mktTideDiff == null) return false;
        if (g.optionType === 'P' && mktTideDiff > DIRECTION_GATE_T) {
          return true;
        }
        if (g.optionType === 'C' && mktTideDiff < -DIRECTION_GATE_T) {
          return true;
        }
        return false;
      })();
      // Gate-applied tier matches what the TAKE-IT model was trained on
      // (post-gate rows). Feed THIS to scoreSilentBoom — never the raw
      // `tier` — to preserve model parity. The exemption only affects
      // the final INSERT value, not the model's input.
      const gateAppliedTier: SilentBoomScoreTier = directionGated
        ? 'tier3'
        : tier;

      // Take-It probability (Phase 3c). Mirrors the lottery cron pattern.
      const takeitRow: SilentBoomAlertRow = {
        fire_time: f.bucketTs,
        date: new Date(`${date}T00:00:00Z`),
        option_chain_id: g.optionChain,
        underlying_symbol: g.ticker,
        option_type: g.optionType,
        strike: g.strike,
        dte,
        spike_volume: f.spikeVolume,
        baseline_volume: f.baselineVolume,
        spike_ratio: f.spikeRatio,
        ask_pct: f.askPct,
        vol_oi: f.volOi,
        entry_price: f.entryPrice,
        open_interest: f.openInterest,
        mkt_tide_diff: mktTideDiff,
        mkt_tide_otm_diff: mktTideOtmDiff,
        zero_dte_diff: zeroDteDiff,
        spx_spot_gamma_oi: spxSpotGammaOi,
        multi_leg_share: f.multiLegShare,
        underlying_price_at_spike: f.underlyingPriceAtSpike,
        score,
        score_tier: gateAppliedTier,
        direction_gated: directionGated,
      };
      const {
        prob: takeitProb,
        version: takeitVersion,
        features: takeitFeatures,
      } = scoreSilentBoom(takeitCtx, takeitRow);

      // TAKE-IT-conditioned gate exemption (spec:
      // docs/superpowers/specs/2026-05-27-takeit-conditioned-gate-fix-design.md).
      // When gated AND TAKE-IT >= the exemption threshold, keep the original
      // pre-gate tier — the gate is pure downside above 0.70 per the
      // calibration. Otherwise apply the standard gate-applied tier.
      // `direction_gated` itself stays true on the row so the UI/audit
      // can still see the gate fired.
      const effectiveTier: SilentBoomScoreTier =
        directionGated &&
        takeitProb != null &&
        takeitProb >= TAKEIT_GATE_EXEMPT_MIN_PROB
          ? tier
          : gateAppliedTier;
      // Persist the bundle-shaped feature dict so the SHAP fill cron can
      // hand it straight to the sidecar — no re-derivation in TS, no
      // raw-row passthrough that would miss one-hots + derived features.
      const takeitFeaturesJson =
        takeitFeatures === null ? null : JSON.stringify(takeitFeatures);

      // GexBot context snapshot at fire time (migration #180). Fail-open:
      // a lookup error must not block the alert insert — leave gex_*
      // columns NULL and continue. Probe basis:
      // docs/superpowers/specs/silent-boom-gexbot-probe-findings-2026-05-26.md
      const gexbotTicker = mapToGexbotTicker(g.ticker);
      let gexSnapshot: FireTimeGexbotSnapshot | null = null;
      if (gexbotTicker == null) {
        gexOutOfUniverse += 1;
      } else {
        try {
          gexSnapshot = await getLatestGexbotSnapshotAt(
            gexbotTicker,
            f.bucketTs,
          );
        } catch (err) {
          Sentry.captureException(err, {
            tags: {
              cron: 'detect-silent-boom',
              op: 'getLatestGexbotSnapshotAt',
              ticker: g.ticker,
            },
          });
        }
        if (gexSnapshot == null) gexMisses += 1;
        else gexHits += 1;
      }

      const result = (await withDbRetry(
        () => db`
            INSERT INTO silent_boom_alerts (
              date, bucket_ct, option_chain_id, underlying_symbol,
              option_type, strike, expiry, dte,
              spike_volume, baseline_volume, spike_ratio,
              ask_pct, vol_oi, entry_price, open_interest,
              score, score_tier, direction_gated,
              mkt_tide_diff, mkt_tide_otm_diff, zero_dte_diff, spx_spot_gamma_oi,
              multi_leg_share, underlying_price_at_spike,
              cum_ncp_at_fire, cum_npp_at_fire,
              inferred_structure, is_isolated_leg, match_confidence, pattern_group_id,
              takeit_prob, takeit_model_version, takeit_features,
              gamma_at_trigger, pre_trade_count, adj_cofire,
              first_min_share, spread_in_bucket,
              gex_one_cvroflow, gex_net_put_dex, gex_one_dexoflow, gex_one_gexoflow,
              gex_zcvr, gex_zero_gamma, gex_spot, gex_captured_at
            ) VALUES (
              ${date}::date, ${f.bucketTs.toISOString()},
              ${g.optionChain}, ${g.ticker},
              ${g.optionType}, ${g.strike}, ${g.expiry}::date, ${dte},
              ${f.spikeVolume}, ${f.baselineVolume}, ${f.spikeRatio},
              ${f.askPct}, ${f.volOi}, ${f.entryPrice}, ${f.openInterest},
              ${score}, ${effectiveTier}, ${directionGated},
              ${mktTideDiff}, ${mktTideOtmDiff}, ${zeroDteDiff}, ${spxSpotGammaOi},
              ${f.multiLegShare}, ${f.underlyingPriceAtSpike},
              ${cumNcpAtFire}, ${cumNppAtFire},
              ${inferredStructure}, ${isIsolatedLeg}, ${matchConfidence}, ${patternGroupId},
              ${takeitProb}, ${takeitVersion}, ${takeitFeaturesJson}::jsonb,
              ${f.gammaAtSpike}, ${preTradeCount}, ${adjCofire},
              ${f.firstMinShareAtSpike}, ${f.spreadInBucketAtSpike},
              ${gexSnapshot?.oneCvroflow ?? null},
              ${gexSnapshot?.netPutDex ?? null},
              ${gexSnapshot?.oneDexoflow ?? null},
              ${gexSnapshot?.oneGexoflow ?? null},
              ${gexSnapshot?.zcvr ?? null},
              ${gexSnapshot?.zeroGamma ?? null},
              ${gexSnapshot?.spot ?? null},
              ${gexSnapshot?.capturedAt.toISOString() ?? null}
            )
            ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING
            RETURNING id
          `,
        2,
        10_000,
      )) as { id: number }[];
      if (result.length > 0) inserted += 1;
    }

    // Multileg null-rate alert (Task 6 / Finding 0.2). When more than
    // half of attempted classifications return null AND we actually
    // inserted enough rows to make the ratio meaningful, capture a
    // warning. Threshold rationale:
    //   - 50% strict (`<`, not `<=`): a 50/50 split is plausible on
    //     thin tape (small-cap tickers with few neighboring legs); we
    //     only alert when nulls clearly dominate.
    //   - inserted > 10: low-volume protection. On quiet days a couple
    //     of fail-open misses can drag a small denominator under 50%
    //     and produce spurious pages. Ten inserts represents an active
    //     tick worth investigating.
    // This is observability, not a hard failure — captureMessage, not
    // throw — the cron's job is to insert alerts; classifier nulls do
    // not block that.
    const multilegTotal = multilegHits + multilegMisses;
    if (
      inserted > 10 &&
      multilegTotal > 0 &&
      multilegHits / multilegTotal < 0.5
    ) {
      Sentry.captureMessage('multileg.classify.high_null_rate', {
        level: 'warning',
        extra: {
          cron: 'detect-silent-boom',
          multilegHits,
          multilegMisses,
          inserted,
        },
      });
    }

    ctx.logger.info(
      {
        bucketRows: bucketRows.length,
        chains: groups.size,
        skippedShort,
        skippedNoOi,
        totalFires,
        inserted,
        priorSeeds: priorByChain.size,
        gexHits,
        gexMisses,
        gexOutOfUniverse,
        multilegHits,
        multilegMisses,
        macroDegraded,
        macroSeriesFailed,
        macroGenuineFailures: genuineFailures,
      },
      'detect-silent-boom completed',
    );

    // Status contract (FIX #1 + #9). Alerts ALWAYS land — status only
    // signals macro health:
    //   - genuineFailures > 0 → 'error' (loud; pages via the cron monitor),
    //     REGARDLESS of inserted count: a genuine schema bug is real even on
    //     a 0-fire tick.
    //   - else transientFailures > 0 AND inserted > 0 → 'partial'
    //     (observably degraded). A transient blip on a 0-fire tick had zero
    //     blast radius → stays 'success' (do NOT escalate).
    //   - else → 'success'.
    const status: 'error' | 'partial' | 'success' =
      genuineFailures > 0
        ? 'error'
        : transientFailures > 0 && inserted > 0
          ? 'partial'
          : 'success';
    return {
      status,
      rows: inserted,
      metadata: {
        bucketRows: bucketRows.length,
        chains: groups.size,
        skippedShort,
        skippedNoOi,
        totalFires,
        inserted,
        priorSeeds: priorByChain.size,
        gexHits,
        gexMisses,
        gexOutOfUniverse,
        multilegHits,
        multilegMisses,
        macroDegraded,
        macroSeriesFailed,
        macroGenuineFailures: genuineFailures,
      },
    };
  },
  { requireApiKey: false },
);
