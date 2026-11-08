/**
 * The one rule for a strike ladder that is not stored, shared by
 * `fetch-strike-exposure` and `fetch-strike-all`
 * (docs/superpowers/specs/live-data-integrity-2026-11-06.md, P0.3).
 *
 * A ladder is skipped for one of five kinds (`LadderSkipKind` in
 * strike-ladder.ts): stale, stale_spot, all_zero, empty, outside_window.
 * Whatever the kind:
 *   - nothing is stored;
 *   - a warning is logged and a named metric is counted;
 *   - from 09:40 ET on, a Sentry **error** names the kind and the ticker.
 *     Nobody reads a warning, and a ladder that is still unusable at 09:40 is
 *     no longer the 09:25 to 09:32 rollover. 09:40 ET is P0.1's `feed_stalled`
 *     threshold (`isFeedStalled`, closed-buckets.ts). Before it the skip is
 *     quiet, because UW answering with yesterday's ladder, or an empty or
 *     zero one, is the normal state until it rolls over.
 *
 * The caller turns a skip into its response: a skipped run is never reported
 * as a success.
 */

import { isFeedStalled } from './closed-buckets.js';
import logger from './logger.js';
import { Sentry, metrics } from './sentry.js';
import type { LadderSkipKind } from './strike-ladder.js';

const METRIC_BY_KIND: Record<LadderSkipKind, string> = {
  stale: 'stale_cache_skip',
  stale_spot: 'stale_spot_skip',
  all_zero: 'zero_snapshot_skip',
  empty: 'empty_ladder_skip',
  outside_window: 'outside_window_skip',
};

const WORDING_BY_KIND: Record<LadderSkipKind, string> = {
  stale: 'stale UW cache (ladder from an earlier ET day)',
  stale_spot: 'stale UW spot (spot row from an earlier ET day)',
  all_zero: 'rejecting all-zero gamma snapshot',
  empty: 'UW returned no strikes',
  outside_window: 'no returned strike inside the stored range',
};

export function reportLadderSkip(opts: {
  job: 'fetch-strike-exposure' | 'fetch-strike-all';
  kind: LadderSkipKind;
  ticker: string;
  expiry?: string;
  /** Extra log fields: the data's ET date, row counts. */
  detail?: Record<string, unknown>;
}): void {
  const { job, kind, ticker, expiry, detail } = opts;
  const what = expiry === undefined ? ticker : `${ticker} ${expiry}`;

  logger.warn(
    { kind, ticker, expiry, ...detail },
    `${job}: ${WORDING_BY_KIND[kind]}, skipping store`,
  );
  metrics.increment(`${job.replaceAll('-', '_')}.${METRIC_BY_KIND[kind]}`);

  // isFeedStalled(0, now): "nothing usable arrived", true from 09:40 ET.
  if (isFeedStalled(0, new Date())) {
    Sentry.setTag('cron.job', job);
    Sentry.captureMessage(
      `${job}: ${kind} ladder for ${what}, nothing stored (09:40 ET or later)`,
      'error',
    );
  }
}
