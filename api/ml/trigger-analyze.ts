import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import { metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

/**
 * POST /api/ml/trigger-analyze
 *
 * Fires the analyze-plots pipeline from the UI without exposing CRON_SECRET
 * to the browser. Bot-protected; owner-only in production.
 *
 * Returns 202 immediately — analyze-plots runs independently (780s budget).
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const done = metrics.request('/api/ml/trigger-analyze');

  if (req.method !== 'POST') {
    done({ status: 405 });
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    done({ status: 500 });
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const host = process.env.VERCEL_URL ?? 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  const analyzeUrl = `${protocol}://${host}/api/ml/analyze-plots`;

  // Fire and forget — analyze-plots has its own 780s timeout and runs
  // as an independent Vercel function invocation.
  fetch(analyzeUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  }).catch((err: unknown) => {
    logger.error({ err }, 'trigger-analyze: background call failed');
  });

  done({ status: 202 });
  res.status(202).json({ message: 'Analysis started' });
}
