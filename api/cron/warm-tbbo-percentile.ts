/**
 * GET /api/cron/warm-tbbo-percentile
 *
 * Daily pre-warm for the sidecar's `/archive/tbbo-ofi-percentile`
 * endpoint. The first call of the day pays a ~10-20s cold-cache cost
 * (loading Parquet footers + hot-pathing the aggregation). The
 * Vercel-side fetcher caps at 2s, so without this warm the first
 * analyze call of the day silently returns null and Claude sees no
 * "historical rank" line.
 *
 * Schedule: 0 13 * * 1-5 (13:00 UTC weekdays, 30 min before open).
 * Runs BEFORE market hours by design — `marketHours: false`.
 *
 * Failure is non-fatal. Worst case we fall back to the Phase 4b
 * no-percentile rendering, which is the current behavior anyway.
 * We log outcome and always return 200 so Vercel's cron dashboard
 * does not flag transient sidecar hiccups as hard failures.
 *
 * Env: CRON_SECRET, SIDECAR_URL (consumed by archive-sidecar.ts).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard } from '../_lib/api-helpers.js';
import { fetchTbboOfiPercentile } from '../_lib/archive-sidecar.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    requireApiKey: false,
    marketHours: false,
  });
  if (!guard) return;

  const startTime = Date.now();

  const [esResult, nqResult] = await Promise.allSettled([
    fetchTbboOfiPercentile('ES', 0, '1h'),
    fetchTbboOfiPercentile('NQ', 0, '1h'),
  ]);

  if (esResult.status === 'rejected') {
    logger.warn(
      { err: esResult.reason },
      'warm-tbbo-percentile: ES fetch failed',
    );
    Sentry.captureException(esResult.reason);
  }
  if (nqResult.status === 'rejected') {
    logger.warn(
      { err: nqResult.reason },
      'warm-tbbo-percentile: NQ fetch failed',
    );
    Sentry.captureException(nqResult.reason);
  }

  const esOk = esResult.status === 'fulfilled' && esResult.value !== null;
  const nqOk = nqResult.status === 'fulfilled' && nqResult.value !== null;

  logger.info(
    { esOk, nqOk, durationMs: Date.now() - startTime },
    'tbbo-ofi-percentile pre-warm completed',
  );

  return res.status(200).json({
    ok: esOk || nqOk,
    es: esOk,
    nq: nqOk,
    durationMs: Date.now() - startTime,
  });
}
