/**
 * Persistence layer for /api/trace-live-analyze.
 *
 * Mirrors the analyses-table pattern from `embeddings.ts`:
 *
 *   1. `buildTraceLiveSummary()` — pipe-delimited key:value pairs that
 *      describe the *market state* (regime, gamma sign, charm direction,
 *      override fires, predicted close) so embeddings cluster on chart
 *      topology, not headline text or warnings.
 *   2. `saveTraceLiveAnalysis()` — single INSERT including the embedding
 *      vector. Unlike `saveAnalysis()` which inserts then updates the
 *      embedding separately, we have the embedding in hand at write time
 *      for these short-lived ticks; one round-trip is enough.
 *
 * No streaming, no retry loop here — the caller in trace-live-analyze.ts
 * decides how to react to a failed save (the analysis is still returned
 * to the client; the DB row is best-effort).
 */

import { getDb } from './db.js';
import logger from './logger.js';
import { metrics, Sentry } from './sentry.js';
import type { TraceAnalysis } from './trace-live-types.js';
import type { TraceLiveImageUrls } from './trace-live-blob.js';

// ============================================================
// SUMMARY BUILDER (for embedding text)
// ============================================================

/**
 * Pipe-delimited textual summary of a TRACE-live tick. The embedding
 * generated from this string is what drives "find similar past ticks"
 * retrieval. Order matters: drivers of trade behavior come first, narrative
 * fields (headline, warnings) are excluded so embeddings don't cluster on
 * boilerplate phrasing.
 *
 * Example:
 *   "ts:2026-04-25T18:35:00Z | spot:6612.40 | stab:67.0 |
 *    regime:range_bound_positive_gamma | gamma:positive_strong |
 *    dom:6605@5.5B/12.3x | override:true | charm:red/short |
 *    junction:6610 | corridor:6595..6630 | conf:high |
 *    predict:6605 | trade:iron_fly@6605/full"
 */
export function buildTraceLiveSummary(args: {
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  analysis: TraceAnalysis;
}): string {
  const { capturedAt, spot, stabilityPct, analysis } = args;
  const { charm, gamma, delta, synthesis } = analysis;

  const parts: string[] = [];
  parts.push(`ts:${capturedAt}`);
  parts.push(`spot:${spot.toFixed(2)}`);
  if (stabilityPct != null) parts.push(`stab:${stabilityPct.toFixed(1)}`);

  parts.push(`regime:${analysis.regime}`);
  parts.push(`gamma:${gamma.signAtSpot}`);
  if (
    gamma.dominantNodeStrike != null &&
    gamma.dominantNodeMagnitudeB != null
  ) {
    const ratio =
      gamma.dominantNodeRatio != null
        ? `${gamma.dominantNodeRatio.toFixed(1)}x`
        : 'inf';
    parts.push(
      `dom:${gamma.dominantNodeStrike}@${gamma.dominantNodeMagnitudeB.toFixed(2)}B/${ratio}`,
    );
  }
  parts.push(`override:${gamma.overrideFires ? 'true' : 'false'}`);
  if (gamma.floorStrike != null) parts.push(`floor:${gamma.floorStrike}`);
  if (gamma.ceilingStrike != null) parts.push(`ceil:${gamma.ceilingStrike}`);

  parts.push(`charm:${charm.predominantColor}/${charm.direction}`);
  if (charm.junctionStrike != null)
    parts.push(`junction:${charm.junctionStrike}`);
  if (charm.flipFlopDetected) parts.push('flipflop:true');
  if (charm.rejectionWicksAtRed) parts.push('wicks:true');

  parts.push(`zone:${delta.zoneBehavior}`);
  if (delta.blueBelowStrike != null && delta.redAboveStrike != null) {
    parts.push(`corridor:${delta.blueBelowStrike}..${delta.redAboveStrike}`);
  }

  parts.push(`conf:${synthesis.confidence}`);
  parts.push(`agree:${synthesis.crossChartAgreement}`);
  parts.push(`predict:${synthesis.predictedClose.toFixed(2)}`);
  parts.push(`trade:${synthesis.trade.type}/${synthesis.trade.size}`);
  if (synthesis.trade.centerStrike != null) {
    parts.push(`center:${synthesis.trade.centerStrike}`);
  }

  return parts.join(' | ');
}

// ============================================================
// NOVELTY SCORE
// ============================================================

/**
 * Number of nearest historical embeddings to look at when computing the
 * novelty score. The score is the cosine distance to the k-th nearest
 * neighbor — k=20 means "is this setup further than 20 historical
 * setups have ever been?"
 *
 * Higher k reduces noise (a single weird neighbor doesn't dominate);
 * too high a k requires more history before the score is meaningful.
 * 20 is a balance: meaningful after ~100 captures, noise-resistant
 * once the corpus grows.
 */
