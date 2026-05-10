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

/**
 * The 3-mode lifecycle (Phase 6 of the periscope-chat overhaul):
 *   - `pre_trade` — one daily read at/before the open. No parent.
 *   - `intraday` — every 10-min slice during the session. Parent is
 *     today's pre_trade or the previous intraday read in the chain.
 *   - `debrief` — one end-of-day read. Parent is the last intraday.
 */
export type PeriscopeMode = 'pre_trade' | 'intraday' | 'debrief';

/** Allowed bias enum values (mirrors DB CHECK constraint). */
export type PeriscopeBias =
  | 'long-only'
  | 'short-only'
  | 'fade-only'
  | 'two-sided'
  | 'no-trade';

/** Allowed confidence enum values (mirrors DB CHECK constraint). */
export type PeriscopeConfidence = 'low' | 'medium' | 'high';

/** Spot lookup audit tag. Mirrors the DB CHECK on spot_source. */
export type PeriscopeSpotSource = 'db_exact' | 'db_snapped';

/**
 * Auto-playbook lifecycle states (migration #142). Mirrors the DB CHECK on
 * `status`. The auto-playbook endpoint inserts `'in_progress'` and updates
 * to `'complete'` / `'failed'` / `'truncated'` after the Claude call. Manual
 * chat writes default to `'complete'`.
 */
export type PeriscopeAnalysisStatus =
  | 'in_progress'
  | 'complete'
  | 'failed'
  | 'truncated';

/** Concrete level anchors lifted from the playbook JSON. */
export interface PeriscopeKeyLevels {
  gamma_floor: number | null;
  gamma_ceiling: number | null;
  magnet: number | null;
  charm_zero: number | null;
}

/**
 * Structured fields parsed from the JSON code block at end of
 * response. Phase 2 expanded the schema with the structured trading
 * playbook (bias, trade_types_*, key_levels, expected_dealer_behavior,
 * confidence, confidence_basis). Each new field is independently
 * coerced; a single malformed value nulls itself but does NOT sink
 * the rest of the structured payload.
 *
 * `parse_ok` is parser metadata, NOT a model-emitted field — set by
 * `parseStructuredFields` to `true` iff the JSON block was found and
 * `JSON.parse` succeeded. Persisted as a column so the dashboard can
 * flag partial reads.
 */
export interface PeriscopeStructuredFields {
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
  /**
   * Generic directional-execution string for the user's directional
   * futures trades (NQ primarily, ES sometimes — read off the same SPX
   * Periscope chart). Three labeled sections separated by blank lines:
   * `LONG:` (verdict + level tie above spot), `SHORT:` (verdict + level
   * tie below spot), `WAIT:` (no-trade band). Levels are SPX-priced;
   * the contract sizes against the same structure. `null` only when
   * the chart supports neither direction at any level. Embedded into
   * `buildPeriscopeSummary` so similarity search clusters by futures
   * setup across days.
   */
  futures_plan: string | null;
}

export interface SavePeriscopeAnalysisInput {
  /** ISO 8601 capture time (server-side, request arrival). */
  capturedAt: string;
  /** YYYY-MM-DD. Derived from capturedAt or read_date in the endpoint. */
  tradingDate: string;
  /**
   * The TIMESTAMPTZ the read is FOR — distinct from `captured_at`.
   * Built from (read_date, read_time, CT) by the periscope-chat
   * handler.
   */
  readTime: string;
  /** Authoritative SPX spot at `read_time`, looked up from index_candles_1m. */
  spotAtReadTime: number;
  /** Audit which path produced `spotAtReadTime`. */
  spotSource: PeriscopeSpotSource;
  mode: PeriscopeMode;
  /**
   * When the read links to an existing read in the chain. Required for
   * intraday + debrief; null only for pre_trade.
   */
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
  /** True iff the JSON block parsed cleanly. Parser metadata, not model-emitted. */
  parseOk: boolean;
  // Anthropic call metadata for cost analysis + cache-hit monitoring:
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number;
  // Auto-playbook lifecycle fields (migration #142). Optional + backward
  // compatible — manual chat callers omit these and the DB defaults take
  // effect (auto_generated=FALSE, slot_captured_at=NULL, status='complete',
  // failure_reason=NULL, panel_payload=NULL).
  /** Distinguishes scraper-triggered cron rows (true) from manual chat (false). */
  autoGenerated?: boolean;
  /** Exact periscope_snapshots.captured_at the read corresponds to (ISO 8601). */
  slotCapturedAt?: string | null;
  /** Lifecycle state for the panel render-state matrix. Defaults to 'complete'. */
  status?: PeriscopeAnalysisStatus;
  /** Populated when status='failed' or 'truncated'. Sentry id, error class, etc. */
  failureReason?: string | null;
  /** Structured panel JSON the frontend renders directly. JSONB-stringified. */
  panelPayload?: Record<string, unknown> | null;
}

