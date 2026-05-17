/**
 * GET /api/tracker/alerts/unread
 *
 * Returns all tracker_alerts rows with acknowledged=false, joined to
 * the parent tracker_contracts row so the frontend toast renderer has
 * ticker/strike/expiry context without a follow-up fetch.
 *
 * Polled every 30s by `useTrackerAlerts` while the app is open — toasts
 * only fire while the tab is foregrounded. Single-tenant (every valid
 * cookie sees the same alert set).
 *
 * Owner-or-guest gated. Cache-Control: no-store to keep the polling
 * surface real-time.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { guardOwnerOrGuestEndpoint } from '../../_lib/api-helpers.js';
import { getDb } from '../../_lib/db.js';
import logger from '../../_lib/logger.js';
import { Sentry, metrics } from '../../_lib/sentry.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/tracker/alerts/unread');
    const done = metrics.request('/api/tracker/alerts/unread');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    try {
      const sql = getDb();
      const rows = await sql`
        SELECT
          a.id              AS id,
          a.contract_id     AS contract_id,
          a.fired_at        AS fired_at,
          a.alert_type      AS alert_type,
          a.threshold       AS threshold,
          a.price_at_fire   AS price_at_fire,
          a.underlying_at_fire AS underlying_at_fire,
          a.acknowledged    AS acknowledged,
          c.occ_symbol      AS occ_symbol,
          c.ticker          AS ticker,
          c.expiry          AS expiry,
          c.strike          AS strike,
          c.side            AS side,
          c.direction       AS direction,
          c.entry_price     AS entry_price,
          c.quantity        AS quantity,
          c.status          AS contract_status
        FROM tracker_alerts a
        INNER JOIN tracker_contracts c ON c.id = a.contract_id
        WHERE a.acknowledged = FALSE
        ORDER BY a.fired_at DESC, a.id DESC
      `;
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ alerts: rows, count: rows.length });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'tracker-alerts unread fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
