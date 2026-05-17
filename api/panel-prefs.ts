/**
 * GET  /api/panel-prefs  → { hiddenPanels: string[] }
 * PUT  /api/panel-prefs  body { hiddenPanels: string[] } → { hiddenPanels }
 *
 * Per-identity show/hide preferences for the home-page panels.
 * Identity is `'owner'` for the cookie session, or sha256(guest_key) for
 * a guest. Storing the hash means a leak of panel_prefs reveals no live
 * guest credential — see spec docs/superpowers/specs/panel-prefs-2026-05-17.md.
 *
 * Returns empty array when no row exists (first read for an identity).
 */
import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import {
  isOwner,
  parseCookies,
  rejectIfRateLimited,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { GUEST_COOKIE, guardOwnerOrGuestEndpoint } from './_lib/guest-auth.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { panelPrefsBodySchema } from './_lib/validation.js';

function resolveIdentity(req: VercelRequest): string {
  if (isOwner(req)) return 'owner';
  const key = parseCookies(req)[GUEST_COOKIE] ?? '';
  return crypto.createHash('sha256').update(key).digest('hex');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/panel-prefs');
  if (req.method !== 'GET' && req.method !== 'PUT') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET or PUT only' });
  }
  const rejected = await guardOwnerOrGuestEndpoint(req, res, done);
  if (rejected) return;

  if (req.method === 'PUT') {
    const rateLimited = await rejectIfRateLimited(req, res, 'panel-prefs', 20);
    if (rateLimited) {
      done({ status: 429 });
      return;
    }
  }

  const identity = resolveIdentity(req);
  const db = getDb();

  if (req.method === 'GET') {
    try {
      const rows = await db`
        SELECT hidden_panels FROM panel_prefs WHERE identity = ${identity}
      `;
      const hiddenPanels =
        rows.length > 0
          ? ((rows[0]?.hidden_panels as string[] | null) ?? [])
          : [];
      done({ status: 200 });
      return res.status(200).json({ hiddenPanels });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'panel-prefs GET failed');
      done({ status: 500 });
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  const parsed = panelPrefsBodySchema.safeParse(req.body);
  if (respondIfInvalid(parsed, res, done)) return;
  const { hiddenPanels } = parsed.data;
  try {
    await db`
      INSERT INTO panel_prefs (identity, hidden_panels, updated_at)
      VALUES (${identity}, ${JSON.stringify(hiddenPanels)}::jsonb, NOW())
      ON CONFLICT (identity) DO UPDATE SET
        hidden_panels = EXCLUDED.hidden_panels,
        updated_at = NOW()
    `;
    done({ status: 200 });
    return res.status(200).json({ hiddenPanels });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'panel-prefs PUT failed');
    done({ status: 500 });
    return res.status(500).json({ error: 'Internal error' });
  }
}
