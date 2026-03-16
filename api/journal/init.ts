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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { initDb, migrateDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  try {
    await initDb();
    const migrated = await migrateDb();
    return res.status(200).json({
      success: true,
      tables: ['market_snapshots', 'analyses', 'outcomes', 'positions'],
      migrated,
      message: 'All tables created and migrations applied',
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to init database',
    });
  }
}
