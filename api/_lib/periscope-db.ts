/**
 * DB writers for /api/periscope-chat.
 *
 * Mirrors api/_lib/trace-live-db.ts but for the periscope_analyses table
 * (migration 103). Two exports:
 *
 *   - buildPeriscopeSummary() builds a stable, pipe-delimited string that
 *     captures the structural fingerprint of a read or debrief. It's the
 *     input to text-embedding-3-large, so similarity matches on chart
 *     topology + trigger geometry, not on prose phrasing.
 *
 *   - savePeriscopeAnalysis() inserts the row with the embedding bound as
 *     a `vector(2000)` literal. Returns the new row id, or null on any
 *     failure. Caller decides what to do with null (the endpoint logs +
 *     Sentry-captures so the response still ships even if persistence
 *     fails — a bad row is worse than a missing row).
 *
 * Structured fields (spot, cone_lower, cone_upper, long_trigger,
 * short_trigger, regime_tag) come from a fenced JSON code block at the
 * end of Claude's response. The endpoint parses that block before calling
 * here; on parse failure all six fields are null and the row still saves.
 */

import { getDb } from './db.js';
import logger from './logger.js';
import { Sentry } from './sentry.js';
import type { PeriscopeImageUrls } from './periscope-blob.js';

export type PeriscopeMode = 'read' | 'debrief';

/** Structured fields parsed from the JSON code block at end of response. */
export interface PeriscopeStructuredFields {
  spot: number | null;
  cone_lower: number | null;
  cone_upper: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
}

export interface SavePeriscopeAnalysisInput {
  /** ISO 8601 capture time (server-side, request arrival). */
  capturedAt: string;
  /** YYYY-MM-DD. Derived from capturedAt in the endpoint. */
  tradingDate: string;
  mode: PeriscopeMode;
  /** When this is a debrief that links to an existing read. */
  parentId: number | null;
  /** Optional user-supplied note attached to the request. */
  userContext: string | null;
  /** Sparse map of {kind: blobUrl}. Empty / partial OK. */
  imageUrls: PeriscopeImageUrls;
  /** Claude's prose response with the trailing JSON block stripped. */
  proseText: string;
  /**
   * Full Anthropic response payload (raw text + usage + stop_reason etc.)
   * Stored as JSONB so a future format change doesn't lose data.
   */
  fullResponse: Record<string, unknown>;
  /** text-embedding-3-large vector. null when generation failed. */
  embedding: number[] | null;
  structured: PeriscopeStructuredFields;
  // Anthropic call metadata for cost analysis + cache-hit monitoring:
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number;
}

/**
 * Build the embedding-input summary. Stable, pipe-delimited fields plus a
 * truncated prose excerpt — this is what gets embedded by OpenAI's
 * text-embedding-3-large for retrieval queries. Keep the field order
 * stable; reordering invalidates similarity against past rows.
 */
export function buildPeriscopeSummary(args: {
  mode: PeriscopeMode;
  tradingDate: string;
  structured: PeriscopeStructuredFields;
  proseText: string;
}): string {
  const { mode, tradingDate, structured, proseText } = args;
  const fmt = (n: number | null) => (n == null ? 'null' : n.toString());
  // 800 chars ≈ 200 tokens — captures the open-read summary, regime
  // diagnosis, and trigger geometry without dragging in late-prose
  // boilerplate that fuzzes similarity.
  const proseExcerpt = proseText.slice(0, 800).replace(/\s+/g, ' ').trim();
  return [
    `mode=${mode}`,
    `date=${tradingDate}`,
    `spot=${fmt(structured.spot)}`,
    `cone=${fmt(structured.cone_lower)}-${fmt(structured.cone_upper)}`,
    `long_trigger=${fmt(structured.long_trigger)}`,
    `short_trigger=${fmt(structured.short_trigger)}`,
    `regime=${structured.regime_tag ?? 'null'}`,
    `prose=${proseExcerpt}`,
  ].join(' | ');
}

/** Subset of a periscope_analyses row needed to anchor a debrief. */
export interface PeriscopeParentRead {
  id: number;
  mode: PeriscopeMode;
  tradingDate: string;
  proseText: string;
  structured: PeriscopeStructuredFields;
}

