/**
 * POST /api/journal/migrate
 *
 * Runs database migrations to add new columns to existing tables.
 * Safe to call multiple times — all ALTERs use IF NOT EXISTS.
 *
 * Call this after deploying new features that add columns to
 * market_snapshots. It preserves all existing data.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { migrateDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  try {
    const applied = await migrateDb();
    return res.status(200).json({
      success: true,
      columnsAdded: applied,
      message: `Migration complete: ${applied.length} column(s) ensured`,
    });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Migration failed',
    });
  }
}
