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
 * Ticker mix (2026-04-24 rescope): 5 tickers, all 0DTE-capable.
 *   - Cash-index weekly roots: SPXW (SPX weeklies), NDXP (NDX weeklies)
 *   - ETFs: SPY, QQQ, IWM
 *
 * SPX monthlies (3rd-Friday expiry under the `SPX` root) are intentionally
 * excluded — 0DTE lives on SPXW, and mixing SPX monthlies into the same
 * bucket produced cross-root noise in the 2026-04-24 production run. Same
 * for sector ETFs (TLT/XLF/XLE/XLK): chains were too thin and too noisy
 * to contribute signal, so they were dropped in the rescope.
 *
 * SPXW / NDXP are not directly queryable on Schwab — the cron fetches
 * `$SPX` / `$NDX` chains and filters contract symbols to the desired
 * weekly root. See `fetch-strike-iv.ts` schwabSymbol / root-filter.
 */
export const STRIKE_IV_OTM_RANGE_PCT = 0.03;
/** Cash-index weekly roots (SPXW, NDXP) — $5-wide strikes, OI concentrates. */
export const STRIKE_IV_MIN_OI_INDEX = 500;
export const STRIKE_IV_MIN_OI_SPY_QQQ = 250;
/** IWM (Russell 2000) — smaller-cap liquidity sits below QQQ. */
export const STRIKE_IV_MIN_OI_IWM = 150;
export const STRIKE_IV_TICKERS = ['SPXW', 'NDXP', 'SPY', 'QQQ', 'IWM'] as const;
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
