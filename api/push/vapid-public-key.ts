/**
 * GET /api/push/vapid-public-key
 *
 * Returns the VAPID public key so the browser can call
 * `registration.pushManager.subscribe({ applicationServerKey })`.
 *
 * The VAPID public key is intentionally public — it identifies this
 * server to the push service and is what `applicationServerKey` expects.
 * The corresponding private key lives only in server env and is never
 * sent over the wire. Owner-gated + botid-protected anyway to keep the
 * endpoint scoped to the single-owner app surface.
 *
 * No edge caching — the owner gate must fire on every request. A
 * cached response would be served past the cookie check for up to the
 * TTL, and while the key itself is public, bypassing the owner gate
 * isn't. The frontend fetches this once per subscription flow, so the
 * cost of no-cache is negligible.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry } from '../_lib/sentry.js';
import { checkBot, rejectIfNotOwner } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';

export interface VapidPublicKeyResponse {
  publicKey: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/push/vapid-public-key');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwner(req, res)) return;

    try {
      const publicKey = process.env.VAPID_PUBLIC_KEY;
      if (!publicKey) {
        logger.error('VAPID_PUBLIC_KEY is not configured');
        return res.status(500).json({ error: 'Push not configured' });
      }

      const response: VapidPublicKeyResponse = { publicKey };
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(response);
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'vapid-public-key error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
