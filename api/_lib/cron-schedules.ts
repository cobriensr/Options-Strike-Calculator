/**
 * Cron schedule map → the Sentry cron monitor config that both cron
 * wrappers, withCronInstrumentation and withCronCheckin (the lighter wrap
 * for crons with non-standard shapes), send as `monitor_config` on a run's
 * first `in_progress` check-in. Check-ins are direct HTTP POSTs to Sentry's
 * Crons ingest endpoint (sentryCheckInDirect in cron-instrumentation.ts),
 * not Sentry.withMonitor() or captureCheckIn(). A job with no entry here
 * sends no check-ins at all. Keep entries in sync with vercel.json.
 *
 * Why a separate file: the schedule strings live in vercel.json (the
 * canonical source) but both wrappers need them at request time without
 * parsing JSON on the cold path. Hand-mirroring the values is the
 * cheapest correct option. cron-schedules.test.ts checks both directions:
 * each entry against vercel.json, and each vercel.json cron for an entry
 * here or a written exemption (UNMONITORED_CRONS in that test).
 *
 * Spec: docs/superpowers/specs/sentry-monitoring-2026-05-07.md
 *       docs/superpowers/specs/cron-monitor-coverage-2026-10-29.md
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
 * DST_TAIL_NOTE — why four market-hours monitors use an ET-local schedule,
 * and how it relates to the wrapper-level skip check-in fix.
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
 *   - On the skip path the wrapper DID send a check-in — but a LONE `ok`
 *     (no preceding `in_progress`, no check_in_id). Empirically those
 *     5-min ticks in the ~2h EDT tail still expired to `missed`: `ok`
 *     check-ins WITH real durations (paired live-session runs) stop at
 *     20:05 UTC; 20:10→21:55 were all `missed`, every day. The original
 *     note attributed this to "a lone `ok` cannot satisfy a tick" — but
 *     Sentry's heartbeat docs say a lone `ok` IS a valid tick-completing
 *     check-in. The honest read is: a lone heartbeat `ok` mixed into a
 *     monitor otherwise driven by `in_progress`→`ok` PAIRS did not
 *     reliably credit the tick in practice. Rather than depend on which
 *     interpretation is right, we fixed BOTH layers.
 *
 * TWO-LAYER FIX (2026-06-08, second pass):
 *
 *   Layer 1 (wrapper, O(1), helps ALL ~27 market-hours monitors):
 *     `sendIntentionalSkipCheckin` now emits the SAME shape a live tick
 *     emits — an `in_progress` immediately followed by a terminal `ok`
 *     (same check_in_id, duration 0) — instead of a lone `ok`. This is
 *     the canonical two-step crons lifecycle, so Sentry unambiguously
 *     marks the served-but-skipped tick OK. Any market-hours cron that
 *     hits the market-closed skip path is now covered, not just these
 *     four.
 *
 *   Layer 2 (these four monitors' ET-local schedule — KEPT):
 *     The wrapper fix only rescues ticks Vercel ACTUALLY FIRES (an
 *     invocation must happen for any skip check-in to be sent). Ticks the
 *     fixed-UTC crontab does NOT serve in a given regime get no
 *     invocation at all — e.g. 09:00–09:50 ET in EDT = 13:00–13:50 UTC,
 *     outside `14-22` for evaluate-round-trip; the function never runs,
 *     so no skip check-in can rescue them. Anchoring the MONITOR window
 *     to `America/New_York` makes it expect ticks only where the UTC
 *     crontab actually serves AND the session is live in BOTH regimes, so
 *     those structurally-unserved ticks are never expected. The two
 *     layers are complementary: Layer 1 covers served-but-skipped ticks,
 *     Layer 2 stops the monitor from expecting never-served ticks.
 *
 * Why we kept Layer 2 rather than reverting it: the empirical EDT-tail
 * `missed` flood was observed against the lone-`ok` shape, and we are not
 * willing to bet a live-session outage signal on the unverified claim
 * that the new paired skip check-in alone fully subsumes the ET anchoring
 * for the structurally-unserved (never-invoked) ticks. Layer 2 is cheap,
 * independently validated by the cross-check test (every ET tick lands in
 * the UTC window in both regimes), and strictly tightens the expectation
 * set. failureIssueThreshold:3 is retained throughout.
 *
 * Window-derivation note (evaluate-round-trip, finding #6): the 10:00 ET
 * start is NOT an under-coverage bug. EST has served+fired ticks at 09:30–
 * 09:55 ET, but an ET-local crontab that expected 09:30 ET would ALSO
 * expect 09:30 ET in EDT = 13:30 UTC, which vercel.json's `every-10-min
 * 14-22` UTC crontab never serves → guaranteed `missed`. So the start
 * cannot be widened without reintroducing a structural miss. The end is
 * 17:50 ET (2026-10-02): the handler's own gate runs to close + 80 so
 * the session's last fires are evaluated before the weekend prunes their
 * tape, and 17:50 ET is the last tick served in EST (22:50 UTC). Ticks
 * past the handler gate are satisfied by Layer 1's paired skip check-in.
 */
