/**
 * Production-parity replay of the lottery_finder_fires detector for
 * 2026-05-18. Walks minute-by-minute through 13:30 UTC → current time,
 * scanning the same 7-min window the cron uses, and inserts qualifying
 * fires with ON CONFLICT DO NOTHING.
 *
 * The live cron has been failing every tick today (Sentry
 * SENTRY-EMERALD-DESERT-8G) because of an empty-string-to-numeric bug
 * on raw_payload->>'gamma'. Fix shipped in 54d66db1 wraps the read in
 * NULLIF(...,'')::numeric — this replay mirrors that read so qualifying
 * fires for the missed window get backfilled.
 *
 * Adapted from scripts/replay-lottery-fires-2026-05-04.ts. Differences
 * since that replay:
 *   - SELECT now reads gamma from raw_payload (migration #168, NULLIF).
 *   - INSERT writes range_pos_at_trigger (UW stock candles).
 *   - INSERT writes cum_ncp_at_fire / cum_npp_at_fire (ticker flow).
 *   - INSERT writes inferred_structure / is_isolated_leg /
 *     match_confidence / pattern_group_id (multileg classify).
 *   - INSERT writes takeit_prob / takeit_model_version / takeit_features.
 *   - INSERT writes gamma_at_trigger (from rec.triggerGamma).
 *   - INSERT writes score + direction_gated (per current cron).
 *
 * Imports the unmodified production detector + enrichers + scorers
 * from api/_lib/*.ts so whatever fires here is exactly what
 * detect-lottery-fires.ts would have written had it been able to run.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/replay-lottery-fires-2026-05-18.ts
 */

import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import {
  detectChainFires,
  enrichFires,
  type LotteryFireRecord,
  type OptionTradeTick,
} from '../api/_lib/lottery-finder.ts';
import { computeLotteryScore } from '../api/_lib/lottery-score-weights.ts';
import { applyEmpiricalBonuses } from '../api/_lib/lottery-score-bonuses.ts';
import {
  computeRangePos,
  fetchStockCandles1m,
  type UWStockCandle,
} from '../api/_lib/uw-stock-candles.ts';
import {
  loadTakeitDetectContext,
  scoreLottery,
  type RecentCofireRow,
  type RecentFireRow,
} from '../api/_lib/takeit-detect.ts';
import type { LotteryAlertRow } from '../api/_lib/takeit-features.ts';
import {
  fetchTickerFlowSeries,
  flowAtFireTime,
  type TickerFlowSeries,
} from '../api/_lib/ticker-flow-snapshot.ts';
import {
  classifyAlertMultileg,
  type MultilegClassifyCache,
} from '../api/_lib/multileg-classify-batch.ts';

loadEnv({ path: '.env.local' });

const REPLAY_DAY_ET = '2026-05-18';
const REPLAY_START_UTC = new Date('2026-05-18T13:30:00Z');
const REPLAY_END_UTC = new Date(); // current time at script run
const STEP_MS = 60_000;
const SCAN_WINDOW_MIN = 7; // mirrors detect-lottery-fires.ts
const PER_CHAIN_MIN_PRINTS = 5;
const PRIOR_FIRE_LOOKBACK_MIN = 10;

const TICKERS_WITH_GEX_STRIKE = new Set([
  'SPX',
  'SPXW',
  'NDX',
  'NDXP',
  'SPY',
  'QQQ',
]);

const LOTTERY_DIRECTION_GATE_T = 150_000_000;

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
  underlying_price: DbNullableNumeric;
  side: DbSide;
  implied_volatility: DbNullableNumeric;
  delta: DbNullableNumeric;
  // Pulled from raw_payload JSONB at SELECT — see SQL below. NULL when
  // the payload omits the field OR when it's the literal empty string
  // (NULLIF coerces both → SQL NULL so the ::numeric cast never sees "").
  gamma: DbNullableNumeric;
  open_interest: number | null;
}

