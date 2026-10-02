/**
 * GET /api/cron/refit-lottery-ticker-stats
 *
 * Daily SHADOW refit of the per-ticker inversion quality in
 * `lottery_ticker_stats` (inversion_lcb_21d/90d, blend, quintile, n_21d/90d)
 * from the live enrichment in lottery_finder_fires. It is a DB-only port of
 * `refit_ticker_inversion_stats` (scripts/enrich_lottery_outcomes.py); the
 * math lives in api/_lib/lottery-ticker-refit.ts.
 *
 * SHADOW MODE: it computes the would-be stats and records them, but it does
 * NOT write lottery_ticker_stats, which still drives Q1/Q2 suppression
 * (lottery-suppression.ts) and the inversion score bonus
 * (lottery-inversion-bonus.ts). The live table was frozen on 2026-06-17,
 * when the local nightly stopped. Two reasons to hold:
 *   - The cutoffs and quintiles were tuned on parquet NBBO-mid inversion.
 *     The live realized_flow_inversion_pct uses UW's synthetic per-minute
 *     mid (option-intraday.ts deriveMid), and that parity is unverified.
 *   - The inputs were empty from late June until enrichment resumed
 *     (docs/superpowers/specs/lottery-enrichment-starvation-2026-10-02.md),
 *     so an early refit would clear every quintile and switch suppression
 *     off. writeLiveTickerStats refuses any write that would clear more
 *     live quintiles than it keeps or re-fits.
 *
 * Where to inspect a run: the cron metadata (Axiom `refit-lottery-ticker-
 * stats` events and the HTTP response) carries the coverage and the diff
 * against the live quintiles. The structured log line also carries every
 * ticker's would-be stats, and a Sentry breadcrumb carries the summary.
 *
 * PROMOTION: once coverage and the diff look right, set PROMOTE_TO_LIVE
 * below to `true`. That one line makes each run also UPDATE
 * lottery_ticker_stats (UPDATE-only, like the Python refit). It is a code
 * constant, not an env var: promotion is a reviewed, one-time decision.
 *
 * Schedule: `55 23 * * 1-5`, after the last enrich-lottery-outcomes slot
 * (23:40 UTC), so the day's inversions are in.
 *
 * Environment: CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  buildShadowReport,
  computeTickerInversionStats,
  readLiveTickerStats,
  readTickerWindowCounts,
  writeLiveTickerStats,
} from '../_lib/lottery-ticker-refit.js';

/**
 * PROMOTION SWITCH. `false` = shadow (compute + report only). `true` = also
 * write the refit into lottery_ticker_stats on every run.
 */
const PROMOTE_TO_LIVE: boolean = false;

export default withCronInstrumentation(
  'refit-lottery-ticker-stats',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();
    const [counts, live] = await Promise.all([
      readTickerWindowCounts(sql),
      readLiveTickerStats(sql),
    ]);
    const stats = computeTickerInversionStats(counts);
    const report = buildShadowReport(stats, live);
    const mode = PROMOTE_TO_LIVE ? 'live' : 'shadow';

    const { changes, ...summary } = report;
    const headline =
      `refit-lottery-ticker-stats (${mode}): ${report.tickersWithBlend}/` +
      `${report.tickersSeen} tickers have a blend; ` +
      `${changes.length} quintile change(s) vs live`;
    ctx.logger.info({ mode, ...report, stats }, headline);
    Sentry.addBreadcrumb({
      category: 'lottery.refit',
      level: 'info',
      message: headline,
      data: summary,
    });

    const written = PROMOTE_TO_LIVE
      ? await writeLiveTickerStats(sql, stats, report)
      : 0;

    return {
      status: 'success',
      rows: written,
      message: headline,
      metadata: { mode, ...report },
    };
  },
  // Runs after the close; DB-only (no UW call).
  { marketHours: false, requireApiKey: false },
);
