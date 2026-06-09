/**
 * Cron schedule map → fed to Sentry.withMonitor() inside
 * withCronInstrumentation AND to Sentry.captureCheckIn() inside
 * withCronCheckin (the lighter wrap for crons with non-standard shapes).
 * Keep entries in sync with vercel.json.
 *
 * Why a separate file: the schedule strings live in vercel.json (the
 * canonical source) but both wrappers need them at request time without
 * parsing JSON on the cold path. Hand-mirroring the values is the
 * cheapest correct option — drift is caught by the unit test that
 * cross-checks each entry against the file at test time.
 *
 * Spec: docs/superpowers/specs/sentry-monitoring-2026-05-07.md
 */

export interface CronMonitorConfig {
  /**
   * Crontab string the Sentry monitor evaluates ticks against.
   *
   * For UTC entries (the default — `timezone` absent) this MUST match
   * vercel.json verbatim; the cross-check test enforces it.
   *
   * For ET-anchored entries (`timezone: 'America/New_York'`) this is an
   * ET-LOCAL crontab that the cross-check test reconciles against the
   * UTC vercel.json window in both DST regimes (see DST_TAIL_NOTE).
   */
  schedule: string;
  /** Minutes a check-in can be late before alerting. */
  checkinMargin: number;
  /** Maximum expected runtime in minutes. */
  maxRuntime: number;
  /** Failure check-ins required to trigger an issue (default 1 = page on first miss). */
  failureIssueThreshold?: number;
  /** Successful check-ins required to resolve (default 1). */
  recoveryThreshold?: number;
  /**
   * IANA timezone for the `schedule` crontab. Omit for UTC (the default,
   * and what vercel.json uses). Set to `'America/New_York'` for
   * market-hours crons whose handler gate is ET-anchored — see
   * DST_TAIL_NOTE below.
   */
  timezone?: string;
}

const DEFAULT_MARGIN = 5;
const DEFAULT_MAX_RUNTIME = 5;
const LONG_RUNNER_MAX_RUNTIME = 10;

/**
 * Failure threshold for high-frequency monitors (every-minute and
 * every-5-min schedules during market hours). With the direct-HTTP
 * Sentry bypass landed in commit bbc3a79a we observed ~5% transient
 * miss rate on the completion check-in — stale-connection drops in
 * Node's fetch pool that no application-level fix can fully eliminate.
 * Requiring 3 consecutive misses before opening an issue cuts the
 * effective alert rate to (0.05)^3 ≈ 0.013% (1 in ~8000 runs), so
 * single-blip noise is silenced while a real outage (3+ minutes with
 * no successful completion) still pages immediately.
 *
 * Low-frequency monitors (daily, hourly, once-per-window) keep the
 * default threshold of 1 — a single miss there is genuinely
 * significant and would not be masked by network noise.
 */
const HIGH_FREQ_FAILURE_THRESHOLD = 3;

/**
 * DST_TAIL_NOTE — why four market-hours monitors use an ET-local schedule.
 *
 * Diagnosis (2026-06-08, pulled from Sentry monitor check-in history):
 * detect-periscope-{put,call}-lottery, evaluate-round-trip, and
 * refresh-tracker-contracts accumulated hundreds of "missed" check-ins
 * NOT from network drops (the failureIssueThreshold:3 + direct-HTTP
 * bypass already silence those) but from a deterministic DST window
 * mismatch:
 *
 *   - vercel.json runs these on a fixed-UTC every-5/10-min crontab over
 *     the UTC hours 13-21 (or 13-20) sized to cover the EST cash session
 *     (close 21:00 UTC).
 *   - The handler gate, cronGuard → isMarketHours(), is ET-anchored:
 *     it opens ~09:25 ET and closes ~16:05 ET. In EDT (summer) 16:05 ET
 *     = 20:05 UTC, so from 20:10 UTC through the end of the UTC crontab
 *     window (21:55) the handler is past close and intentionally skips.
 *   - On the skip path the wrapper sends a lone `ok` check-in, but a
 *     standalone `ok` with no preceding `in_progress` does not satisfy
 *     the scheduled tick — so every 5-min tick in that ~2h EDT tail
 *     expires to `missed`. Verified: `ok` check-ins (with real durations)
 *     stop exactly at 20:05 UTC; 20:10→21:55 are all `missed`, every day.
 *
 * Why NOT widen checkinMargin: margin only rescues a check-in that
 * arrives LATE. In the EDT tail the check-in never arrives for those
 * ticks (market is closed), so no finite margin covers a 2-hour blackout
 * — it would only mask the real-outage signal we want to keep.
 *
 * Fix: evaluate these monitors' schedule in `America/New_York`. An
 * ET-local crontab DST-shifts in lockstep with the isMarketHours() gate,
 * so the monitor expects ticks only during the live session in BOTH EST
 * and EDT. Vercel still invokes on its UTC union window; the out-of-
 * session UTC invocations are intentional skips the ET monitor simply
 * does not expect. failureIssueThreshold:3 is retained, so a genuine 3+-
 * window outage (≥15 min dark during the live session) still pages.
 *
 * Residual: the ET crontab uses whole-hour ranges (`9-16` / `9-15`)
 * while isMarketHours() opens at :25 and closes at :05-past, so a few
 * boundary ticks (9:00-9:20 ET pre-open; close-hour tail) can still be
 * intentional skips. These are SYMMETRIC across DST (same handful summer
 * and winter, not a 60-min seasonal blackout) and are individually
 * covered by the 3-window threshold. Eliminating them entirely would
 * require minute-precise ranges or an in_progress-anchored skip check-in
 * (wrapper change) — out of scope for this alerting-only fix.
 */