interface MacroSnapshot {
  mkt_tide_ncp: number | null;
  mkt_tide_npp: number | null;
  mkt_tide_diff: number | null;
  mkt_tide_otm_diff: number | null;
  spx_flow_diff: number | null;
  spy_etf_diff: number | null;
  qqq_etf_diff: number | null;
  zero_dte_diff: number | null;
  spx_spot_gamma_oi: number | null;
  spx_spot_gamma_vol: number | null;
  spx_spot_charm_oi: number | null;
  spx_spot_vanna_oi: number | null;
  gex_strike_call_minus_put: number | null;
  gex_strike_call_ask_minus_bid: number | null;
  gex_strike_put_ask_minus_bid: number | null;
  gex_strike_actual_strike: number | null;
}

const EMPTY_MACRO: MacroSnapshot = {
  mkt_tide_ncp: null,
  mkt_tide_npp: null,
  mkt_tide_diff: null,
  mkt_tide_otm_diff: null,
  spx_flow_diff: null,
  spy_etf_diff: null,
  qqq_etf_diff: null,
  zero_dte_diff: null,
  spx_spot_gamma_oi: null,
  spx_spot_gamma_vol: null,
  spx_spot_charm_oi: null,
  spx_spot_vanna_oi: null,
  gex_strike_call_minus_put: null,
  gex_strike_call_ask_minus_bid: null,
  gex_strike_put_ask_minus_bid: null,
  gex_strike_actual_strike: null,
};

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

const DATABASE_URL =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
const UW_API_KEY = process.env.UW_API_KEY ?? '';
if (!UW_API_KEY) {
  console.warn(
    'WARN: UW_API_KEY is unset — range_pos_at_trigger will be NULL for every fire',
  );
}
const db = neon(DATABASE_URL);

// Macro snapshot cache — minute-bucket × (ticker|strike) when relevant.
const macroCache = new Map<string, MacroSnapshot>();

function macroCacheKey(rec: LotteryFireRecord, minuteIso: string): string {
  const wantStrike = TICKERS_WITH_GEX_STRIKE.has(rec.underlyingSymbol);
  const strikeKey = wantStrike ? `${rec.underlyingSymbol}|${rec.strike}` : '_';
  return `${minuteIso}|${strikeKey}`;
}

