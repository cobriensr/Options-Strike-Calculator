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
 * state: ~1.35M rows / ~30 GB before retention. The archive-gexbot
 * cron snapshots to Parquet on Vercel Blob and cleanup-gexbot trims
 * to a 2-day live window.
 *
 * Separated from fetch-gexbot-fast so a single GEXBot slowdown doesn't
 * push the whole capture surface over the Hobby-plan 10-second cron
 * timeout. Production maxDuration is 300s — fits easily.
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 *
 * Environment: GEXBOT_API_KEY, CRON_SECRET
 */

import { isFuturesRthCt } from '../_lib/cron-helpers.js';
import { mapWithConcurrency, withRetry } from '../_lib/uw-fetch.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
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
          // DESERT-8F. 4xx (bad auth) still fails fast.
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
          Sentry.captureException(result.err, {
            tags: {
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
      status: failed === 0 ? 'success' : 'partial',
      rows: captures.length,
      metadata: { captures: captures.length, failed },
    };
  },
  // Gate to futures-tied RTH (08:30–15:55 CT) — keeps capture aligned
  // with the sibling fetch-gexbot-fast (which uses the same gate) so
  // per-strike rows continue to land alongside the orderflow scalars
  // through the futures settlement window past equity close.
  { requireApiKey: false, timeCheck: isFuturesRthCt },
);
