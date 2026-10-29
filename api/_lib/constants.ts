/**
 * Shared constants for API serverless functions.
 * Centralizes timeouts, market time boundaries, and other magic numbers
 * that were previously scattered across endpoint files.
 */

/** HTTP request timeouts (milliseconds) */
export const TIMEOUTS = {
  /** Schwab API calls */
  SCHWAB_API: 30_000,
  /** Unusual Whales API calls */
  UW_API: 15_000,
  /** Default API call timeout */
  DEFAULT: 10_000,
} as const;

// ============================================================
// DB RETRY BUDGET — shared by the resilient read paths
// ============================================================
//
// The "nice-to-have" / degrade-on-timeout DB reads (lottery-finder feed,
// lottery/silent-boom export endpoints) share a single retry budget so the
// per-attempt timeout and attempt count live in exactly one place. Used as
// the defaults for `degradeOnTimeout(...)`'s options object and passed to
// `withDbRetry` at the export call sites.
//
// 20s per attempt was tuned for the slowest reignition CTEs (window funcs
// over 5k+ daily fires) — see the note in degradeOnTimeout. Don't push the
// user-path timeout past 20s.

/** Number of retries (in addition to the first attempt) for resilient DB reads. */
export const DB_RETRY_ATTEMPTS = 2;

/** Per-attempt timeout (ms) for resilient DB reads. */
export const DB_RETRY_TIMEOUT_MS = 20_000;

// ============================================================
// SESSION HOURS — single source of truth
// ============================================================
//
// US equity regular-trading-hours session window. Authored in CT (the
// trader's timezone) and exposed in ET / UTC equivalents for the
// existing callers that expressed the same instant in those zones.
//
// 08:30 CT == 09:30 ET == 13:30 UTC (DST) / 14:30 UTC (standard).
// 15:00 CT == 16:00 ET == 20:00 UTC (DST) / 21:00 UTC (standard).
//
// The UTC anchor is DST-sensitive — anchor against an ET date string
// (e.g. via getETDateStr) and convert through getETTime / getCTTime
// rather than using the UTC hour directly. The legacy UTC constant
// below is preserved for the `rthOpenIsoFor` call in uw-deltas.ts which
// uses 13:30 UTC as its DST-tolerant "earliest candidate" anchor.

/** 08:30 CT in minutes since CT midnight = 510. */
export const SESSION_OPEN_MIN_CT = 8 * 60 + 30;
/** 15:00 CT in minutes since CT midnight = 900 (exclusive). */
export const SESSION_CLOSE_MIN_CT = 15 * 60;

/** Market time boundaries in minutes since midnight (ET). 9:30 ET == 8:30 CT. */
export const MARKET_MINUTES = {
  /** 9:30 AM ET = 570 minutes (== SESSION_OPEN_MIN_CT + 60). */
  OPEN: SESSION_OPEN_MIN_CT + 60,
  /** 4:00 PM ET = 960 minutes (== SESSION_CLOSE_MIN_CT + 60). */
  CLOSE: SESSION_CLOSE_MIN_CT + 60,
} as const;

/**
 * Earliest-candidate UTC hour for the cash-session open. 13:30 UTC ==
 * 09:30 ET during DST and 08:30 ET during standard time, so this is
 * the DST-tolerant lower bound for "after the open". Real
 * timezone-aware comparisons should anchor on an ET date string
 * (`getETDateStr`) and convert through `getETTime`/`getCTTime`.
 */
export const SESSION_OPEN_HOUR_UTC = 13;
/** Minutes-of-hour companion to `SESSION_OPEN_HOUR_UTC`. */
export const SESSION_OPEN_MINUTE_UTC = 30;

/** Unusual Whales API base URL */
export const UW_BASE = 'https://api.unusualwhales.com/api';

// ============================================================
// STRIKE IV ANOMALY DETECTOR (Phase 1)
// ============================================================

