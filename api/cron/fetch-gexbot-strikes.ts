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

    // Wrap each fetch so the rejection carries task context for
    // Sentry tagging — Promise.allSettled only exposes `reason`.
    const results = await Promise.all(
      tasks.map(async ({ ticker, category }) => {
        try {
          const body = await fetchStatePerStrike(apiKey, ticker, category);
          return { ok: true as const, ticker, category, body };
        } catch (err) {
          return { ok: false as const, ticker, category, err };
        }
      }),
    );

    const captures: CaptureRow[] = [];
    let failed = 0;

    for (const result of results) {
      if (!result.ok) {
        failed += 1;
        Sentry.captureException(result.err, {
          tags: {
            'gexbot.cron': 'strikes',
            'gexbot.ticker': result.ticker,
            'gexbot.endpoint': 'state',
            'gexbot.category': result.category,
          },
        });
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
  { requireApiKey: false },
);