const MARKET_HOURS_TZ = 'America/New_York';

export const SCHEDULE_MAP: Record<string, CronMonitorConfig> = {
  'archive-gexbot': {
    // Daily Parquet export; crashed at module load for four weeks in Sep–Oct
    // 2026 with no Sentry event because nothing ran. A missed check-in is
    // the only signal for that failure class. maxDuration is 300 s → long runner.
    schedule: '30 21 * * 2-6',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'audit-takeit-calibration': {
    // Weekly Take-It calibration audit, Monday 11:00 UTC (before the
    // open; the handler sets marketHours: false). Audits are the safety
    // net: if one silently stops running, nothing else notices, so every
    // audit-* cron carries a monitor. Weekly → default failure threshold
    // of 1. docs/superpowers/specs/cron-monitor-coverage-2026-10-29.md.
    schedule: '0 11 * * 1',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'auto-prefill-premarket': {
    // Dual-slot 13:30 + 14:30 UTC: the 08:30 CT cash open is 13:30 UTC in
    // CDT and 14:30 UTC in CST, and no single fixed-UTC slot hits both. The
    // handler's isAfterCashOpen gate skips the early CST slot (07:30 CT)
    // so the post-open slot does the work; the redundant CDT slot is an
    // idempotent re-run. See the header comment in the handler.
    schedule: '30 13,14 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'backfill-gamma-setup-outcomes': {
    // Daily after the close: fills the forward returns on unresolved
    // ws_gamma_setup_fires rows from the last two trading days (weekends and
    // NYSE holidays skipped, so Monday's run retries Friday's fires).
    // maxDuration is 120 s, inside the default max runtime. Daily → default
    // failure threshold of 1.
    schedule: '30 21 * * 1-5',
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
    // ws_option_trades and upserts the (date, slot) snapshot, then persists
    // the previous slot into flow_regime_slot_daily once it has settled
    // (5 min past its close). High-freq
    // → relaxed failure threshold so a single transient miss doesn't
    // page (same policy as the other 5-min market-hours crons).
    schedule: '*/5 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'capture-flow-regime-daily': {
    // 21:55 UTC weekdays — once post-close (after both EDT 16:00→20:00 UTC and
    // EST 16:00→21:00 UTC cash closes). Fills the flow_regime_slot_daily
    // slots still missing for today and the previous weekday (normally only
    // the final 15:30–16:00 ET slot, which the live cron can't reach), one
    // bounded window at a time. Low-freq → default failure threshold (a
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
  'check-gamma-setup-drift': {
    // Weekly, Friday 21:45 UTC, 15 min after backfill-gamma-setup-outcomes
    // fills the week's returns. Weekly → default failure threshold of 1.
    schedule: '45 21 * * 5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'cleanup-gexbot': {
    schedule: '15 12 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'compute-cone': {
    schedule: '32 13 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'compute-zero-gamma': {
    schedule: '4,9,14,19,24,29,34,39,44,49,54,59 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'detect-gamma-setups': {
    // Every minute in the 13-21 UTC window, same cadence and policy as
    // detect-lottery-fires. UTC verbatim is safe: every tick vercel.json
    // fires checks in, either live or via the wrapper's paired skip
    // check-in outside the market-hours gate (DST_TAIL_NOTE, Layer 1).
    // High-freq → relaxed failure threshold.
    schedule: '* 13-21 * * 1-5',
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
    // ET-local schedule — see DST_TAIL_NOTE. vercel.json fires `*/10 14-22`
    // UTC. 14 UTC = 09 ET (EST) / 10 ET (EDT), so the window starts at
    // 10:00 ET, an hour later than the lottery pair. It ends at 17:50 ET
    // because the handler gate runs to close + 80 (17:20 ET) to evaluate
    // the last fires of the session (see POST_CLOSE_EVAL_MIN in the
    // handler); 17:50 ET = 22:50 UTC in EST, the last served tick.
    // 17:30–17:50 ET (and every post-gate tick on a half-day or holiday)
    // is satisfied by the wrapper's skip check-in.
    schedule: '*/10 10-17 * * 1-5',
    timezone: MARKET_HOURS_TZ,
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-gexbot-fast': {
    // Three vercel.json entries (`30-59 13`, `* 14-20`, `0-1 21`); three
    // whole minutes went missing in Oct 2026 (10-20 15:06 UTC, 10-21 19:03,
    // 10-22 19:34) with no signal. ET-local `* 10-15` (10:00-15:59 ET) lies
    // inside the `* 14-20` UTC entry in BOTH regimes (EDT 14:00-19:59 UTC,
    // EST 15:00-20:59 UTC), so no tick is expected that Vercel won't send;
    // the open and close edges are covered by the handler's own gate.
    // maxDuration is 60 s, so DEFAULT_MAX_RUNTIME is ample.
    schedule: '* 10-15 * * 1-5',
    timezone: MARKET_HOURS_TZ,
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'fetch-gexbot-strikes': {
    // Same windows and rationale as fetch-gexbot-fast.
    schedule: '* 10-15 * * 1-5',
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
    // Three post-close slots: each run is time-boxed (~4 min) and the
    // later slots drain what the first could not (tape + UW inversion).
    schedule: '40 21,22,23 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'enrich-silent-boom-outcomes': {
    // Two post-close slots so a Friday alert gets a retry before the
    // Monday retention cutoff.
    schedule: '45 21,23 * * 1-5',
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
    schedule: '0 23 * * 2-6',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-economic-calendar': {
    schedule: '25 13,14 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
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
  'fetch-futures-session-stats': {
    // vercel.json fires `30 12 * * 2-6` and `30 21 * * 1-5`; a monitor has
    // one crontab, so it expects the 12:30 run, which carries the settled
    // session's final open interest. The 21:30 run checks in on the same
    // slug off-schedule, which is safe: on an ok check-in Sentry computes
    // the next expected tick from that check-in's time (mark_ok →
    // update_monitor_environment in getsentry/sentry src/sentry/monitors/
    // logic/), so 21:30 Mon expects 12:30 Tue and causes no false miss. A
    // failed 21:30 run still shows as an error check-in. Daily → default
    // failure threshold of 1.
    schedule: '30 12 * * 2-6',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
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
    schedule: '30 13,14 * * 1-5',
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
  'repair-futures-blocks': {
    // Nightly REST repair of blocks the websocket missed during drops. Its
    // paging stops at 240 s, inside the default 300 s limit. Low frequency
    // → default failure threshold of 1.
    schedule: '15 22 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'rollup-ws-gex-strike-expiry': {
    // Daily WS GEX → strike_exposures copy. Five runs in Oct 2026 left no
    // rows and no Sentry event; the monitor is what turns a killed run into
    // a timeout alert. maxDuration is 300 s → long runner, so a run that
    // uses its whole budget still completes inside the max runtime. Low
    // frequency → default failure threshold of 1.
    schedule: '30 22 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'schwab-reauth-reminder': {
    // Hourly, every day: the refresh-token clock ignores market hours. Low
    // frequency → default failure threshold of 1.
    schedule: '7 * * * *',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'takeit-fill-shap': {
    // Every 2 min in the 13-21 UTC window: SHAP top features for scored
    // Lottery and Silent Boom alerts. Skipped ticks check in via the
    // wrapper (see detect-gamma-setups). High-freq → relaxed threshold.
    schedule: '*/2 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
  },
  'wave2-confirmation': {
    // Every 5 min in the 13-21 UTC window: labels wave-2 confirmation on
    // recent Lottery and Silent Boom fires. High-freq → relaxed threshold.
    schedule: '*/5 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    failureIssueThreshold: HIGH_FREQ_FAILURE_THRESHOLD,
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
  'audit-migration-drift': {
    // Daily 12:00 UTC, every day, ahead of the 13:00 UTC market-data
    // crons. Safety-net audit, monitored for the reason given at
    // audit-takeit-calibration. Daily → default failure threshold of 1.
    schedule: '0 12 * * *',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'audit-takeit-health': {
    // Daily 23:30 UTC, every day, after EOD settles. Safety-net audit,
    // monitored for the reason given at audit-takeit-calibration. Daily →
    // default failure threshold of 1.
    schedule: '30 23 * * *',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'backfill-futures-gaps': {
    schedule: '0 6 * * 1-6',
    checkinMargin: DEFAULT_MARGIN,
    // 14 min covers its 800 s maxDuration (13.3 min). The OHLC pass alone
    // can take ~10 min when UW hangs, and the order-flow pass can run up to
    // its 600 s deadline plus one candle load and one page, so the 10 min
    // long-runner default would page on a run Vercel still lets finish.
    maxRuntime: 14,
  },
  'backup-tables': {
    schedule: '0 5 * * 0',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'cleanup-ws-gex-strike-expiry': {
    // Daily pre-market retention sweep, 12:00 UTC weekdays. maxDuration is
    // 300 s → long runner. It runs once a weekday, so a failed sweep isn't
    // retried until the next one: default failure threshold of 1 (unlike
    // cleanup-ws-option-trades, which runs hourly and self-heals).
    schedule: '0 12 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'cleanup-ws-option-trades': {
    // Hourly at :05 from 22:05 through 12:05 UTC, every day — never 13–21
    // UTC, where batch deletes would contend with uw-stream's market-hours
    // inserts. A run can use its full ~5 min budget → long-runner max
    // runtime. A failed run self-heals on the next hourly run, so page on
    // two consecutive failures rather than one. Cadence math:
    // docs/superpowers/specs/flow-regime-and-retention-2026-10-02.md.
    schedule: '5 0-12,22-23 * * *',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
    failureIssueThreshold: 2,
  },
  'archive-gexbot-eod': {
    // GEXBot EOD report capture, every day (weekend runs find nothing new).
    // Spec: docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md
    schedule: '0 2,12,19,23 * * *',
    checkinMargin: DEFAULT_MARGIN,
    // Long-runner: 800 s Vercel timeout (budget: no new downloads after 600 s, abort at 740 s). 14 min covers it with headroom.
    maxRuntime: 14,
  },
  'audit-gexbot-eod': {
    // Alarm for a lost GEXBot EOD day, weekdays 19:45 UTC.
    // Spec: docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md
    schedule: '45 19 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
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
  'refit-lottery-ticker-stats': {
    // Shadow refit; after the last enrich-lottery-outcomes slot (23:40 UTC).
    schedule: '55 23 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'populate-periscope-from-gexbot': {
    // vercel.json: `30,40,50 13`, `*/10 14-20`, `*/10 21`. ET-local
    // `*/10 10-15` sits inside the `*/10 14-20` UTC entry in both regimes.
    schedule: '*/10 10-15 * * 1-5',
    timezone: MARKET_HOURS_TZ,
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
};