/**
 * Per-strike IV snapshot filters for the fetch-strike-iv cron.
 * OTM range: ±3% of spot covers 1% (today's 7100→7034 example) through tail hedges.
 * Min OI gates out illiquid strikes whose mid prices are stale — per-ticker
 * because index (SPXW/NDXP) strikes are $5-wide (OI concentrates) vs
 * SPY/QQQ $1-wide (OI disperses across a wider band), and IWM has a
 * thinner chain still. Numbers calibrated on the tightest strike-wide
 * gate that still filters ghost liquidity.
 *
 * Ticker mix (2026-04-25 multi-theme expansion): 13 tickers, all 0DTE-capable
 * (or weekly at worst).
 *   - Cash-index weekly roots: SPXW (SPX weeklies), NDXP (NDX weeklies)
 *   - Broad ETFs: SPY, QQQ, IWM
 *   - Sector ETFs: SMH (semis)
 *   - High-liquidity single-name tech: NVDA, TSLA, META, MSFT (AI capex /
 *     hyperscaler complex; deep 0DTE OI)
 *   - Mid-liquidity single names: SNDK (memory), MSTR (BTC proxy), MU
 *     (memory peer to SNDK)
 *
 * SPX monthlies (3rd-Friday expiry under the `SPX` root) are intentionally
 * excluded — 0DTE lives on SPXW, and mixing SPX monthlies into the same
 * bucket produced cross-root noise in the 2026-04-24 production run. Same
 * for sector ETFs (TLT/XLF/XLE/XLK) tested earlier: chains were too thin and
 * too noisy to contribute signal, so they were dropped in the original
 * rescope. SMH re-enters in the 2026-04-25 expansion as the dedicated AI-
 * silicon ETF analog (10-day rollup: 136 chains, $182M premium, 100% small-
 * sample ASK win rate — clean signal vs the dropped sector ETFs).
 *
 * The 2026-04-25 expansion (TSLA, META, MSTR, MSFT, MU, SMH) was driven by
 * a 10-day EOD flow study: TSLA carried the largest non-index outsized
 * premium ($439M / 344 chains, 55% ASK-side win rate); META/MSFT/MSTR all
 * cleared the 65%+ ASK win-rate bar. AMD was explicitly excluded — its
 * 1W/7L (12% ASK win rate) is a textbook dumb-money fingerprint. The
 * intent is to capture entry signals across the full informed-flow surface
 * and let downstream ML separate signal from noise per-ticker rather than
 * pre-narrow the watchlist by trader preference.
 *
 * SPXW / NDXP are not directly queryable on Schwab — the cron fetches
 * `$SPX` / `$NDX` chains and filters contract symbols to the desired
 * weekly root. See `fetch-strike-iv.ts` schwabSymbol / root-filter.
 * Equity / ETF tickers (SPY, QQQ, IWM, SMH, NVDA, TSLA, META, MSFT, SNDK,
 * MSTR, MU) are root-unique — Schwab accepts the bare symbol.
 */
/**
 * OTM range — three-tier 2026-04-25 after the rescope + whale-print
 * studies:
 *
 *   - Cash-index weeklies (SPXW, NDXP): ±12%. These are the only roots
 *     where institutional traders concentrate "lottery-ticket" 0DTE flow
 *     at 8-12% OTM strikes. Empirical: NDXP 27300C at 11.4% OTM on
 *     2026-04-24 ran $1.90 → $42.85 (+2,155%) on 51× vol/OI. Same
 *     pattern visible on SPXW deep-OTM puts during flush days. The
 *     ±3% gate filtered all of these out.
 *   - Broad ETFs (SPY, QQQ, IWM): ±3%. Reaction surface — informed
 *     flow stays close to ATM since dealer hedging response is what
 *     moves SPY/QQQ.
 *   - Sector ETFs + single names: ±5%. Single-name lottery tickets
 *     sit at 4-5% OTM (verified in 10-day backfill funnel — 75-90%
 *     of META/MSTR rollup chains were outside ±3%).
 */
