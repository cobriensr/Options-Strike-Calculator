/**
 * GET /api/cron/fetch-gexbot-strikes
 *
 * Heavy half of the GEXBot Orderflow-tier capture pipeline. Polls the
 * per-strike state endpoints once per minute:
 *
 *   - 16 tickers × 8 state categories ({gamma,delta,vanna,charm}_{zero,one})
 *     = 128 HTTP calls → gexbot_api_capture
 *
 * Each response carries ~150 strikes with per-strike Greek values, so
 * the raw JSONB payload is ~20–30 KB per row. Daily volume at steady
 * state: 128 rows/min × 392 live minutes ≈ 50k rows / ~1–1.5 GB before
 * retention. The archive-gexbot cron snapshots to Parquet on Vercel
 * Blob and cleanup-gexbot trims to a 2-day live window.
 *
 * Separated from fetch-gexbot-fast so a single GEXBot slowdown doesn't
 * push the whole capture surface over the Hobby-plan 10-second cron
 * timeout. maxDuration is 60 s (config below) — fits easily.
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 *
 * Environment: GEXBOT_API_KEY, CRON_SECRET
 */

import { isGexbotLiveCt } from '../_lib/cron-helpers.js';
import { mapWithConcurrency, withRetry } from '../_lib/uw-fetch.js';
import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  classifyGexbotError,
  fetchStatePerStrike,
  GEXBOT_TICKERS,
  STATE_CATEGORIES,
  type GexbotTicker,
  type StateCategory,
} from '../_lib/gexbot-client.js';
import { insertCaptureRows, type CaptureRow } from '../_lib/gexbot-store.js';
import { Sentry } from '../_lib/sentry.js';

// ── Handler ─────────────────────────────────────────────────

export const config = { maxDuration: 60 };

/**
 * Concurrency cap for the 128-way fetch fan-out. Matches the
 * fetch-gexbot-fast cap (32) — before the cap, a single slow GEXBot
 * minute produced 128 simultaneous TimeoutErrors (SENTRY-EMERALD-
 * DESERT-8F, 144 events; SENTRY-EMERALD-DESERT-76, 19 events).
 */
const FETCH_CONCURRENCY = 32;

/**
 * Max Sentry events per tick. Beyond this we emit one summary
 * captureMessage and drop the remaining stack traces — keeps
 * triage signal during a GEXBot outage. Mirrors fetch-gexbot-fast.
 */
const SENTRY_CAPTURE_CAP = 10;

export default withCronInstrumentation(
  'fetch-gexbot-strikes',
  async (ctx): Promise<CronResult> => {
    const apiKey = process.env.GEXBOT_API_KEY;
    if (!apiKey) {
      throw new Error('GEXBOT_API_KEY is not configured');
    }

    // 16 × 8 = 128 (ticker, category) pairs
    const tasks: Array<{ ticker: GexbotTicker; category: StateCategory }> =
      GEXBOT_TICKERS.flatMap((ticker) =>
        STATE_CATEGORIES.map((category) => ({ ticker, category })),
      );

    // Concurrency-capped (FETCH_CONCURRENCY) to avoid a 128-way burst
    // on every cron tick. Wrap each fetch so the rejection carries
    // task context for Sentry tagging.
    const results = await mapWithConcurrency(
      tasks,
      FETCH_CONCURRENCY,
      async ({ ticker, category }) => {
        try {
          // Retry transient 5xx / timeout / ECONNRESET up to 2 times
          // (3 attempts total, 1s + 2s exponential backoff). Mirrors
          // the fetch-gexbot-fast wrap that suppressed SENTRY-EMERALD-
          // DESERT-8F. Every 4xx (bad auth, incl. 429 quota) still fails
          // fast.
          const body = await withRetry(() =>
            fetchStatePerStrike(apiKey, ticker, category),
          );
          return { ok: true as const, ticker, category, body };
        } catch (err) {
          return { ok: false as const, ticker, category, err };
        }
      },
    );

    const captures: CaptureRow[] = [];
    let failed = 0;
    let sentryCaptured = 0;

    for (const result of results) {
      if (!result.ok) {
        failed += 1;
        if (sentryCaptured < SENTRY_CAPTURE_CAP) {
          // Stable grouping: one issue per (cron, status class). Without it
          // Sentry split the same TimeoutError into two issues (8F by
          // message, 76 by internal timer frames), and keying on err.name
          // alone put 401/403/429/5xx in one issue.
          const { statusClass, statusTag } = classifyGexbotError(result.err);
          Sentry.captureException(result.err, {
            fingerprint: [
              'gexbot-fetch-failure',
              'fetch-gexbot-strikes',
              statusClass,
            ],
            tags: {
              'gexbot.status': statusTag,
              'gexbot.cron': 'strikes',
              'gexbot.ticker': result.ticker,
              'gexbot.endpoint': 'state',
              'gexbot.category': result.category,
            },
          });
          sentryCaptured += 1;
        }
        continue;
      }
      const { ticker, category, body } = result;
      const sourceTs =
        typeof body.timestamp === 'number' && Number.isInteger(body.timestamp)
          ? body.timestamp
          : null;
      captures.push({
        ticker,
        endpoint: 'state',
        category,
        sourceTimestamp: sourceTs,
        rawJson: JSON.stringify(body),
      });
    }

    if (failed > SENTRY_CAPTURE_CAP) {
      Sentry.captureMessage(
        `fetch-gexbot-strikes: ${failed - SENTRY_CAPTURE_CAP} additional failures suppressed (cap=${SENTRY_CAPTURE_CAP})`,
        {
          level: 'warning',
          // The message embeds a varying count; pin one issue per cron.
          fingerprint: ['gexbot-failures-suppressed', 'fetch-gexbot-strikes'],
          tags: {
            'gexbot.cron': 'strikes',
            'gexbot.summary': 'true',
          },
        },
      );
    }

    await insertCaptureRows(captures);

    ctx.logger.info(
      { stored: captures.length, failed },
      'fetch-gexbot-strikes completed',
    );

    return {
      status: deriveCronStatus(failed, tasks.length),
      rows: captures.length,
      metadata: { captures: captures.length, failed },
    };
  },
  // Gate to the GexBot live window (09:30 ET → cash close + 1 min), same
  // as the sibling fetch-gexbot-fast. GexBot freezes at the close, so
  // post-close ticks only re-fetch a duplicate snapshot (and were the
  // source of 99.8% of GexBot TimeoutErrors).
  { requireApiKey: false, timeCheck: isGexbotLiveCt },
);
