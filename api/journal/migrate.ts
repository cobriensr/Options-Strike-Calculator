/**
 * POST /api/journal/migrate
 *
 * Runs database migrations to add new columns to existing tables.
 * Safe to call multiple times — all ALTERs use IF NOT EXISTS.
 *
 * Call this after deploying new features that add columns to
 * market_snapshots. It preserves all existing data.
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { migrateDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/journal/migrate');

  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    done({ status: 403 });
    return res.status(403).json({ error: 'Access denied' });
  }

  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) {
    done({ status: 401 });
    return ownerCheck;
  }

  try {
    const applied = await migrateDb();
    done({ status: 200 });
    return res.status(200).json({
      success: true,
      columnsAdded: applied,
      message: `Migration complete: ${applied.length} column(s) ensured`,
    });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
