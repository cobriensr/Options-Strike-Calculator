/**
 * Cron schedule map → fed to Sentry.cron.withMonitor() inside
 * withCronInstrumentation. Keep entries in sync with vercel.json.
 *
 * Why a separate file: the schedule strings live in vercel.json (the
 * canonical source) but the wrapper needs them at request time without
 * parsing JSON on the cold path. Hand-mirroring the values is the
 * cheapest correct option — drift is caught by the unit test that
 * cross-checks each entry against the file at test time.
 *
 * Only entries for jobs that route through `withCronInstrumentation` are
 * present. Crons that bypass the wrapper (legacy, paginated, non-standard
 * shapes — see docs/superpowers/specs/sentry-monitoring-2026-05-07.md
 * Phase 3) get monitors in a separate sweep.
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
  'compute-es-overnight': {
    schedule: '35 13,14 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'compute-zero-gamma': {
    schedule: '4,9,14,19,24,29,34,39,44,49,54,59 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'detect-lottery-fires': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'detect-silent-boom': {
    schedule: '*/5 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
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
  },
  'fetch-etf-tide': {
    schedule: '2,7,12,17,22,27,32,37,42,47,52,57 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-flow': {
    schedule: '0,5,10,15,20,25,30,35,40,45,50,55 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-flow-alerts': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-gex-0dte': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-gex-strike-expiry-etfs': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-greek-exposure': {
    schedule: '0,5,10,15,20,25,30,35,40,45,50,55 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
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
  },
  'fetch-greek-flow-etf': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-market-internals': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-net-flow': {
    schedule: '1,6,11,16,21,26,31,36,41,46,51,56 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
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
  },
  'fetch-strike-iv': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'fetch-strike-trade-volume': {
    schedule: '* 13-21 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
  'reconcile-greek-flow-etf': {
    schedule: '0 22 * * 1-5',
    checkinMargin: DEFAULT_MARGIN,
    maxRuntime: DEFAULT_MAX_RUNTIME,
  },
};
