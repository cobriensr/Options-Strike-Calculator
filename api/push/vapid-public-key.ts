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
import { Sentry, metrics } from '../_lib/sentry.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';

export interface VapidPublicKeyResponse {
  publicKey: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/push/vapid-public-key');
    const done = metrics.request('/api/push/vapid-public-key');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerEndpoint(req, res, done)) return;

    try {
      const publicKey = process.env.VAPID_PUBLIC_KEY;
      if (!publicKey) {
        done({ status: 500 });
        logger.error('VAPID_PUBLIC_KEY is not configured');
        return res.status(500).json({ error: 'Push not configured' });
      }

      const response: VapidPublicKeyResponse = { publicKey };
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'vapid-public-key error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
