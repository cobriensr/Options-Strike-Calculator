/**
 * GET /api/periscope-chat-detail?id=N
 *
 * Single-row fetch for the Periscope Chat history detail viewer.
 * Returns the full prose, structured fields, image URLs (Vercel Blob),
 * Anthropic call metadata, and parent/child linkage.
 *
 * Authorization: owner OR guest. Read-only data; the user opted to
 * share past playbooks with guest-key holders. Only the Claude POST
 * endpoint (`/api/periscope-chat`) stays owner-gated.
 *
 * Rate limit: 120/min — clicking through past entries can fire several
 * requests in a few seconds; the frontend caches client-side so the
 * practical hit rate is much lower.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getDb, withDbRetry } from './_lib/db.js';
import { withDbReader } from './_lib/request-scope.js';
import { periscopeChatDetailQuerySchema } from './_lib/validation.js';
import { toIsoDate, toIsoTimestamp } from './_lib/periscope-db.js';
import type {
  PeriscopeBias,
  PeriscopeConfidence,
  PeriscopeKeyLevels,
  PeriscopeMode,
} from './_lib/periscope-db.js';

interface PeriscopeImageEntry {
  kind: string;
  url: string;
}

interface PeriscopeChatDetailRow {
  id: number;
  trading_date: string;
  captured_at: string;
  read_time: string;
  spot_at_read_time: number;
  spot_source: 'db_exact' | 'db_snapped';
  mode: PeriscopeMode;
  parent_id: number | null;
  user_context: string | null;
  prose_text: string;
  spot: number | null;
  cone_lower: number | null;
  cone_upper: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  bias: PeriscopeBias | null;
  trade_types_recommended: string[];
  trade_types_avoided: string[];
  key_levels: PeriscopeKeyLevels | null;
  expected_dealer_behavior: string | null;
  confidence: PeriscopeConfidence | null;
  confidence_basis: string | null;
  futures_plan: string | null;
  parse_ok: boolean;
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

function parseStringArray(raw: unknown): string[] {
  const v = parseJsonbField<unknown>(raw);
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function parseKeyLevels(raw: unknown): PeriscopeKeyLevels | null {
  const v = parseJsonbField<unknown>(raw);
  if (v == null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;
  return {
    gamma_floor: num(o.gamma_floor),
    gamma_ceiling: num(o.gamma_ceiling),
    magnet: num(o.magnet),
    charm_zero: num(o.charm_zero),
  };
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
  const biasRaw = r.bias;
  const bias =
    biasRaw === 'long-only' ||
    biasRaw === 'short-only' ||
    biasRaw === 'fade-only' ||
    biasRaw === 'two-sided' ||
    biasRaw === 'no-trade'
      ? biasRaw
      : null;
  const confidenceRaw = r.confidence;
  const confidence =
    confidenceRaw === 'low' ||
    confidenceRaw === 'medium' ||
    confidenceRaw === 'high'
      ? confidenceRaw
      : null;
  return {
    id,
    trading_date: toIsoDate(r.trading_date),
    captured_at: toIsoTimestamp(r.captured_at),
    read_time: toIsoTimestamp(r.read_time),
    spot_at_read_time: Number(r.spot_at_read_time),
    spot_source: r.spot_source as 'db_exact' | 'db_snapped',
    mode: r.mode as PeriscopeMode,
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    user_context: (r.user_context as string | null) ?? null,
    prose_text: (r.prose_text as string) ?? '',
    spot: r.spot == null ? null : Number(r.spot),
    cone_lower: r.cone_lower == null ? null : Number(r.cone_lower),
    cone_upper: r.cone_upper == null ? null : Number(r.cone_upper),
    long_trigger: r.long_trigger == null ? null : Number(r.long_trigger),
    short_trigger: r.short_trigger == null ? null : Number(r.short_trigger),
    regime_tag: (r.regime_tag as string | null) ?? null,
    bias,
    trade_types_recommended: parseStringArray(r.trade_types_recommended),
    trade_types_avoided: parseStringArray(r.trade_types_avoided),
    key_levels: parseKeyLevels(r.key_levels),
    expected_dealer_behavior:
      (r.expected_dealer_behavior as string | null) ?? null,
    confidence,
    confidence_basis: (r.confidence_basis as string | null) ?? null,
    futures_plan: (r.futures_plan as string | null) ?? null,
    parse_ok: Boolean(r.parse_ok),
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
    created_at: toIsoTimestamp(r.created_at),
  };
}

export default withDbReader(
  '/api/periscope-chat-detail',
  'periscope_chat_detail',
  async (req: VercelRequest, res: VercelResponse, done) => {
    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

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

    const sql = getDb();
    setCacheHeaders(res, 60, 120);

    const rows = await withDbRetry(
      () => sql`
      SELECT id, trading_date, captured_at, read_time, spot_at_read_time,
             spot_source, mode, parent_id,
             user_context, prose_text, spot, cone_lower, cone_upper,
             long_trigger, short_trigger, regime_tag, bias,
             trade_types_recommended, trade_types_avoided, key_levels,
             expected_dealer_behavior, confidence, confidence_basis,
             futures_plan, parse_ok, calibration_quality,
             image_urls, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, duration_ms,
             created_at
      FROM periscope_analyses
      WHERE id = ${id}
      LIMIT 1
    `,
      2,
      10_000,
    );

    if (rows.length === 0) {
      done({ status: 404 });
      res.status(404).json({ error: 'Read not found' });
      return;
    }

    done({ status: 200 });
    res.status(200).json(parseDetailRow(rows[0]!));
  },
);