/**
 * Fetch a single periscope_analyses row by id. Returns null when the row
 * doesn't exist or the query fails. Used by /api/periscope-chat to inject
 * the parent read's prose + structured fields into a debrief request so
 * Claude has the open read to score against — without this the debrief
 * preamble references a parent the model can't see.
 */
export async function fetchPeriscopeAnalysisById(
  id: number,
): Promise<PeriscopeParentRead | null> {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT id, mode, trading_date, prose_text,
             spot, cone_lower, cone_upper,
             long_trigger, short_trigger, regime_tag
      FROM periscope_analyses
      WHERE id = ${id}
      LIMIT 1
    `;
    const r = rows[0];
    if (r == null) return null;
    return {
      id: Number(r.id),
      mode: r.mode as PeriscopeMode,
      tradingDate: r.trading_date as string,
      proseText: (r.prose_text as string) ?? '',
      structured: {
        spot: (r.spot as number | null) ?? null,
        cone_lower: (r.cone_lower as number | null) ?? null,
        cone_upper: (r.cone_upper as number | null) ?? null,
        long_trigger: (r.long_trigger as number | null) ?? null,
        short_trigger: (r.short_trigger as number | null) ?? null,
        regime_tag: (r.regime_tag as string | null) ?? null,
      },
    };
  } catch (err) {
    logger.error({ err, id }, 'fetchPeriscopeAnalysisById: query failed');
    Sentry.captureException(err);
    return null;
  }
}

/**
 * Persist a single Periscope read or debrief to Postgres. Returns the new
 * row id on success, null on any failure. Caller logs / Sentry-captures
 * if it cares — drift in this table doesn't break the user's session.
 */
export async function savePeriscopeAnalysis(
  input: SavePeriscopeAnalysisInput,
): Promise<number | null> {
  const sql = getDb();
  const {
    capturedAt,
    tradingDate,
    mode,
    parentId,
    userContext,
    imageUrls,
    proseText,
    fullResponse,
    embedding,
    structured,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    durationMs,
  } = input;

  // pgvector accepts a `[v1,v2,...]::vector` literal for non-null inserts
  // and a plain SQL NULL when generation failed. The cast is unconditional;
  // `NULL::vector` is valid Postgres and stays NULL.
  const vectorLiteral =
    embedding && embedding.length > 0 ? `[${embedding.join(',')}]` : null;

  // image_urls is jsonb. Empty / null both coalesce to '[]' so the read
  // endpoints can iterate without a null guard. We pass an array of
  // {kind, url} objects (rather than the sparse Partial<Record>) because
  // the column default is '[]'::jsonb and an array round-trips cleaner
  // through pgvector's serializer than an object with optional keys.
  const imageArray = (Object.entries(imageUrls) as [string, string][]).map(
    ([kind, url]) => ({ kind, url }),
  );

  try {
    const rows = await sql`
      INSERT INTO periscope_analyses (
        trading_date,
        captured_at,
        mode,
        parent_id,
        user_context,
        image_urls,
        prose_text,
        full_response,
        analysis_embedding,
        spot,
        cone_lower,
        cone_upper,
        long_trigger,
        short_trigger,
        regime_tag,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        duration_ms
      ) VALUES (
        ${tradingDate},
        ${capturedAt},
        ${mode},
        ${parentId},
        ${userContext},
        ${JSON.stringify(imageArray)}::jsonb,
        ${proseText},
        ${JSON.stringify(fullResponse)}::jsonb,
        ${vectorLiteral}::vector,
        ${structured.spot},
        ${structured.cone_lower},
        ${structured.cone_upper},
        ${structured.long_trigger},
        ${structured.short_trigger},
        ${structured.regime_tag},
        ${model},
        ${inputTokens},
        ${outputTokens},
        ${cacheReadTokens},
        ${cacheWriteTokens},
        ${durationMs}
      )
      RETURNING id
    `;
    // Neon's serverless driver returns BIGSERIAL ids as strings
    // (BigInt-safe representation). Coerce defensively, returning null
    // only if the value is missing or not numeric.
    const raw = rows[0]?.id;
    if (raw == null) return null;
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    logger.error(
      { err, tradingDate, mode },
      'savePeriscopeAnalysis: insert failed',
    );
    Sentry.captureException(err);
    return null;
  }
}