const MARKET_HOURS_TZ = 'America/New_York';

export const SCHEDULE_MAP: Record<string, CronMonitorConfig> = {
  'auto-prefill-premarket': {
    schedule: '30 13 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'build-features': {
    schedule: '45 20,21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'capture-flow-regime': {
    // Every 5 min during the RTH cron window (13-21 UTC weekdays).
    // Recomputes the current 30-min flow-regime bucket from
    // ws_option_trades and upserts the (date, slot) snapshot. High-freq
    // → relaxed failure threshold so a single transient miss doesn't
    // page (same policy as the other 5-min market-hours crons).
    schedule: '*/5 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'capture-flow-regime-daily': {
    // 21:55 UTC weekdays — once post-close (after both EDT 16:00→20:00 UTC and
    // EST 16:00→21:00 UTC cash closes). Accumulates the day's per-slot
    // component sums into flow_regime_slot_daily so the live cron can compute
    // percentile breakpoints on read. Low-freq → default failure threshold (a
    // single miss is genuinely significant).
    schedule: '55 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'capture-opening-flow-signal': {
    // 14:50 UTC weekdays. Fires year-round AFTER the V4 09:30–09:40 ET
    // slice 2 window has closed:
    //   - CDT (Mar–Nov): 09:50 CT / 10:50 ET (1h 10m after window close)
    //   - CST (Nov–Mar): 08:50 CT / 09:50 ET (10m after window close)
    // The earlier 13:50 UTC option would have fired DURING the window
    // in CST (07:50 CT / 08:50 ET), so the cron would have written an
    // empty `windowStatus='before_open'` row for the ~4-week DST seam
    // and never had a chance to overwrite it later in the day.
    schedule: '50 14 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'capture-regime-0dte': {
    // 21:30 UTC weekdays (16:30 ET / 15:30 CT) — after the 15:00 CT cash
    // close + settle. Nightly self-scoring: evaluates the day's 0DTE
    // gamma regime as-of 15:00 CT and upserts the verdict + realized
    // outcome into flow_regime_0dte_daily. Low-frequency daily job →
    // default failure threshold (a single miss is genuinely significant).
    schedule: '30 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'check-cone-breach': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'compute-cone': {
    schedule: '32 13 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'compute-es-overnight': {
    schedule: '35 13,14 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'compute-zero-gamma': {
    schedule: '4,9,14,19,24,29,34,39,44,49,54,59 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'detect-lottery-fires': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'detect-silent-boom': {
    schedule: '*/5 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'detect-periscope-call-lottery': {
    // ET-local schedule — see DST_TAIL_NOTE. vercel.json fires `*/5 13-21`
    // UTC (EST-sized union); the handler's isMarketHours() gate is
    // ET-anchored (09:25–16:05 ET), so in EDT the 20:10–21:55 UTC ticks
    // are always intentional skips that expire to `missed`. Evaluating in
    // America/New_York makes the monitor expect ticks only during the live
    // session in both DST regimes. `9-16` is the guaranteed served subset.
    schedule: '*/5 9-16 * * 1-5',
    timezone: MARKET_HOURS_TZ,
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'detect-periscope-put-lottery': {
    // ET-local schedule — see DST_TAIL_NOTE. Identical cadence to the call
    // sibling; vercel.json `*/5 13-21` UTC → ET-local `*/5 9-16`.
    schedule: '*/5 9-16 * * 1-5',
    timezone: MARKET_HOURS_TZ,
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'enrich-periscope-lottery-outcomes': {
    schedule: '50 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'evaluate-round-trip': {
    // ET-local schedule — see DST_TAIL_NOTE. vercel.json fires `*/10 14-21`
    // UTC. 14 UTC = 09 ET (EST) / 10 ET (EDT); the guaranteed served-AND-
    // fired subset across both regimes is 10:00–16:00 ET, so the ET-local
    // crontab starts an hour later than the lottery pair.
    schedule: '*/10 10-16 * * 1-5',
    timezone: MARKET_HOURS_TZ,
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'embed-yesterday': {
    schedule: '0 7 * * 2-6',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'enrich-lottery-outcomes': {
    schedule: '40 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'enrich-silent-boom-outcomes': {
    schedule: '45 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'enrich-vega-spike-returns': {
    schedule: '*/5 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-day-ohlc': {
    schedule: '0 23 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-economic-calendar': {
    schedule: '25 13,14 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-es-options-eod': {
    schedule: '0 22 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'fetch-etf-candles-1m': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-etf-tide': {
    schedule: '2,7,12,17,22,27,32,37,42,47,52,57 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-flow': {
    schedule: '0,5,10,15,20,25,30,35,40,45,50,55 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-flow-alerts': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-gex-0dte': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-gex-strike-expiry-etfs': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-greek-exposure': {
    schedule: '0,5,10,15,20,25,30,35,40,45,50,55 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-greek-exposure-strike': {
    schedule: '30 13 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-greek-flow': {
    schedule: '3,8,13,18,23,28,33,38,43,48,53,58 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-greek-flow-etf': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-market-internals': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-net-flow': {
    schedule: '1,6,11,16,21,26,31,36,41,46,51,56 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-net-flow-history': {
    schedule: '25 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-nope': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-oi-change': {
    schedule: '30 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-oi-per-strike': {
    schedule: '30 14 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-outcomes': {
    schedule: '25 20,21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-spot-gex': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-strike-iv': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-strike-trade-volume': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'reconcile-greek-flow-etf': {
    schedule: '0 22 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },

  // ── withCronCheckin (lighter wrap, original handler shape preserved) ──

  'audit-gexbot-health': {
    // Daily NULL-rate tripwire for the GexBot classic-basic merge. Single
    // schedule (unlike the multi-window fetch-gexbot crons), so it can carry
    // a Sentry heartbeat — alerts if the monitor itself stops running. Low
    // frequency → default failure threshold of 1 (a single miss is real).
    schedule: '30 22 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'backfill-futures-gaps': {
    schedule: '0 6 * * 1-6',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'backup-tables': {
    schedule: '0 5 * * 0',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'curate-lessons': {
    schedule: '0 3 * * 6',
    checkinMargin: DEFAULT_MARGIN,
    // Long-runner: 780s Vercel timeout. 14 min covers it with headroom.
    maxRuntime: 14,
  },
  'curate-periscope-lessons': {
    schedule: '0 3 * * 1',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: 14,
  },
  'fetch-futures-snapshot': {
    schedule: '*/5 * * * 0-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-spx-candles-1m': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-strike-all': {
    schedule: '3,8,13,18,23,28,33,38,43,48,53,58 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-strike-exposure': {
    schedule: '3,8,13,18,23,28,33,38,43,48,53,58 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-vol-surface': {
    schedule: '35 21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-zero-dte-flow': {
    schedule: '4,9,14,19,24,29,34,39,44,49,54,59 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'monitor-flow-ratio': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'monitor-vega-spike': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'refresh-current-snapshot': {
    schedule: '*/5 13-20 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'refresh-tracker-contracts': {
    // ET-local schedule — see DST_TAIL_NOTE. vercel.json fires `*/5 13-20`
    // UTC. 20 UTC = 15 ET (EST) / 16 ET (EDT); since EST caps the fired
    // window at 15:00 ET, the guaranteed served-AND-fired subset across
    // both regimes is 09:00–15:00 ET → ET-local `*/5 9-15`.
    schedule: '*/5 9-15 * * 1-5',
    timezone: MARKET_HOURS_TZ,
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'refresh-vix1d': {
    schedule: '0 11 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'warm-tbbo-percentile': {
    schedule: '0 13 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
};
