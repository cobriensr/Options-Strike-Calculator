/**
 * GET /api/cron/detect-silent-boom
 *
 * Runs every 5 min during market hours. Aggregates the last
 * SCAN_WINDOW_MIN of ws_option_trades into 5-min per-chain buckets in
 * SQL (size, ask/bid splits, vwap, last price, max OI), runs the
 * silent-boom detector, records each alert's trigger print and its
 * exchange leg kind (one batched anchor lookup per tick), and INSERTs
 * alerts into silent_boom_alerts
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

import {
  getDb,
  isRetryableDbError,
  withDbRetry,
  settleDegradable,
} from '../_lib/db.js';
import { DeadlineError, withDeadline } from '../_lib/deadline.js';
import {
  detectSilentBoomFires,
  SILENT_BOOM_BUCKET_MS,
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
  lookupAnchorLegs,
  type AnchorLegs,
  type AnchorRequest,
} from '../_lib/anchor-legs.js';
import {
  withCronInstrumentation,
  type CronResult,
  type CronStatus,
} from '../_lib/cron-instrumentation.js';
import { isPastCashOpen } from '../_lib/cron-helpers.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  awaitWinRateWarmup,
  loadTakeitDetectContext,
  priorSessionWinRatesForDay,
  scoreSilentBoom,
  type PriorWinRateRow,
  type TakeitPrefetchFailure,
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
  getLatestGexbotSnapshotAt,
  mapToGexbotTicker,
  type FireTimeGexbotSnapshot,
} from '../_lib/gexbot-queries.js';
import { MULTI_LEG_TRADE_CODES } from '../_lib/multileg-codes.js';
import { TAKEIT_GATE_EXEMPT_MIN_PROB } from '../_lib/takeit-score.js';
import { withRetry } from '../_lib/uw-fetch.js';
import { Sentry } from '../_lib/sentry.js';
import { CASH_INDEX_ROOTS } from '../_lib/constants.js';

// 35-min scan window — needs at least baselineBuckets+1 buckets of
// history (4+1 = 5 buckets = 25 min) plus 10 min slack for cron jitter
// + late first ticks landing mid-bucket. Tight 30-min windows can drop
// chains whose first trade arrives ≥6 min into the window.
const SCAN_WINDOW_MIN = 35;

// Cooldown lookback for the per-chain priorLastFireMs seed. Detector
// cooldown is 60 min (12 buckets × 5min); we look back 70 min to
// absorb clock skew between cron invocations.
const PRIOR_FIRE_LOOKBACK_MIN = 70;

// Deadline for one ticker-day's flow series, with a run-level breaker: a
// stall or a transient failure costs a run at most 5 s, once, and the
// remaining uncached ticker-days are skipped with cum_ncp/cum_npp NULL.
// Unbounded, fetchTickerFlowSeries' own retries (3 × 10 s plus backoff)
// let two slow tickers time the run out. The query normally answers well
// under a second. The losing fetch keeps running on Neon, retries
// included; the breaker stops a second one. Same rule as
// detect-lottery-fires.
const FLOW_SERIES_DEADLINE_MS = 5_000;

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

interface ChainGroupBuilder {
  ticker: string;
  optionChain: string;
  optionType: 'C' | 'P';
  strike: number;
  expiry: string;
  buckets: ChainBucket[];
  oi: number;
}

/** Cash-index roots trade on $5 strike increments; all other tickers
 *  use the $1 default. Matches the adjacent-strike co-fire detection
 *  in docs/tmp/sb-93d-peak-revisit-2026-05-17.py. */