async function fetchMacroSnapshot(
  rec: LotteryFireRecord,
  asOf: Date,
): Promise<MacroSnapshot> {
  const bucket = new Date(Math.floor(asOf.getTime() / 60_000) * 60_000);
  const bucketIso = bucket.toISOString();
  const cacheKey = macroCacheKey(rec, bucketIso);
  const hit = macroCache.get(cacheKey);
  if (hit) return hit;

  const flowRows = (await db`
    SELECT source, ncp, npp
    FROM flow_data
    WHERE timestamp <= ${asOf.toISOString()}
      AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
      AND source IN (
        'market_tide', 'market_tide_otm', 'spx_flow',
        'spy_etf_tide', 'qqq_etf_tide', 'zero_dte_greek_flow'
      )
    ORDER BY timestamp DESC
    LIMIT 200
  `) as {
    source: string;
    ncp: DbNumeric;
    npp: DbNumeric;
  }[];

  const spotRows = (await db`
    SELECT gamma_oi, gamma_vol, charm_oi, vanna_oi
    FROM spot_exposures
    WHERE ticker = 'SPX'
      AND timestamp <= ${asOf.toISOString()}
      AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
    ORDER BY timestamp DESC
    LIMIT 1
  `) as {
    gamma_oi: DbNullableNumeric;
    gamma_vol: DbNullableNumeric;
    charm_oi: DbNullableNumeric;
    vanna_oi: DbNullableNumeric;
  }[];

  const wantStrike = TICKERS_WITH_GEX_STRIKE.has(rec.underlyingSymbol);
  const strikeRows = wantStrike
    ? ((await db`
        SELECT
          strike,
          (call_gamma_oi - put_gamma_oi) AS call_minus_put,
          (call_gamma_ask - call_gamma_bid) AS call_ask_minus_bid,
          (put_gamma_ask - put_gamma_bid) AS put_ask_minus_bid
        FROM strike_exposures
        WHERE ticker = ${rec.underlyingSymbol}
          AND timestamp <= ${asOf.toISOString()}
          AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
          AND ABS(strike - ${rec.strike}::numeric) / NULLIF(${rec.strike}::numeric, 0) <= 0.01
        ORDER BY timestamp DESC, ABS(strike - ${rec.strike}::numeric) ASC
        LIMIT 1
      `) as {
        strike: DbNumeric;
        call_minus_put: DbNullableNumeric;
        call_ask_minus_bid: DbNullableNumeric;
        put_ask_minus_bid: DbNullableNumeric;
      }[])
    : [];

  const latestBySource = new Map<string, { ncp: number; npp: number }>();
  for (const r of flowRows) {
    if (latestBySource.has(r.source)) continue;
    latestBySource.set(r.source, {
      ncp: Number(r.ncp),
      npp: Number(r.npp),
    });
  }
  const tide = latestBySource.get('market_tide');
  const otm = latestBySource.get('market_tide_otm');
  const spxF = latestBySource.get('spx_flow');
  const spyE = latestBySource.get('spy_etf_tide');
  const qqqE = latestBySource.get('qqq_etf_tide');
  const zd = latestBySource.get('zero_dte_greek_flow');
  const spot = spotRows[0];
  const strikeRow = strikeRows[0];

  const snap: MacroSnapshot = {
    ...EMPTY_MACRO,
    mkt_tide_ncp: tide?.ncp ?? null,
    mkt_tide_npp: tide?.npp ?? null,
    mkt_tide_diff: tide ? tide.ncp - tide.npp : null,
    mkt_tide_otm_diff: otm ? otm.ncp - otm.npp : null,
    spx_flow_diff: spxF ? spxF.ncp - spxF.npp : null,
    spy_etf_diff: spyE ? spyE.ncp - spyE.npp : null,
    qqq_etf_diff: qqqE ? qqqE.ncp - qqqE.npp : null,
    zero_dte_diff: zd ? zd.ncp - zd.npp : null,
    spx_spot_gamma_oi:
      spot && spot.gamma_oi != null ? Number(spot.gamma_oi) : null,
    spx_spot_gamma_vol:
      spot && spot.gamma_vol != null ? Number(spot.gamma_vol) : null,
    spx_spot_charm_oi:
      spot && spot.charm_oi != null ? Number(spot.charm_oi) : null,
    spx_spot_vanna_oi:
      spot && spot.vanna_oi != null ? Number(spot.vanna_oi) : null,
    gex_strike_call_minus_put:
      strikeRow && strikeRow.call_minus_put != null
        ? Number(strikeRow.call_minus_put)
        : null,
    gex_strike_call_ask_minus_bid:
      strikeRow && strikeRow.call_ask_minus_bid != null
        ? Number(strikeRow.call_ask_minus_bid)
        : null,
    gex_strike_put_ask_minus_bid:
      strikeRow && strikeRow.put_ask_minus_bid != null
        ? Number(strikeRow.put_ask_minus_bid)
        : null,
    gex_strike_actual_strike: strikeRow ? Number(strikeRow.strike) : null,
  };
  macroCache.set(cacheKey, snap);
  return snap;
}

