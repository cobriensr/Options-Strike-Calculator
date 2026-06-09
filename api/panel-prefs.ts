/**
 * GET  /api/panel-prefs  → { hiddenPanels, panelOrder, groupOrder }
 * PUT  /api/panel-prefs  body { hiddenPanels?, panelOrder?, groupOrder? }
 *      → { hiddenPanels, panelOrder, groupOrder }
 *
 * Per-identity show/hide + layout-order preferences for the home-page
 * panels. Identity is `'owner'` for the cookie session, or
 * sha256(guest_key) for a guest. Storing the hash means a leak of
 * panel_prefs reveals no live guest credential — see spec
 * docs/superpowers/specs/panel-prefs-2026-05-17.md.
 *
 * PUT is a partial update: any field omitted from the body is left
 * untouched on the existing row (read-merge-write). The single hook
 * caller (usePanelPrefs) always sends all three, but the merge path
 * keeps the endpoint safe against partial clients (and against
 * single-axis writes from `Reset visibility` / `Reset panel order` /
 * `Reset group order`).
 *
 * Returns empty arrays for all three when no row exists (first read
 * for an identity).
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
import { getDb, withDbRetry } from './_lib/db.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import logger from './_lib/logger.js';
import { panelPrefsBodySchema } from './_lib/validation.js';

function resolveIdentity(req: VercelRequest): string {
  if (isOwner(req)) return 'owner';
  const key = parseCookies(req)[GUEST_COOKIE] ?? '';
  return crypto.createHash('sha256').update(key).digest('hex');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
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
      const rows = await withDbRetry(
        () => db`
        SELECT hidden_panels, panel_order, group_order
          FROM panel_prefs WHERE identity = ${identity}
      `,
        2,
        10_000,
      );
      const row = rows[0];
      done({ status: 200 });
      return res.status(200).json({
        hiddenPanels: asStringArray(row?.hidden_panels),
        panelOrder: asStringArray(row?.panel_order),
        groupOrder: asStringArray(row?.group_order),
      });
    } catch (err) {
      done({ status: 500 });
      sendDbErrorResponse(res, err, {
        label: 'panel_prefs',
        serverErrorBody: { error: 'Internal error' },
      });
      return;
    }
  }

  const parsed = panelPrefsBodySchema.safeParse(req.body);
  if (respondIfInvalid(parsed, res, done)) return;
  const { hiddenPanels, panelOrder, groupOrder } = parsed.data;

  try {
    const existing = await withDbRetry(
      () => db`
      SELECT hidden_panels, panel_order, group_order
        FROM panel_prefs WHERE identity = ${identity}
    `,
      2,
      10_000,
    );
    const prior = existing[0];
    const mergedHidden = hiddenPanels ?? asStringArray(prior?.hidden_panels);
    const mergedPanelOrder = panelOrder ?? asStringArray(prior?.panel_order);
    const mergedGroupOrder = groupOrder ?? asStringArray(prior?.group_order);

    await withDbRetry(
      () => db`
      INSERT INTO panel_prefs
        (identity, hidden_panels, panel_order, group_order, updated_at)
      VALUES (
        ${identity},
        ${JSON.stringify(mergedHidden)}::jsonb,
        ${JSON.stringify(mergedPanelOrder)}::jsonb,
        ${JSON.stringify(mergedGroupOrder)}::jsonb,
        NOW()
      )
      ON CONFLICT (identity) DO UPDATE SET
        hidden_panels = EXCLUDED.hidden_panels,
        panel_order   = EXCLUDED.panel_order,
        group_order   = EXCLUDED.group_order,
        updated_at    = NOW()
    `,
      2,
      10_000,
    );
    done({ status: 200 });
    return res.status(200).json({
      hiddenPanels: mergedHidden,
      panelOrder: mergedPanelOrder,
      groupOrder: mergedGroupOrder,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'panel-prefs PUT failed');
    done({ status: 500 });
    return res.status(500).json({ error: 'Internal error' });
  }
}
