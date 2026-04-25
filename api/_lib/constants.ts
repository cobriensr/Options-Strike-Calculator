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

/** Market time boundaries in minutes since midnight (ET) */
export const MARKET_MINUTES = {
  /** 9:30 AM ET = 570 minutes */
  OPEN: 570,
  /** 4:00 PM ET = 960 minutes */
  CLOSE: 960,
} as const;

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
export const STRIKE_IV_TICKERS = [
  'SPXW',
  'NDXP',
  'SPY',
  'QQQ',
  'IWM',
  'SMH',
  'NVDA',
  'TSLA',
  'META',
  'MSFT',
  'SNDK',
  'MSTR',
  'MU',
] as const;
export type StrikeIVTicker = (typeof STRIKE_IV_TICKERS)[number];

/**
 * Primary gate for the anomaly detector: target strike's intraday volume
 * divided by start-of-day OI. A strike must have `volume / oi >= 5.0` to
 * even enter skew_delta / z_score / ask_mid_div evaluation.
 *
 * Rationale (from 2026-04-24 live validation):
 *   - A SPXW put at 5.0×+ vol/OI on the morning of the 2026-04-23 flush
 *     ran from $45 → ~$200 (4x) — the ratio was the single most reliable
 *     filter for tradeable informed flow.
 *   - Every noise anomaly from the 2026-04-24 production run had vol/OI
 *     well under 2× at firing time. The 5.0× threshold cuts that noise
 *     essentially completely.
 *
 * Ratio grows throughout the session since `volume` is cumulative
 * intraday and `oi` is start-of-day. Early-morning alerts are sparse by
 * design — user only wants to see "massively outsized" signals.
 */
export const VOL_OI_RATIO_THRESHOLD = 5.0;

// ============================================================
// STRIKE IV ANOMALY DETECTOR (Phase 2 — detection)
// ============================================================

/**
 * Cross-strike skew delta: target strike IV minus avg IV of the 2 neighbors
 * each side (same side, same expiry, same ticker, most recent sample).
 * 1.5 vol points is large enough that common charm/gamma factors don't
 * produce false positives on liquid chains, but small enough to flag the
 * informed-flow ramp pattern at detection time.
 */
export const SKEW_DELTA_THRESHOLD = 1.5;

/**
 * Rolling Z-score: target strike's iv_mid vs its own Z_WINDOW_SIZE-sample
 * history. 2.0σ is the ~97.5th percentile for a normal distribution — rare
 * enough to be informative, frequent enough to get labeled samples for ML.
 */
export const Z_SCORE_THRESHOLD = 2.0;

/**
 * How many prior samples feed the rolling Z. 60 samples at 1-min cadence
 * ≈ 1 trading hour — long enough for σ to stabilize, short enough that
 * regime shifts during the session still propagate.
 */
export const Z_WINDOW_SIZE = 60;

/**
 * Ask-mid IV divergence: iv_ask minus iv_mid. Tracked on every anomaly
 * but NOT a standalone gate per spec — it's a tie-breaker / supporting
 * signal for Claude's retrospective analysis in Phase 4.
 */
export const ASK_MID_DIV_THRESHOLD = 0.5;

/**
 * Secondary gate for the anomaly detector: minimum fraction of the bid-ask
 * IV spread that must sit on a single side (above mid for ask-dominant,
 * below for bid-dominant) before a strike enters the IV signal evaluation.
 *
 * `ask_skew = (iv_ask - iv_mid) / (iv_ask - iv_bid)` — fraction of the
 * spread above mid. `bid_skew = 1 - ask_skew` (when spread > 0). A value
 * of 0.65 means at least 65% of the spread is on one side.
 *
 * This is a PROXY for true tape-side volume dominance until UW per-strike
 * bid-vs-ask volume is wired (see
 * `docs/superpowers/specs/tape-side-volume-exit-signal-2026-04-24.md`).
 * It uses fields the detector already reads (iv_bid / iv_mid / iv_ask)
 * and is directionally correct — when MMs mark up the ask faster than the
 * mid moves, that signature shows up here as ask_skew → 1. Two-sided
 * unwinding flow (e.g., 2026-04-24 SPY 0DTE puts at 50/50 ask/bid)
 * collapses to ask_skew ≈ 0.5 and is filtered out.
 *
 * Calibration: 0.65 matches the 65% side-dominance target from the live
 * 2026-04-23 SPY 705P observation (97% ask during accumulation). When
 * the full spec ships, real `bid_pct` / `ask_pct` REPLACE this proxy —
 * they don't augment it.
 */
export const IV_SIDE_SKEW_THRESHOLD = 0.65;

// ============================================================
// STRIKE IV ANOMALY DETECTOR (Phase 4 — EOD resolution)
// ============================================================

/**
 * Outcome-class thresholds for `resolveAnomaly()`.
 *
 * `notional_1c_pnl` is in **dollars per contract** (SPX/SPY/QQQ — 100× multiplier
 * baked into the P&L math). A $5 flat band keeps single-tick noise from tipping
 * genuinely flat anomalies into winner/loser buckets — tune once we have a week
 * of labeled data.
 *
 * Time cutoff for winner_fast vs winner_slow uses detection-to-IV-peak minutes,
 * not spot move: the anomaly's predictive claim is on IV, and the trade a 0DTE
 * operator takes is usually a vol-expansion play that's closed near the IV peak
 * (not at 4pm close). 30 min separates "the detector leads by an hour or more"
 * from "the detector confirms what's already happening."
 */
export const RESOLVE_FLAT_PNL_THRESHOLD = 5;
export const RESOLVE_FAST_PEAK_MINS = 30;

/**
 * Retrospective catalyst analysis (`analyzeCatalysts`).
 *
 * T-60 → T+0 window: we scan a rolling 60-minute pre-detection window for
 * leading-lag signals and concurrent events. 60 minutes matches the 2026-04-23
 * validation event (TLT bid → SPX flush with ~60 min lead time).
 */
export const CATALYST_WINDOW_MINS = 60;

/**
 * Minimum |correlation| for a cross-asset to appear in `leading_assets`.
 * Pearson on 1-min log-returns inside the T-60 window. 0.5 is the middle of
 * the "moderate correlation" band — filters noise without demanding the tight
 * lock-step that only appears during extreme sessions.
 */
export const CATALYST_CORR_THRESHOLD = 0.5;

/**
 * Minimum |correlation| + minimum lag to surface a `likely_catalyst` narrative
 * tag. We only claim a cross-asset "led" the anomaly when it BOTH correlates
 * strongly AND moved measurably ahead of the anomaly ticker. 5 minutes is
 * large enough that tick-level noise can't fake it, small enough to still
 * catch fast macro-tape handoffs (ZN futures → SPX).
 */
export const CATALYST_NARRATIVE_CORR_MIN = 0.6;
export const CATALYST_NARRATIVE_LAG_MIN_MINS = 5;

/**
 * Range-break lookback in trading days. 5 gives us "broke the weekly range"
 * without depending on any specific session boundary. Breaking a 5-day high
 * or low inside the anomaly window is a classic ignition signal.
 */
export const CATALYST_RANGE_BREAK_DAYS = 5;

/**
 * Large dark print threshold (notional dollars). Dark prints inside the
 * T-60 window above this notional are flagged as potential catalyst candidates.
 * Matches the `dark_pool_levels.total_premium` row shape (already dollar-denominated).
 */
export const CATALYST_LARGE_DARK_NOTIONAL = 5_000_000;