const NOVELTY_K = 20;

/**
 * Compute the novelty score for a new tick by querying the k-th nearest
 * neighbor's cosine distance against the historical embedding corpus.
 *
 * Returns null when:
 *   - The new embedding itself is null (embedding generation failed)
 *   - Fewer than NOVELTY_K historical rows exist (insufficient corpus)
 *   - The query throws (treated as best-effort — don't block the save)
 *
 * Higher score = more novel. Cosine distance ranges 0 (identical) to
 * 2 (opposite); typical TRACE-live embeddings cluster in [0.05, 0.4]
 * for similar-regime captures. A novelty > 0.5 against the 20th
 * neighbor is genuinely "we've never seen this" terrain.
 */
async function computeNoveltyScore(
  embedding: number[] | null,
): Promise<number | null> {
  if (!embedding || embedding.length === 0) return null;
  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;
  try {
    // OFFSET k-1 LIMIT 1 returns the k-th-nearest neighbor's distance.
    // The HNSW index serves this efficiently — pgvector pushes the limit
    // through the ORDER BY when the operator class matches the index.
    const rows = await sql`
      SELECT (analysis_embedding <=> ${vectorLiteral}::vector)::float8 AS distance
      FROM trace_live_analyses
      WHERE analysis_embedding IS NOT NULL
      ORDER BY analysis_embedding <=> ${vectorLiteral}::vector
      LIMIT 1 OFFSET ${NOVELTY_K - 1}
    `;
    if (rows.length === 0) return null; // Fewer than NOVELTY_K historical rows.
    return Number(rows[0]!.distance);
  } catch (err) {
    logger.warn({ err }, 'computeNoveltyScore failed; saving without score');
    Sentry.captureException(err);
    return null;
  }
}

// ============================================================
// SAVE
// ============================================================

export interface SaveTraceLiveAnalysisInput {
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  analysis: TraceAnalysis;
  embedding: number[] | null;
  /** Sparse map of {chart: blobUrl}. Empty / partial / null all valid. */
  imageUrls?: TraceLiveImageUrls;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number;
}

/**
 * Persist a single TRACE-live tick to Postgres. Returns the new row id
 * on success, or null on any failure (caller decides what to do).
 */
export async function saveTraceLiveAnalysis(
  input: SaveTraceLiveAnalysisInput,
): Promise<number | null> {
  const sql = getDb();
  const {
    capturedAt,
    spot,
    stabilityPct,
    analysis,
    embedding,
    imageUrls,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    durationMs,
  } = input;

  // pgvector accepts a `[v1,v2,...]::vector` literal for non-null inserts and
  // a plain SQL NULL when the embedding generation failed. We pass the string
  // (or null) through Neon's parameter binding and apply ::vector unconditionally
  // — `NULL::vector` is valid Postgres and stays NULL.
  const vectorLiteral =
    embedding && embedding.length > 0 ? `[${embedding.join(',')}]` : null;

  // image_urls is jsonb. Empty / undefined / null all coalesce to NULL in the
  // column, which the read endpoints handle by returning {} to the frontend.
  const imageUrlsJson =
    imageUrls && Object.keys(imageUrls).length > 0
      ? JSON.stringify(imageUrls)
      : null;

  // Compute novelty BEFORE the insert so the new row's own embedding doesn't
  // count against itself. Best-effort: a failure here returns null and the
  // row still saves — drift detection is a defense-in-depth signal, not
  // load-bearing for the analysis itself.
  const noveltyScore = await computeNoveltyScore(embedding);

  try {
    const rows = await sql`
      INSERT INTO trace_live_analyses (
        captured_at,
        spot,
        stability_pct,
        regime,
        predicted_close,
        confidence,
        override_applied,
        headline,
        full_response,
        analysis_embedding,
        image_urls,
        novelty_score,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        duration_ms
      ) VALUES (
        ${capturedAt},
        ${spot},
        ${stabilityPct},
        ${analysis.regime},
        ${analysis.synthesis.predictedClose},
        ${analysis.synthesis.confidence},
        ${analysis.synthesis.overrideApplied},
        ${analysis.synthesis.headline},
        ${JSON.stringify(analysis)}::jsonb,
        ${vectorLiteral}::vector,
        ${imageUrlsJson}::jsonb,
        ${noveltyScore},
        ${model},
        ${inputTokens},
        ${outputTokens},
        ${cacheReadTokens},
        ${cacheWriteTokens},
        ${durationMs}
      )
      RETURNING id
    `;
    metrics.dbSave('trace_live_analyses', true);
    return rows.length > 0 ? (rows[0]!.id as number) : null;
  } catch (err) {
    metrics.dbSave('trace_live_analyses', false);
    logger.error({ err }, 'saveTraceLiveAnalysis failed');
    Sentry.captureException(err);
    return null;
  }
}