// Single per-script-run Take-It detect context. Built once (not per
// tick) because the bundle fetch + 3 prefetch queries are expensive
// and the inputs only drift on the order of minutes — within a
// minute-by-minute walk over today's window the staleness is
// negligible vs. the per-tick cost of rebuilding it 400+ times.
async function buildTakeitContext() {
  return loadTakeitDetectContext('lottery', {
    fetchRecentSameType: async (lookbackMin) => {
      const rows = (await db`
        SELECT trigger_time_ct AS fire_time, underlying_symbol, option_type
        FROM lottery_finder_fires
        WHERE trigger_time_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
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
          bucket_ct AS fire_time
        FROM silent_boom_alerts
        WHERE bucket_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
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
          FROM lottery_finder_fires
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

async function processOneCronTick(
  simulatedNow: Date,
  takeitCtx: Awaited<ReturnType<typeof buildTakeitContext>>,
): Promise<{
  scanned: number;
  inserted: number;
  totalFires: number;
}> {
  const windowStart = new Date(
    simulatedNow.getTime() - SCAN_WINDOW_MIN * 60_000,
  );
  // SELECT mirrors the production cron — gamma is pulled from
  // raw_payload via NULLIF(...,'')::numeric so empty-string payloads
  // don't blow up the numeric cast (the bug that crashed today's cron).
  const rows = (await db`
    SELECT
      ticker, option_chain, option_type, strike, expiry::text AS expiry,
      executed_at, price, size, underlying_price, side,
      implied_volatility, delta,
      NULLIF(raw_payload->>'gamma', '')::numeric AS gamma,
      open_interest
    FROM ws_option_trades
    WHERE executed_at >  ${windowStart.toISOString()}
      AND executed_at <= ${simulatedNow.toISOString()}
      AND canceled = FALSE
      AND price > 0
    ORDER BY option_chain, executed_at ASC
  `) as TickRow[];

  if (rows.length === 0) return { scanned: 0, inserted: 0, totalFires: 0 };

  interface ChainGroup {
    ticker: string;
    optionChain: string;
    optionType: 'C' | 'P';
    strike: number;
    expiry: string;
    ticks: OptionTradeTick[];
    oi: number;
  }
  const groups = new Map<string, ChainGroup>();
  for (const r of rows) {
    let g = groups.get(r.option_chain);
    if (!g) {
      g = {
        ticker: r.ticker,
        optionChain: r.option_chain,
        optionType: r.option_type,
        strike: Number(r.strike),
        expiry: r.expiry,
        ticks: [],
        oi: 0,
      };
      groups.set(r.option_chain, g);
    }
    g.ticks.push({
      executedAt: new Date(r.executed_at),
      optionChain: r.option_chain,
      optionType: r.option_type,
      strike: Number(r.strike),
      expiry: new Date(`${r.expiry}T00:00:00Z`),
      price: Number(r.price),
      size: r.size,
      underlyingPrice:
        r.underlying_price != null ? Number(r.underlying_price) : null,
      side: r.side,
      impliedVolatility:
        r.implied_volatility != null ? Number(r.implied_volatility) : null,
      delta: r.delta != null ? Number(r.delta) : null,
      gamma: r.gamma != null ? Number(r.gamma) : null,
      openInterest: r.open_interest,
    });
    if (r.open_interest != null && r.open_interest > g.oi) {
      g.oi = r.open_interest;
    }
  }

  // Cooldown seed — mirrors production. Without this, replay would
  // re-fire the same logical trigger on consecutive ticks because the
  // in-memory cooldown in detectChainFires resets each call.
  const eligibleChainIds: string[] = [];
  for (const g of groups.values()) {
    if (g.ticks.length >= PER_CHAIN_MIN_PRINTS && g.oi > 0) {
      eligibleChainIds.push(g.optionChain);
    }
  }
  const priorByChain = new Map<string, number>();
  if (eligibleChainIds.length > 0) {
    // Use simulatedNow rather than NOW() so the lookback respects
    // the replay's virtual clock — otherwise a fast replay would
    // pull "prior" fires from after the simulated window.
    const lookbackStart = new Date(
      simulatedNow.getTime() - PRIOR_FIRE_LOOKBACK_MIN * 60_000,
    );
    const priorRows = (await db`
      SELECT
        option_chain_id,
        EXTRACT(EPOCH FROM MAX(trigger_time_ct)) * 1000 AS last_ms
      FROM lottery_finder_fires
      WHERE option_chain_id = ANY(${eligibleChainIds}::text[])
        AND trigger_time_ct >= ${lookbackStart.toISOString()}
        AND trigger_time_ct <= ${simulatedNow.toISOString()}
      GROUP BY option_chain_id
    `) as { option_chain_id: string; last_ms: DbNullableNumeric }[];
    for (const r of priorRows) {
      if (r.last_ms != null) {
        priorByChain.set(r.option_chain_id, Number(r.last_ms));
      }
    }
  }

  let totalFires = 0;
  let inserted = 0;

  // Per-tick caches — same lifetime as a single cron invocation.
  const candleCache = new Map<string, UWStockCandle[]>();
  const tickerFlowCache = new Map<string, TickerFlowSeries>();
  const multilegCache: MultilegClassifyCache = new Map();

  for (const g of groups.values()) {
    if (g.ticks.length < PER_CHAIN_MIN_PRINTS) continue;
    if (g.oi <= 0) continue;
    const dte = daysBetween(REPLAY_DAY_ET, g.expiry);

    const priorMs = priorByChain.get(g.optionChain) ?? null;
    const fires = detectChainFires(g.ticks, g.oi, dte, priorMs);
    if (fires.length === 0) continue;
    totalFires += fires.length;

    const records = enrichFires(fires, {
      date: REPLAY_DAY_ET,
      optionChainId: g.optionChain,
      underlyingSymbol: g.ticker,
      optionType: g.optionType,
      strike: g.strike,
      expiry: g.expiry,
      dte,
    });
    const inUniverse = records.filter((r) => r.mode !== 'OUT_OF_UNIVERSE');
    if (inUniverse.length === 0) continue;
    const firstTick = g.ticks[0]!;

    for (const rec of inUniverse) {
      // Macro snapshot (fail-soft).
      let macro: MacroSnapshot;
      try {
        macro = await fetchMacroSnapshot(rec, firstTick.executedAt);
      } catch {
        macro = EMPTY_MACRO;
      }

      // Base score + empirical bonuses.
      const baseScore = computeLotteryScore({
        ticker: rec.underlyingSymbol,
        mode: rec.mode,
        entryPrice: rec.entryPrice,
        tod: rec.tod,
        optionType: rec.optionType,
      });

      // Range Kill — UW stock candles for the underlying × date.
      const cacheKey = `${rec.underlyingSymbol}_${rec.date}`;
      let candles = candleCache.get(cacheKey);
      if (candles == null) {
        candles = await fetchStockCandles1m(
          UW_API_KEY,
          rec.underlyingSymbol,
          rec.date,
        );
        candleCache.set(cacheKey, candles);
      }
      const rangePosAtTrigger = computeRangePos(
        candles,
        rec.triggerTimeCt,
        rec.spotAtFirst,
      );

      // Ticker cumulative net flow at fire time.
      const flowCacheKey = `${rec.underlyingSymbol}_${rec.date}`;
      let flowSeries = tickerFlowCache.get(flowCacheKey);
      if (flowSeries == null) {
        flowSeries = await fetchTickerFlowSeries(
          db,
          rec.underlyingSymbol,
          rec.date,
        );
        tickerFlowCache.set(flowCacheKey, flowSeries);
      }
      const { cumNcp: cumNcpAtFire, cumNpp: cumNppAtFire } = flowAtFireTime(
        flowSeries,
        rec.triggerTimeCt,
      );

      // Multileg classification (fail-open).
      const multilegResult = await classifyAlertMultileg(
        db,
        multilegCache,
        rec.underlyingSymbol,
        rec.optionChainId,
        rec.triggerTimeCt,
      );
      const inferredStructure = multilegResult?.inferredStructure ?? null;
      const isIsolatedLeg = multilegResult?.isIsolatedLeg ?? null;
      const matchConfidence = multilegResult?.matchConfidence ?? null;
      const patternGroupId = multilegResult?.patternGroupId ?? null;

      const score = applyEmpiricalBonuses({
        baseScore,
        triggerVolToOiWindow: rec.triggerVolToOiWindow,
      });

      // Direction gate — OTM-tide threshold per Phase 4 spec.
      const directionGated = (() => {
        const otm = macro.mkt_tide_otm_diff;
        if (otm == null) return false;
        if (rec.optionType === 'P' && otm > LOTTERY_DIRECTION_GATE_T) {
          return true;
        }
        if (rec.optionType === 'C' && otm < -LOTTERY_DIRECTION_GATE_T) {
          return true;
        }
        return false;
      })();

      // Take-It probability (heuristic still lands if null).
      const takeitRow: LotteryAlertRow = {
        fire_time: rec.triggerTimeCt,
        date: new Date(`${rec.date}T00:00:00Z`),
        option_chain_id: rec.optionChainId,
        underlying_symbol: rec.underlyingSymbol,
        option_type: rec.optionType,
        strike: rec.strike,
        dte: rec.dte,
        trigger_vol_to_oi_window: rec.triggerVolToOiWindow,
        trigger_vol_to_oi_cum: rec.triggerVolToOiCum,
        trigger_iv: rec.triggerIv,
        trigger_delta: rec.triggerDelta,
        trigger_ask_pct: rec.triggerAskPct,
        trigger_window_size: rec.triggerWindowSize,
        trigger_window_prints: rec.triggerWindowPrints,
        entry_price: rec.entryPrice,
        open_interest: rec.openInterest,
        spot_at_first: rec.spotAtFirst,
        alert_seq: rec.alertSeq,
        minutes_since_prev_fire: rec.minutesSincePrevFire,
        flow_quad: rec.flowQuad,
        tod: rec.tod,
        mode: rec.mode,
        reload_tagged: rec.reloadTagged,
        cheap_call_pm_tagged: rec.cheapCallPmTagged,
        burst_ratio_vs_prev: rec.burstRatioVsPrev,
        entry_drop_pct_vs_prev: rec.entryDropPctVsPrev,
        mkt_tide_ncp: macro.mkt_tide_ncp,
        mkt_tide_npp: macro.mkt_tide_npp,
        mkt_tide_diff: macro.mkt_tide_diff,
        mkt_tide_otm_diff: macro.mkt_tide_otm_diff,
        spx_flow_diff: macro.spx_flow_diff,
        spy_etf_diff: macro.spy_etf_diff,
        qqq_etf_diff: macro.qqq_etf_diff,
        zero_dte_diff: macro.zero_dte_diff,
        spx_spot_gamma_oi: macro.spx_spot_gamma_oi,
        spx_spot_gamma_vol: macro.spx_spot_gamma_vol,
        spx_spot_charm_oi: macro.spx_spot_charm_oi,
        spx_spot_vanna_oi: macro.spx_spot_vanna_oi,
        gex_strike_call_minus_put: macro.gex_strike_call_minus_put,
        gex_strike_call_ask_minus_bid: macro.gex_strike_call_ask_minus_bid,
        gex_strike_put_ask_minus_bid: macro.gex_strike_put_ask_minus_bid,
        score,
        direction_gated: directionGated,
      };
      const {
        prob: takeitProb,
        version: takeitVersion,
        features: takeitFeatures,
      } = scoreLottery(takeitCtx, takeitRow);
      const takeitFeaturesJson =
        takeitFeatures === null ? null : JSON.stringify(takeitFeatures);

      const result = (await db`
        INSERT INTO lottery_finder_fires (
          date, trigger_time_ct, entry_time_ct, option_chain_id,
          underlying_symbol, option_type, strike, expiry, dte,
          trigger_vol_to_oi_window, trigger_vol_to_oi_cum,
          trigger_iv, trigger_delta, trigger_ask_pct,
          trigger_window_size, trigger_window_prints,
          entry_price, open_interest, spot_at_first,
          alert_seq, minutes_since_prev_fire,
          flow_quad, tod, mode,
          reload_tagged, cheap_call_pm_tagged,
          burst_ratio_vs_prev, entry_drop_pct_vs_prev,
          mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff, mkt_tide_otm_diff,
          spx_flow_diff, spy_etf_diff, qqq_etf_diff, zero_dte_diff,
          spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm_oi, spx_spot_vanna_oi,
          gex_strike_call_minus_put, gex_strike_call_ask_minus_bid,
          gex_strike_put_ask_minus_bid, gex_strike_actual_strike,
          score, direction_gated, range_pos_at_trigger,
          cum_ncp_at_fire, cum_npp_at_fire,
          inferred_structure, is_isolated_leg, match_confidence, pattern_group_id,
          takeit_prob, takeit_model_version, takeit_features,
          gamma_at_trigger
        ) VALUES (
          ${rec.date}::date, ${rec.triggerTimeCt.toISOString()}, ${rec.entryTimeCt.toISOString()},
          ${rec.optionChainId}, ${rec.underlyingSymbol}, ${rec.optionType},
          ${rec.strike}, ${rec.expiry}::date, ${rec.dte},
          ${rec.triggerVolToOiWindow}, ${rec.triggerVolToOiCum},
          ${rec.triggerIv}, ${rec.triggerDelta}, ${rec.triggerAskPct},
          ${rec.triggerWindowSize}, ${rec.triggerWindowPrints},
          ${rec.entryPrice}, ${rec.openInterest}, ${rec.spotAtFirst},
          ${rec.alertSeq}, ${rec.minutesSincePrevFire},
          ${rec.flowQuad}, ${rec.tod}, ${rec.mode},
          ${rec.reloadTagged}, ${rec.cheapCallPmTagged},
          ${rec.burstRatioVsPrev}, ${rec.entryDropPctVsPrev},
          ${macro.mkt_tide_ncp}, ${macro.mkt_tide_npp}, ${macro.mkt_tide_diff}, ${macro.mkt_tide_otm_diff},
          ${macro.spx_flow_diff}, ${macro.spy_etf_diff}, ${macro.qqq_etf_diff}, ${macro.zero_dte_diff},
          ${macro.spx_spot_gamma_oi}, ${macro.spx_spot_gamma_vol}, ${macro.spx_spot_charm_oi}, ${macro.spx_spot_vanna_oi},
          ${macro.gex_strike_call_minus_put}, ${macro.gex_strike_call_ask_minus_bid},
          ${macro.gex_strike_put_ask_minus_bid}, ${macro.gex_strike_actual_strike},
          ${score}, ${directionGated}, ${rangePosAtTrigger},
          ${cumNcpAtFire}, ${cumNppAtFire},
          ${inferredStructure}, ${isIsolatedLeg}, ${matchConfidence}, ${patternGroupId},
          ${takeitProb}, ${takeitVersion}, ${takeitFeaturesJson}::jsonb,
          ${rec.triggerGamma}
        )
        ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING
        RETURNING id
      `) as { id: number }[];
      if (result.length > 0) inserted += 1;
    }
  }

  return { scanned: rows.length, inserted, totalFires };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let totalScanned = 0;
  let totalInserted = 0;
  let totalFiresSeen = 0;

  const totalMinutes = Math.max(
    1,
    Math.floor((REPLAY_END_UTC.getTime() - REPLAY_START_UTC.getTime()) / STEP_MS) +
      1,
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
    const { scanned, inserted, totalFires } = await processOneCronTick(
      simulatedNow,
      takeitCtx,
    );
    totalScanned += scanned;
    totalInserted += inserted;
    totalFiresSeen += totalFires;

    if (i % 30 === 0 || inserted > 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `  [${i}/${totalMinutes}] ${simulatedNow.toISOString()} ` +
          `scanned=${scanned} fires=${totalFires} inserted=${inserted} ` +
          `cum_inserted=${totalInserted} elapsed=${elapsed}s`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\nDONE: ticks=${i} scanned=${totalScanned} fires_seen=${totalFiresSeen} ` +
      `inserted=${totalInserted} in ${elapsed}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
