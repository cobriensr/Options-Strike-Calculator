/**
 * POST /api/snapshot
 *
 * Saves the complete calculator state as a market snapshot.
 * Owner-gated: only writes for authenticated sessions.
 * Uniqueness: one snapshot per date + entry_time.
 * Duplicate submissions are silently skipped.
 *
 * Called automatically by the frontend whenever results are computed.
 */

import { Sentry } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner, rejectIfRateLimited } from './_lib/api-helpers.js';
import { saveSnapshot } from './_lib/db.js';
import { snapshotBodySchema } from './_lib/validation.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });

  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  // Rate limit: max 30 snapshots per minute (generous for normal use)
  const rateLimited = await rejectIfRateLimited(req, res, 'snapshot', 30);
  if (rateLimited) return;

  try {
    const parsed = snapshotBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return res.status(400).json({
        error: firstError?.message ?? 'Invalid request body',
      });
    }

    const id = await saveSnapshot(parsed.data);

    return res.status(200).json({ id, saved: id != null });
  } catch (err) {
    // Don't fail the user experience or leak DB details
    Sentry.captureException(err);
    logger.error({ err }, 'Snapshot save error');
    return res.status(200).json({ id: null, saved: false });
  }
}
