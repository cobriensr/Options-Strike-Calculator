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

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  rejectIfNotOwner,
  rejectIfRateLimited,
  checkBot,
} from './_lib/api-helpers.js';
import { saveSnapshot } from './_lib/db.js';
import { snapshotBodySchema } from './_lib/validation.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/snapshot');

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

  // Rate limit: max 30 snapshots per minute (generous for normal use)
  const rateLimited = await rejectIfRateLimited(req, res, 'snapshot', 30);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const parsed = snapshotBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      done({ status: 400 });
      return res.status(400).json({
        error: firstError?.message ?? 'Invalid request body',
      });
    }

    const id = await saveSnapshot(parsed.data);

    metrics.dbSave('market_snapshots', true);
    done({ status: 200 });
    return res.status(200).json({ id, saved: id != null });
  } catch (err) {
    // Don't fail the user experience or leak DB details
    metrics.dbSave('market_snapshots', false);
    done({ status: 200 });
    Sentry.captureException(err);
    logger.error({ err }, 'Snapshot save error');
    return res.status(200).json({ id: null, saved: false });
  }
}
