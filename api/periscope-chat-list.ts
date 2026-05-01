/**
 * GET /api/periscope-chat-list
 *
 * Paginated index for the Periscope Chat history viewer. Returns a
 * compact summary of past reads + debriefs ordered by `created_at DESC`,
 * suitable for the dashboard's history panel. Image bytes and the full
 * prose response live behind /api/periscope-chat-detail?id=N.
 *
 * Query params:
 *   ?limit=N        — max rows returned (1-100, default 20)
 *   ?before=N       — return rows with id < this BIGSERIAL value
 *                     (cursor-style pagination from the most recent)
 *
 * Authorization: owner-only (`guardOwnerEndpoint`). The chat data is
 * Anthropic-API-backed and personal — guests don't see it. Mirrors
 * `/api/periscope-chat`'s auth posture.
 *
 * Rate limit: 60/min — ample for browsing the history list and
 * occasional refreshes.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { periscopeChatListQuerySchema } from './_lib/validation.js';

interface PeriscopeChatSummary {
  id: number;
  trading_date: string;
  captured_at: string;
  mode: 'read' | 'debrief';
  parent_id: number | null;
  spot: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  calibration_quality: number | null;
  prose_excerpt: string;
  duration_ms: number | null;
}

function parseSummaryRow(r: Record<string, unknown>): PeriscopeChatSummary {
  const proseText = typeof r.prose_text === 'string' ? r.prose_text : '';
  return {
    id: Number(r.id),
    trading_date: r.trading_date as string,
    captured_at: r.captured_at as string,
    mode: r.mode as 'read' | 'debrief',
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    spot: r.spot == null ? null : Number(r.spot),
    long_trigger: r.long_trigger == null ? null : Number(r.long_trigger),
    short_trigger: r.short_trigger == null ? null : Number(r.short_trigger),
    regime_tag: (r.regime_tag as string | null) ?? null,
    calibration_quality:
      r.calibration_quality == null ? null : Number(r.calibration_quality),
    // First 240 chars — enough for a one-line preview without dragging
    // the full response (some prose runs to 4-6KB).
    prose_excerpt: proseText.slice(0, 240),
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-chat-list');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-chat-list',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const parsed = periscopeChatListQuerySchema.safeParse(req.query);
  if (respondIfInvalid(parsed, res, done)) return;
  const { limit, before } = parsed.data;

  try {
    const sql = getDb();
    setCacheHeaders(res, 30, 60);

    // Cursor pagination on id (BIGSERIAL, monotonic) — newer rows have
    // larger ids regardless of trading_date / captured_at, so this is
    // the cheapest stable cursor.
    const rows = before
      ? await sql`
          SELECT id, trading_date, captured_at, mode, parent_id,
                 spot, long_trigger, short_trigger, regime_tag,
                 calibration_quality, prose_text, duration_ms
          FROM periscope_analyses
          WHERE id < ${before}
          ORDER BY id DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, trading_date, captured_at, mode, parent_id,
                 spot, long_trigger, short_trigger, regime_tag,
                 calibration_quality, prose_text, duration_ms
          FROM periscope_analyses
          ORDER BY id DESC
          LIMIT ${limit}
        `;

    const items = rows.map(parseSummaryRow);
    const nextBefore =
      items.length === limit ? (items.at(-1)?.id ?? null) : null;

    done({ status: 200 });
    return res.status(200).json({ items, nextBefore });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'periscope-chat-list endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