function adjCofireStrikeStep(ticker: string): number {
  return CASH_INDEX_ROOTS.has(ticker) ? 5.0 : 1.0;
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

    // Per-ticker prior-session win rates, a Take-It input. Its answer only
    // changes with the ET date, so it is loaded once per ET day and shared
    // across runs. Started here, before the bucket scan, so a cold load
    // has the whole setup phase to finish before the 5 s Take-It prefetch
    // asks for it. Not awaited: the cache handles a rejection, and the
    // prefetch below joins the load or retries it if this one failed.
    const loadPriorWinRates = async (
      beforeDate: string,
    ): Promise<PriorWinRateRow[]> =>
      (await db`
        SELECT underlying_symbol, AVG(daily_rate)::float AS win_rate
        FROM (
          SELECT underlying_symbol, date,
                 AVG((peak_ceiling_pct >= 20)::int::float) AS daily_rate
          FROM silent_boom_alerts
          WHERE peak_ceiling_pct IS NOT NULL
            AND date < ${beforeDate}::date
          GROUP BY underlying_symbol, date
        ) per_day
        GROUP BY underlying_symbol
      `) as PriorWinRateRow[];
    const winRateWarmup = priorSessionWinRatesForDay(
      'silentboom',
      ctx.today,
      loadPriorWinRates,
    );

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
          WHERE raw_payload->>'trade_code' = ANY(${MULTI_LEG_TRADE_CODES as string[]}::text[])
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
      // Nothing else to do: wait for the win-rate load started above, so
      // the pre-open run warms the cache instead of leaving the load to
      // freeze with the instance. Bounded from the run's start (45 s), so a
      // slow bucket scan plus the wait can't pass maxDuration.
      await awaitWinRateWarmup(winRateWarmup, ctx.startTimeMs);
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

    // Pre-fetch Take-It bundle + sequential context: two recent-fire
    // queries plus the win-rate day cache (started at the top of the run),
    // once per cron tick. Best-effort: the helper gives them 5 s, and on
    // any failure returns null (takeit_prob stays NULL, the heuristic
    // INSERT still lands) and tells us why via the callback.
    //
    // The two recent-fire lookbacks (35 and 10 min) carry a `date` bound
    // too: it is the leading column of the (date, bucket_ct) and (date,
    // trigger_time_ct) indexes, so the scan is a two-day range instead of
    // the whole index (planner cost ~1,490 → ~10 here, ~41,500 → ~190 on
    // lottery_finder_fires, 2026-10-28). That makes them sub-second, so
    // each gets one retry for a Neon blip (after a 1 s backoff). No
    // per-attempt cap: the 5 s prefetch deadline bounds the total, and a
    // cap would turn a slow success into a failure plus a second,
    // uncancelled copy of the query on Neon. Yesterday is included so a
    // lookback that crosses ET midnight still sees its fires.
    let takeitPrefetchFailure = null as TakeitPrefetchFailure | null;
    const takeitCtx = await loadTakeitDetectContext(
      'silentboom',
      {
        fetchRecentSameType: async (lookbackMin) =>
          (await withDbRetry(
            () => db`
              SELECT bucket_ct AS fire_time, underlying_symbol, option_type
              FROM silent_boom_alerts
              WHERE date >= ${ctx.today}::date - 1
                AND bucket_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
            `,
            1,
          )) as RecentFireRow[],
        // Pulls underlying_symbol + option_type too so the same row set powers
        // both the chain-keyed cofire map AND the sibling-chain (ticker+dir)
        // cofire map. One round-trip.
        fetchRecentOtherTypeByChain: async (lookbackMin) =>
          (await withDbRetry(
            () => db`
              SELECT
                option_chain_id,
                underlying_symbol,
                option_type,
                trigger_time_ct AS fire_time
              FROM lottery_finder_fires
              WHERE date >= ${ctx.today}::date - 1
                AND trigger_time_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
            `,
            1,
          )) as RecentCofireRow[],
        // Joins the load started at the top of the run, or retries it if
        // that one already failed (see loadPriorWinRates).
        fetchPriorSessionWinRateByTicker: () =>
          priorSessionWinRatesForDay(
            'silentboom',
            ctx.today,
            loadPriorWinRates,
          ),
      },
      (failure) => {
        takeitPrefetchFailure = failure;
      },
    );
    const takeitPrefetchError = takeitPrefetchFailure?.reason ?? null;
    const takeitPrefetchFailureKind = takeitPrefetchFailure?.kind ?? null;
    // The helper already sent this run's one Sentry event (an error for a
    // broken query, else a warning).
    if (takeitPrefetchFailureKind === 'error') {
      ctx.logger.error(
        { takeitPrefetchError, takeitPrefetchFailureKind },
        'detect-silent-boom: Take-It prefetch query error; takeit_prob left null',
      );
    } else if (takeitPrefetchFailureKind != null) {
      ctx.logger.warn(
        { takeitPrefetchError, takeitPrefetchFailureKind },
        'detect-silent-boom: Take-It prefetch failed; takeit_prob left null',
      );
    }

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

    // Per-(ticker, date) cumulative net-flow series cache. Shared across
    // all chain groups so two TSLA chains in the same cron tick fetch
    // the TSLA series once. Spec:
    // docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md.
    const tickerFlowCache = new Map<string, TickerFlowSeries>();
    // Ticker-days whose flow series failed or was skipped this run. Their
    // alerts are still written, with cum_ncp/cum_npp NULL (the score
    // doesn't use them). The empty series is cached, so the ticker's other
    // alerts don't retry. Reported once per run, after the insert loop:
    //   - a deadline or transient (Neon) failure: warning, 'partial', and
    //     the breaker opens so the remaining ticker-days are skipped;
    //   - any other error (a broken query): error, the run reports 'error'.
    let flowSeriesFailures = 0;
    let flowSeriesSkippedBreaker = 0;
    let flowSeriesGenuineFailures = 0;
    let flowBreakerOpen = false;
    let firstFlowSeriesError: {
      ticker: string;
      date: string;
      error: string;
    } | null = null;
    let firstFlowSeriesGenuineError: {
      ticker: string;
      date: string;
      err: unknown;
    } | null = null;

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

    // ── Trigger print + spread legs: one batched lookup per tick ─────────
    // The anchor is the top price × size print on the alert's own chain in
    // its 5-min bucket [bucket_ct, bucket_ct + 5 min). Its exchange trade
    // code says whether it was one leg of a spread, and for a spread leg
    // the lookup also groups the other legs (spec
    // 2026-10-28-classifier-replacement-design.md, migration #197 columns;
    // it replaces the Railway classifier, whose four migration #160
    // columns are no longer written). At most two queries for the whole
    // tick (R5), made before any INSERT. Alerts that will hit ON CONFLICT
    // are looked up too: they can't be told apart in advance, and in a
    // batch they cost nothing extra.
    //
    // A failed lookup leaves the columns NULL on every alert, so it is
    // reported apart from a missing anchor: a Sentry event and a log line
    // named anchor_legs.lookup_failed, anchorLookupError in the run
    // payload, and status 'partial' when the run wrote alerts. A missing
    // anchor is a warning of its own (see anchor-missing below).
    //
    // Retry budget: the lottery cron's two queries take 7–40 ms warm and
    // ~0.4 s cold (EXPLAIN on prod, 2026-10-29). This window is 5 min
    // instead of 1 on the same (option_chain, executed_at) index, so a 5 s
    // attempt cap still only cuts off a stall. With one retry the worst
    // case is 5 + 1 + 5 = 11 s ahead of the INSERTs, inside the 60 s
    // maxDuration.
    const anchorKey = (chain: string, bucketTs: Date): string =>
      `${chain}|${bucketTs.toISOString()}`;
    const anchorRequests: AnchorRequest[] = allFires.map(({ g, f }) => ({
      // Unique per alert in the tick: one fire per chain per bucket, the
      // same pair as the ON CONFLICT key.
      key: anchorKey(g.optionChain, f.bucketTs),
      // The ticker and chain exactly as the bucket scan read them from
      // ws_option_trades; the anchor query matches both.
      ticker: g.ticker,
      optionChain: g.optionChain,
      windowStart: f.bucketTs,
      windowEnd: new Date(f.bucketTs.getTime() + SILENT_BOOM_BUCKET_MS),
    }));
    let anchorsByKey = new Map<string, AnchorLegs | null>();
    let anchorLookupError: string | null = null;
    try {
      anchorsByKey = await withDbRetry(
        () => lookupAnchorLegs(anchorRequests),
        1,
        5_000,
      );
    } catch (err) {
      anchorLookupError = err instanceof Error ? err.message : String(err);
      // An exhausted Neon blip degrades quietly (warning); anything else
      // is a broken query and pages (error). Either way the alerts below
      // are still written.
      const transient = isRetryableDbError(err);
      const detail = { err, alerts: anchorRequests.length, transient };
      const message =
        'detect-silent-boom: anchor_legs.lookup_failed; alerts written without anchor legs';
      if (transient) ctx.logger.warn(detail, message);
      else ctx.logger.error(detail, message);
      Sentry.captureException(err, {
        level: transient ? 'warning' : 'error',
        fingerprint: ['detect-silent-boom', 'anchor_legs.lookup_failed'],
        tags: {
          'cron.job': 'detect-silent-boom',
          'cron.anomaly': 'anchor_legs.lookup_failed',
        },
        extra: { alerts: anchorRequests.length },
      });
    }
    // anchorsFound / anchorsMissing count every looked-up alert, including
    // alerts that then hit ON CONFLICT, not inserted rows.
    let anchorsFound = 0;
    for (const anchor of anchorsByKey.values()) {
      if (anchor != null) anchorsFound += 1;
    }
    // Empty map after a failed lookup, so a failure never counts as missing.
    const anchorsMissing = anchorsByKey.size - anchorsFound;

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
        flowSeries = { ts: [], cumNcp: [], cumNpp: [] };
        if (flowBreakerOpen) {
          flowSeriesSkippedBreaker += 1;
        } else {
          try {
            flowSeries = await withDeadline(
              fetchTickerFlowSeries(db, g.ticker, date),
              FLOW_SERIES_DEADLINE_MS,
              'ticker flow series',
            );
          } catch (err) {
            if (err instanceof DeadlineError || isRetryableDbError(err)) {
              // Neon slow or blipping: stop asking for this run.
              flowSeriesFailures += 1;
              flowBreakerOpen = true;
              firstFlowSeriesError ??= {
                ticker: g.ticker,
                date,
                error: err instanceof Error ? err.message : String(err),
              };
            } else {
              // A broken query fails fast; keep asking so the count shows
              // its reach.
              flowSeriesGenuineFailures += 1;
              firstFlowSeriesGenuineError ??= { ticker: g.ticker, date, err };
            }
          }
        }
        tickerFlowCache.set(flowCacheKey, flowSeries);
      }
      const { cumNcp: cumNcpAtFire, cumNpp: cumNppAtFire } = flowAtFireTime(
        flowSeries,
        f.bucketTs,
      );

      // This alert's trigger print from the batched lookup above: null when
      // it had no anchor print or the lookup failed. spread_legs stores the
      // SpreadLeg objects as returned (camelCase keys), serialised for jsonb.
      const anchor = anchorsByKey.get(anchorKey(g.optionChain, f.bucketTs));
      const spreadLegsJson =
        anchor?.spreadLegs == null ? null : JSON.stringify(anchor.spreadLegs);

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
              takeit_prob, takeit_model_version, takeit_features,
              gamma_at_trigger, pre_trade_count, adj_cofire,
              first_min_share, spread_in_bucket,
              gex_one_cvroflow, gex_net_put_dex, gex_one_dexoflow, gex_one_gexoflow,
              gex_zcvr, gex_zero_gamma, gex_spot, gex_captured_at,
              anchor_ws_trade_id, anchor_trade_code, anchor_leg_kind,
              spread_shape, spread_legs
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
              ${gexSnapshot?.capturedAt.toISOString() ?? null},
              ${anchor?.anchorWsTradeId ?? null}, ${anchor?.anchorTradeCode ?? null},
              ${anchor?.legKind ?? null}, ${anchor?.spreadShape ?? null},
              ${spreadLegsJson}::jsonb
            )
            ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING
            RETURNING id
          `,
        2,
        10_000,
      )) as { id: number }[];
      if (result.length > 0) inserted += 1;
    }

    // An alert's spike bucket is an aggregate of this tick's scan of
    // ws_option_trades: at least minSpikeVol contracts on the same chain
    // and ticker, price > 0, not canceled, inside [bucket_ct, bucket_ct +
    // 5 min). Each of those prints qualifies as the anchor, and the
    // canceled flag is set only at insert. So an alert with no anchor
    // means the bucket scan and the lookup disagree on ticker or time, a
    // regression and not a quiet market. The rows are written and the
    // status stays 'success'; this makes it visible, once per run.
    if (anchorsMissing > 0) {
      const message =
        'detect-silent-boom: no anchor print found for a fresh alert; anchor columns left null';
      const detail = { anchorsMissing, anchorsFound };
      ctx.logger.warn(detail, message);
      Sentry.captureMessage(message, {
        level: 'warning',
        fingerprint: ['detect-silent-boom', 'anchor-missing'],
        tags: {
          'cron.job': 'detect-silent-boom',
          'cron.anomaly': 'anchor-missing',
        },
        extra: detail,
      });
    }

    // Flow-series failures leave cum_ncp/cum_npp null on the row; the alert
    // itself is written. Each kind is reported once per run, with its first
    // case: Neon slow or blipping as a warning, a broken query as an error.
    if (flowSeriesFailures > 0) {
      const message =
        'detect-silent-boom: ticker flow series failed; alerts written without flow features';
      const detail = {
        flowSeriesFailures,
        flowSeriesSkippedBreaker,
        firstFlowSeriesError,
      };
      ctx.logger.warn(detail, message);
      Sentry.captureMessage(message, {
        level: 'warning',
        fingerprint: ['detect-silent-boom', 'flow-series-failed'],
        tags: {
          'cron.job': 'detect-silent-boom',
          'cron.anomaly': 'flow-series-failed',
        },
        extra: detail,
      });
    }
    const firstFlowSeriesGenuineErrorMeta =
      firstFlowSeriesGenuineError == null
        ? null
        : {
            ticker: firstFlowSeriesGenuineError.ticker,
            date: firstFlowSeriesGenuineError.date,
            error:
              firstFlowSeriesGenuineError.err instanceof Error
                ? firstFlowSeriesGenuineError.err.message
                : String(firstFlowSeriesGenuineError.err),
          };
    if (firstFlowSeriesGenuineError != null) {
      const message =
        'detect-silent-boom: ticker flow series query error; alerts written without flow features';
      ctx.logger.error(
        {
          err: firstFlowSeriesGenuineError.err,
          flowSeriesGenuineFailures,
          firstFlowSeriesGenuineError: firstFlowSeriesGenuineErrorMeta,
        },
        message,
      );
      Sentry.captureException(firstFlowSeriesGenuineError.err, {
        level: 'error',
        fingerprint: ['detect-silent-boom', 'flow-series-error'],
        tags: {
          'cron.job': 'detect-silent-boom',
          'cron.anomaly': 'flow-series-error',
        },
        extra: {
          flowSeriesGenuineFailures,
          firstFlowSeriesGenuineError: firstFlowSeriesGenuineErrorMeta,
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
        macroDegraded,
        macroSeriesFailed,
        macroGenuineFailures: genuineFailures,
        takeitPrefetchFailures: takeitPrefetchError == null ? 0 : 1,
        flowSeriesFailures,
        flowSeriesSkippedBreaker,
        flowSeriesGenuineFailures,
        anchorsFound,
        anchorsMissing,
        anchorLookupFailures: anchorLookupError == null ? 0 : 1,
      },
      'detect-silent-boom completed',
    );

    // Status contract (FIX #1 + #9). Alerts ALWAYS land — status only
    // signals degradation:
    //   - a genuine (non-transient) macro, flow-series or Take-It prefetch
    //     error → 'error' (loud; pages via the cron monitor), REGARDLESS of
    //     inserted count: a genuine schema bug is real even on a 0-fire
    //     tick.
    //   - else a transient macro failure, a Take-It prefetch that timed out
    //     or hit a Neon blip (takeit_prob NULL), a flow series that
    //     failed or was skipped by the breaker (cum_* NULL), or a failed
    //     anchor-legs lookup, transient or not (anchor columns NULL on
    //     every alert; the lookup's own Sentry event pages a broken query),
    //     AND inserted > 0 → 'partial' (observably degraded). On a 0-fire
    //     tick no row was degraded → stays 'success' (do NOT escalate).
    //   - else → 'success'.
    const degraded =
      transientFailures > 0 ||
      takeitPrefetchError != null ||
      flowSeriesFailures > 0 ||
      flowSeriesSkippedBreaker > 0 ||
      anchorLookupError != null;
    const status: CronStatus =
      genuineFailures > 0 ||
      flowSeriesGenuineFailures > 0 ||
      takeitPrefetchFailureKind === 'error'
        ? 'error'
        : degraded && inserted > 0
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
        macroDegraded,
        macroSeriesFailed,
        macroGenuineFailures: genuineFailures,
        takeitPrefetchFailures: takeitPrefetchError == null ? 0 : 1,
        takeitPrefetchError,
        takeitPrefetchFailureKind,
        flowSeriesFailures,
        flowSeriesSkippedBreaker,
        flowSeriesGenuineFailures,
        firstFlowSeriesError,
        firstFlowSeriesGenuineError: firstFlowSeriesGenuineErrorMeta,
        anchorsFound,
        anchorsMissing,
        anchorLookupFailures: anchorLookupError == null ? 0 : 1,
        anchorLookupError,
      },
    };
  },
  { requireApiKey: false },
);
