/**
 * POST /api/journal/init
 *
 * One-time endpoint to create all database tables:
 *   - market_snapshots (calculator state at each date+time)
 *   - analyses (Claude chart analysis responses)
 *   - outcomes (end-of-day settlement data)
 *
 * Call once after setting up the Neon database.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { initDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  try {
    await initDb();
    return res.status(200).json({
      success: true,
      tables: ['market_snapshots', 'analyses', 'outcomes'],
      message: 'All tables created successfully',
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to init database',
    });
  }
}
