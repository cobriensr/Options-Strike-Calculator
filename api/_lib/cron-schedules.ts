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
  /** Crontab string from vercel.json (UTC, Vercel's cron timezone). */
  schedule: string;
  /** Minutes a check-in can be late before alerting. */
  checkinMargin: number;
  /** Maximum expected runtime in minutes. */
  maxRuntime: number;
  /** Failure check-ins required to trigger an issue (default 1 = page on first miss). */
  failureIssueThreshold?: number;
  /** Successful check-ins required to resolve (default 1). */
  recoveryThreshold?: number;
}

const DEFAULT_MARGIN = 2;
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
  'embed-yesterday': {
    schedule: '0 7 * * 2-6',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: LONG_RUNNER_MAX_RUNTIME,
  },
  'enrich-lottery-outcomes': {
    schedule: '30 21 * * 1-5',
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
  'fetch-vol-0dte': {
    schedule: '* 13-21 * * 1-5',
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