export const STRIKE_IV_OTM_RANGE_PCT_CASH_INDEX = 0.12;
export const STRIKE_IV_OTM_RANGE_PCT_BROAD_ETF = 0.03;
export const STRIKE_IV_OTM_RANGE_PCT_SINGLE_NAME = 0.05;
/**
 * High-liquidity single-name tech (NVDA, TSLA, META, MSFT, GOOGL) —
 * widened to ±12% on 2026-04-28 to match the cash-index band. Deep-OTM
 * lottery-ticket whales on these names sit 8-12% OTM (e.g., TSLA 400C
 * 2026-05-01 @ 11.4% OTM was profitable on 2026-04-27 but invisible to
 * the prior ±5% gate). Liquidity supports the wider window — these
 * names have $1-spaced strikes through ~15% OTM with tradeable OI.
 */
export const STRIKE_IV_OTM_RANGE_PCT_HIGH_LIQ_NAME = 0.12;
/**
 * OI floors — looser-tier values 2026-04-25. Prior values were
 * calibrated for index dominance + ATM strikes and were over-filtering
 * both single-name flow AND deep-OTM cash-index whale prints. The
 * 10-day backfill funnel showed 60-89% of single-name rollup chains
 * being dropped by OI alone, and the NDXP 2,155% lottery tickets had
 * OI in the 14-137 range (well below the prior 300-OI cash-index
 * floor). New floors keep the signal-to-noise ratio acceptable while
 * widening the detector's operating envelope.
 *
 * Cash-index weekly roots (SPXW, NDXP) — lowered to 50 to capture the
 * deep-OTM lottery-ticket whale strikes that cluster at low OI but
 * carry massive vol/OI ratios (51-256× on the 2026-04-24 NDXP whales).
 */
export const STRIKE_IV_MIN_OI_CASH_INDEX = 50;
export const STRIKE_IV_MIN_OI_SPY_QQQ = 150;
/** IWM (Russell 2000) — smaller-cap liquidity sits below QQQ. */
export const STRIKE_IV_MIN_OI_IWM = 75;
/** Sector ETFs (SMH and similar) — narrower 0DTE chain than SPY/QQQ. */
export const STRIKE_IV_MIN_OI_SECTOR_ETF = 100;
/**
 * High-liquidity single-name tech (NVDA, TSLA, META, MSFT) — deep OI on
 * most strikes near ATM, but lower than the original 1000 to capture
 * institutional flow on $1-strike-spaced near-ATM contracts that
 * concentrate ~500 OI rather than 1000+.
 */
export const STRIKE_IV_MIN_OI_HIGH_LIQ = 500;
/** Mid-liquidity single names (SNDK, MSTR, MU) — thinner ladder. */
export const STRIKE_IV_MIN_OI_SINGLE_NAME = 100;
/**
 * Order matters — both the cron iteration AND the UI ticker-pill row use
 * this list directly. SPY first per 2026-04-29 outlier study: SPY's win
 * rate (63% on n=138) materially beats SPXW (53%), QQQ (54%), and SPX (46%)
 * because the biggest SPX whale prints are mostly portfolio rebalancing
 * (~$8M median premium, directionally uninformative) while SPY's smaller
 * $50K-median prints are real directional positioning. See
 * `ml/findings/outlier-detection-2026-04-28.md` for the full breakdown.
 *
 * TSM, NFLX, RUTW added 2026-04-29 — all three appeared in the high-edge
 * outlier buckets at 100% win rate, small n. TSM and NFLX slot into
 * HIGH_LIQ_NAME tier; RUTW gets cash-index treatment via `$RUT` chain
 * fetch + strict OSI-root filter (mirrors SPXW handling).
 */
