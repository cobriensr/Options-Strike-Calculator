/**
 * GET /api/cron/detect-silent-boom
 *
 * Runs every 5 min during market hours. Reads the last 30 min of
 * ws_option_trades, buckets to 5-min, runs the silent-boom detector,
 * and INSERTs alerts into silent_boom_alerts with ON CONFLICT DO
 * NOTHING for idempotency.
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
  SILENT_BOOM_BUCKET_MS,
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
type DbSide = 'ask' | 'bid' | 'mid' | 'no_side';

interface TickRow {
  ticker: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: DbNumeric;
  expiry: string;
  executed_at: DbTimestamp;
  price: DbNumeric;
  size: number;
  side: DbSide;
  open_interest: number | null;
}

interface ChainGroupBuilder {
  ticker: string;
  optionChain: string;
  optionType: 'C' | 'P';
  strike: number;
  expiry: string;
  buckets: Map<number, BucketBuilder>;
  oi: number;
}

interface BucketBuilder {
  bucketMs: number;
  size: number;
  askSize: number;
  bidSize: number;
  notional: number; // price * size — divided at the end for vwap
  lastPrice: number;
}

function bucketMsForTime(ms: number): number {
  return Math.floor(ms / SILENT_BOOM_BUCKET_MS) * SILENT_BOOM_BUCKET_MS;
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

    // Pull every tick in the scan window. expiry::text bypasses any
    // driver-side TZ round-trip on DATE columns.
    const rows = (await db`
      SELECT
        ticker, option_chain, option_type, strike, expiry::text AS expiry,
        executed_at, price, size, side, open_interest
      FROM ws_option_trades
      WHERE executed_at >= NOW() - (${SCAN_WINDOW_MIN}::int * INTERVAL '1 minute')
        AND canceled = FALSE
        AND price > 0
      ORDER BY option_chain, executed_at ASC
    `) as TickRow[];

    if (rows.length === 0) {
      return {
        status: 'skipped',
        message: 'no ticks in scan window',
        metadata: { scanned: 0 },
      };
    }

    // Group by chain → bucket within chain. One linear pass.
    const groups = new Map<string, ChainGroupBuilder>();
    for (const r of rows) {
      let g = groups.get(r.option_chain);
      if (!g) {
        g = {
          ticker: r.ticker,
          optionChain: r.option_chain,
          optionType: r.option_type,
          strike: Number(r.strike),
          expiry: r.expiry,
          buckets: new Map(),
          oi: 0,
        };
        groups.set(r.option_chain, g);
      }
      const ts = new Date(r.executed_at).getTime();
      const bucketMs = bucketMsForTime(ts);
      let b = g.buckets.get(bucketMs);
      if (!b) {
        b = {
          bucketMs,
          size: 0,
          askSize: 0,
          bidSize: 0,
          notional: 0,
          lastPrice: 0,
        };
        g.buckets.set(bucketMs, b);
      }
      const size = r.size;
      const price = Number(r.price);
      b.size += size;
      if (r.side === 'ask') b.askSize += size;
      if (r.side === 'bid') b.bidSize += size;
      b.notional += size * price;
      b.lastPrice = price; // rows are sorted by executed_at within chain
      if (r.open_interest != null && r.open_interest > g.oi) {
        g.oi = r.open_interest;
      }
    }

    // Seed cooldown state from the DB so successive cron runs don't
    // re-fire within the cooldown window.
    const eligibleChainIds: string[] = [];
    for (const g of groups.values()) {
      if (g.buckets.size >= SILENT_BOOM_SPEC_V1.baselineBuckets + 1) {
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
      if (g.buckets.size < SILENT_BOOM_SPEC_V1.baselineBuckets + 1) {
        skippedShort += 1;
        continue;
      }
      if (g.oi < SILENT_BOOM_SPEC_V1.minOi) {
        skippedNoOi += 1;
        continue;
      }

      // Build sorted ChainBucket[] for the detector.
      const sortedBuckets = [...g.buckets.values()].sort(
        (a, b) => a.bucketMs - b.bucketMs,
      );
      const chainBuckets: ChainBucket[] = sortedBuckets.map((b) => ({
        bucket: new Date(b.bucketMs),
        size: b.size,
        askSize: b.askSize,
        bidSize: b.bidSize,
        maxOi: g.oi,
        vwap: b.size > 0 ? b.notional / b.size : 0,
        lastPrice: b.lastPrice,
      }));

      const priorMs = priorByChain.get(g.optionChain) ?? null;
      const fires = detectSilentBoomFires(chainBuckets, priorMs);
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
        const zeroDteDiff = zeroDteDiffAt(targetMs);
        const spxSpotGammaOi = spxGammaAt(targetMs);

        const result = (await db`
          INSERT INTO silent_boom_alerts (
            date, bucket_ct, option_chain_id, underlying_symbol,
            option_type, strike, expiry, dte,
            spike_volume, baseline_volume, spike_ratio,
            ask_pct, vol_oi, entry_price, open_interest,
            score, score_tier,
            mkt_tide_diff, zero_dte_diff, spx_spot_gamma_oi
          ) VALUES (
            ${ctx.today}::date, ${f.bucketTs.toISOString()},
            ${g.optionChain}, ${g.ticker},
            ${g.optionType}, ${g.strike}, ${g.expiry}::date, ${dte},
            ${f.spikeVolume}, ${f.baselineVolume}, ${f.spikeRatio},
            ${f.askPct}, ${f.volOi}, ${f.entryPrice}, ${f.openInterest},
            ${score}, ${tier},
            ${mktTideDiff}, ${zeroDteDiff}, ${spxSpotGammaOi}
          )
          ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING
          RETURNING id
        `) as { id: number }[];
        if (result.length > 0) inserted += 1;
      }
    }

    ctx.logger.info(
      {
        scanned: rows.length,
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
        scanned: rows.length,
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
