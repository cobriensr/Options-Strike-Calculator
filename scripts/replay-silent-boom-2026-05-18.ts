/**
 * Production-parity replay of the silent_boom_alerts detector for
 * 2026-05-18. Walks minute-by-minute through 13:30 UTC → current time,
 * scanning the same 35-min trailing window the cron uses, and inserts
 * qualifying fires with ON CONFLICT DO NOTHING.
 *
 * The live cron has been failing every tick today (Sentry
 * SENTRY-EMERALD-DESERT-8G) because of an empty-string-to-numeric bug
 * on `raw_payload->>'gamma'`. Fix shipped in 54d66db1 wraps the read in
 * `NULLIF(raw_payload->>'gamma', '')::numeric` inside the bucket
 * aggregation. This replay mirrors that production SQL verbatim except
 * for replacing `NOW()` references with the per-tick `simulatedNow`.
 *
 * Structural template: scripts/replay-lottery-fires-2026-05-18.ts.
 * Detector logic is very different from lottery — silent-boom does
 * 5-min bucket aggregation entirely in SQL (raw-tick projection blows
 * past the Neon HTTP 64 MB cap on busy days, per
 * SENTRY-EMERALD-DESERT-5S). Per the spec, the production aggregation
 * is copied inline rather than extracted to a library.
 *
 * Differences from production cron:
 *   - `executed_at >= NOW() - (SCAN_WINDOW_MIN * INTERVAL '1 minute')`
 *       → `executed_at >  windowStart::timestamptz
 *          AND executed_at <= simulatedNow::timestamptz`
 *   - Cooldown lookback `NOW() - (PRIOR_FIRE_LOOKBACK_MIN * '1 min')`
 *       → bounded by `simulatedNow` on both ends.
 *   - Macro snapshot queries (flow_data, spot_exposures) replace
 *     `NOW() - (SCAN_WINDOW_MIN + 30) * '1 min'` with the same offset
 *     from `simulatedNow`, plus an upper bound of `simulatedNow` so
 *     the replay's virtual clock is respected.
 *   - Pre-trade count uses the per-fire `bucket_ct` upper bound (no
 *     `NOW()` reference in production) — left unchanged.
 *
 * The empty-string gamma NULLIF fix from 54d66db1 is preserved in the
 * bucket aggregation SQL below — see `bucket_gamma`.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/replay-silent-boom-2026-05-18.ts
 */

import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import {
  detectSilentBoomFires,
  SILENT_BOOM_SPEC_V1,
  type ChainBucket,
} from '../api/_lib/silent-boom.ts';
import {
  computeSilentBoomScore,
  silentBoomScoreTier,
  silentBoomTodFromMinuteCt,
} from '../api/_lib/silent-boom-score.ts';
import {
  loadTakeitDetectContext,
  scoreSilentBoom,
  type RecentCofireRow,
  type RecentFireRow,
} from '../api/_lib/takeit-detect.ts';
import type { SilentBoomAlertRow } from '../api/_lib/takeit-features.ts';
import {
  fetchTickerFlowSeries,
  flowAtFireTime,
  type TickerFlowSeries,
} from '../api/_lib/ticker-flow-snapshot.ts';
// classifyAlertMultileg / MultilegClassifyCache deliberately not
// imported — see comment at the per-fire multileg block below.

loadEnv({ path: '.env.local' });

const REPLAY_DAY_ET = '2026-05-18';
const REPLAY_START_UTC = new Date('2026-05-18T13:30:00Z');
const REPLAY_END_UTC = new Date(); // current time at script run
const STEP_MS = 60_000;

// Mirrors production cron — see api/cron/detect-silent-boom.ts.
const SCAN_WINDOW_MIN = 35;
const PRIOR_FIRE_LOOKBACK_MIN = 70;

// Direction-gate threshold (Phase 4 spec). STRICT > / < per production.
const DIRECTION_GATE_T = 100_000_000;

/** OPRA-standard multi-leg sale condition codes — same list the production
 *  cron uses to compute multi_leg_size in the bucket aggregation. */
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

/** Cash-index roots that trade on $5 strike increments. Mirrors the
 *  adj_cofire helper in detect-silent-boom.ts. */
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
  return (h === 24 ? 0 : h) * 60 + m;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;

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
  underlying_notional: DbNumeric | null;
  bucket_gamma: DbNumeric | null;
  first_min_share: DbNullableNumeric;
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

