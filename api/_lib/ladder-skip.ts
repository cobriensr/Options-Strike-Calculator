/**
 * The one rule for a write that is skipped because its data is unusable
 * (docs/superpowers/specs/live-data-integrity-2026-11-06.md, P0.3 and P0.4).
 * Whatever the reason:
 *   - nothing is stored;
 *   - a warning is logged and a named metric is counted;
 *   - from 09:40 ET on, a Sentry **error** says what was skipped.
 *     Nobody reads a warning, and data that is still unusable at 09:40 is no
 *     longer the 09:25 to 09:32 rollover. 09:40 ET is P0.1's `feed_stalled`
 *     threshold (`isFeedStalled`, closed-buckets.ts). Before it the skip is
 *     quiet, because UW answering with yesterday's data, or an empty or zero
 *     answer, is the normal state until it rolls over.
 *
 * `reportSkippedWrite` is the rule itself. `reportLadderSkip` applies it to a
 * strike ladder (`fetch-strike-exposure`, `fetch-strike-all`,
 * `fetch-gex-0dte`, and `compute-zero-gamma` for its source ladder), which is
 * skipped for one of six kinds (`LadderSkipKind` in strike-ladder.ts): stale,
 * stale_spot, stale_source, all_zero, empty, outside_window.
 *
 * The caller turns a skip into its response: a skipped run is never reported
 * as a success.
 */

import { isFeedStalled } from './closed-buckets.js';
import logger from './logger.js';
import { Sentry, metrics } from './sentry.js';
import type { LadderSkipKind } from './strike-ladder.js';

/**
 * Warn and count `metric`; from 09:40 ET also raise a Sentry error with
 * `alert`, if given. Leave `alert` out for a skip that is not worth an error
 * (the caller decides, e.g. fetch-spot-gex alerts only on the newest row).
 */
export function reportSkippedWrite(opts: {
  job: string;
  /** The full metric name, e.g. `fetch_spot_gex.zero_row_skip`. */
  metric: string;
  warning: string;
  /** Log fields. */
  detail?: Record<string, unknown>;
  /** The Sentry error text, without the time suffix. */
  alert?: string;
}): void {
  const { job, metric, warning, detail, alert } = opts;

  logger.warn({ ...detail }, warning);
  metrics.increment(metric);

  // isFeedStalled(0, now): "nothing usable arrived", true from 09:40 ET.
  if (alert !== undefined && isFeedStalled(0, new Date())) {
    Sentry.setTag('cron.job', job);
    Sentry.captureMessage(`${alert} (09:40 ET or later)`, 'error');
  }
}

const METRIC_BY_KIND: Record<LadderSkipKind, string> = {
  stale: 'stale_cache_skip',
  stale_spot: 'stale_spot_skip',
  stale_source: 'stale_source_skip',
  all_zero: 'zero_snapshot_skip',
  empty: 'empty_ladder_skip',
  outside_window: 'outside_window_skip',
};

const WORDING_BY_KIND: Record<LadderSkipKind, string> = {
  stale: 'stale UW cache (ladder from an earlier ET day)',
  stale_spot: 'stale UW spot (spot row from an earlier ET day)',
  stale_source: 'source ladder too old',
  all_zero: 'rejecting all-zero gamma snapshot',
  empty: 'UW returned no strikes',
  outside_window: 'no returned strike inside the stored range',
};

export function reportLadderSkip(opts: {
  job:
    | 'fetch-strike-exposure'
    | 'fetch-strike-all'
    | 'fetch-gex-0dte'
    | 'compute-zero-gamma';
  kind: LadderSkipKind;
  ticker: string;
  expiry?: string;
  /** Extra log fields: the data's ET date, row counts. */
  detail?: Record<string, unknown>;
}): void {
  const { job, kind, ticker, expiry, detail } = opts;
  const what = expiry === undefined ? ticker : `${ticker} ${expiry}`;

  reportSkippedWrite({
    job,
    metric: `${job.replaceAll('-', '_')}.${METRIC_BY_KIND[kind]}`,
    warning: `${job}: ${WORDING_BY_KIND[kind]}, skipping store`,
    detail: { kind, ticker, expiry, ...detail },
    alert: `${job}: ${kind} ladder for ${what}, nothing stored`,
  });
}
