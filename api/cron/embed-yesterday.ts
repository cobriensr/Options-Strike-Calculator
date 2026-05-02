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
 * Runs daily at 07:00 UTC - that's 2-3 hours after the US cash
 * session settles, so yesterday's futures tape is fully committed to
 * the archive + sidecar is quiet.
 */

import { fetchDaySummary } from '../_lib/archive-sidecar.js';
import {
  DAY_EMBEDDING_DIMS,
  upsertDayEmbedding,
} from '../_lib/day-embeddings.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import { fetchDaySummaryFromPostgres } from '../_lib/postgres-day-summary.js';
import { metrics } from '../_lib/sentry.js';

export const config = { maxDuration: 60 };

/** Return YYYY-MM-DD for the most recent previous weekday relative to `today`. */
function priorTradingDay(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

// Sentinel errors so the wrapper's errorPayload can preserve the
// pre-wrapper response shapes verbatim. The body shape was a stable
// downstream contract (Vercel cron dashboard + Sentry alerts both keyed
// on the `error` field), so the wrapper preserves them rather than
// migrating to `{job, error: 'Internal error'}`.

class EmbedYesterdayError extends Error {
  constructor(
    public readonly kind: 'embed_failed' | 'upsert_failed',
    public readonly date: string,
  ) {
    super(kind);
    this.name = 'EmbedYesterdayError';
  }
}

export default withCronInstrumentation(
  'embed-yesterday',
  async (ctx): Promise<CronResult> => {
    const { today, logger: log } = ctx;
    const date = priorTradingDay(today);
    log.info({ date, invokedOn: today }, 'embed-yesterday start');

    let summary = await fetchDaySummary(date);
    let source: 'sidecar' | 'postgres' = 'sidecar';
    if (!summary) {
      // Sidecar archive doesn't have this date - usually because the
      // parquet archive lags the streaming feed by a few days (parquet
      // gets refreshed manually after a fresh Databento batch is
      // converted and uploaded). Try the Postgres-fed fallback before
      // giving up: spx_candles_1m is populated by Schwab streaming in
      // real-time, so most "missing in sidecar" dates are present here.
      summary = await fetchDaySummaryFromPostgres(date);
      if (!summary) {
        // True empty: holiday, weekend (already filtered above), or
        // streaming feed didn't run that day. Recorded as skipped, not
        // a failure - shouldn't page anyone.
        log.info({ date }, 'embed-yesterday: no summary for date');
        metrics.increment('embed_yesterday.no_summary');
        return {
          status: 'skipped',
          message: 'no_summary',
          metadata: { date, skipped: true, reason: 'no_summary' },
        };
      }
      source = 'postgres';
      metrics.increment('embed_yesterday.postgres_fallback');
      log.info({ date }, 'embed-yesterday: using Postgres fallback');
    }

    const embedding = await generateEmbedding(summary);
    if (!embedding || embedding.length !== DAY_EMBEDDING_DIMS) {
      throw new EmbedYesterdayError('embed_failed', date);
    }

    // Summary format: "YYYY-MM-DD SYM | ...". Second whitespace token is
    // the front-month symbol. Defensive slice: if the format ever
    // changes, we fall back to 'ES' so the row still persists with a
    // sane symbol rather than failing the whole upsert.
    const parts = summary.split(' ');
    const symbol = parts[1] ?? 'ES';

    const ok = await upsertDayEmbedding({ date, symbol, summary, embedding });
    if (!ok) {
      throw new EmbedYesterdayError('upsert_failed', date);
    }

    metrics.increment('embed_yesterday.success');
    log.info(
      { date, symbol, source, elapsed: Date.now() - ctx.startTimeMs },
      'embed-yesterday complete',
    );
    return {
      status: 'success',
      metadata: {
        date,
        symbol,
        source,
        // `elapsed` was the pre-wrapper response field name; the wrapper
        // emits its own `durationMs` for observability parity, but
        // existing dashboards reading the old key keep working.
        elapsed: Date.now() - ctx.startTimeMs,
      },
    };
  },
  {
    marketHours: false,
    requireApiKey: false,
    // Both legacy 500 shapes are `{date, error: <kind-or-msg>}`.
    // EmbedYesterdayError sentinels carry the date + kind verbatim;
    // any other thrown error falls back to `{date, error: <msg>}`
    // using the priorTradingDay-derived date (best-effort: priorTradingDay
    // may itself have not been called yet, in which case the date key
    // is the wrapper's start-of-day - acceptable since this code only
    // runs at 07:00 UTC, well after the date rolls).
    errorPayload: (err, ctx) => {
      const date = priorTradingDay(ctx.today);
      if (err instanceof EmbedYesterdayError) {
        return { date: err.date, error: err.kind };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { date, error: msg };
    },
  },
);
