/**
 * POST /api/journal/init
 *
 * One-time endpoint to create all database tables:
 *   - market_snapshots (calculator state at each date+time)
 *   - analyses (Claude chart analysis responses)
 *   - outcomes (end-of-day settlement data)
 *   - positions (live Schwab SPX 0DTE positions)
 *
 * Call once after setting up the Neon database.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import { initDb, migrateDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/journal/init');

  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  try {
    await initDb();
    const migrated = await migrateDb();
    done({ status: 200 });
    return res.status(200).json({
      success: true,
      tables: ['market_snapshots', 'analyses', 'outcomes'],
      migrated,
      message: 'All tables created and migrations applied',
    });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
