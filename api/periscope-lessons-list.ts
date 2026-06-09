/**
 * GET /api/periscope-lessons-list
 *
 * Lists the candidate + active + archived lessons curated by the
 * `curate-periscope-lessons` cron. Backs the LessonLibrary dashboard
 * panel — the user reviews `proposed` rows there and either promotes
 * them to `active` (which makes the cron's `## Recent lessons learned`
 * sub-section pick them up) or archives them.
 *
 * Replaces the manual SQL-via-psql workflow that shipped with commit
 * 5a849294. The reasoning for splitting the read + write into two
 * endpoints (rather than one PATCH/GET combo) mirrors
 * periscope-chat-list / periscope-chat-update — the read is cacheable
 * at the edge, the write isn't.
 *
 * Authorization: owner OR guest. The user opted to share read access
 * to the curated lesson library with guest-key holders.
 * `/api/periscope-lessons-update` (the mutation that promotes /
 * archives lessons) stays owner-only.
 *
 * Rate limit: 60/min — interactive review can fire bursts as the user
 * scrolls and toggles tabs.
 *
 * Cache: 30s edge / 60s SWR — same posture as periscope-chat-list. The
 * cron runs Sunday nights so the underlying data changes infrequently;
 * the user's optimistic local state covers the staleness window after
 * a promote/archive.
 *
 * Response shape:
 *   { lessons: PeriscopeLessonRow[] }
 *
 * Ordering: status (proposed → active → archived) then citation_count
 * DESC, then created_at DESC. Keeps the most-cited candidates at the
 * top of the proposed tab where the user is doing triage work.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getDb, withDbRetry } from './_lib/db.js';
import { DB_RETRY_ATTEMPTS, DB_RETRY_TIMEOUT_MS } from './_lib/constants.js';
import { metrics } from './_lib/sentry.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import { toIsoTimestamp } from './_lib/periscope-db.js';
import type { PeriscopeLessonStatus } from './_lib/periscope-lessons.js';

/**
 * Wire shape exposed to the frontend. Extends the core
 * `PeriscopeLessonRow` from `_lib/periscope-lessons.ts` with the two
 * lifecycle timestamps the dashboard surfaces (`promoted_at`,
 * `archived_at`). Both are nullable — a `proposed` row has neither
 * stamped yet.
 */
export interface PeriscopeLessonListRow {
  id: number;
  lesson_text: string;
  source_ids: number[];
  status: PeriscopeLessonStatus;
  citation_count: number;
  created_at: string;
  promoted_at: string | null;
  archived_at: string | null;
}

/**
 * Coerce a single DB row (string-keyed `unknown`) to the wire shape.
 * `source_ids` lands as a JS array on the Neon serverless driver for
 * `bigint[]` columns; defensively coerce each element to a Number so
 * the wire format is always `number[]`. Timestamps round-trip through
 * `toIsoTimestamp` to normalize Date objects into ISO strings.
 */
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
  const done = metrics.request('/api/periscope-lessons-list');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-lessons-list',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const sql = getDb();
    setCacheHeaders(res, 30, 60);

    // CASE expression maps the status enum onto a sortable integer so
    // the panel's three tabs land in the natural review order (proposed
    // first, then active, then archived). citation_count + created_at
    // are the secondary keys within each status group.
    const rows = await withDbRetry(
      () => sql`
      SELECT id, lesson_text, source_ids, status, citation_count,
             created_at, promoted_at, archived_at
      FROM periscope_lessons
      ORDER BY
        CASE status
          WHEN 'proposed' THEN 0
          WHEN 'active'   THEN 1
          WHEN 'archived' THEN 2
          ELSE 3
        END ASC,
        citation_count DESC,
        created_at DESC
    `,
      DB_RETRY_ATTEMPTS,
      DB_RETRY_TIMEOUT_MS,
    );

    const lessons = rows.map(parseRow);
    done({ status: 200 });
    return res.status(200).json({ lessons });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    sendDbErrorResponse(res, err, {
      label: 'periscope_lessons_list',
      serverErrorBody: { error: 'Internal error' },
    });
    return;
  }
}
