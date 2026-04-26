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
// SAVE
// ============================================================

export interface SaveTraceLiveAnalysisInput {
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  analysis: TraceAnalysis;
  embedding: number[] | null;
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
