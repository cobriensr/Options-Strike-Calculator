/**
 * GET /api/cron/embed-yesterday
 *
 * Nightly cron: compute the text summary + embedding for yesterday's
 * trading day and upsert into `day_embeddings`. Keeps the analog
 * cohort fresh so today's analyze calls can compare against the most
 * recent full session.
 *
 * Skips weekends. A weekend invocation is a no-op (returns 200 with
 * skipped:true) rather than an error.
 *
 * Depends on:
 *   - Railway sidecar `/archive/day-summary` reachable via SIDECAR_URL
 *   - OpenAI API key for text-embedding-3-large @ 2000 dims
 *   - `day_embeddings` table (migration #73) present on Neon
 *
 * Runs daily at 07:00 UTC — that's 2-3 hours after the US cash
 * session settles, so yesterday's futures tape is fully committed to
 * the archive + sidecar is quiet.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard } from '../_lib/api-helpers.js';
import { fetchDaySummary } from '../_lib/archive-sidecar.js';
import {
  DAY_EMBEDDING_DIMS,
  upsertDayEmbedding,
} from '../_lib/day-embeddings.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import logger from '../_lib/logger.js';
import { fetchDaySummaryFromPostgres } from '../_lib/postgres-day-summary.js';
import { metrics, Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 60 };

/** Return YYYY-MM-DD for the most recent previous weekday relative to `today`. */
function priorTradingDay(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;

  const date = priorTradingDay(today);
  const startTime = Date.now();
  logger.info({ date, invokedOn: today }, 'embed-yesterday start');

  try {
    let summary = await fetchDaySummary(date);
    let source: 'sidecar' | 'postgres' = 'sidecar';
    if (!summary) {
      // Sidecar archive doesn't have this date — usually because the
      // parquet archive lags the streaming feed by a few days (parquet
      // gets refreshed manually after a fresh Databento batch is
      // converted and uploaded). Try the Postgres-fed fallback before
      // giving up: spx_candles_1m is populated by Schwab streaming in
      // real-time, so most "missing in sidecar" dates are present here.
      summary = await fetchDaySummaryFromPostgres(date);
      if (!summary) {
        // True empty: holiday, weekend (already filtered above), or
        // streaming feed didn't run that day. Recorded as skipped, not
        // a failure — shouldn't page anyone.
        logger.info({ date }, 'embed-yesterday: no summary for date');
        metrics.increment('embed_yesterday.no_summary');
        return res
          .status(200)
          .json({ date, skipped: true, reason: 'no_summary' });
      }
      source = 'postgres';
      metrics.increment('embed_yesterday.postgres_fallback');
      logger.info({ date }, 'embed-yesterday: using Postgres fallback');
    }

    const embedding = await generateEmbedding(summary);
    if (!embedding || embedding.length !== DAY_EMBEDDING_DIMS) {
      Sentry.setTag('cron.job', 'embed-yesterday');
      Sentry.captureMessage(
        `embed-yesterday: embedding call returned unexpected shape for ${date}`,
      );
      return res.status(500).json({ date, error: 'embed_failed' });
    }

    // Summary format: "YYYY-MM-DD SYM | ...". Second whitespace token is
    // the front-month symbol. Defensive slice: if the format ever
    // changes, we fall back to 'ES' so the row still persists with a
    // sane symbol rather than failing the whole upsert.
    const parts = summary.split(' ');
    const symbol = parts[1] ?? 'ES';

    const ok = await upsertDayEmbedding({ date, symbol, summary, embedding });
    if (!ok) {
      return res.status(500).json({ date, error: 'upsert_failed' });
    }

    const elapsed = Date.now() - startTime;
    metrics.increment('embed_yesterday.success');
    logger.info({ date, symbol, source, elapsed }, 'embed-yesterday complete');
    return res.status(200).json({ date, symbol, source, elapsed });
  } catch (err) {
    Sentry.setTag('cron.job', 'embed-yesterday');
    Sentry.captureException(err);
    logger.error({ err, date }, 'embed-yesterday failed');
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ date, error: msg });
  }
}
