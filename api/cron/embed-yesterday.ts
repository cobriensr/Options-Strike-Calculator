/**
 * GET /api/cron/embed-yesterday[?date=YYYY-MM-DD]
 *
 * Nightly cron: compute the text summary + embedding for yesterday's
 * trading day and upsert into `day_embeddings`. Keeps the analog
 * cohort fresh so today's analyze calls can compare against the most
 * recent full session.
 *
 * Manual re-embed: `GET ...?date=2026-11-18` with the CRON_SECRET bearer
 * embeds that ET date instead of the prior weekday. It exists for a day
 * the nightly run skipped (`incomplete_day` or `no_summary`) that has
 * since had its bars repaired: nothing else ever targets a past day again.
 * Triggered by hand; Vercel's scheduler sends no query. `date` must be a
 * real YYYY-MM-DD calendar date strictly BEFORE today (ET), since a day
 * is embedded once it is over. Anything else (a bad format, today, a
 * later day, a repeated param) throws before any source is read, and the
 * wrapper answers 500 `{ error }` naming the cause. The override runs
 * the same path as the nightly target: the same skips below, the same
 * Postgres summary read, VIX bucket and upsert. It cannot force a
 * partial day through. Re-running a day is safe: the upsert is
 * idempotent.
 *
 * Skips (200, `skipped: true`) rather than failing when:
 *   - the target weekday is a NYSE holiday (`not_trading_day`);
 *   - Postgres has no bars for it (`no_summary`);
 *   - the day is PARTIAL in Postgres (`incomplete_day`) — fewer
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
 *   - `index_candles_1m` (SPX) on Neon, read through
 *     `api/_lib/postgres-day-summary.ts`. The sidecar archive is frozen
 *     at 2026-04-17 and the nightly target is always a later date, so
 *     this cron makes no sidecar call. A `?date=` on or before that day
 *     reads Postgres too, and skips `no_summary` if Postgres has no bars.
 *   - OpenAI API key for text-embedding-3-large @ 2000 dims
 *   - `day_embeddings` table (migration #73) present on Neon
 *
 * Runs Tue–Sat at 07:00 UTC (Mon–Fri targets) - hours after the US
 * cash session settles, so yesterday's tape is fully committed.
 */

import { vixBucketOf } from '../_lib/analog-range-forecast.js';
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
  parseIsoDate,
} from '../../src/data/marketHours.js';

// maxDuration (60s) is set in vercel.json's `functions{}` block
// (`"api/cron/embed-yesterday.ts": { "maxDuration": 60 }`). Vercel's docs
// also show a file-level `export const config = { maxDuration }` for
// Node.js api/ functions; this file doesn't set one.

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

/** A rejected `?date=`: no day was targeted, so the payload carries no date. */
class InvalidDateParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateParamError';
  }
}

/**
 * The ET date to embed: `?date=` when given and valid, else the prior
 * weekday of `today`. Weekday-only stepping keeps the Tue–Sat schedule →
 * Mon–Fri mapping; a holiday is skipped by the handler rather than
 * re-embedding the day before.
 */
function resolveTargetDate(dateParam: unknown, today: string): string {
  if (dateParam === undefined) return priorWeekday(today);
  // Any defined non-string (e.g. a repeated ?date= array) is invalid too.
  if (typeof dateParam !== 'string' || parseIsoDate(dateParam) == null) {
    throw new InvalidDateParamError(
      'embed-yesterday: invalid date param (expected YYYY-MM-DD)',
    );
  }
  // A day is embedded once it is over, the same as the nightly run.
  if (dateParam >= today) {
    throw new InvalidDateParamError(
      `embed-yesterday: date ${dateParam} is not before today (${today})`,
    );
  }
  return dateParam;
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
    const dateParam = ctx.req?.query.date;
    const date = resolveTargetDate(dateParam, today);
    log.info(
      { date, invokedOn: today, override: dateParam !== undefined },
      'embed-yesterday start',
    );

    if (!isTradingDay(date)) {
      log.info({ date }, 'embed-yesterday: target is a market holiday');
      return skipped('not_trading_day', { date });
    }

    // The one source of the summary; kept in the run result and the log so
    // the key stays continuous with earlier runs.
    const source = 'postgres';

    // index_candles_1m (SPX) is populated by Schwab streaming in real
    // time. A DB reject propagates: the wrapper reports an error.
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
    const { summary } = pg;

    const vixBucket = vixBucketOf(await fetchVixCloseFromPostgres(date));

    const embedding = await generateEmbedding(summary);
    if (!embedding || embedding.length !== DAY_EMBEDDING_DIMS) {
      throw new EmbedYesterdayError('embed_failed', date);
    }

    // Summary format: "YYYY-MM-DD SYM | ...". The second whitespace token
    // is the symbol: SPX in the summaries `postgres-day-summary.ts`
    // builds. Defensive slice: if the format ever changes, we fall back
    // to 'SPX' so the row still persists with the symbol its bars came
    // from rather than failing the whole upsert.
    const parts = summary.split(' ');
    const symbol = parts[1] ?? 'SPX';

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
    // `?date=` is read from the request.
    passReq: true,
    // Both legacy 500 shapes are `{date, error: <kind-or-msg>}`.
    // EmbedYesterdayError sentinels carry the date + kind verbatim;
    // any other thrown error falls back to `{date, error: <msg>}`
    // using the date the run targeted (the override, else priorWeekday).
    errorPayload: (err, ctx) => {
      if (err instanceof EmbedYesterdayError) {
        return { date: err.date, error: err.kind };
      }
      const msg = err instanceof Error ? err.message : String(err);
      // A rejected override targeted no day: say why, name no date.
      if (err instanceof InvalidDateParamError) return { error: msg };
      // Any other throw came after the handler resolved its target, so
      // resolving again from the same ctx cannot throw.
      return {
        date: resolveTargetDate(ctx.req?.query.date, ctx.today),
        error: msg,
      };
    },
  },
);