const DATABASE_URL =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
const db = neon(DATABASE_URL);

// ============================================================
// Per-script Take-It detect context (built once, reused across ticks).
// Same pattern as the lottery replay — the bundle fetch + 3 prefetch
// queries are expensive and the inputs only drift on the order of
// minutes, which is negligible vs. rebuilding it ~400× over the walk.
// ============================================================
async function buildTakeitContext() {
  return loadTakeitDetectContext('silentboom', {
    fetchRecentSameType: async (lookbackMin) => {
      const rows = (await db`
        SELECT bucket_ct AS fire_time, underlying_symbol, option_type
        FROM silent_boom_alerts
        WHERE bucket_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
      `) as Array<{
        fire_time: Date;
        underlying_symbol: string;
        option_type: 'C' | 'P';
      }>;
      return rows as RecentFireRow[];
    },
    fetchRecentOtherTypeByChain: async (lookbackMin) => {
      const rows = (await db`
        SELECT
          option_chain_id,
          underlying_symbol,
          option_type,
          trigger_time_ct AS fire_time
        FROM lottery_finder_fires
        WHERE trigger_time_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
      `) as Array<{
        option_chain_id: string;
        underlying_symbol: string;
        option_type: 'C' | 'P';
        fire_time: Date;
      }>;
      return rows as RecentCofireRow[];
    },
    fetchPriorSessionWinRateByTicker: async () => {
      const rows = (await db`
        SELECT underlying_symbol, AVG(daily_rate)::float AS win_rate
        FROM (
          SELECT underlying_symbol, date,
                 AVG((peak_ceiling_pct >= 20)::int::float) AS daily_rate
          FROM silent_boom_alerts
          WHERE peak_ceiling_pct IS NOT NULL
            AND date < ${REPLAY_DAY_ET}::date
          GROUP BY underlying_symbol, date
        ) per_day
        GROUP BY underlying_symbol
      `) as Array<{ underlying_symbol: string; win_rate: number | null }>;
      return rows;
    },
  });
}

// ============================================================
// Macro snapshot ticks fetched per cron-tick. The production cron
// pulls these once per invocation across the SCAN_WINDOW_MIN + 30
// minute lookup window, then uses an in-memory binary search to find
// the latest tick at-or-before each fire's bucket_ct. We reproduce
// that here against the simulated clock.
// ============================================================
interface MacroTicksBundle {
  tideTicks: Array<{ ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }>;
  tideOtmTicks: Array<{ ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }>;
  zeroDteTicks: Array<{ ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }>;
  spxGammaTicks: Array<{ ts_ms: DbNumeric; gamma_oi: DbNumeric }>;
}

async function fetchMacroTicks(simulatedNow: Date): Promise<MacroTicksBundle> {
  const lookbackStart = new Date(
    simulatedNow.getTime() - (SCAN_WINDOW_MIN + 30) * 60_000,
  );
  const startIso = lookbackStart.toISOString();
  const endIso = simulatedNow.toISOString();

  const tideTicks = (await db`
    SELECT
      EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
      ncp, npp
    FROM flow_data
    WHERE source = 'market_tide'
      AND timestamp >= ${startIso}::timestamptz
      AND timestamp <= ${endIso}::timestamptz
    ORDER BY timestamp ASC
  `) as { ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }[];

  const tideOtmTicks = (await db`
    SELECT
      EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
      ncp, npp
    FROM flow_data
    WHERE source = 'market_tide_otm'
      AND timestamp >= ${startIso}::timestamptz
      AND timestamp <= ${endIso}::timestamptz
    ORDER BY timestamp ASC
  `) as { ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }[];

  const zeroDteTicks = (await db`
    SELECT
      EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
      ncp, npp
    FROM flow_data
    WHERE source = 'zero_dte_greek_flow'
      AND timestamp >= ${startIso}::timestamptz
      AND timestamp <= ${endIso}::timestamptz
    ORDER BY timestamp ASC
  `) as { ts_ms: DbNumeric; ncp: DbNumeric; npp: DbNumeric }[];

  const spxGammaTicks = (await db`
    SELECT
      EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
      gamma_oi
    FROM spot_exposures
    WHERE ticker = 'SPX'
      AND timestamp >= ${startIso}::timestamptz
      AND timestamp <= ${endIso}::timestamptz
    ORDER BY timestamp ASC
  `) as { ts_ms: DbNumeric; gamma_oi: DbNumeric }[];

  return { tideTicks, tideOtmTicks, zeroDteTicks, spxGammaTicks };
}