/**
 * Build the embedding-input summary. Stable, pipe-delimited fields plus a
 * truncated prose excerpt — this is what gets embedded by OpenAI's
 * text-embedding-3-large for retrieval queries. Keep the field order
 * stable; reordering invalidates similarity against past rows.
 *
 * Phase 6D: the calendar `date=` token has been REMOVED from the
 * embedded text. The retrieval intent is topology / structural
 * similarity, not "rows from the same week" — including the date
 * fights cosine similarity by adding a uniform offset to every
 * vector. The `mode` token is kept (3 distinct modes have distinct
 * narrative shapes; embeddings cluster by mode meaningfully).
 *
 * `tradingDate` remains in the public arg shape so callers don't need
 * to thread a different signature; it just isn't tokenized.
 */
export function buildPeriscopeSummary(args: {
  mode: PeriscopeMode;
  tradingDate: string;
  structured: PeriscopeStructuredFields;
  proseText: string;
}): string {
  const { mode, structured, proseText } = args;
  const fmt = (n: number | null) => (n == null ? 'null' : n.toString());
  const proseExcerpt = proseText.slice(0, 800).replace(/\s+/g, ' ').trim();
  const baseLine = [
    `mode=${mode}`,
    `spot=${fmt(structured.spot)}`,
    `cone=${fmt(structured.cone_lower)}-${fmt(structured.cone_upper)}`,
    `long_trigger=${fmt(structured.long_trigger)}`,
    `short_trigger=${fmt(structured.short_trigger)}`,
    `regime=${structured.regime_tag ?? 'null'}`,
    `prose=${proseExcerpt}`,
  ].join(' | ');
  // Append futures_plan as a labeled segment so the embedding clusters
  // reads by futures setup (LONG/SHORT/WAIT permission map). Whitespace
  // is collapsed so the embedding input stays one logical "document"
  // even though the model emits the field with internal blank lines.
  if (structured.futures_plan != null && structured.futures_plan.length > 0) {
    const collapsed = structured.futures_plan.replace(/\s+/g, ' ').trim();
    return `${baseLine}\nFutures plan: ${collapsed}`;
  }
  return baseLine;
}

/** Subset of a periscope_analyses row needed to anchor a debrief / chain. */
export interface PeriscopeParentRead {
  id: number;
  mode: PeriscopeMode;
  tradingDate: string;
  proseText: string;
  structured: PeriscopeStructuredFields;
}

