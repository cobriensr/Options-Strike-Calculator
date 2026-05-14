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

import { getDb } from '../_lib/db.js';
import {
  detectSilentBoomFires,
  SILENT_BOOM_SPEC_V1,
  type ChainBucket,
} from '../_lib/silent-boom.js';
import {
  computeSilentBoomScore,
  silentBoomScoreTier,
  silentBoomTodFromMinuteCt,
} from '../_lib/silent-boom-score.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

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
    const bucketRows = (await db`
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
        (ARRAY_AGG(price ORDER BY executed_at DESC))[1] AS last_price
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
    `) as BucketRow[];

    if (bucketRows.length === 0) {
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
      g.buckets.push({
        bucket: new Date(r.bucket_ts),
        size,
        askSize: Number(r.ask_size),
        bidSize: Number(r.bid_size),
        multiLegSize: Number(r.multi_leg_size),
        maxOi: 0, // patched below once chain-level max is known
        vwap: size > 0 ? notional / size : 0,
        lastPrice: Number(r.last_price),
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
      const priorRows = (await db`
        SELECT
          option_chain_id,
          EXTRACT(EPOCH FROM MAX(bucket_ct)) * 1000 AS last_ms
        FROM silent_boom_alerts
        WHERE option_chain_id = ANY(${eligibleChainIds}::text[])
          AND bucket_ct >= NOW() - (${PRIOR_FIRE_LOOKBACK_MIN}::int * INTERVAL '1 minute')
        GROUP BY option_chain_id
      `) as { option_chain_id: string; last_ms: DbNullableNumeric }[];
      for (const r of priorRows) {
        if (r.last_ms != null) {
          priorByChain.set(r.option_chain_id, Number(r.last_ms));
        }
      }
    }

    // Pull macro snapshots across the scan window once. Each fire's
    // mkt_tide_diff / zero_dte_diff / spx_spot_gamma_oi is the latest
    // tick at or before the bucket time within 30 min — same window
    // lottery uses. Single round-trip per source vs. a per-fire LATERAL.
    const tideTicks = (await db`
      SELECT
        EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
        ncp, npp
      FROM flow_data
      WHERE source = 'market_tide'
        AND timestamp >= NOW() - (
          (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
        )
      ORDER BY timestamp ASC
    `) as { ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }[];
    // OTM variant of market_tide. Per the spec, the OTM data for
    // source='market_tide_otm' lives in the regular ncp/npp columns;
    // the otm_ncp/otm_npp columns on flow_data are vestigial and NULL
    // for this source. Same lookup window (30 min) as the all-in tide.
    const tideOtmTicks = (await db`
      SELECT
        EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
        ncp, npp
      FROM flow_data
      WHERE source = 'market_tide_otm'
        AND timestamp >= NOW() - (
          (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
        )
      ORDER BY timestamp ASC
    `) as { ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }[];
    const zeroDteTicks = (await db`
      SELECT
        EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
        ncp, npp
      FROM flow_data
      WHERE source = 'zero_dte_greek_flow'
        AND timestamp >= NOW() - (
          (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
        )
      ORDER BY timestamp ASC
    `) as { ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }[];
    const spxGammaTicks = (await db`
      SELECT
        EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
        gamma_oi
      FROM spot_exposures
      WHERE ticker = 'SPX'
        AND timestamp >= NOW() - (
          (${SCAN_WINDOW_MIN}::int + 30) * INTERVAL '1 minute'
        )
      ORDER BY timestamp ASC
    `) as { ts_ms: DbNumeric; gamma_oi: DbNumeric }[];

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

      const dte = daysBetween(ctx.today, g.expiry);

      for (const f of fires) {
        // Score is deterministic from the fire payload + day context.
        // Computed inline so the row lands fully scored (no lazy
        // backfill / re-pass).
        const ctMinuteOfDay = ctMinuteFromUtcMs(f.bucketTs.getTime());
        const tod = silentBoomTodFromMinuteCt(ctMinuteOfDay);
        const score = computeSilentBoomScore({
          dte,
          baselineVolume: f.baselineVolume,
          spikeRatio: f.spikeRatio,
          entryPrice: f.entryPrice,
          askPct: f.askPct,
          tod,
          optionType: g.optionType,
        });
        const tier = silentBoomScoreTier(score);

        const targetMs = f.bucketTs.getTime();
        const mktTideDiff = tideDiffAt(targetMs);
        const mktTideOtmDiff = tideOtmDiffAt(targetMs);
        const zeroDteDiff = zeroDteDiffAt(targetMs);
        const spxSpotGammaOi = spxGammaAt(targetMs);

        const result = (await db`
          INSERT INTO silent_boom_alerts (
            date, bucket_ct, option_chain_id, underlying_symbol,
            option_type, strike, expiry, dte,
            spike_volume, baseline_volume, spike_ratio,
            ask_pct, vol_oi, entry_price, open_interest,
            score, score_tier,
            mkt_tide_diff, mkt_tide_otm_diff, zero_dte_diff, spx_spot_gamma_oi,
            multi_leg_share
          ) VALUES (
            ${ctx.today}::date, ${f.bucketTs.toISOString()},
            ${g.optionChain}, ${g.ticker},
            ${g.optionType}, ${g.strike}, ${g.expiry}::date, ${dte},
            ${f.spikeVolume}, ${f.baselineVolume}, ${f.spikeRatio},
            ${f.askPct}, ${f.volOi}, ${f.entryPrice}, ${f.openInterest},
            ${score}, ${tier},
            ${mktTideDiff}, ${mktTideOtmDiff}, ${zeroDteDiff}, ${spxSpotGammaOi},
            ${f.multiLegShare}
          )
          ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING
          RETURNING id
        `) as { id: number }[];
        if (result.length > 0) inserted += 1;
      }
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
      },
      'detect-silent-boom completed',
    );

    return {
      status: 'success',
      rows: inserted,
      metadata: {
        bucketRows: bucketRows.length,
        chains: groups.size,
        skippedShort,
        skippedNoOi,
        totalFires,
        inserted,
        priorSeeds: priorByChain.size,
      },
    };
  },
  { requireApiKey: false },
);
