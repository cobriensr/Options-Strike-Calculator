/**
 * POST /api/push/subscribe
 *
 * Registers a browser push subscription (`PushSubscription.toJSON()` shape)
 * so the regime-alert cron can deliver notifications via web-push.
 *
 * Upserts on `endpoint` — each browser/device has a single globally-unique
 * push-service URL, so re-subscribing refreshes the row rather than
 * creating duplicates.
 *
 * Enforces MAX_SUBSCRIPTIONS_PER_USER (5): before insert, if the table
 * already holds the cap's worth of rows, the oldest row is deleted.
 * Single-owner app → "per user" is effectively "per device across all the
 * owner's devices"; five covers laptop + phone + tablet + two spares.
 * Owner-gated + botid-protected. No cache headers (mutating endpoint).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry } from '../_lib/sentry.js';
import { checkBot, rejectIfNotOwner } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { PushSubscribeBodySchema } from '../_lib/validation.js';

const MAX_SUBSCRIPTIONS_PER_USER = 5;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/push/subscribe');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwner(req, res)) return;

    const parsed = PushSubscribeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const { endpoint, keys } = parsed.data;
    // Device tag comes from the trusted request header, not the body —
    // prevents a compromised client from spoofing device identity.
    const rawUa = req.headers['user-agent'];
    const userAgent =
      typeof rawUa === 'string' && rawUa.length > 0
        ? rawUa.slice(0, 500)
        : null;

    try {
      const sql = getDb();

      // ── 1. Enforce device cap ─────────────────────────────────
      // If the new endpoint is already present this is a no-op refresh
      // (the upsert below will just bump last_delivered_at by way of
      // created_at on re-insert). Only trim when the endpoint is NEW
      // and the table is at or above the cap.
      const existing = (await sql`
        SELECT 1 FROM push_subscriptions WHERE endpoint = ${endpoint}
      `) as Array<Record<string, unknown>>;

      if (existing.length === 0) {
        const countRows = (await sql`
          SELECT COUNT(*)::int AS count FROM push_subscriptions
        `) as Array<{ count: number }>;
        const current = countRows[0]?.count ?? 0;
        if (current >= MAX_SUBSCRIPTIONS_PER_USER) {
          // Delete the single oldest row(s) until a slot is open.
          // Usually this is exactly 1, but a race or earlier bug could
          // have left the table above the cap; loop semantics via LIMIT
          // keep the query bounded and parametrized.
          const toRemove = current - MAX_SUBSCRIPTIONS_PER_USER + 1;
          await sql`
            DELETE FROM push_subscriptions
            WHERE endpoint IN (
              SELECT endpoint FROM push_subscriptions
              ORDER BY created_at ASC
              LIMIT ${toRemove}
            )
          `;
        }
      }

      // ── 2. Upsert the subscription ────────────────────────────
      await sql`
        INSERT INTO push_subscriptions (
          endpoint, p256dh, auth, user_agent, failure_count, created_at
        ) VALUES (
          ${endpoint}, ${keys.p256dh}, ${keys.auth},
          ${userAgent}, 0, now()
        )
        ON CONFLICT (endpoint) DO UPDATE SET
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent,
          failure_count = 0
      `;

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'push/subscribe error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