/** Helpers for coercing JSONB columns the Neon driver returns as strings. */
function parseJsonb<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function asStringArray(raw: unknown): string[] {
  const arr = parseJsonb<unknown>(raw, []);
  if (!Array.isArray(arr)) return [];
  return arr.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function asKeyLevels(raw: unknown): PeriscopeKeyLevels | null {
  const obj = parseJsonb<unknown>(raw, null);
  if (obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    gamma_floor: num(o.gamma_floor),
    gamma_ceiling: num(o.gamma_ceiling),
    magnet: num(o.magnet),
    charm_zero: num(o.charm_zero),
  };
}

function asBias(raw: unknown): PeriscopeBias | null {
  if (
    raw === 'long-only' ||
    raw === 'short-only' ||
    raw === 'fade-only' ||
    raw === 'two-sided' ||
    raw === 'no-trade'
  ) {
    return raw;
  }
  return null;
}

function asConfidence(raw: unknown): PeriscopeConfidence | null {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return null;
}

/**
 * Coerce a Neon-driver value to a finite number. Numeric columns can
 * round-trip as either `number` or `string` depending on the column
 * type and driver mode; this helper normalizes both shapes and rejects
 * non-finite results (NaN, Infinity).
 */
/**
 * Coerce a Postgres DATE column value to an ISO `YYYY-MM-DD` string.
 *
 * `@neondatabase/serverless` returns DATE columns as JavaScript `Date`
 * objects (midnight UTC of the stored date), not strings. Casting via
 * `as string` is a TypeScript lie — the runtime value is a Date, and
 * any subsequent string comparison (e.g. `tradingDate !== row.trading_date`)
 * fails because JS `!==` between a string and a Date is always true.
 * Template-literal interpolation then renders the Date via `.toString()`,
 * yielding "Wed May 06 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"
 * which is what surfaced in the user-visible error message.
 *
 * Use this helper at every row-mapping site that exposes `trading_date`
 * to a downstream string consumer.
 */
export function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * Coerce a Postgres TIMESTAMPTZ column value to a full ISO 8601 string.
 *
 * Same `Date`-object-from-Neon-driver issue as `toIsoDate`. Use this at
 * every row-mapping site that exposes a TIMESTAMPTZ to a downstream
 * string consumer (or to a `new Date(...)` constructor that would
 * silently coerce but violate the typed contract).
 */
export function toIsoTimestamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toFiniteNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToStructuredFields(
  r: Record<string, unknown>,
): PeriscopeStructuredFields {
  const num = toFiniteNumber;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  return {
    spot: num(r.spot),
    cone_lower: num(r.cone_lower),
    cone_upper: num(r.cone_upper),
    long_trigger: num(r.long_trigger),
    short_trigger: num(r.short_trigger),
    regime_tag: str(r.regime_tag),
    bias: asBias(r.bias),
    trade_types_recommended: asStringArray(r.trade_types_recommended),
    trade_types_avoided: asStringArray(r.trade_types_avoided),
    key_levels: asKeyLevels(r.key_levels),
    expected_dealer_behavior: str(r.expected_dealer_behavior),
    confidence: asConfidence(r.confidence),
    confidence_basis: str(r.confidence_basis),
    futures_plan: str(r.futures_plan),
  };
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
             long_trigger, short_trigger, regime_tag,
             bias, trade_types_recommended, trade_types_avoided,
             key_levels, expected_dealer_behavior, confidence, confidence_basis,
             futures_plan
      FROM periscope_analyses
      WHERE id = ${id}
      LIMIT 1
    `;
    const r = rows[0];
    if (r == null) return null;
    return {
      id: Number(r.id),
      mode: r.mode as PeriscopeMode,
      tradingDate: toIsoDate(r.trading_date),
      proseText: (r.prose_text as string) ?? '',
      structured: rowToStructuredFields(r),
    };
  } catch (err) {
    logger.error({ err, id }, 'fetchPeriscopeAnalysisById: query failed');
    Sentry.captureException(err);
    return null;
  }
}

/** One row in the parent chain returned by {@link fetchParentChain}. */
export interface ParentChainRow {
  id: number;
  mode: PeriscopeMode;
  regime_tag: string | null;
  bias: PeriscopeBias | null;
  /** First ~400 chars of the row's prose, whitespace-collapsed. */
  prose_excerpt: string;
  /** Compact subset of structured fields used to summarize the row. */
  structured: {
    spot: number | null;
    cone_lower: number | null;
    cone_upper: number | null;
    long_trigger: number | null;
    short_trigger: number | null;
  };
}

const PARENT_CHAIN_DEPTH_CAP = 10;
const PARENT_CHAIN_PROSE_CHARS = 400;

/**
 * Walk the parent chain from `parentId` back to the root pre_trade
 * read using `WITH RECURSIVE`. Returns the ancestors in oldest-first
 * order so callers can render the chain chronologically (root first,
 * immediate parent last). Capped at PARENT_CHAIN_DEPTH_CAP levels to
 * defend against malformed self-references.
 */
export async function fetchParentChain(
  parentId: number,
): Promise<ParentChainRow[]> {
  try {
    const sql = getDb();
    const rows = await sql`
      WITH RECURSIVE chain AS (
        SELECT id, mode, regime_tag, bias, prose_text,
               spot, cone_lower, cone_upper,
               long_trigger, short_trigger,
               parent_id, 0 AS depth
        FROM periscope_analyses
        WHERE id = ${parentId}
        UNION ALL
        SELECT p.id, p.mode, p.regime_tag, p.bias, p.prose_text,
               p.spot, p.cone_lower, p.cone_upper,
               p.long_trigger, p.short_trigger,
               p.parent_id, c.depth + 1 AS depth
        FROM periscope_analyses p
        JOIN chain c ON p.id = c.parent_id
        WHERE c.depth < ${PARENT_CHAIN_DEPTH_CAP}
      )
      SELECT id, mode, regime_tag, bias, prose_text,
             spot, cone_lower, cone_upper,
             long_trigger, short_trigger, depth
      FROM chain
      ORDER BY depth DESC
    `;
    const num = toFiniteNumber;
    return rows.map((r): ParentChainRow => {
      const proseRaw = (r.prose_text as string) ?? '';
      const collapsed = proseRaw.replace(/\s+/g, ' ').trim();
      const excerpt =
        collapsed.length > PARENT_CHAIN_PROSE_CHARS
          ? collapsed.slice(0, PARENT_CHAIN_PROSE_CHARS).trimEnd() + '…'
          : collapsed;
      return {
        id: Number(r.id),
        mode: r.mode as PeriscopeMode,
        regime_tag: (r.regime_tag as string | null) ?? null,
        bias: asBias(r.bias),
        prose_excerpt: excerpt,
        structured: {
          spot: num(r.spot),
          cone_lower: num(r.cone_lower),
          cone_upper: num(r.cone_upper),
          long_trigger: num(r.long_trigger),
          short_trigger: num(r.short_trigger),
        },
      };
    });
  } catch (err) {
    logger.error({ err, parentId }, 'fetchParentChain: query failed');
    Sentry.captureException(err);
    return [];
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
    readTime,
    spotAtReadTime,
    spotSource,
    mode,
    parentId,
    userContext,
    imageUrls,
    proseText,
    fullResponse,
    embedding,
    structured,
    parseOk,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    durationMs,
    autoGenerated = false,
    slotCapturedAt = null,
    status = 'complete',
    failureReason = null,
    panelPayload = null,
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

  // JSONB columns for the new playbook fields. We pre-stringify and
  // cast at the SQL boundary so the Neon tagged template binds
  // unambiguously. trade_types_* default to '[]' when empty so the
  // column NOT NULL constraint is always satisfied.
  const recommendedJson = JSON.stringify(structured.trade_types_recommended);
  const avoidedJson = JSON.stringify(structured.trade_types_avoided);
  // key_levels is nullable; pre-serialize when present so the bound
  // value goes through the JSONB cast as a single string literal.
  const keyLevelsJson =
    structured.key_levels == null
      ? null
      : JSON.stringify(structured.key_levels);
  // panel_payload is the auto-playbook's structured panel JSON. Pre-stringify
  // when present; bind null otherwise so the JSONB cast resolves to NULL.
  const panelPayloadJson =
    panelPayload == null ? null : JSON.stringify(panelPayload);

  try {
    const rows = await sql`
      INSERT INTO periscope_analyses (
        trading_date,
        captured_at,
        read_time,
        spot_at_read_time,
        spot_source,
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
        bias,
        trade_types_recommended,
        trade_types_avoided,
        key_levels,
        expected_dealer_behavior,
        confidence,
        confidence_basis,
        futures_plan,
        parse_ok,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        duration_ms,
        auto_generated,
        slot_captured_at,
        status,
        failure_reason,
        panel_payload
      ) VALUES (
        ${tradingDate},
        ${capturedAt},
        ${readTime},
        ${spotAtReadTime},
        ${spotSource},
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
        ${structured.bias},
        ${recommendedJson}::jsonb,
        ${avoidedJson}::jsonb,
        ${keyLevelsJson}::jsonb,
        ${structured.expected_dealer_behavior},
        ${structured.confidence},
        ${structured.confidence_basis},
        ${structured.futures_plan},
        ${parseOk},
        ${model},
        ${inputTokens},
        ${outputTokens},
        ${cacheReadTokens},
        ${cacheWriteTokens},
        ${durationMs},
        ${autoGenerated},
        ${slotCapturedAt},
        ${status},
        ${failureReason},
        ${panelPayloadJson}::jsonb
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
