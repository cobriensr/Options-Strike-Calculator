/**
 * GET /api/cron/detect-lottery-fires
 *
 * Runs the v4 trigger detector on the rolling per-tick stream in
 * ws_option_trades for the Lottery Finder universe (~50 tickers).
 * Each qualifying fire is enriched with the per-fire discriminators
 * (RE-LOAD, cheap-call-PM, mode, flow_quad, tod) plus a macro-context
 * snapshot at fire time, then inserted into lottery_finder_fires with
 * ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING.
 *
 * Cadence: every minute during market hours (13:30–21:00 UTC, Mon-Fri).
 * Each invocation scans the last 7 minutes of trades — wider than the
 * 5-min v4 window so a slow cron tick can still pick up a trigger that
 * landed at the front of its window. Cooldown + ON CONFLICT make
 * re-firing on the same chain idempotent.
 *
 * Macro snapshot is **display-only** (per spec Appendix A — every
 * macro-augmented selection rule UNDERPERFORMED the cheap-call-PM-only
 * baseline on total realized $ in the 15-day backtest).
 */

import { getDb } from '../_lib/db.js';
import {
  detectChainFires,
  enrichFires,
  type LotteryFireRecord,
  type OptionTradeTick,
} from '../_lib/lottery-finder.js';
import { computeLotteryScore } from '../_lib/lottery-score-weights.js';
import { applyEmpiricalBonuses } from '../_lib/lottery-score-bonuses.js';
import {
  computeRangePos,
  fetchStockCandles1m,
  type UWStockCandle,
} from '../_lib/uw-stock-candles.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  loadTakeitDetectContext,
  scoreLottery,
  type RecentCofireRow,
  type RecentFireRow,
} from '../_lib/takeit-detect.js';
import type { LotteryAlertRow } from '../_lib/takeit-features.js';
import {
  fetchTickerFlowSeries,
  flowAtFireTime,
  type TickerFlowSeries,
} from '../_lib/ticker-flow-snapshot.js';
import {
  classifyAlertMultileg,
  type MultilegClassifyCache,
} from '../_lib/multileg-classify-batch.js';
import { withRetry } from '../_lib/uw-fetch.js';
import { Sentry } from '../_lib/sentry.js';

// 7-minute scan window — 5-min v4 window + 2-min slack so a slow cron
// tick can't drop a trigger that landed at the start of its window.
const SCAN_WINDOW_MIN = 7;

// Per-chain print floor — matches the Python p14.py MIN_PRINTS / 14
// scaling for a 7-min slice. The detector also gates on cntWindowMin
// (≥5 in the rolling window) but we filter at the SQL level too so the
// per-chain group-by stays cheap.
const PER_CHAIN_MIN_PRINTS = 5;

// Prior-fires lookback for the cooldown seed. The detector cooldown is
// 5 minutes; we look back 10 to absorb clock skew and any retried cron
// run. Anything older than 10 min can't gate the current window so
// pulling it would just be wasted bytes.
const PRIOR_FIRE_LOOKBACK_MIN = 10;

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbSide = 'ask' | 'bid' | 'mid' | 'no_side';

interface TickRow {
  ticker: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: DbNumeric;
  // expiry is selected as `expiry::text` so the wire value is always a
  // YYYY-MM-DD string, bypassing any driver-side Date<->TIMESTAMPTZ
  // round-trip that could shift the date by a TZ offset.
  expiry: string;
  executed_at: DbTimestamp;
  price: DbNumeric;
  size: number;
  underlying_price: DbNullableNumeric;
  side: DbSide;
  implied_volatility: DbNullableNumeric;
  delta: DbNullableNumeric;
  // Gamma is extracted from raw_payload JSONB at SELECT time —
  // ws_option_trades' typed columns only carry implied_volatility and
  // delta; the full UW payload (which includes gamma) lives in
  // raw_payload. Migration #168 added the storage column on
  // lottery_finder_fires; this is the read side.
  gamma: DbNullableNumeric;
  open_interest: number | null;
}

