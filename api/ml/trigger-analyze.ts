import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkBot, rejectIfNotOwner } from '../_lib/api-helpers.js';
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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (rejectIfNotOwner(req, res)) return;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
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

  res.status(202).json({ message: 'Analysis started' });
}
