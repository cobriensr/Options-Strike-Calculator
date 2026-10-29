/**
 * GET /api/cron/detect-lottery-fires
 *
 * Runs the v4 trigger detector on the rolling per-tick stream in
 * ws_option_trades for the Lottery Finder universe (~50 tickers).
 * Each qualifying fire is enriched with the per-fire discriminators
 * (RE-LOAD, cheap-call-PM, mode, flow_quad, tod), a macro-context
 * snapshot at fire time and its anchor print's exchange leg kind, then
 * inserted into lottery_finder_fires with
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
 *
 * Calls UW once per ticker-day per run for 1-min stock candles
 * (range_pos), so cronGuard's default UW_API_KEY check applies: a
 * missing key fails the run with 500 like every other UW cron.
 */

import { getDb, isRetryableDbError, withDbRetry } from '../_lib/db.js';
import { DeadlineError, withDeadline } from '../_lib/deadline.js';
import {
  detectChainFires,
  enrichFires,
  type LotteryFireRecord,
  type OptionTradeTick,
} from '../_lib/lottery-finder.js';
import {
  computeLotteryScoreV2,
  LOTTERY_TIER_THRESHOLDS_V2,
} from '../_lib/lottery-score-weights-v2.js';
import { tierFromQualityScore } from '../_lib/lottery-tier.js';
import { INVERSION_BONUS_CASE_SQL } from '../_lib/lottery-inversion-bonus.js';
import {
  computeRangePos,
  fetchStockCandles1m,
  type UWStockCandle,
} from '../_lib/uw-stock-candles.js';
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
import { CASH_INDEX_ROOTS } from '../_lib/constants.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  awaitWinRateWarmup,
  loadTakeitDetectContext,
  priorSessionWinRatesForDay,
  scoreLottery,
  type PriorWinRateRow,
  type TakeitPrefetchFailure,
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
  getLatestGexbotSnapshotAt,
  mapToGexbotTicker,
  type FireTimeGexbotSnapshot,
} from '../_lib/gexbot-queries.js';
import { Sentry } from '../_lib/sentry.js';
import { parseUwHttpStatus, withRetry } from '../_lib/uw-fetch.js';

// Deadline for one UW candle lookup (range_pos), retry included. The
// lookups run one at a time inside Pass 2, ahead of each fire's INSERT;
// maxDuration is 60 s (vercel.json), and a run killed mid-Pass-2 loses
// its remaining INSERTs. Unbounded, one stalled lookup could hold the
// run well past that: each UW semaphore wait alone can take 15–30 s,
// and the 15 s UW timeout can hit twice with the retry (the deadline
// now bounds all of it). Sentry's per-ticker `ohlc/1m` p99 over 3 days
// is 0.4–2.5 s, so 5 s only cuts off a stall. The deadline error has
// no UW status, so it opens the breaker in Pass 2: a stall costs a run
// at most 5 s, once, and the remaining ticker-days are skipped with
// range_pos NULL. The losing uwFetch keeps running until its own 15 s
// abort, holding one UW semaphore slot until its finally releases it
// (the slot's lease expires after 30 s regardless). A timeout knob:
// change it with care.
const CANDLE_FETCH_DEADLINE_MS = 5_000;

// Deadline for one ticker-day's flow series (Pass 1), with the same
// breaker as the candles: a stall or a transient failure costs a run at
// most 5 s, once, and the remaining uncached ticker-days are skipped with
// cum_ncp/cum_npp and the V2 score NULL. Unbounded, fetchTickerFlowSeries'
// own retries (3 × 10 s plus backoff) let two slow tickers time the run
// out. The query normally answers well under a second. The losing fetch
// keeps running on Neon, retries included; the breaker stops a second one.
const FLOW_SERIES_DEADLINE_MS = 5_000;

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

