/**
 * POST /api/tracker/alerts/:id/ack
 *
 * Marks one tracker_alerts row as acknowledged. Idempotent — acking an
 * already-acknowledged alert returns 200. Owner-or-guest gated.
 *
 * Used by both the toast click handler (frontend marks the toast as
 * read) and the dismiss-all batch button. Single PATCH per id avoids
 * over-fetching the unread list.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { guardOwnerOrGuestEndpoint } from '../../../_lib/api-helpers.js';
import { getDb } from '../../../_lib/db.js';
import logger from '../../../_lib/logger.js';
import { Sentry, metrics } from '../../../_lib/sentry.js';
import { trackerIdParamSchema } from '../../../_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/tracker/alerts/[id]/ack');
    const done = metrics.request('/api/tracker/alerts/[id]/ack');

    if (req.method !== 'POST') {
      done({ status: 405 });
      return res.status(405).json({ error: 'POST only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const idParsed = trackerIdParamSchema.safeParse(req.query);
    if (!idParsed.success) {
      done({ status: 400 });
      return res.status(400).json({
        error: idParsed.error.issues[0]?.message ?? 'Invalid id',
      });
    }
    const { id } = idParsed.data;

    try {
      const sql = getDb();
      const rows = await sql`
        UPDATE tracker_alerts
        SET acknowledged = TRUE
        WHERE id = ${id}
        RETURNING id, acknowledged
      `;
      if (rows.length === 0) {
        done({ status: 404 });
        return res.status(404).json({ error: 'Alert not found' });
      }
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ acknowledged: id });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err, id }, 'tracker-alerts ack error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