export const STRIKE_IV_TICKERS = [
  'SPY',
  'SPXW',
  'NDXP',
  'RUTW',
  'QQQ',
  'IWM',
  'SMH',
  'NVDA',
  'TSLA',
  'META',
  'MSFT',
  'GOOGL',
  'NFLX',
  'TSM',
  'SNDK',
  'MSTR',
  'MU',
] as const;
export type StrikeIVTicker = (typeof STRIKE_IV_TICKERS)[number];

// ============================================================
// DIR VEGA SPIKE MONITOR (Phase 3)
// See docs/superpowers/specs/dir-vega-spike-monitor-2026-04-27.md
// ============================================================

/**
 * Magnitude floor per ticker — alert only fires if |dir_vega_flow| is at
 * least this large. Empirical p99 of |dir_vega_flow| from a 30-day backfill,
 * rounded UP to the nearest 10K. Chose p99 over p99.5 to catch moderate
 * spikes (e.g. 450K QQQ events) that would silently miss at the tighter
 * cut. Expected alert load: ~0.82 SPY/day + ~0.54 QQQ/day = ~1.4/day total.
 */
export const VEGA_SPIKE_FLOORS: Record<string, number> = {
  SPY: 490000, // p99 = 482.1K (n=11753)
  QQQ: 330000, // p99 = 320.2K (n=11760)
};

/** Robust z-score gate. score = |dir_vega| / MAD(|dir_vega|, prior bars same day). */
export const VEGA_SPIKE_Z_SCORE_THRESHOLD = 6.0;

/** Magnitude must exceed this multiple of the day's prior max |dir_vega_flow|. */
export const VEGA_SPIKE_VS_PRIOR_MAX_RATIO = 2.0;

/** Minimum bars elapsed in the session before any alert can fire (avoids 9:30 first-bar artifact and stabilizes MAD). */
export const VEGA_SPIKE_MIN_BARS_ELAPSED = 30;

/** Window (seconds) within which concurrent SPY+QQQ alerts get the confluence flag. */
export const VEGA_SPIKE_CONFLUENCE_WINDOW_SEC = 60;

// ============================================================
// CRON TICKER FAN-OUT
// ============================================================

/**
 * Default in-flight concurrency for crons that fan out per-ticker
 * Schwab/UW requests via `mapWithConcurrency`. UW caps concurrent
 * in-flight requests at 3, so 4 is the highest safe value for UW
 * crons (one slot of headroom for the limiter); Schwab is more
 * permissive but 4 is a sensible default that won't 429 either API.
 *
 * Phase 3c of docs/superpowers/specs/api-refactor-2026-05-02.md.
 */
export const CRON_TICKER_DEFAULT_CONCURRENCY = 4;

/**
 * Strike-IV cron concurrency. fetch-strike-iv is Schwab-only (no UW)
 * across 13 tickers — 4-wide fan-out produced enough sequential
 * "waves" that Sentry's Consecutive HTTP detector fired on every run
 * (SENTRY-EMERALD-DESERT-4F + 4D, 92 events between 2026-05-04 and
 * 2026-05-14). 8 cuts the wave count from 4 → 2 while staying well
 * inside Schwab's per-app concurrency budget.
 */
export const STRIKE_IV_TICKER_CONCURRENCY = 8;

/**
 * Minimum option entry price ($/contract) for alert feeds. Filters out
 * the $0.01-$0.02 algo prints that re-trigger the lottery and silent-
 * boom pipelines as algo noise. Applied at the data layer in
 * `/api/lottery-finder` and `/api/silent-boom-feed` so sub-threshold
 * fires never reach the rollup aggregator or the ticker list.
 *
 * Threshold chosen 2026-05-15 from trader feedback. Raise if the algo
 * noise floor creeps up; lower if a real signal gets caught.
 */
export const MIN_ALERT_ENTRY_PRICE = 0.1;

// ============================================================
// CASH-INDEX OPTION ROOTS
// ============================================================