/** Binary-search latest tick at-or-before targetMs within a 30-min
 *  window. Mirrors the `lookupAt` helper in detect-silent-boom.ts. */
function lookupAt<T extends { ts_ms: DbNumeric }>(
  ticks: T[],
  targetMs: number,
): T | null {
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
}

// ============================================================
// Per-cron-tick processing. Same shape as detect-silent-boom.ts.
// ============================================================
async function processOneCronTick(
  simulatedNow: Date,
  takeitCtx: Awaited<ReturnType<typeof buildTakeitContext>>,
): Promise<{
  bucketRows: number;
  chains: number;
  totalFires: number;
  inserted: number;
  skippedShort: number;
  skippedNoOi: number;
}> {
  const windowStart = new Date(
    simulatedNow.getTime() - SCAN_WINDOW_MIN * 60_000,
  );
  const windowStartIso = windowStart.toISOString();
  const simulatedNowIso = simulatedNow.toISOString();

  // ============================================================
  // BUCKET AGGREGATION — copied inline from detect-silent-boom.ts
  // lines ~186-275 with two adaptations:
  //   1. executed_at >= NOW() - (SCAN_WINDOW_MIN * INTERVAL '1 min')
  //      → executed_at >  windowStart AND executed_at <= simulatedNow
  //   2. The empty-string gamma NULLIF (commit 54d66db1) is preserved
  //      so the cast `(raw_payload->>'gamma')::numeric` never sees "".
  // ============================================================
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
      (ARRAY_AGG(price ORDER BY executed_at DESC))[1] AS last_price,
      SUM(underlying_price * size) FILTER (WHERE underlying_price IS NOT NULL) AS underlying_notional,
      SUM(NULLIF(raw_payload->>'gamma', '')::numeric * size)
        FILTER (WHERE NULLIF(raw_payload->>'gamma', '') IS NOT NULL)
        / NULLIF(
            SUM(size) FILTER (WHERE NULLIF(raw_payload->>'gamma', '') IS NOT NULL),
            0
          )
        AS bucket_gamma,
      SUM(size) FILTER (
        WHERE executed_at <
          date_bin(
            INTERVAL '5 minutes',
            executed_at,
            TIMESTAMPTZ '2000-01-01 00:00:00+00'
          ) + INTERVAL '1 minute'
      )::numeric / NULLIF(SUM(size), 0) AS first_min_share,
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
    WHERE executed_at >  ${windowStartIso}::timestamptz
      AND executed_at <= ${simulatedNowIso}::timestamptz
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
      bucketRows: 0,
      chains: 0,
      totalFires: 0,
      inserted: 0,
      skippedShort: 0,
      skippedNoOi: 0,
    };
  }

  // Group buckets by chain — mirrors production lines ~290-334.
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
      maxOi: 0,
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

  // Cooldown seed — replay uses simulatedNow as the upper bound on the
  // lookback so prior fires from "the future" relative to the virtual
  // clock are excluded. Production uses NOW() implicitly.
  const eligibleChainIds: string[] = [];
  for (const g of groups.values()) {
    if (g.buckets.length >= SILENT_BOOM_SPEC_V1.baselineBuckets + 1) {
      eligibleChainIds.push(g.optionChain);
    }
  }
  const priorByChain = new Map<string, number>();
  if (eligibleChainIds.length > 0) {
    const lookbackStart = new Date(
      simulatedNow.getTime() - PRIOR_FIRE_LOOKBACK_MIN * 60_000,
    );
    const priorRows = (await db`
      SELECT
        option_chain_id,
        EXTRACT(EPOCH FROM MAX(bucket_ct)) * 1000 AS last_ms
      FROM silent_boom_alerts
      WHERE option_chain_id = ANY(${eligibleChainIds}::text[])
        AND bucket_ct >= ${lookbackStart.toISOString()}::timestamptz
        AND bucket_ct <= ${simulatedNowIso}::timestamptz
      GROUP BY option_chain_id
    `) as { option_chain_id: string; last_ms: DbNullableNumeric }[];
    for (const r of priorRows) {
      if (r.last_ms != null) {
        priorByChain.set(r.option_chain_id, Number(r.last_ms));
      }
    }
  }

  // Macro snapshot — pulled once per cron tick.
  const { tideTicks, tideOtmTicks, zeroDteTicks, spxGammaTicks } =
    await fetchMacroTicks(simulatedNow);
  const tideDiffAt = (targetMs: number): number | null => {
    const t = lookupAt(tideTicks, targetMs);
    return t == null ? null : Number(t.ncp) - Number(t.npp);
  };
  const tideOtmDiffAt = (targetMs: number): number | null => {
    const t = lookupAt(tideOtmTicks, targetMs);
    return t == null ? null : Number(t.ncp) - Number(t.npp);
  };
  const zeroDteDiffAt = (targetMs: number): number | null => {
    const t = lookupAt(zeroDteTicks, targetMs);
    return t == null ? null : Number(t.ncp) - Number(t.npp);
  };
  const spxGammaAt = (targetMs: number): number | null => {
    const t = lookupAt(spxGammaTicks, targetMs);
    return t == null ? null : Number(t.gamma_oi);
  };

  // Per-tick caches — same lifetime as a single cron invocation.
  const tickerFlowCache = new Map<string, TickerFlowSeries>();

  // Pre-pass: detect all fires before scoring so adj_cofire can see
  // both sides of a pair in this tick. Mirrors production.
  type FireRecord = {
    g: ChainGroupBuilder;
    f: ReturnType<typeof detectSilentBoomFires>[number];
    dte: number;
  };
  const allFires: FireRecord[] = [];
  let skippedShort = 0;
  let skippedNoOi = 0;
  let totalFires = 0;
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
    const dte = daysBetween(REPLAY_DAY_ET, g.expiry);
    for (const f of fires) allFires.push({ g, f, dte });
  }

  const cofireKeyset = new Set<string>();
  for (const { g, f } of allFires) {
    const k = `${g.ticker}|${g.optionType}|${f.bucketTs.toISOString()}|${g.strike}`;
    cofireKeyset.add(k);
  }

  let inserted = 0;
  for (const { g, f, dte } of allFires) {
    const ctMinuteOfDay = ctMinuteFromUtcMs(f.bucketTs.getTime());
    const tod = silentBoomTodFromMinuteCt(ctMinuteOfDay);

    const cofireStep = adjCofireStrikeStep(g.ticker);
    const cofireTs = f.bucketTs.toISOString();
    const adjCofire =
      cofireKeyset.has(
        `${g.ticker}|${g.optionType}|${cofireTs}|${g.strike + cofireStep}`,
      ) ||
      cofireKeyset.has(
        `${g.ticker}|${g.optionType}|${cofireTs}|${g.strike - cofireStep}`,
      );

    // Pre-trade count — bounded by the fire's bucket_ct (no NOW() in
    // production, so this is unchanged).
    const preTradeCountRows = (await db`
        SELECT COUNT(*)::int AS cnt
          FROM ws_option_trades
         WHERE option_chain = ${g.optionChain}
           AND canceled = FALSE
           AND price > 0
           AND executed_at >= (
             (${REPLAY_DAY_ET}::date + INTERVAL '8 hours 30 minutes')
               AT TIME ZONE 'America/Chicago'
           )
           AND executed_at < ${f.bucketTs.toISOString()}::timestamptz
      `) as { cnt: number }[];
    const preTradeCount = preTradeCountRows[0]?.cnt ?? 0;

    const score = computeSilentBoomScore({
      dte,
      baselineVolume: f.baselineVolume,
      spikeRatio: f.spikeRatio,
      entryPrice: f.entryPrice,
      askPct: f.askPct,
      tod,
      optionType: g.optionType,
      tradingDay: REPLAY_DAY_ET,
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

    // Ticker flow at fire time — cached per (ticker, date).
    const flowCacheKey = `${g.ticker}_${REPLAY_DAY_ET}`;
    let flowSeries = tickerFlowCache.get(flowCacheKey);
    if (flowSeries == null) {
      flowSeries = await fetchTickerFlowSeries(db, g.ticker, REPLAY_DAY_ET);
      tickerFlowCache.set(flowCacheKey, flowSeries);
    }
    const { cumNcp: cumNcpAtFire, cumNpp: cumNppAtFire } = flowAtFireTime(
      flowSeries,
      f.bucketTs,
    );

    // Multileg classification — SKIPPED in this replay. The Railway
    // sidecar's multileg_assembler module is broken (returns HTTP 500
    // "No module named 'multileg_assembler'") and calling it for every
    // chain on every tick balloons replay runtime to >5 hours. Columns
    // stay NULL; the live cron also tolerates NULL here.
    const inferredStructure = null;
    const isIsolatedLeg = null;
    const matchConfidence = null;
    const patternGroupId = null;

    // Direction gate (Phase 4 spec). STRICT > / < — exactly ±T is NOT
    // gated. Threshold is the all-in mkt_tide_diff at fire time.
    const directionGated = (() => {
      if (mktTideDiff == null) return false;
      if (g.optionType === 'P' && mktTideDiff > DIRECTION_GATE_T) return true;
      if (g.optionType === 'C' && mktTideDiff < -DIRECTION_GATE_T) return true;
      return false;
    })();
    const effectiveTier = directionGated ? 'tier3' : tier;

    const takeitRow: SilentBoomAlertRow = {
      fire_time: f.bucketTs,
      date: new Date(`${REPLAY_DAY_ET}T00:00:00Z`),
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
      score_tier: effectiveTier,
      direction_gated: directionGated,
    };
    const {
      prob: takeitProb,
      version: takeitVersion,
      features: takeitFeatures,
    } = scoreSilentBoom(takeitCtx, takeitRow);
    const takeitFeaturesJson =
      takeitFeatures === null ? null : JSON.stringify(takeitFeatures);

    const result = (await db`
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
          first_min_share, spread_in_bucket
        ) VALUES (
          ${REPLAY_DAY_ET}::date, ${f.bucketTs.toISOString()},
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
          ${f.firstMinShareAtSpike}, ${f.spreadInBucketAtSpike}
        )
        ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING
        RETURNING id
      `) as { id: number }[];
    if (result.length > 0) inserted += 1;
  }

  return {
    bucketRows: bucketRows.length,
    chains: groups.size,
    totalFires,
    inserted,
    skippedShort,
    skippedNoOi,
  };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let totalBucketRows = 0;
  let totalChains = 0;
  let totalFires = 0;
  let totalInserted = 0;

  const totalMinutes = Math.max(
    1,
    Math.floor(
      (REPLAY_END_UTC.getTime() - REPLAY_START_UTC.getTime()) / STEP_MS,
    ) + 1,
  );
  console.log(
    `replay window: ${REPLAY_START_UTC.toISOString()} → ${REPLAY_END_UTC.toISOString()} ` +
      `(${totalMinutes} cron ticks, scan window ${SCAN_WINDOW_MIN} min)`,
  );

  const takeitCtx = await buildTakeitContext();
  if (takeitCtx == null) {
    console.warn(
      'WARN: Take-It bundle unreachable — takeit_prob/version/features will be NULL on every row',
    );
  }

  let i = 0;
  for (
    let t = REPLAY_START_UTC.getTime();
    t <= REPLAY_END_UTC.getTime();
    t += STEP_MS
  ) {
    i += 1;
    const simulatedNow = new Date(t);
    const {
      bucketRows,
      chains,
      totalFires: tickFires,
      inserted,
    } = await processOneCronTick(simulatedNow, takeitCtx);
    totalBucketRows += bucketRows;
    totalChains += chains;
    totalFires += tickFires;
    totalInserted += inserted;

    if (i % 30 === 0 || inserted > 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `  [${i}/${totalMinutes}] ${simulatedNow.toISOString()} ` +
          `buckets=${bucketRows} chains=${chains} fires=${tickFires} ` +
          `inserted=${inserted} cum_inserted=${totalInserted} elapsed=${elapsed}s`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\nDONE: ticks=${i} bucket_rows=${totalBucketRows} chains=${totalChains} ` +
      `fires_seen=${totalFires} inserted=${totalInserted} in ${elapsed}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
