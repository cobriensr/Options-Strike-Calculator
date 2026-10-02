/**
 * GET /api/cron/embed-yesterday
 *
 * Nightly cron: compute the text summary + embedding for yesterday's
 * trading day and upsert into `day_embeddings`. Keeps the analog
 * cohort fresh so today's analyze calls can compare against the most
 * recent full session.
 *
 * Skips (200, `skipped: true`) rather than failing when:
 *   - the target weekday is a NYSE holiday (`not_trading_day`);
 *   - neither source has bars for it (`no_summary`);
 *   - the Postgres source is a PARTIAL day (`incomplete_day`) — fewer
 *     regular-session bars than the session has (390, or 210 on an
 *     early close). A feed that died mid-session must never land as a
 *     complete day (it did on 2026-07-22 with 82 bars and 2026-09-21
 *     with 169).
 * The last two mean the feed failed on a trading day — a hole in the
 * corpus — so they are surfaced as warnings (log + metric + Sentry
 * warning); the 07-23 → 09-07 SPX outage went unseen for six weeks
 * behind an info-level skip. A DB reject while reading is an error.
 *
 * The row's `vix_bucket` comes from the day's VIX close in `outcomes`,
 * bucketed with the same cut-points the range forecast queries by.
 *
 * Depends on:
 *   - Railway sidecar `/archive/day-summary` reachable via SIDECAR_URL
 *     (frozen at 2026-04-17; new dates fall through to Postgres)
 *   - OpenAI API key for text-embedding-3-large @ 2000 dims
 *   - `day_embeddings` table (migration #73) present on Neon
 *
 * Runs Tue–Sat at 07:00 UTC (Mon–Fri targets) - hours after the US
 * cash session settles, so yesterday's tape is fully committed.
 */

import { vixBucketOf } from '../_lib/analog-range-forecast.js';
import { fetchDaySummary } from '../_lib/archive-sidecar.js';
import {
  DAY_EMBEDDING_DIMS,
  upsertDayEmbedding,
} from '../_lib/day-embeddings.js';
import {
  withCronInstrumentation,
  type CronContext,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import {
  fetchDaySummaryFromPostgres,
  fetchVixCloseFromPostgres,
} from '../_lib/postgres-day-summary.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  cashSessionMinutes,
  isTradingDay,
} from '../../src/data/marketHours.js';

// maxDuration is set authoritatively in vercel.json's `functions{}` block
// (`"api/cron/embed-yesterday.ts": { "maxDuration": 60 }`). Raw Vercel
// Functions (non-Next.js) do not honor a module-level `export const config`.

/** Return YYYY-MM-DD for the most recent previous weekday relative to `today`. */
function priorWeekday(today: string): string {
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

type SkipReason = 'not_trading_day' | 'no_summary' | 'incomplete_day';

function skipped(
  reason: SkipReason,
  metadata: Record<string, unknown>,
): CronResult {
  metrics.increment(`embed_yesterday.${reason}`);
  return {
    status: 'skipped',
    message: reason,
    metadata: { ...metadata, skipped: true, reason },
  };
}

/** A trading day the SPX feed failed on: skip it, loudly. */
function feedFailureSkip(
  log: CronContext['logger'],
  reason: Extract<SkipReason, 'no_summary' | 'incomplete_day'>,
  detail: { date: string; barCount: number; expectedBars: number },
): CronResult {
  log.warn(detail, `embed-yesterday: ${reason}, not embedding`);
  Sentry.captureMessage(`embed-yesterday: ${reason}, day not embedded`, {
    level: 'warning',
    extra: detail,
  });
  return skipped(reason, detail);
}

export default withCronInstrumentation(
  'embed-yesterday',
  async (ctx): Promise<CronResult> => {
    const { today, logger: log } = ctx;
    // Weekday-only stepping keeps the Tue–Sat schedule → Mon–Fri mapping;
    // a holiday is skipped below rather than re-embedding the day before.
    const date = priorWeekday(today);
    log.info({ date, invokedOn: today }, 'embed-yesterday start');

    if (!isTradingDay(date)) {
      log.info({ date }, 'embed-yesterday: target is a market holiday');
      return skipped('not_trading_day', { date });
    }

    let summary = await fetchDaySummary(date);
    let source: 'sidecar' | 'postgres' = 'sidecar';
    if (!summary) {
      // The sidecar archive is frozen at 2026-04-17, so new dates land
      // here. index_candles_1m (SPX) is populated by Schwab streaming in
      // real time. A DB reject propagates: the wrapper reports an error.
      const pg = await fetchDaySummaryFromPostgres(date);
      const expectedBars = cashSessionMinutes(date);
      if (!pg) {
        return feedFailureSkip(log, 'no_summary', {
          date,
          barCount: 0,
          expectedBars,
        });
      }
      if (pg.barCount < expectedBars) {
        return feedFailureSkip(log, 'incomplete_day', {
          date,
          barCount: pg.barCount,
          expectedBars,
        });
      }
      summary = pg.summary;
      source = 'postgres';
      metrics.increment('embed_yesterday.postgres_fallback');
      log.info({ date }, 'embed-yesterday: using Postgres fallback');
    }

    const vixBucket = vixBucketOf(await fetchVixCloseFromPostgres(date));

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

    const ok = await upsertDayEmbedding({
      date,
      symbol,
      summary,
      embedding,
      vixBucket,
    });
    if (!ok) {
      throw new EmbedYesterdayError('upsert_failed', date);
    }

    metrics.increment('embed_yesterday.success');
    log.info(
      {
        date,
        symbol,
        source,
        vixBucket,
        elapsed: Date.now() - ctx.startTimeMs,
      },
      'embed-yesterday complete',
    );
    return {
      status: 'success',
      metadata: {
        date,
        symbol,
        source,
        vixBucket,
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
    // using the priorWeekday-derived date.
    errorPayload: (err, ctx) => {
      const date = priorWeekday(ctx.today);
      if (err instanceof EmbedYesterdayError) {
        return { date: err.date, error: err.kind };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { date, error: msg };
    },
  },
);