/**
 * Cash-settled index roots: the weekly roots the alert feeds carry
 * (SPXW, NDXP, RUTW) and their index tickers (SPX, NDX, RUT).
 *
 * - detect-silent-boom steps the adjacent-strike co-fire check by $5
 *   on these (their strike increment) instead of $1.
 * - detect-lottery-fires skips the UW candle fetch for these: UW
 *   answers 422 with code `cboe_index_access_missing` ("Prices for the
 *   CBOE index SPXW require provisioned access and CBOE approval.";
 *   uw-api-ws-alignment-2026-10-23.md, D8).
 */
export const CASH_INDEX_ROOTS: ReadonlySet<string> = new Set([
  'SPXW',
  'SPX',
  'NDXP',
  'NDX',
  'RUTW',
  'RUT',
]);

// ============================================================
// LOTTERY FINDER — REIGNITION DETECTION (Task A of
// docs/superpowers/specs/lottery-reignition-ui-2026-05-17.md)
// ============================================================
//
// A chain qualifies as REIGNITED when its same-day fire history shows
// the "went quiet, came back" pattern: multiple fires earlier in the
// session, a meaningful silent stretch, then a flurry of post-gap
// fires. The pinned UI section promotes qualifying chains out of their
// ticker group so the user catches the BOOM moment before scrolling.
//
// Tuned 2026-05-17 against 626k fires across 93 days (2026-01-02 →
// 2026-05-15). The (3, 30, 2) prereq + top-5/day rank lifts precision
// on outlier-peak winners from 40% (baseline of any multi-fire chain)
// to 70%, with +18% median realized trail30/10 R. Mean R is slightly
// negative (-2.3%, 95% CI [-7.0, +2.7]) — REIGNITION is a visual
// surfacing tool, NOT an auto-trade signal. The trader filters further
// by context (chart shape, ticker, time of day, plan).
//
// CRITICAL: gap math MUST use `trigger_time_ct` differences directly
// and ignore the `minutes_since_prev_fire` column — the latter is
// NULL/0 on the QQQ 708P 2026-05-15 anchor despite 21 distinct fires
// spanning 6 hours, making it unreliable as a gap source.

/** Minimum fires on a chain-day before it can be considered for REIGNITION. */
export const REIGNITION_MIN_FIRES = 3;
/** Minimum gap (minutes) between two consecutive fires for the chain to count
 *  as having "gone quiet" at some point during the session. */
export const REIGNITION_MIN_GAP_MIN = 30;
/** Minimum fires that must land AFTER the longest gap on the chain
 *  (inclusive of the fire that closes the gap). */
export const REIGNITION_MIN_POST_GAP_FIRES = 2;
/** Per-day cap on how many qualifying chains carry the REIGNITED flag.
 *  Ranked by post_gap_fires DESC, fire_count DESC. */
export const REIGNITION_TOP_N_PER_DAY = 5;

// ============================================================
// MEGA-CLUSTER detection — cross-ticker minute concentration
// ============================================================
//
// When the SAME CT minute carries fires from many distinct tickers,
// the fires that follow outperform. Per the 2026-05-17 cluster
// analysis (docs/tmp/cluster-2026-05-15-1205ct-findings.md) on 626k
// fires across 93 days:
//   - 1 ticker (solo):     n=3,774,   median trail = +13.9%, win 59.2%
//   - 3-4 tickers:         n=30,118,  median trail = +6.2%,  win 57.0%
//   - 5-11 tickers:        n=259,782, median trail = +7.0%,  win 56.5%
//   - >=12 tickers:        n=324,911, median trail = +16.3%, win 60.0%
// The 12+ bucket carries the strongest signal — when the whole flow
// surface lights up at the same minute, those fires tend to work.

/** Threshold above which a CT-minute is flagged as a "mega cluster" —
 *  i.e. ≥ N distinct underlying tickers fired in the same 1-minute
 *  bucket on the same trading day. */
export const MEGA_CLUSTER_MIN_DISTINCT_TICKERS = 12;

