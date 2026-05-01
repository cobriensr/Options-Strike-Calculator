/**
 * GET /api/periscope-chat-detail?id=N
 *
 * Single-row fetch for the Periscope Chat history detail viewer.
 * Returns the full prose, structured fields, image URLs (Vercel Blob),
 * Anthropic call metadata, and parent/child linkage.
 *
 * Authorization: owner-only. Same posture as the rest of the
 * periscope-chat-* family.
 *
 * Rate limit: 120/min — clicking through past entries can fire several
 * requests in a few seconds; the frontend caches client-side so the
 * practical hit rate is much lower.
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
import { periscopeChatDetailQuerySchema } from './_lib/validation.js';

interface PeriscopeImageEntry {
  kind: string;
  url: string;
}

interface PeriscopeChatDetailRow {
  id: number;
  trading_date: string;
  captured_at: string;
  mode: 'read' | 'debrief';
  parent_id: number | null;
  user_context: string | null;
  prose_text: string;
  spot: number | null;
  cone_lower: number | null;
  cone_upper: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  calibration_quality: number | null;
  image_urls: PeriscopeImageEntry[];
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

/**
 * Neon's serverless driver returns JSONB columns as already-parsed
 * objects, but historical rows or driver mode changes can return them
 * as strings. Handle both.
 */
function parseJsonbField<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function parseDetailRow(r: Record<string, unknown>): PeriscopeChatDetailRow {
  const id = Number(r.id);
  // Stored URLs in image_urls JSONB are the raw private Vercel Blob
  // URLs, which the browser can't fetch directly. Rewrite each entry
  // to point at /api/periscope-chat-image, which proxies the bytes
  // with the server-side BLOB_READ_WRITE_TOKEN. Frontend just renders
  // <img src={image.url}> against the proxy URL.
  const rawImages = parseJsonbField<PeriscopeImageEntry[]>(r.image_urls) ?? [];
  const proxiedImages = rawImages.map((img) => ({
    kind: img.kind,
    url: `/api/periscope-chat-image?id=${id}&kind=${encodeURIComponent(img.kind)}`,
  }));
  return {
    id,
    trading_date: r.trading_date as string,
    captured_at: r.captured_at as string,
    mode: r.mode as 'read' | 'debrief',
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    user_context: (r.user_context as string | null) ?? null,
    prose_text: (r.prose_text as string) ?? '',
    spot: r.spot == null ? null : Number(r.spot),
    cone_lower: r.cone_lower == null ? null : Number(r.cone_lower),
    cone_upper: r.cone_upper == null ? null : Number(r.cone_upper),
    long_trigger: r.long_trigger == null ? null : Number(r.long_trigger),
    short_trigger: r.short_trigger == null ? null : Number(r.short_trigger),
    regime_tag: (r.regime_tag as string | null) ?? null,
    calibration_quality:
      r.calibration_quality == null ? null : Number(r.calibration_quality),
    image_urls: proxiedImages,
    model: (r.model as string) ?? 'unknown',
    input_tokens: r.input_tokens == null ? null : Number(r.input_tokens),
    output_tokens: r.output_tokens == null ? null : Number(r.output_tokens),
    cache_read_tokens:
      r.cache_read_tokens == null ? null : Number(r.cache_read_tokens),
    cache_write_tokens:
      r.cache_write_tokens == null ? null : Number(r.cache_write_tokens),
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
    created_at: r.created_at as string,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-chat-detail');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-chat-detail',
    120,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const parsed = periscopeChatDetailQuerySchema.safeParse(req.query);
  if (respondIfInvalid(parsed, res, done)) return;
  const { id } = parsed.data;

  try {
    const sql = getDb();
    setCacheHeaders(res, 60, 120);

    const rows = await sql`
      SELECT id, trading_date, captured_at, mode, parent_id,
             user_context, prose_text, spot, cone_lower, cone_upper,
             long_trigger, short_trigger, regime_tag, calibration_quality,
             image_urls, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, duration_ms,
             created_at
      FROM periscope_analyses
      WHERE id = ${id}
      LIMIT 1
    `;

    if (rows.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Read not found' });
    }

    done({ status: 200 });
    return res.status(200).json(parseDetailRow(rows[0]!));
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'periscope-chat-detail endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
