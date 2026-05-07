/**
 * POST /api/periscope-lessons-update
 *
 * Promote / archive / unarchive a row in `periscope_lessons`. Drives
 * the LessonLibrary panel's three action buttons and replaces the
 * manual SQL workflow that shipped pre-MVP.
 *
 * Body:
 *   { id: number, action: 'promote' | 'archive' | 'unarchive' }
 *
 * State machine (enforced server-side; Zod only checks shape):
 *   proposed --promote--> active
 *   proposed --archive--> archived
 *   active   --archive--> archived
 *   archived --unarchive--> proposed (clears both promoted_at + archived_at)
 *
 *   promote-from-archived → 422 (must explicitly unarchive first so the
 *   audit trail captures the demotion → re-promotion as two distinct
 *   events rather than collapsing them).
 *   unarchive-from-non-archived → 422 (no-op + 422 keeps the response
 *   consistent with the promote-from-archived guard).
 *
 * Authorization: owner-only. Same posture as the rest of the
 * periscope-* family.
 *
 * Rate limit: 60/min — review sessions can click through many rows in
 * a few minutes.
 *
 * Returns the updated row (`RETURNING *` shape) so the frontend can
 * mirror server state without a follow-up GET.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { periscopeLessonsUpdateBodySchema } from './_lib/validation.js';
import { toIsoTimestamp } from './_lib/periscope-db.js';
import type { PeriscopeLessonStatus } from './_lib/periscope-lessons.js';
import type { PeriscopeLessonListRow } from './periscope-lessons-list.js';

function parseRow(r: Record<string, unknown>): PeriscopeLessonListRow {
  return {
    id: Number(r.id),
    lesson_text: String(r.lesson_text ?? ''),
    source_ids: ((r.source_ids as unknown[] | null) ?? []).map((n) =>
      Number(n),
    ),
    status: r.status as PeriscopeLessonStatus,
    citation_count: Number(r.citation_count),
    created_at: toIsoTimestamp(r.created_at),
    promoted_at: r.promoted_at == null ? null : toIsoTimestamp(r.promoted_at),
    archived_at: r.archived_at == null ? null : toIsoTimestamp(r.archived_at),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-lessons-update');
  Sentry.setTag('endpoint', 'periscope-lessons-update');

  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-lessons-update',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const parsed = periscopeLessonsUpdateBodySchema.safeParse(req.body);
  if (respondIfInvalid(parsed, res, done)) return;
  const { id, action } = parsed.data;

  try {
    const sql = getDb();

    // Look up current status BEFORE the UPDATE so we can enforce the
    // state-machine guards with a clear 422 instead of letting an
    // illegal transition silently no-op (the WHERE-clause guard form
    // would return zero affected rows + a 404, which is misleading
    // when the row is actually present but in the wrong state).
    const existing = await sql`
      SELECT id, status FROM periscope_lessons WHERE id = ${id} LIMIT 1
    `;
    const current = existing[0];
    if (current == null) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Lesson not found' });
    }
    const currentStatus = current.status as PeriscopeLessonStatus;

    // Action-specific guards. Each illegal transition is a 422 with a
    // human-readable message — the panel surfaces these as toasts so
    // the user knows what to do (e.g. "unarchive first").
    if (action === 'promote' && currentStatus === 'archived') {
      done({ status: 422 });
      return res.status(422).json({
        error:
          'Cannot promote an archived lesson directly. Unarchive it first to make the audit trail explicit.',
      });
    }
    if (action === 'unarchive' && currentStatus !== 'archived') {
      done({ status: 422 });
      return res.status(422).json({
        error: 'Cannot unarchive a lesson that is not currently archived.',
      });
    }

    // Three SQL shapes — one per action. Each uses RETURNING * so the
    // caller gets the post-update row in a single round-trip.
    let rows: Record<string, unknown>[];
    if (action === 'promote') {
      rows = await sql`
        UPDATE periscope_lessons
        SET status = 'active', promoted_at = NOW()
        WHERE id = ${id}
        RETURNING id, lesson_text, source_ids, status, citation_count,
                  created_at, promoted_at, archived_at
      `;
    } else if (action === 'archive') {
      rows = await sql`
        UPDATE periscope_lessons
        SET status = 'archived', archived_at = NOW()
        WHERE id = ${id}
        RETURNING id, lesson_text, source_ids, status, citation_count,
                  created_at, promoted_at, archived_at
      `;
    } else {
      // unarchive — clear BOTH lifecycle timestamps so a re-promote
      // later doesn't carry a stale promoted_at across the demotion.
      rows = await sql`
        UPDATE periscope_lessons
        SET status = 'proposed', promoted_at = NULL, archived_at = NULL
        WHERE id = ${id}
        RETURNING id, lesson_text, source_ids, status, citation_count,
                  created_at, promoted_at, archived_at
      `;
    }

    const row = rows[0];
    if (row == null) {
      // Conflict edge: row vanished between the SELECT and the UPDATE
      // (parallel session). Treat as 404 — the client should refetch.
      done({ status: 404 });
      return res.status(404).json({ error: 'Lesson not found' });
    }

    done({ status: 200 });
    return res.status(200).json({ ok: true, lesson: parseRow(row) });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error(
      { err, id, action },
      'periscope-lessons-update endpoint error',
    );
    return res.status(500).json({ error: 'Internal error' });
  }
}