// Cluster bonus constants — V2.2 Phase C.4
// (spec: docs/tmp/v22-co-fire-analysis-2026-05-22.md).
// Non-monotonic: peak lift at 2-4 tickers; 5+ dilutes back toward baseline.
const CLUSTER_WINDOW_MS = 5 * 60 * 1_000; // 5 minutes in milliseconds
const CLUSTER_BONUS_ISOLATED = 0; // cluster_size 1
const CLUSTER_BONUS_PAIR = 1; // cluster_size 2
const CLUSTER_BONUS_SMALL = 2; // cluster_size 3-4 (peak empirical lift)
const CLUSTER_BONUS_LARGE = 1; // cluster_size 5+ (signal dilutes)

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

    // Mean of daily win-rates (PIT-correct: only strictly-earlier dates)
    // per ticker, a Take-It input. A parallel seq scan of the whole table
    // (~5 s idle), and its answer only changes with the ET date, so it is
    // loaded once per ET day and shared across runs. Started here, before
    // the tick scan, so a cold load (the day's first run on an instance)
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
          FROM lottery_finder_fires
          WHERE peak_ceiling_pct IS NOT NULL
            AND date < ${beforeDate}::date
          GROUP BY underlying_symbol, date
        ) per_day
        GROUP BY underlying_symbol
      `) as PriorWinRateRow[];
    const winRateWarmup = priorSessionWinRatesForDay(
      'lottery',
      ctx.today,
      loadPriorWinRates,
    );

    // Pull every tick in the scan window, ordered for chain-grouping.
    // expiry is cast to ::text so the wire value is a stable YYYY-MM-DD
    // string — bypasses any driver-side Date<->TZ round-trip that could
    // shift the date by an offset.
    //
    // Hash-partitioned into TICK_QUERY_BATCHES parallel queries by
    // ticker. The single-shot SELECT used to hit Neon's HTTP 64MB
    // response cap during the 8:30-9:00 CT volume spike — see
    // SENTRY-EMERALD-DESERT-CB (2026-05-22). hashtext is deterministic
    // so every chain lands in exactly one batch; cross-batch ordering
    // doesn't matter because the downstream chain-keyed Map only
    // requires executed_at ordering WITHIN each chain, which the
    // per-batch ORDER BY preserves. Gamma extracted from raw_payload
    // JSONB (migration #168) — uw-stream only promotes delta to a
    // typed column; NULLIF guards against UW's literal empty-string
    // payloads (~0.3%) before the ::numeric cast.
    //
    // withDbRetry covers transient Neon HTTP failures (ECONNRESET /
    // fetch failed / socket hang up) — see SENTRY-EMERALD-DESERT-8X
    // (2026-05-18, 2h Neon blip that silently zeroed out hours 18-20
    // UTC). 10s per-attempt timeout matches the secondary
    // lottery_finder_fires query below.
    const TICK_QUERY_BATCHES = 3;
    const tickBatches = await Promise.all(
      Array.from({ length: TICK_QUERY_BATCHES }, (_, batchIdx) =>
        withDbRetry(
          () => db`
            SELECT
              ticker, option_chain, option_type, strike, expiry::text AS expiry,
              executed_at, price, size, underlying_price, side,
              implied_volatility, delta,
              NULLIF(raw_payload->>'gamma', '')::numeric AS gamma,
              open_interest
            FROM ws_option_trades
            WHERE executed_at >= NOW() - (${SCAN_WINDOW_MIN}::int * INTERVAL '1 minute')
              AND canceled = FALSE
              AND price > 0
              AND mod(abs(hashtextextended(ticker, 0)), ${TICK_QUERY_BATCHES}::int) = ${batchIdx}::int
            ORDER BY option_chain, executed_at ASC
          `,
          2,
          10_000,
        ),
      ),
    );
    const rows = tickBatches.flat() as TickRow[];

    if (rows.length === 0) {
      // We're inside the market-hours-gated handler, so an empty trade
      // window is anomalous — ws_option_trades fills continuously during
      // open hours. Most likely cause: a Neon read failure that withDbRetry
      // exhausted, or upstream ws-stream daemon stalling. Capture as a
      // warning so the silent-skip pattern from 2026-05-18 (where hours
      // 18-20 UTC showed zero fires with no Sentry event) can't recur
      // without surfacing.
      //
      // BUT: the cronGuard gate (isMarketHours) opens 5 min before the
      // cash open to catch the auction, and the scan window itself reaches
      // back into the pre-open minutes. An empty scan in that pre-open
      // sliver is normal, not a stall — gate the alarm on isPastCashOpen()
      // (with a 2-min grace for the tape to start printing) so we stop
      // false-paging at 8:25-8:31 CT while still catching real stalls
      // once the session is genuinely active.
      if (isPastCashOpen(2)) {
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
      }
      // Nothing else to do: wait for the win-rate load started above, so
      // the 08:25–08:30 CT pre-open runs warm the cache instead of leaving
      // the load to freeze with the instance. Bounded from the run's start
      // (45 s), so a slow tick scan plus the wait can't pass maxDuration.
      await awaitWinRateWarmup(winRateWarmup, ctx.startTimeMs);
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
    // Phase 6 observability: per-tier counts on each cron run. Lets us
    // detect "zero tier1+ for N consecutive runs" without re-querying
    // the DB. The per-tier counts are computed AFTER the insert loop by
    // querying today's fires through the exact feed tier logic (see the
    // post-loop block below) — not bucketed per-insert, because the feed
    // tier needs the read-time qas (combined_score + per-ticker inversion
    // bonus) which isn't available at insert time. See spec
    // docs/superpowers/specs/lottery-rescore-2026-05-22.md Phase 6 and
    // lottery-feed-tier-recalibration-2026-06-03.md.
    let skippedNoOi = 0;
    let skippedShort = 0;
    // GexBot lookup counters (migration #181). Same observability shape
    // as detect-silent-boom — a successful-but-null return is the silent
    // failure mode, so without these counts we have no signal when
    // GexBot polling regresses or the freshness window starts missing.
    let gexHits = 0;
    let gexMisses = 0;
    let gexOutOfUniverse = 0;

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
      const priorRows = (await withDbRetry(
        () => db`
          SELECT
            option_chain_id,
            EXTRACT(EPOCH FROM MAX(trigger_time_ct)) * 1000 AS last_ms
          FROM lottery_finder_fires
          WHERE option_chain_id = ANY(${eligibleChainIds}::text[])
            AND trigger_time_ct >= NOW() - (${PRIOR_FIRE_LOOKBACK_MIN}::int * INTERVAL '1 minute')
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
    // too: it is the leading column of the (date, trigger_time_ct) and
    // (date, bucket_ct) indexes, so the scan is a two-day range instead of
    // the whole index (planner cost ~41,500 → ~190, 2026-10-28). That
    // makes them sub-second, so each gets one retry for a Neon blip (after
    // a 1 s backoff). No per-attempt cap: the 5 s prefetch deadline bounds
    // the total, and a cap would turn a slow success into a failure plus a
    // second, uncancelled copy of the query on Neon. Yesterday is included
    // so a lookback that crosses ET midnight still sees its fires.
    let takeitPrefetchFailure = null as TakeitPrefetchFailure | null;
    const takeitCtx = await loadTakeitDetectContext(
      'lottery',
      {
        fetchRecentSameType: async (lookbackMin) =>
          (await withDbRetry(
            () => db`
              SELECT trigger_time_ct AS fire_time, underlying_symbol, option_type
              FROM lottery_finder_fires
              WHERE date >= ${ctx.today}::date - 1
                AND trigger_time_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
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
                bucket_ct AS fire_time
              FROM silent_boom_alerts
              WHERE date >= ${ctx.today}::date - 1
                AND bucket_ct >= NOW() - (${lookbackMin}::int * INTERVAL '1 minute')
            `,
            1,
          )) as RecentCofireRow[],
        // Joins the load started at the top of the run, or retries it if
        // that one already failed (see loadPriorWinRates).
        fetchPriorSessionWinRateByTicker: () =>
          priorSessionWinRatesForDay('lottery', ctx.today, loadPriorWinRates),
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
        'detect-lottery-fires: Take-It prefetch query error; takeit_prob left null',
      );
    } else if (takeitPrefetchFailureKind != null) {
      ctx.logger.warn(
        { takeitPrefetchError, takeitPrefetchFailureKind },
        'detect-lottery-fires: Take-It prefetch failed; takeit_prob left null',
      );
    }

    // Per-(ticker, date) ticker net-flow cumulative series cache. Shared
    // across all chain groups so two TSLA chains in the same cron tick
    // only fetch the TSLA flow series once. Scoped to handler lifetime
    // (cleared when handler returns). Spec:
    // docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md.
    const tickerFlowCache = new Map<string, TickerFlowSeries>();
    // Ticker-days whose flow series failed or was skipped this run. Their
    // fires are still written, with cum_ncp/cum_npp NULL and so no V2
    // score (a fire with no flow isn't aligned). The empty series is
    // cached, so the ticker's other fires don't retry. Reported once per
    // run, after the insert loop:
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

    // Per-(ticker, date) candle cache — promoted to handler scope so
    // both passes (and fires across chains of the same ticker) share one
    // UW lookup. A failed or skipped lookup caches [] so it isn't retried
    // per fire. Cleared when the handler returns.
    const candleCache = new Map<string, UWStockCandle[]>();
    // Candle lookups this run, one per ticker-day: UW failures (deadline
    // included), days UW returned no candles for, cash-index days skipped
    // by design, and days skipped once the breaker opened. All go in the
    // Axiom payload (→ `meta`). Failures and empty days each raise one
    // Sentry warning per run, after the insert loop.
    let candleFetchFailures = 0;
    let candleFetchEmpty = 0;
    let candleFetchSkippedIndex = 0;
    let candleFetchSkippedBreaker = 0;
    let candleBreakerOpen = false;
    let firstCandleFetchError: {
      ticker: string;
      date: string;
      error: string;
    } | null = null;
    let firstCandleFetchEmpty: { ticker: string; date: string } | null = null;

    // V2.2 Phase C.4 cluster bonus is computed in a SYMMETRIC PRE-PASS
    // (Fix 3, 2026-06-09): the prior form computed the bonus inline while
    // iterating groups, so the first-iterated chain saw an empty
    // committedFires list (clusterSize 1, bonus 0) while a later chain saw
    // the full set — two simultaneous fires got DIFFERENT bonuses purely
    // by Map iteration order. We now score EVERY in-universe fire first
    // (Pass 1), build the full co-fire membership over all this-tick fires
    // (pre-pass), then do the heavy per-fire work + INSERT (Pass 2) so
    // every member sees the same symmetric ±5-min window. Silent Boom
    // already uses this pre-pass shape (cofireKeyset).
    interface PreparedFire {
      rec: LotteryFireRecord;
      score: number | null;
      isAligned: boolean;
      cumNcpAtFire: number | null;
      cumNppAtFire: number | null;
    }
    const preparedFires: PreparedFire[] = [];

    // ── Pass 1: detect + score every in-universe fire ──────────────────
    for (const g of groups.values()) {
      if (g.ticks.length < PER_CHAIN_MIN_PRINTS) {
        skippedShort += 1;
        continue;
      }
      if (g.oi <= 0) {
        skippedNoOi += 1;
        continue;
      }

      // Session day + DTE are derived from the fire's OWN timestamp in ET,
      // NOT ctx.today (the cron-RUN wall-clock ET date). On a late or
      // retried run — or any tick firing after the ET date rolls relative
      // to the trade window — ctx.today would file the fire under the wrong
      // day and skew dte by one. The read endpoints filter `date = ...::date`
      // off the same per-fire timestamp, so deriving the stamp from the
      // tick keeps insert and read aligned. The group-level value seeds
      // detection (detectChainFires + classifyMode gate on dte); it's taken
      // from the chain's first tick. Each fire's own date/dte is re-derived
      // per-fire below (rare cross-midnight chains). g.expiry is the raw
      // YYYY-MM-DD string from `expiry::text` so no driver-side TZ round-trip
      // can shift the date.
      //
      // NOTE: ctx.today stays the run-scoped key for cooldown/dedup seeding
      // and the PIT win-rate + feed-tier monitor queries — only the PER-FIRE
      // stamped date/dte move to the fire timestamp.
      const firstTick = g.ticks[0]!;
      const tradeDateStr = getETDateStr(firstTick.executedAt);
      const expiryStr = g.expiry;
      const dte = daysBetween(tradeDateStr, expiryStr);

      const priorMs = priorByChain.get(g.optionChain) ?? null;
      const fires = detectChainFires(g.ticks, g.oi, dte, priorMs);
      if (fires.length === 0) continue;
      totalFires += fires.length;

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
        // Re-derive THIS fire's session day + dte from its OWN trigger
        // timestamp in ET (not the chain-level firstTick day, and never
        // ctx.today). For the overwhelmingly common case where all of a
        // chain's fires share one ET day this is a no-op vs the group
        // value; it only diverges for a chain that straddles the ET
        // midnight boundary. Mutating rec here keeps every downstream
        // consumer (INSERT date/dte binds, takeit row, cache keys) on the
        // per-fire stamp.
        rec.date = getETDateStr(rec.triggerTimeCt);
        rec.dte = daysBetween(rec.date, expiryStr);

        // Snapshot the ticker cumulative net call/put premium at fire
        // time. Cached per (ticker, date) so multiple fires reuse one SQL
        // fetch + binary-search. Needed here in Pass 1 because the V2
        // score depends on isAligned; Pass 2 reuses the same cache.
        const flowCacheKey = `${rec.underlyingSymbol}_${rec.date}`;
        let flowSeries = tickerFlowCache.get(flowCacheKey);
        if (flowSeries == null) {
          flowSeries = { ts: [], cumNcp: [], cumNpp: [] };
          if (flowBreakerOpen) {
            flowSeriesSkippedBreaker += 1;
          } else {
            try {
              flowSeries = await withDeadline(
                fetchTickerFlowSeries(db, rec.underlyingSymbol, rec.date),
                FLOW_SERIES_DEADLINE_MS,
                'ticker flow series',
              );
            } catch (err) {
              if (err instanceof DeadlineError || isRetryableDbError(err)) {
                // Neon slow or blipping: stop asking for this run.
                flowSeriesFailures += 1;
                flowBreakerOpen = true;
                firstFlowSeriesError ??= {
                  ticker: rec.underlyingSymbol,
                  date: rec.date,
                  error: err instanceof Error ? err.message : String(err),
                };
              } else {
                // A broken query fails fast; keep asking so the count
                // shows its reach.
                flowSeriesGenuineFailures += 1;
                firstFlowSeriesGenuineError ??= {
                  ticker: rec.underlyingSymbol,
                  date: rec.date,
                  err,
                };
              }
            }
          }
          tickerFlowCache.set(flowCacheKey, flowSeries);
        }
        const { cumNcp: cumNcpAtFire, cumNpp: cumNppAtFire } = flowAtFireTime(
          flowSeries,
          rec.triggerTimeCt,
        );

        // V2 score — null for misaligned fires or DTE > 3.
        // applyEmpiricalBonuses is NOT called: V2's quintile weights for
        // vol/OI already encode the same population signal; calling
        // applyEmpiricalBonuses on top would double-count the vol/OI
        // bonus and inflate scores systematically.
        const isAligned =
          cumNcpAtFire != null &&
          cumNppAtFire != null &&
          ((rec.optionType === 'C' && cumNcpAtFire > cumNppAtFire) ||
            (rec.optionType === 'P' && cumNppAtFire > cumNcpAtFire));
        const score = computeLotteryScoreV2({
          ticker: rec.underlyingSymbol,
          tod: rec.tod,
          dte: rec.dte,
          volOiWindow: rec.triggerVolToOiWindow ?? null,
          gammaAtTrigger: rec.triggerGamma ?? null,
          triggerAskPct: rec.triggerAskPct ?? null,
          optionType: rec.optionType,
          isAligned,
          dayOfWeek: new Date(`${rec.date}T12:00:00Z`).toLocaleDateString(
            'en-US',
            { weekday: 'long' },
          ),
          // NOTE: Phase D context features (spxSpotCharmOi, spxSpotVannaOi,
          // mktTideNcp, mktTideNpp, mktTideDiff, mktTideOtmDiff,
          // spxSpotGammaOi) removed 2026-05-23 — walk-forward found them
          // systematically overfit (+0.099 OOS Sharpe gain from removal).
        });

        preparedFires.push({
          rec,
          score,
          isAligned,
          cumNcpAtFire,
          cumNppAtFire,
        });
      }
    }

    // ── Pre-pass: symmetric co-fire membership over ALL this-tick fires ─
    // Includes ALL scored fires (even those that will hit ON CONFLICT) so
    // an idempotent re-run sees the same cluster window. Every fire is
    // scored against the identical ±5-min set — no iteration-order skew.
    const allCofireEntries: CommittedFireEntry[] = preparedFires.map((p) => ({
      ticker: p.rec.underlyingSymbol,
      triggerTimeMs: p.rec.triggerTimeCt.getTime(),
      score: p.score,
    }));

    // ── Anchor print + spread legs: one batched lookup per tick ────────
    // The anchor is the top price × size print on the fire's own chain in
    // [trigger − 30 s, trigger + 30 s). Its exchange trade code says
    // whether it was one leg of a spread, and for a spread leg the lookup
    // also groups the other legs (spec
    // 2026-10-28-classifier-replacement-design.md, migration #197 columns;
    // it replaces the Railway classifier, whose four migration #160
    // columns are no longer written). At most two queries for the whole
    // tick (R5), made before any INSERT. Fires that will hit ON CONFLICT
    // are looked up too: they can't be told apart in advance, and in a
    // batch they cost nothing extra.
    //
    // A fire with no anchor print gets NULL columns, and that is not a
    // failure (counted as anchorsMissing). A failed lookup also leaves the
    // columns NULL, on every fire, so it is reported apart: a Sentry event
    // and a log line named anchor_legs.lookup_failed, anchorLookupError in
    // the run payload, and status 'partial' when the run wrote fires.
    //
    // Retry budget: the two queries take 7–40 ms warm and ~0.4 s cold
    // (EXPLAIN on prod, 2026-10-29), so a 5 s attempt cap only cuts off a
    // stall. With one retry the worst case is 5 + 1 + 5 = 11 s ahead of
    // the INSERTs, inside the 60 s maxDuration that setup and Pass 2 share.
    const anchorKey = (rec: LotteryFireRecord): string =>
      `${rec.optionChainId}|${rec.triggerTimeCt.toISOString()}`;
    const anchorRequests: AnchorRequest[] = preparedFires.map(({ rec }) => {
      const triggerMs = rec.triggerTimeCt.getTime();
      return {
        key: anchorKey(rec),
        // The ticker and chain exactly as the tick scan read them from
        // ws_option_trades; the anchor query matches both.
        ticker: rec.underlyingSymbol,
        optionChain: rec.optionChainId,
        windowStart: new Date(triggerMs - 30_000),
        windowEnd: new Date(triggerMs + 30_000),
      };
    });
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
      // is a broken query and pages (error). Either way the fires below
      // are still written.
      const transient = isRetryableDbError(err);
      const detail = { err, fires: anchorRequests.length, transient };
      const message =
        'detect-lottery-fires: anchor_legs.lookup_failed; fires written without anchor legs';
      if (transient) ctx.logger.warn(detail, message);
      else ctx.logger.error(detail, message);
      Sentry.captureException(err, {
        level: transient ? 'warning' : 'error',
        fingerprint: ['detect-lottery-fires', 'anchor_legs.lookup_failed'],
        tags: {
          'cron.job': 'detect-lottery-fires',
          'cron.anomaly': 'anchor_legs.lookup_failed',
        },
        extra: { fires: anchorRequests.length },
      });
    }
    let anchorsFound = 0;
    for (const anchor of anchorsByKey.values()) {
      if (anchor != null) anchorsFound += 1;
    }
    // Empty map after a failed lookup, so a failure never counts as missing.
    const anchorsMissing = anchorsByKey.size - anchorsFound;

    // ── Pass 2: macro / gexbot / takeit + INSERT ───────────────────────
    for (const prepared of preparedFires) {
      const { rec, score, cumNcpAtFire, cumNppAtFire } = prepared;
      {
        // A transient flow_data / spot_exposures issue must not drop
        // the fire — macro is display-only (per spec Appendix A), so
        // fall back to EMPTY_MACRO and continue. The fire itself is
        // the load-bearing record.
        let macro: MacroSnapshot;
        try {
          // As-of MUST be THIS fire's own trigger time — not the chain's
          // first-tick executedAt. A 2nd fire on the chain (or any fire
          // after the window's first tick) would otherwise snapshot macro
          // (market-tide diff, SPX gamma, strike GEX) AND the
          // direction_gated (Market-Tide-OTM) decision at a stale time.
          // Silent Boom already does this per-fire (tideDiffAt(bucketTs)).
          macro = await fetchMacroSnapshot(db, rec, rec.triggerTimeCt);
        } catch (macroErr) {
          ctx.logger.warn(
            { err: macroErr, optionChain: rec.optionChainId },
            'detect-lottery-fires macro snapshot failed; using EMPTY_MACRO',
          );
          // Surface to Sentry — prior to 2026-05-19 this was logger-only,
          // so a sustained macro-fetch outage silently degraded every
          // fire on that day to EMPTY_MACRO (no VIX, no futures regime,
          // no GEX state). Score quality regressions were invisible.
          Sentry.captureException(macroErr, {
            level: 'warning',
            tags: {
              cron: 'detect-lottery-fires',
              stage: 'macro_snapshot',
            },
            extra: { optionChain: rec.optionChainId },
          });
          macro = EMPTY_MACRO;
        }

        // Range position — fetch 1-min stock candles for the underlying
        // × fire date (cached across fires on the same ticker) and compute
        // spot position in the session range up to trigger time. Written
        // to the row for the display-only "NEW HIGH" badge; not used in
        // V2 scoring. With no candles (index root, UW failure, deadline,
        // empty day, breaker skip) range_pos stays null and the fire is
        // still written.
        const cacheKey = `${rec.underlyingSymbol}_${rec.date}`;
        let candles = candleCache.get(cacheKey);
        if (candles == null) {
          candles = [];
          if (CASH_INDEX_ROOTS.has(rec.underlyingSymbol)) {
            // UW answers 422, code `cboe_index_access_missing` ("Prices for
            // the CBOE index SPXW require provisioned access and CBOE
            // approval."), for index roots (spec
            // uw-api-ws-alignment-2026-10-23.md, D8), so don't ask:
            // range_pos stays null for these fires by design.
            candleFetchSkippedIndex += 1;
          } else if (candleBreakerOpen) {
            candleFetchSkippedBreaker += 1;
          } else {
            try {
              // One at a time on purpose: every UW call shares the global
              // 3-slot concurrency semaphore with the other crons.
              candles = await withDeadline(
                withRetry(
                  () =>
                    fetchStockCandles1m(
                      ctx.apiKey,
                      rec.underlyingSymbol,
                      rec.date,
                    ),
                  1,
                ),
                CANDLE_FETCH_DEADLINE_MS,
                'stock candle fetch',
              );
              if (candles.length === 0) {
                candleFetchEmpty += 1;
                firstCandleFetchEmpty ??= {
                  ticker: rec.underlyingSymbol,
                  date: rec.date,
                };
              }
            } catch (err) {
              candleFetchFailures += 1;
              const error = err instanceof Error ? err.message : String(err);
              firstCandleFetchError ??= {
                ticker: rec.underlyingSymbol,
                date: rec.date,
                error,
              };
              // A definite 4xx (unknown ticker, plan or auth) is about this
              // one request. Anything else (5xx, 429, timeout, network, an
              // unreadable body, the deadline) means UW itself is
              // struggling: stop asking for the rest of the run so stalls
              // can't eat the minute.
              const status = parseUwHttpStatus(error);
              if (status == null || status >= 500 || status === 429) {
                candleBreakerOpen = true;
              }
            }
          }
          candleCache.set(cacheKey, candles);
        }
        const rangePosAtTrigger = computeRangePos(
          candles,
          rec.triggerTimeCt,
          rec.spotAtFirst,
        );

        // This fire's anchor from the batched lookup above: null when it had
        // no anchor print or the lookup failed. spread_legs stores the
        // SpreadLeg objects as returned (camelCase keys), serialised for jsonb.
        const anchor = anchorsByKey.get(anchorKey(rec)) ?? null;
        const spreadLegsJson =
          anchor?.spreadLegs == null ? null : JSON.stringify(anchor.spreadLegs);

        // V2.2 Phase C.4 cluster bonus: count distinct other tier1 tickers
        // that fired within ±5 min of this fire across the WHOLE cron tick
        // (symmetric pre-pass set), then apply the tiered bonus. The bonus
        // is stored separately from `score` so audits can attribute the
        // delta to clustering. Applies even to fires that hit ON CONFLICT
        // — the idempotent re-run sees the same cluster window.
        const clusterSize = computeClusterSize(
          allCofireEntries,
          rec.underlyingSymbol,
          rec.triggerTimeCt.getTime(),
        );
        const clusterBonus = applyClusterBonus(clusterSize);

        // Phase 4 direction gate (spec:
        // docs/superpowers/specs/silent-boom-direction-gate-and-trail-ui-2026-05-14.md).
        // V2.2 Phase C.9 ASYMMETRIC FIX (2026-05-22, audit memo:
        // docs/tmp/v22-direction-gate-audit-2026-05-22.md):
        //
        // Original gate flagged BOTH counter-trend puts (otm > +150M)
        // AND counter-trend calls (otm < -150M). The 30-day audit
        // revealed the put side was catastrophically wrong:
        //   Gated puts (otm > +150M): mean +1950% — BEST cohort
        //   Gated calls (otm < -150M): mean +21.9% vs ungated +83.1%
        //                              — gate correctly demotes calls
        //
        // Put gate removed. Call gate kept. See audit memo for full
        // bucket-level breakdown. STRICT < per spec — exactly -T is NOT
        // gated.
        const LOTTERY_DIRECTION_GATE_T = 150_000_000;
        const directionGated = (() => {
          const otm = macro.mkt_tide_otm_diff;
          if (otm == null) return false;
          // Put gate intentionally removed (V2.2 Phase C.9): gated puts
          // outperformed ungated by +1900pp mean in 30-day audit.
          // Call gate kept: gated calls underperform ungated by -61pp.
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
          spot_at_trigger: rec.spotAtTrigger,
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

        // GexBot context snapshot at fire time (migration #181). Fail-open:
        // a lookup error must not block the alert insert — leave gex_*
        // columns NULL and continue. Mirrors the Silent Boom integration
        // (migration #180, commit 3c2069a0). Probe basis:
        // docs/superpowers/specs/silent-boom-gexbot-probe-findings-2026-05-26.md.
        const gexbotTicker = mapToGexbotTicker(rec.underlyingSymbol);
        let gexSnapshot: FireTimeGexbotSnapshot | null = null;
        if (gexbotTicker == null) {
          gexOutOfUniverse += 1;
        } else {
          try {
            gexSnapshot = await getLatestGexbotSnapshotAt(
              gexbotTicker,
              rec.triggerTimeCt,
            );
          } catch (err) {
            Sentry.captureException(err, {
              tags: {
                cron: 'detect-lottery-fires',
                op: 'getLatestGexbotSnapshotAt',
                ticker: rec.underlyingSymbol,
              },
            });
          }
          if (gexSnapshot == null) gexMisses += 1;
          else gexHits += 1;
        }

        const result = (await withDbRetry(
          () => db`
          INSERT INTO lottery_finder_fires (
            date, trigger_time_ct, entry_time_ct, option_chain_id,
            underlying_symbol, option_type, strike, expiry, dte,
            trigger_vol_to_oi_window, trigger_vol_to_oi_cum,
            trigger_iv, trigger_delta, trigger_ask_pct,
            trigger_window_size, trigger_window_prints,
            entry_price, open_interest, spot_at_first, spot_at_trigger,
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
            takeit_prob, takeit_model_version, takeit_features,
            gamma_at_trigger, cluster_bonus,
            gex_one_cvroflow, gex_net_put_dex, gex_one_dexoflow, gex_one_gexoflow,
            gex_zcvr, gex_zero_gamma, gex_spot, gex_captured_at,
            anchor_ws_trade_id, anchor_trade_code, anchor_leg_kind,
            spread_shape, spread_legs
          ) VALUES (
            ${rec.date}::date, ${rec.triggerTimeCt.toISOString()}, ${rec.entryTimeCt.toISOString()},
            ${rec.optionChainId}, ${rec.underlyingSymbol}, ${rec.optionType},
            ${rec.strike}, ${rec.expiry}::date, ${rec.dte},
            ${rec.triggerVolToOiWindow}, ${rec.triggerVolToOiCum},
            ${rec.triggerIv}, ${rec.triggerDelta}, ${rec.triggerAskPct},
            ${rec.triggerWindowSize}, ${rec.triggerWindowPrints},
            ${rec.entryPrice}, ${rec.openInterest}, ${rec.spotAtFirst}, ${rec.spotAtTrigger},
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
            ${takeitProb}, ${takeitVersion}, ${takeitFeaturesJson}::jsonb,
            ${rec.triggerGamma}, ${clusterBonus},
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
          ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING
          RETURNING id
        `,
          2,
          10_000,
        )) as { id: number }[];
        if (result.length > 0) {
          inserted += 1;
        }
      }
    }

    // Feed-tier monitor (Phase 6 + lottery-feed-tier-recalibration-2026-06-03).
    // Count today's fires through the EXACT feed tier logic so the
    // "zero tier1 for N consecutive days" Sentry alert (keyed on feedTier1:0)
    // shares fate with what the user actually sees. We compute the SAME
    // quality-adjusted score (qas) the feed gates + badges on
    // (api/lottery-finder.ts qasExprText):
    //   qas = GREATEST(0, score + round_trip_score_deduct
    //                       + fire_count_score_adjustment)
    //         + INVERSION_BONUS_CASE(s.inversion_quintile)
    // and classify it with tierFromQualityScore (api/_lib/lottery-tier.ts) —
    // the same cutoffs the feed uses — so the monitor cannot silently diverge
    // from the feed again (the 24/22-vs-V2-scale bug that hid for weeks).
    //
    // We DELIBERATELY do NOT read the `combined_score` GENERATED column here:
    // it still folds in a +1 gamma CASE term (migration #168) that the feed
    // DROPPED post-Fix-B (gamma is already credited via the V2 gamma-quintile
    // weight baked into the stored `score`). Reading combined_score would make
    // the monitor over-count by up to +1 on high-gamma rows near a tier
    // boundary. `combined_score` is now VESTIGIAL — unused by both feed and
    // monitor; left in place (gamma-inclusive legacy column) to avoid a
    // migration. The bonus is computed in SQL via INVERSION_BONUS_CASE_SQL (the
    // single source of truth the feed splices) so the qas is byte-identical.
    //
    // Mirrors the DEFAULT feed view (per-row demotion below: null score /
    // direction_gated / Q1-Q2 suppression → tier3, else tier on qas).
    // Best-effort: a failure here logs but never aborts the cron (inserts
    // already succeeded).
    let feedTier1 = 0;
    let feedTier2 = 0;
    let feedTier3 = 0;
    try {
      const todays = (await withDbRetry(
        () => db`
          SELECT f.score, f.direction_gated,
                 s.inversion_quintile,
                 (GREATEST(0, COALESCE(f.score, 0)
                             + COALESCE(f.round_trip_score_deduct, 0)
                             + COALESCE(f.fire_count_score_adjustment, 0))
                  + ${db.unsafe(INVERSION_BONUS_CASE_SQL)}) AS qas
          FROM lottery_finder_fires f
          LEFT JOIN lottery_ticker_stats s
            ON s.ticker = f.underlying_symbol
          WHERE f.date = ${ctx.today}::date
        `,
        2,
        10_000,
      )) as {
        score: number | null;
        direction_gated: boolean | null;
        inversion_quintile: number | null;
        qas: number | null;
      }[];
      for (const f of todays ?? []) {
        // Mirror the DEFAULT feed view: null score / direction_gated / the
        // quintile-1-2 suppression (lottery-finder.ts: `showAll OR
        // inversion_quintile IS NULL OR inversion_quintile > 2`) all render
        // as tier3, else tier on the qas computed in SQL above (identical
        // expression to the feed's qasExprText('f.')).
        const suppressed =
          f.inversion_quintile === 1 || f.inversion_quintile === 2;
        const tier =
          f.score == null || f.direction_gated === true || suppressed
            ? 'tier3'
            : tierFromQualityScore(f.qas == null ? null : Number(f.qas));
        if (tier === 'tier1') feedTier1 += 1;
        else if (tier === 'tier2') feedTier2 += 1;
        else feedTier3 += 1;
      }
    } catch (err) {
      ctx.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'detect-lottery-fires: feed-tier monitor query failed (non-fatal)',
      );
    }

    // Candle and flow-series problems leave columns null on the row; the
    // fire itself is written. Each kind is reported once per run, with its
    // first case, not once per fire, so an outage is one Sentry event per
    // tick.
    const reportRunProblem = (
      slug: string,
      message: string,
      detail: Record<string, unknown>,
    ): void => {
      ctx.logger.warn(detail, message);
      Sentry.captureMessage(message, {
        level: 'warning',
        fingerprint: ['detect-lottery-fires', slug],
        tags: { 'cron.job': 'detect-lottery-fires', 'cron.anomaly': slug },
        extra: detail,
      });
    };
    if (flowSeriesFailures > 0) {
      reportRunProblem(
        'flow-series-failed',
        'detect-lottery-fires: ticker flow series failed; fires written without flow features',
        { flowSeriesFailures, flowSeriesSkippedBreaker, firstFlowSeriesError },
      );
    }
    // A flow-series error that isn't Neon being slow is a broken query: the
    // fires still land (without flow features), but it pages and the run
    // reports 'error'.
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
        'detect-lottery-fires: ticker flow series query error; fires written without flow features';
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
        fingerprint: ['detect-lottery-fires', 'flow-series-error'],
        tags: {
          'cron.job': 'detect-lottery-fires',
          'cron.anomaly': 'flow-series-error',
        },
        extra: {
          flowSeriesGenuineFailures,
          firstFlowSeriesGenuineError: firstFlowSeriesGenuineErrorMeta,
        },
      });
    }
    if (candleFetchFailures > 0) {
      reportRunProblem(
        'candle-fetch-failed',
        'detect-lottery-fires: stock candle fetch failed; range_pos left null',
        {
          candleFetchFailures,
          candleFetchSkippedBreaker,
          firstCandleFetchError,
        },
      );
    }
    if (candleFetchEmpty > 0) {
      reportRunProblem(
        'candle-fetch-empty',
        'detect-lottery-fires: UW returned no stock candles; range_pos left null',
        { candleFetchEmpty, firstCandleFetchEmpty },
      );
    }

    // Phase 6: per-tier counts live in the structured log payload below.
    // Sentry alert for "zero tier1 fires for N consecutive trading days"
    // MUST be (re)configured in the Sentry UI to query
    // `message:"detect-lottery-fires completed" feedTier1:0` — the feedTier*
    // counts are computed above through the exact feed tier logic (today's
    // fires, qas = GREATEST(0, score + rt + fc) + inversion bonus — no gamma,
    // matching the feed's qasExprText), so a cutoff/scale
    // mismatch that zeroes the feed's tier1 (the 2026-06-03 bug) also zeroes
    // feedTier1 and trips the alert. NOTE: the legacy alert keyed on
    // `insertedTier1` (per-insert bare-score 9/7) is now stale — that field
    // was removed; repoint the Sentry query to feedTier1.
    ctx.logger.info(
      {
        scanned: rows.length,
        chains: groups.size,
        skippedShort,
        skippedNoOi,
        totalFires,
        inserted,
        feedTier1,
        feedTier2,
        feedTier3,
        priorSeeds: priorByChain.size,
        gexHits,
        gexMisses,
        gexOutOfUniverse,
        candleFetchFailures,
        candleFetchEmpty,
        candleFetchSkippedIndex,
        candleFetchSkippedBreaker,
        takeitPrefetchFailures: takeitPrefetchError == null ? 0 : 1,
        flowSeriesFailures,
        flowSeriesSkippedBreaker,
        flowSeriesGenuineFailures,
        anchorsFound,
        anchorsMissing,
        anchorLookupFailures: anchorLookupError == null ? 0 : 1,
      },
      'detect-lottery-fires completed',
    );

    // Status:
    //   - a genuine flow-series or Take-It prefetch error (a broken query)
    //     → 'error', whatever was written: it is a bug, and the cron monitor
    //     goes red;
    //   - else a Take-It prefetch that timed out or hit a Neon blip
    //     (takeit_prob NULL on every fire), a flow series that failed or
    //     was skipped by the breaker (no flow features or V2 score on that
    //     ticker's fires), or a failed anchor-legs lookup, transient or not
    //     (anchor columns NULL on every fire), makes the run 'partial'
    //     when it wrote fires. With
    //     nothing written, no row was degraded and the run stays 'success';
    //     the counters and the Sentry event still show the failure.
    const degraded =
      takeitPrefetchError != null ||
      flowSeriesFailures > 0 ||
      flowSeriesSkippedBreaker > 0 ||
      anchorLookupError != null;
    const status: CronStatus =
      flowSeriesGenuineFailures > 0 || takeitPrefetchFailureKind === 'error'
        ? 'error'
        : degraded && inserted > 0
          ? 'partial'
          : 'success';
    return {
      status,
      rows: inserted,
      metadata: {
        scanned: rows.length,
        chains: groups.size,
        skippedShort,
        skippedNoOi,
        totalFires,
        inserted,
        feedTier1,
        feedTier2,
        feedTier3,
        priorSeeds: priorByChain.size,
        gexHits,
        gexMisses,
        gexOutOfUniverse,
        candleFetchFailures,
        candleFetchEmpty,
        candleFetchSkippedIndex,
        candleFetchSkippedBreaker,
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
);

// ============================================================
// Cluster bonus helpers — V2.2 Phase C.4
// ============================================================

interface CommittedFireEntry {
  ticker: string;
  triggerTimeMs: number;
  score: number | null;
}

/**
 * Count distinct other tickers (not `thisTicker`) that scored tier1
 * (score >= LOTTERY_TIER_THRESHOLDS_V2.t1) within CLUSTER_WINDOW_MS of
 * `triggerTimeMs` in the current cron run's committed-fires list.
 *
 * Uses the in-memory `committedFires` list — no DB round-trip. The list
 * only contains fires already processed in this cron invocation so the
 * window is naturally bounded to the current scan pass.
 */
function computeClusterSize(
  committedFires: CommittedFireEntry[],
  thisTicker: string,
  triggerTimeMs: number,
): number {
  const otherTickers = new Set<string>();
  for (const fire of committedFires) {
    if (fire.ticker === thisTicker) continue;
    if (fire.score == null) continue;
    if (fire.score < LOTTERY_TIER_THRESHOLDS_V2.t1) continue;
    if (Math.abs(fire.triggerTimeMs - triggerTimeMs) <= CLUSTER_WINDOW_MS) {
      otherTickers.add(fire.ticker);
    }
  }
  // +1 for this fire itself → total distinct tickers in cluster including self
  return otherTickers.size + 1;
}

/**
 * Map a cluster size (total distinct tickers including self) to the
 * tiered bonus value per the V2.2 Phase C.4 spec.
 *
 * isolated (1)  → 0
 * pair (2)      → +1
 * small (3-4)   → +2  (peak empirical lift: +79% mean vs +10% baseline)
 * large (5+)    → +1  (signal dilutes back toward baseline)
 */
function applyClusterBonus(clusterSize: number): number {
  if (clusterSize >= 5) return CLUSTER_BONUS_LARGE;
  if (clusterSize >= 3) return CLUSTER_BONUS_SMALL;
  if (clusterSize === 2) return CLUSTER_BONUS_PAIR;
  return CLUSTER_BONUS_ISOLATED;
}

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
  const flowQuery = withDbRetry(
    () =>
      db`
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
      ` as Promise<FlowMacroRow[]>,
    2,
    10_000,
  );

  const spotQuery = withDbRetry(
    () =>
      db`
        SELECT gamma_oi, gamma_vol, charm_oi, vanna_oi
        FROM spot_exposures
        WHERE ticker = 'SPX'
          AND timestamp <= ${asOf.toISOString()}
          AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
        ORDER BY timestamp DESC
        LIMIT 1
      ` as Promise<SpotMacroRow[]>,
    2,
    10_000,
  );

  const wantStrike = TICKERS_WITH_GEX_STRIKE.has(rec.underlyingSymbol);
  // Look up the closest stored strike (within ±1% of fire strike) for
  // SPX/SPXW/NDX/NDXP/SPY/QQQ. Other tickers don't have per-strike GEX
  // ingested, so we skip the query.
  const strikeQuery: Promise<StrikeMacroRow[]> = wantStrike
    ? withDbRetry(
        () =>
          db`
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
          ` as Promise<StrikeMacroRow[]>,
        2,
        10_000,
      )
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
