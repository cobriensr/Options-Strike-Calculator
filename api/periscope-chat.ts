/**
 * POST /api/periscope-chat — DEPRECATED, returns 410 Gone.
 *
 * Phase 4d of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * The manual screenshot-upload Periscope chat was replaced by the
 * scraper-triggered auto-playbook (Phase 2b–3). The frontend UI that
 * called this endpoint was removed in the same commit; this thin 410
 * stub stays in place for one deploy window so any stale tab still
 * gets a clear deprecation signal instead of a 404 + opaque error.
 *
 * Callers should switch to:
 *   POST /api/periscope-auto-playbook  (webhook-secret auth, scraper-only)
 *   GET  /api/periscope-playbook       (read auto-generated playbook for date)
 *
 * The chat-list / chat-detail / chat-image / chat-update endpoints are
 * still active — they back the read-only history UI that surfaces past
 * manual entries alongside the new auto-generated rows.
 *
 * Follow-up: delete this file entirely once the deprecation window
 * closes (no telemetry hits across one full trading week).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { metrics } from './_lib/sentry.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-chat');
  done({ status: 410 });
  res.setHeader('X-Deprecation-Replacement', '/api/periscope-auto-playbook');
  return res.status(410).json({
    error:
      '/api/periscope-chat is deprecated. The manual screenshot-upload ' +
      'flow was replaced by the scraper-triggered auto-playbook. The new ' +
      'panel renders Claude playbooks from /api/periscope-playbook; the ' +
      'scraper webhook target is /api/periscope-auto-playbook.',
    method: req.method ?? null,
    replacement: '/api/periscope-auto-playbook',
  });
}