interface ChainGroup {
  ticker: string;
  optionChain: string;
  optionType: 'C' | 'P';
  strike: number;
  // YYYY-MM-DD string (read from SQL as ::text — see TickRow.expiry).
  expiry: string;
  ticks: OptionTradeTick[];
  oi: number;
}

interface FlowMacroRow {
  source: string;
  ncp: DbNumeric;
  npp: DbNumeric;
}

interface SpotMacroRow {
  gamma_oi: DbNullableNumeric;
  gamma_vol: DbNullableNumeric;
  charm_oi: DbNullableNumeric;
  vanna_oi: DbNullableNumeric;
}

interface StrikeMacroRow {
  strike: DbNumeric;
  call_minus_put: DbNullableNumeric;
  call_ask_minus_bid: DbNullableNumeric;
  put_ask_minus_bid: DbNullableNumeric;
}

/**
 * Macro snapshot pulled once per fire (asof lookup). All fields are
 * optional — many will be null on early-session fires before the
 * upstream ingest crons have populated their tables.
 */
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

const TICKERS_WITH_GEX_STRIKE = new Set([
  'SPX',
  'SPXW',
  'NDX',
  'NDXP',
  'SPY',
  'QQQ',
]);

export default withCronInstrumentation(
  'detect-lottery-fires',
  async (ctx): Promise<CronResult> => {
    const db = getDb();

    // Pull every tick in the scan window, ordered for chain-grouping.
    // expiry is cast to ::text so the wire value is a stable YYYY-MM-DD
    // string — bypasses any driver-side Date<->TZ round-trip that could
    // shift the date by an offset.
    // withRetry covers transient Neon HTTP failures (ECONNRESET / fetch
    // failed / socket hang up) — see SENTRY-EMERALD-DESERT-8X (2026-05-18,
    // 2h Neon connectivity blip that silently zeroed out detect output
    // for hours 18-20 UTC).
    const rows = (await withRetry(
      () => db`
      SELECT
        ticker, option_chain, option_type, strike, expiry::text AS expiry,
        executed_at, price, size, underlying_price, side,
        implied_volatility, delta,
        -- Gamma extracted from raw_payload JSONB (migration #168).
        -- UW's option_trades wire format includes 'gamma' alongside
        -- delta in the payload; the uw-stream daemon currently only
        -- promotes delta to a typed column, so we pull gamma from the
        -- JSONB envelope here. NULL when the payload lacks the field
        -- (older rows from before UW's wire format included it) OR
        -- when UW sends the literal empty string (~0.3% of recent
        -- rows) — NULLIF coerces both to SQL NULL so the ::numeric
        -- cast never sees "".
        NULLIF(raw_payload->>'gamma', '')::numeric AS gamma,
        open_interest
      FROM ws_option_trades
      WHERE executed_at >= NOW() - (${SCAN_WINDOW_MIN}::int * INTERVAL '1 minute')
        AND canceled = FALSE
        AND price > 0
      ORDER BY option_chain, executed_at ASC
    `,
    )) as TickRow[];

    if (rows.length === 0) {
      // We're inside the market-hours-gated handler, so an empty trade
      // window is anomalous — ws_option_trades fills continuously during
      // open hours. Most likely cause: a Neon read failure that withRetry
      // exhausted, or upstream ws-stream daemon stalling. Capture as a
      // warning so the silent-skip pattern from 2026-05-18 (where hours
      // 18-20 UTC showed zero fires with no Sentry event) can't recur
      // without surfacing.
      Sentry.captureMessage(
        'detect-lottery-fires: empty trade scan during market hours',
        {
          level: 'warning',
          tags: {
            'cron.job': 'detect-lottery-fires',
            'cron.anomaly': 'empty-window',
          },
        },
      );
      return {
        status: 'skipped',
        message: 'no ticks in scan window',
        metadata: { scanned: 0 },
      };
    }

    // Group by chain. Already sorted by (chain, time) in SQL so a
    // single linear pass is enough.
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
        // OptionTradeTick.expiry is typed as Date — the detector uses it
        // for parity with the parquet shape; a UTC midnight Date matches.
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
      // Take the per-chain max OI — matches Python p14.py
      // `g['open_interest'].max()`.
      if (r.open_interest != null && r.open_interest > g.oi) {
        g.oi = r.open_interest;
      }
    }

    let totalFires = 0;
    let inserted = 0;
    let skippedNoOi = 0;
    let skippedShort = 0;

    // Seed cooldown state from the DB so successive cron runs don't
    // re-qualify the next tick within the 5-min window. Without this,
    // the in-memory cooldown in detectChainFires resets each invocation
    // and the same logical trigger emits 2-7 rows with slightly later
    // trigger_time_ct values — bypassing the unique index.
    const eligibleChainIds: string[] = [];
    for (const g of groups.values()) {
      if (g.ticks.length >= PER_CHAIN_MIN_PRINTS && g.oi > 0) {
        eligibleChainIds.push(g.optionChain);
      }
    }
    const priorByChain = new Map<string, number>();
    if (eligibleChainIds.length > 0) {
      const priorRows = (await db`
        SELECT
          option_chain_id,
          EXTRACT(EPOCH FROM MAX(trigger_time_ct)) * 1000 AS last_ms
        FROM lottery_finder_fires
        WHERE option_chain_id = ANY(${eligibleChainIds}::text[])
          AND trigger_time_ct >= NOW() - (${PRIOR_FIRE_LOOKBACK_MIN}::int * INTERVAL '1 minute')
        GROUP BY option_chain_id
      `) as { option_chain_id: string; last_ms: DbNullableNumeric }[];
      for (const r of priorRows) {
        if (r.last_ms != null) {
          priorByChain.set(r.option_chain_id, Number(r.last_ms));
        }
      }
    }

    // Pre-fetch Take-It bundle + sequential context (3 queries, once per
    // cron tick). On any failure the helper returns null and we proceed
    // without takeit_prob — the heuristic INSERT still lands.
    const takeitCtx = await loadTakeitDetectContext('lottery', {
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
        // Pulls underlying_symbol + option_type too so the same row set powers
        // both the chain-keyed cofire map AND the sibling-chain (ticker+dir)
        // cofire map. One round-trip.
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
        // Mean of daily win-rates (PIT-correct: only strictly-earlier dates)
        // per ticker. ~50 rows; cheap aggregate against an indexed table.
        const rows = (await db`
          SELECT underlying_symbol, AVG(daily_rate)::float AS win_rate
          FROM (
            SELECT underlying_symbol, date,
                   AVG((peak_ceiling_pct >= 20)::int::float) AS daily_rate
            FROM lottery_finder_fires
            WHERE peak_ceiling_pct IS NOT NULL
              AND date < ${ctx.today}::date
            GROUP BY underlying_symbol, date
          ) per_day
          GROUP BY underlying_symbol
        `) as Array<{ underlying_symbol: string; win_rate: number | null }>;
        return rows;
      },
    });

    // Per-(ticker, date) ticker net-flow cumulative series cache. Shared
    // across all chain groups so two TSLA chains in the same cron tick
    // only fetch the TSLA flow series once. Scoped to handler lifetime
    // (cleared when handler returns). Spec:
    // docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md.
    const tickerFlowCache = new Map<string, TickerFlowSeries>();

    // Per-cron-tick multileg classification cache. Keyed inside the
    // helper by (ticker, optionChain, minute) so multiple alerts on the
    // same chain in the same minute reuse one sidecar call. Cleared
    // when the handler returns. Spec: migration #160 columns; sidecar
    // POST /takeit/multileg-classify (commit ced5ff10).
    const multilegCache: MultilegClassifyCache = new Map();

    for (const g of groups.values()) {
      if (g.ticks.length < PER_CHAIN_MIN_PRINTS) {
        skippedShort += 1;
        continue;
      }
      if (g.oi <= 0) {
        skippedNoOi += 1;
        continue;
      }

      // DTE is computed in ET. ctx.today is ET YYYY-MM-DD from cronGuard;
      // g.expiry is the raw YYYY-MM-DD string from `expiry::text` so no
      // driver-side TZ round-trip can shift the date.
      const firstTick = g.ticks[0]!;
      const tradeDateStr = ctx.today;
      const expiryStr = g.expiry;
      const dte = daysBetween(tradeDateStr, expiryStr);

      const priorMs = priorByChain.get(g.optionChain) ?? null;
      const fires = detectChainFires(g.ticks, g.oi, dte, priorMs);
      if (fires.length === 0) continue;
      totalFires += fires.length;

      // Per-(ticker, date) candle cache — multiple fires on the same
      // chain within one cron run share session-range candles, so
      // memoize the UW lookup. Cleared at end of handler scope.
      const candleCache = new Map<string, UWStockCandle[]>();

      const records = enrichFires(fires, {
        date: tradeDateStr,
        optionChainId: g.optionChain,
        underlyingSymbol: g.ticker,
        optionType: g.optionType,
        strike: g.strike,
        expiry: expiryStr,
        dte,
      });
      // Suppress fires the universe doesn't claim — keeps the table
      // focused on Mode A + Mode B and prevents far-OTM stock chains
      // from polluting the UI.
      const inUniverse = records.filter((r) => r.mode !== 'OUT_OF_UNIVERSE');
      if (inUniverse.length === 0) continue;

      for (const rec of inUniverse) {
        // A transient flow_data / spot_exposures issue must not drop
        // the fire — macro is display-only (per spec Appendix A), so
        // fall back to EMPTY_MACRO and continue. The fire itself is
        // the load-bearing record.
        let macro: MacroSnapshot;
        try {
          macro = await fetchMacroSnapshot(db, rec, firstTick.executedAt);
        } catch (macroErr) {
          ctx.logger.warn(
            { err: macroErr, optionChain: rec.optionChainId },
            'detect-lottery-fires macro snapshot failed; using EMPTY_MACRO',
          );
          macro = EMPTY_MACRO;
        }
        // Score is computed from the same fields persisted on the row
        // (ticker, mode, entry price, TOD, option type) so the column
        // is fully derivable for backfills via UPDATE; storing it
        // avoids a JOIN on every read and lets `?sort=score` use the
        // (date, score DESC) index from migration #126.
        const baseScore = computeLotteryScore({
          ticker: rec.underlyingSymbol,
          mode: rec.mode,
          entryPrice: rec.entryPrice,
          tod: rec.tod,
          optionType: rec.optionType,
        });
        // Range Kill — Finding 1 of the 2026-05-15 cross-section EDA.
        // Fetch 1-min stock candles for the underlying × fire date
        // (cached across fires on the same chain), then compute the
        // fire's position in the session range up to its trigger time.
        // Used both as a score bonus (-3 for bottom-10%) and a UI
        // filter signal. On UW failure or insufficient data, range_pos
        // stays null and the score bonus is skipped.
        const cacheKey = `${rec.underlyingSymbol}_${rec.date}`;
        let candles = candleCache.get(cacheKey);
        if (candles == null) {
          candles = await fetchStockCandles1m(
            ctx.apiKey,
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
        // rangePosAtTrigger is written to the row for the display-only
        // "NEW HIGH" badge (range_pos ≥ 1.0 = spot punched above
        // session high during the spike). It is NOT passed to
        // applyEmpiricalBonuses — the original -3 bottom-10% penalty
        // was retired after the 2026-05-16 EDA rerun showed no edge
        // at either tail. See ml/findings/eda-rerun-2026-05-16/.

        // Snapshot the ticker cumulative net call/put premium at fire
        // time. Replaces the per-row LATERAL the feed used to run
        // (caused ~30s page loads). Cached per (ticker, date) so
        // multiple fires reuse one SQL fetch + binary-search.
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

        // Phase 2 multileg classification (spec: migration #160; sidecar
        // POST /takeit/multileg-classify, commit ced5ff10). Fail-open —
        // the helper returns null on sidecar errors, missing anchor
        // trade, or oversized windows, and the four columns stay NULL
        // on the row. Take-It feature pipeline already treats these as
        // optional (`?: T | null`).
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
        // Phase 4 direction gate (spec:
        // docs/superpowers/specs/silent-boom-direction-gate-and-trail-ui-2026-05-14.md).
        // Counter-trend fires get flagged with direction_gated=TRUE so
        // the feed endpoint can override the displayed score tier to
        // tier3. The lottery score itself is NOT mutated — the raw
        // score is preserved on the row and the gate is the read-time
        // override. Threshold is the OTM-only mkt_tide_otm_diff per
        // Phase 4 result (vs. all-in for silent boom). STRICT > / < per
        // spec — exactly ±T is NOT gated.
        const LOTTERY_DIRECTION_GATE_T = 150_000_000;
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
        // Take-It probability (Phase 3c). Builds a feature vector from the
        // same data persisted on the row and walks the trained XGBoost tree
        // dump fetched from Vercel Blob. takeitCtx is null when the bundle
        // is unreachable; both prob and version then come back null and we
        // INSERT with the heuristic score alone.
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
        // Stash the feature dict alongside prob so the SHAP fill cron has
        // the exact bundle-shaped input the explainer needs (one-hots,
        // derived flags, sequential context) without re-deriving from raw
        // row columns and risking drift.
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
      'detect-lottery-fires completed',
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

// ============================================================
// Macro snapshot lookup — asof, NULLs tolerated.
// ============================================================

interface DbClient {
  // Tagged-template SQL accessor — matches @neondatabase/serverless's
  // call signature without coupling to its concrete type so tests can
  // mock with a plain `vi.fn()`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
}

async function fetchMacroSnapshot(
  db: DbClient,
  rec: LotteryFireRecord,
  asOf: Date,
): Promise<MacroSnapshot> {
  // Single round-trip per fire. flow_data + spot_exposures are required;
  // strike_exposures only matters for index/ETF tickers and is left null
  // otherwise.
  const flowQuery = db`
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
  ` as Promise<FlowMacroRow[]>;

  const spotQuery = db`
    SELECT gamma_oi, gamma_vol, charm_oi, vanna_oi
    FROM spot_exposures
    WHERE ticker = 'SPX'
      AND timestamp <= ${asOf.toISOString()}
      AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
    ORDER BY timestamp DESC
    LIMIT 1
  ` as Promise<SpotMacroRow[]>;

  const wantStrike = TICKERS_WITH_GEX_STRIKE.has(rec.underlyingSymbol);
  // Look up the closest stored strike (within ±1% of fire strike) for
  // SPX/SPXW/NDX/NDXP/SPY/QQQ. Other tickers don't have per-strike GEX
  // ingested, so we skip the query.
  const strikeQuery: Promise<StrikeMacroRow[]> = wantStrike
    ? (db`
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
      ` as Promise<StrikeMacroRow[]>)
    : Promise.resolve<StrikeMacroRow[]>([]);

  const [flowRows, spotRows, strikeRows] = await Promise.all([
    flowQuery,
    spotQuery,
    strikeQuery,
  ]);

  // Reduce flowRows to one row per source (the most recent each).
  interface ParsedFlowRow {
    ncp: number;
    npp: number;
  }
  const latestBySource = new Map<string, ParsedFlowRow>();
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

  return {
    ...EMPTY_MACRO,
    mkt_tide_ncp: tide?.ncp ?? null,
    mkt_tide_npp: tide?.npp ?? null,
    mkt_tide_diff: tide ? tide.ncp - tide.npp : null,
    // For source='market_tide_otm', the OTM data lives in the regular
    // ncp/npp columns — the otm_ncp/otm_npp columns on flow_data are
    // vestigial and NULL for this source (verified 2026-05-13: 0/5,277
    // rows populated vs. 5,277/5,277 for ncp/npp). A prior form read
    // otm_ncp/otm_npp here and produced NULL on every row.
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
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
