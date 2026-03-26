/**
 * GET /api/vix-ohlc?date=YYYY-MM-DD
 *
 * Returns VIX OHLC derived from market_snapshots for a given date.
 * open  = VIX at earliest snapshot
 * close = VIX at latest snapshot
 * high  = MAX(vix) across all snapshots
 * low   = MIN(vix) across all snapshots
 * count = number of snapshots used
 *
 * Returns { open: null, high: null, low: null, close: null, count: 0 }
 * when no snapshots exist for the date.
 *
 * Public endpoint — no owner check. VIX data is not sensitive.
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkBot } from './_lib/api-helpers.js';
import { getVixOhlcFromSnapshots } from './_lib/db.js';

const EMPTY = { open: null, high: null, low: null, close: null, count: 0 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/vix-ohlc');
    const done = metrics.request('/api/vix-ohlc');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      done({ status: 403 });
      return res.status(403).json({ error: 'Access denied' });
    }

    const dateParam =
      typeof req.query?.date === 'string' ? req.query.date : '';
    if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      done({ status: 400 });
      return res.status(400).json({
        error: 'Missing or invalid date parameter. Use ?date=YYYY-MM-DD',
      });
    }

    try {
      const result = await getVixOhlcFromSnapshots(dateParam);
      done({ status: 200 });
      return res.status(200).json(result ?? EMPTY);
    } catch (err) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
