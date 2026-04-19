/**
 * GET /api/cron/refresh-current-snapshot
 *
 * Every 5 min during market hours, pulls today's summary + feature
 * vector from the Railway sidecar's DuckDB-backed archive endpoints
 * and upserts them into `current_day_snapshot`. The analyze endpoint
 * reads from this table instead of calling the sidecar on the hot
 * path, so analyze latency is Neon-only (5-15 ms) rather than sidecar
 * DuckDB cold-scan (500-5000 ms).
 *
 * Gates:
 *   - `cronGuard` with `marketHours: true` — this is the purpose of
 *     the snapshot, and outside market hours the embed-yesterday cron
 *     already produces a stable snapshot via `day_embeddings`.
 *   - `SIDECAR_URL` must be set; absence logs and exits cleanly.
 *
 * No-ops without error when either archive endpoint returns null
 * (market holiday, archive missing the date, sidecar down). The old
 * snapshot remains — analyze reads it and falls back to null if it
 * goes past the 30-minute freshness window.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard } from '../_lib/api-helpers.js';
import { fetchDayFeatures, fetchDaySummary } from '../_lib/archive-sidecar.js';
import { upsertCurrentSnapshot } from '../_lib/current-snapshot.js';
import logger from '../_lib/logger.js';
import { metrics, Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: true,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;

  const startTime = Date.now();
  try {
    const [summary, features] = await Promise.all([
      fetchDaySummary(today),
      fetchDayFeatures(today),
    ]);

    if (!summary || !features) {
      // Either source unavailable — skip cleanly. The cron fires every
      // 5 min so the next one will likely succeed.
      logger.info(
        { today, haveSummary: !!summary, haveFeatures: !!features },
        'refresh-current-snapshot: sidecar returned partial data, skipping',
      );
      metrics.increment('refresh_current_snapshot.skipped');
      return res.status(200).json({ skipped: true, reason: 'partial_data' });
    }

    // Front-month symbol is the second whitespace token of the canonical
    // summary: "YYYY-MM-DD SYM | ...". Defensive slice same as the
    // embed-yesterday cron.
    const parts = summary.split(' ');
    const symbol = parts[1] ?? 'ES';

    const ok = await upsertCurrentSnapshot({
      date: today,
      symbol,
      summary,
      features,
    });
    if (!ok) {
      return res.status(500).json({ error: 'upsert_failed' });
    }

    const elapsed = Date.now() - startTime;
    metrics.increment('refresh_current_snapshot.success');
    logger.info(
      { today, symbol, elapsed },
      'refresh-current-snapshot complete',
    );
    return res.status(200).json({ date: today, symbol, elapsed });
  } catch (err) {
    Sentry.setTag('cron.job', 'refresh-current-snapshot');
    Sentry.captureException(err);
    logger.error({ err }, 'refresh-current-snapshot failed');
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