// ============================================================
// GAMMA-AT-TRIGGER bonus — outside-the-box winner-feature
// ============================================================
//
// Per the 2026-05-17 gamma deep-dive
// (docs/tmp/gamma-deep-dive-findings-2026-05-17.md), high gamma at
// trigger time carries +4.8pp (LF) to +10.7pp (SB) winrate lift on
// the trail30/10 exit. The lift is BOTH ticker-conditional AND
// exit-conditional:
//   - Ticker-conditional: 11/13 tickers show positive lift (CRCL,
//     SNDK, META, SLV, AVGO, QQQ, TSLA, NVDA, AMD, INTC, MU), but
//     SPY (-7pp) and USO (-16pp) REVERSE the signal. Likely
//     mechanism: SPY is heavily index-rebalanced (gamma signals MM
//     positioning, not directional info) and USO is commodity-
//     correlated (different gamma dynamics).
//   - Exit-conditional: the lift HOLDS on trail30/10 + hard30m
//     (active exits) but REVERSES on hold-EoD (-10pp at top decile).
//     Reason: high gamma = ATM = peak theta exposure; holding to
//     close destroys 0DTE premium regardless of direction.
//
// LF curve shape is a step function (drag below ~0.025, +4-5pp
// plateau above). SB curve is a monotonic gradient (top decile
// +13pp, no plateau). Single threshold of 0.025 captures LF's
// inflection point and the start of SB's lift.

/** Gamma threshold above which a fire earns the score bonus, IFF
 *  ticker is not excluded. From the LF decile-5 inflection point. */
export const GAMMA_HIGH_BONUS_THRESHOLD = 0.025;

/** Tickers excluded from the gamma bonus because their per-ticker
 *  data shows the signal REVERSES (negative lift). SPY: index-
 *  rebalancing flow proxy. USO: commodity-driven gamma dynamics. */
export const GAMMA_BONUS_EXCLUDED_TICKERS: readonly string[] = ['SPY', 'USO'];

/** Score points added when a fire qualifies for the gamma bonus.
 *  Matches the magnitude of the existing fire_count_score_adjustment
 *  top bracket (+2 for ≥16 fires, +1 for 8-15 fires); +1 keeps the
 *  bonus from dominating the displayed tier. */
export const GAMMA_HIGH_BONUS_POINTS = 1;

// ============================================================
// MACRO WINDOW
// ============================================================

/**
 * Days after a fire's trigger time during which a high-impact economic
 * event is considered "in the window" for macro context lookup. Used
 * by api/lottery-finder.ts to query economic_events for items scheduled
 * within MACRO_WINDOW_DAYS of any fire in the current batch.
 */
export const MACRO_WINDOW_DAYS = 7;

/** MACRO_WINDOW_DAYS expressed as milliseconds for Date arithmetic. */
export const MACRO_WINDOW_MS = MACRO_WINDOW_DAYS * 24 * 3600 * 1000;

// ============================================================
// LOTTERY KEPT-TICKERS RETENTION
// ============================================================

// Days of lottery_kept_tickers history to retain. Floor is >=1 trading day (the never-vanish "current day" guarantee); 7 = margin for weekend/holiday gaps + late enrichment. The set-difference diff-skip in lottery-finder.ts depends on today's rows never being pruned, so this MUST stay >= 1.
export const KEPT_RETENTION_DAYS = 7;

// ============================================================
// WS_OPTION_TRADES RETENTION
// ============================================================

/**
 * Days of `ws_option_trades` history kept by the cleanup-ws-option-trades
 * cron (it deletes rows older than today's ET date minus this many days).
 * Readers that must not mistake "pruned" for "no trades" — e.g.
 * enrich-periscope-lottery-outcomes, which locks a no-trade fire at
 * realized R = -1 — bound their candidates to this window.
 */
export const WS_OPTION_TRADES_RETENTION_DAYS = 2;
