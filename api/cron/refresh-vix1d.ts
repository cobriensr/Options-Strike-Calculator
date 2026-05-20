/**
 * GET /api/cron/refresh-vix1d
 *
 * Fetches the full VIX1D daily OHLC history from CBOE's public CSV and
 * stores it in Redis under the key `vix1d:daily-map`. The `/api/vix1d-daily`
 * endpoint serves from that key, replacing the static `public/vix1d-daily.json`
 * baseline for up-to-date backtest data.
 *
 * Runs weekday mornings before market open so each session has yesterday's
 * VIX1D close available. Full CSV fetch (~65 KB) so no incremental logic
 * needed — just overwrite on each run.
 *
 * Does NOT require the Schwab API key — CBOE's CDN is publicly accessible.
 * CRON_SECRET is still required.
 *
 * Schedule: 0 11 * * 1-5  (11:00 UTC = ~6-7 AM ET Mon–Fri)
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import { redis } from '../_lib/schwab.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';

// ── Constants ──────────────────────────────────────────────────

const CBOE_URL =
  'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX1D_History.csv';
const REDIS_KEY = 'vix1d:daily-map';
/** 8 days — refreshed every weekday morning; stale after a long weekend gap */
const REDIS_TTL = 8 * 24 * 60 * 60;

// ── Types ──────────────────────────────────────────────────────

interface Vix1dEntry {
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Vix1dDailyMap = Record<string, Vix1dEntry>;

// ── CSV parsing ────────────────────────────────────────────────

/**
 * Parse CBOE's VIX1D CSV into a date-keyed map.
 * Header row is skipped. Date column is MM/DD/YYYY → YYYY-MM-DD.
 * Rows with missing or non-numeric values are silently skipped.
 */
export function parseCboeCsv(csv: string): Vix1dDailyMap {
  const result: Vix1dDailyMap = {};
  const lines = csv.split('\n');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 5) continue;

    const [dateStr, openStr, highStr, lowStr, closeStr] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];

    // Convert MM/DD/YYYY → YYYY-MM-DD
    const dateParts = dateStr.trim().split('/');
    if (dateParts.length !== 3) continue;
    const [mm, dd, yyyy] = dateParts as [string, string, string];
    const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;

    const o = Number.parseFloat(openStr.trim());
    const h = Number.parseFloat(highStr.trim());
    const l = Number.parseFloat(lowStr.trim());
    const c = Number.parseFloat(closeStr.trim());

    if (
      Number.isNaN(o) ||
      Number.isNaN(h) ||
      Number.isNaN(l) ||
      Number.isNaN(c)
    )
      continue;

    result[iso] = { o, h, l, c };
  }

  return result;
}

// ── Handler ────────────────────────────────────────────────────

export default withCronCheckin('refresh-vix1d', async (req, res) => {
  await Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/cron/refresh-vix1d');
    Sentry.setTag('cron.job', 'refresh-vix1d');
    const done = metrics.request('/api/cron/refresh-vix1d');
    const startTime = Date.now();

    const guard = cronGuard(req, res, {
      marketHours: false,
      requireApiKey: false,
    });
    if (!guard) return;

    try {
      const response = await fetch(CBOE_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const msg = `CBOE fetch failed: HTTP ${response.status}`;
        logger.error({ status: response.status }, msg);
        Sentry.captureException(new Error(msg));
        await reportCronRun('refresh-vix1d', {
          status: 'error',
          error: msg,
          durationMs: Date.now() - startTime,
        });
        done({ status: 502 });
        return res.status(502).json({ error: msg });
      }

      const csv = await response.text();
      const dailyMap = parseCboeCsv(csv);
      const dayCount = Object.keys(dailyMap).length;

      if (dayCount === 0) {
        const msg = 'Parsed VIX1D CSV produced empty map';
        logger.error({ csv: csv.slice(0, 200) }, msg);
        Sentry.captureException(new Error(msg));
        await reportCronRun('refresh-vix1d', {
          status: 'error',
          error: msg,
          durationMs: Date.now() - startTime,
        });
        done({ status: 500 });
        return res.status(500).json({ error: msg });
      }

      await redis.set(REDIS_KEY, dailyMap, { ex: REDIS_TTL });

      logger.info(
        { dayCount, durationMs: Date.now() - startTime },
        'refresh-vix1d: stored VIX1D daily map in Redis',
      );

      // Phase 5 of the lottery inversion-quality filter
      // (docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md).
      // The per-ticker inversion refit runs manually via
      // scripts/enrich_lottery_outcomes.py. If the operator skips several
      // days, lottery_ticker_stats.updated_at goes stale and the Q1/Q2
      // filter starts working off outdated quintile assignments. Warn via
      // Sentry so the operator knows to re-run the refit. Wrapped in its
      // own try/catch so a transient DB hiccup here doesn't fail the
      // vix1d refresh that already succeeded above.
      try {
        const sql = getDb();
        const ageRows = await sql`
          SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 86400 AS days
          FROM lottery_ticker_stats
        `;
        const days = Number(ageRows[0]?.days ?? 0);
        if (days > 3) {
          Sentry.captureMessage('lottery_ticker_stats stale', {
            level: 'warning',
            extra: { ageDays: days },
          });
        }
      } catch (err) {
        Sentry.captureException(err, {
          tags: { source: 'lottery-ticker-stats-staleness-check' },
        });
      }

      await reportCronRun('refresh-vix1d', {
        status: 'ok',
        dayCount,
        durationMs: Date.now() - startTime,
      });

      done({ status: 200 });
      return res.status(200).json({
        job: 'refresh-vix1d',
        success: true,
        dayCount,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      Sentry.captureException(error);
      await reportCronRun('refresh-vix1d', {
        status: 'error',
        error: String(error),
        durationMs: Date.now() - startTime,
      });
      done({ status: 500, error: 'unhandled' });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
});
