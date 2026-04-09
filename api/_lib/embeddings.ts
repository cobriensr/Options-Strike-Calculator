/**
 * OpenAI embeddings helper for the lessons-learned and analysis retrieval systems.
 *
 * Provides:
 *   generateEmbedding()       — convert text to a 2000-d vector via text-embedding-3-large
 *   findSimilarLessons()      — cosine-similarity search over the lessons table
 *   buildAnalysisSummary()    — build structured text summary for analysis embedding
 *   findSimilarAnalyses()     — cosine-similarity search over the analyses table
 *   saveAnalysisEmbedding()   — persist an embedding vector on an analysis row
 *
 * Install: npm install openai
 */

import OpenAI from 'openai';
import { getDb } from './db.js';
import logger from './logger.js';
import { metrics, Sentry } from './sentry.js';

// ============================================================
// OPENAI CLIENT (lazy singleton, same pattern as db.ts)
// ============================================================

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  _client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/** Reset the cached OpenAI client. Exported for tests only. */
export function _resetClient() {
  _client = null;
}

// ============================================================
// GENERATE EMBEDDING
// ============================================================

/**
 * Generate a 2000-dimension embedding vector for the given text
 * using OpenAI's text-embedding-3-large model with truncated dimensions.
 *
 * Uses 2000 dimensions (instead of the full 3072) to stay within
 * Neon pgvector's HNSW index limit of 2000 dimensions while retaining
 * most of the large model's accuracy advantage over text-embedding-3-small.
 *
 * Returns null on any error (API timeout, network failure, missing key).
 */
export async function generateEmbedding(
  text: string,
): Promise<number[] | null> {
  try {
    const response = await getClient().embeddings.create({
      model: 'text-embedding-3-large',
      input: text,
      dimensions: 2000,
    });
    return response.data[0]?.embedding ?? null;
  } catch (err) {
    logger.error({ err }, 'Embedding generation failed');
    metrics.increment('embeddings.generation_error');
    Sentry.captureException(err);
    return null;
  }
}

// ============================================================
// FIND SIMILAR LESSONS
// ============================================================

export interface SimilarLesson {
  id: number;
  text: string;
  tags: string[];
  category: string | null;
  sourceDate: string;
  distance: number;
}

/**
 * Query the lessons table for the N most similar active lessons
 * by cosine distance (using the HNSW index on the embedding column).
 */
export async function findSimilarLessons(
  embedding: number[],
  limit: number = 5,
): Promise<SimilarLesson[]> {
  if (!embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('Invalid embedding: all values must be finite numbers');
  }
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await sql`
    SELECT id, text, tags, category, source_date,
           embedding <=> ${vectorLiteral}::vector AS distance
    FROM lessons
    WHERE status = 'active'
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${safeLimit}
  `;

  return rows.map((row) => ({
    id: row.id as number,
    text: row.text as string,
    tags: row.tags as string[],
    category: (row.category as string) ?? null,
    sourceDate: row.source_date as string,
    distance: Number(row.distance),
  }));
}

// ============================================================
// ANALYSIS EMBEDDING — SUMMARY BUILDER
// ============================================================

export interface AnalysisSummaryInput {
  date: string;
  mode: string;
  vix: number | null;
  vix1d: number | null;
  spx: number | null;
  structure: string;
  confidence: string;
  suggestedDelta: number | null;
  hedge: string | null;
  // Optional fields from market_snapshots (available during backfill)
  vixTermShape?: string | null;
  gexRegime?: string | null;
  dayOfWeek?: string | null;
  // Optional outcome fields (available post-settlement or backfill)
  settlement?: number | null;
  wasCorrect?: boolean | null;
}

/**
 * Build a structured text summary of an analysis for embedding.
 *
 * The format is pipe-delimited key:value pairs, ordered so that
 * market state fields come first (driving retrieval similarity)
 * and recommendation/outcome fields come second.
 *
 * This text is embedded via generateEmbedding() and stored on the
 * analyses row for cosine-similarity retrieval of analogous days.
 */
export function buildAnalysisSummary(input: AnalysisSummaryInput): string {
  const parts: string[] = [];

  // Market state (drives similarity)
  parts.push(`date:${input.date}`);
  parts.push(`mode:${input.mode}`);
  if (input.vix != null) parts.push(`VIX:${input.vix}`);
  if (input.vix1d != null) parts.push(`VIX1D:${input.vix1d}`);
  if (input.spx != null) parts.push(`SPX:${input.spx}`);
  if (input.vixTermShape) parts.push(`term:${input.vixTermShape}`);
  if (input.gexRegime) parts.push(`GEX:${input.gexRegime}`);
  if (input.dayOfWeek) parts.push(`dow:${input.dayOfWeek}`);

  // Recommendation
  parts.push(`structure:${input.structure}`);
  if (input.suggestedDelta != null) parts.push(`delta:${input.suggestedDelta}`);
  parts.push(`confidence:${input.confidence}`);
  if (input.hedge) parts.push(`hedge:${input.hedge}`);

  // Outcome (only present after settlement or during backfill)
  if (input.settlement != null) parts.push(`settlement:${input.settlement}`);
  if (input.wasCorrect != null)
    parts.push(`correct:${input.wasCorrect ? 'yes' : 'no'}`);

  return parts.join(' | ');
}

// ============================================================
// ANALYSIS EMBEDDING — SAVE
// ============================================================

/**
 * Persist an embedding vector on an analysis row.
 * Uses the analysis's (date, entry_time, mode) as the lookup key
 * since analyses don't return their ID from saveAnalysis().
 */
export async function saveAnalysisEmbedding(
  date: string,
  entryTime: string,
  mode: string,
  embedding: number[],
): Promise<void> {
  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  await sql`
    UPDATE analyses
    SET analysis_embedding = ${vectorLiteral}::vector
    WHERE date = ${date} AND entry_time = ${entryTime} AND mode = ${mode}
      AND analysis_embedding IS NULL
  `;
}

// ============================================================
// ANALYSIS EMBEDDING — FIND SIMILAR
// ============================================================

export interface SimilarAnalysis {
  id: number;
  date: string;
  mode: string;
  structure: string;
  confidence: string;
  suggestedDelta: number;
  spx: number | null;
  vix: number | null;
  hedge: string | null;
  reasoning: string | null;
  settlement: number | null;
  wasCorrect: boolean | null;
  distance: number;
}

/**
 * Find the N most similar historical analyses by embedding cosine distance.
 * Joins with outcomes to include settlement data when available.
 * Excludes analyses from the given date (no self-matching on today).
 */
export async function findSimilarAnalyses(
  embedding: number[],
  excludeDate: string,
  limit: number = 3,
): Promise<SimilarAnalysis[]> {
  if (!embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('Invalid embedding: all values must be finite numbers');
  }
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 10);
  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await sql`
    SELECT a.id, a.date, a.mode, a.structure, a.confidence,
           a.suggested_delta, a.spx, a.vix, a.hedge,
           a.full_response->>'reasoning' AS reasoning,
           o.settlement,
           (a.full_response->'review'->>'wasCorrect')::boolean AS was_correct,
           a.analysis_embedding <=> ${vectorLiteral}::vector AS distance
    FROM analyses a
    LEFT JOIN outcomes o ON o.date = a.date
    WHERE a.analysis_embedding IS NOT NULL
      AND a.date != ${excludeDate}
      AND a.mode = 'entry'
    ORDER BY a.analysis_embedding <=> ${vectorLiteral}::vector
    LIMIT ${safeLimit}
  `;

  return rows.map((row) => ({
    id: row.id as number,
    date: row.date as string,
    mode: row.mode as string,
    structure: row.structure as string,
    confidence: row.confidence as string,
    suggestedDelta: Number(row.suggested_delta),
    spx: row.spx == null ? null : Number(row.spx),
    vix: row.vix == null ? null : Number(row.vix),
    hedge: (row.hedge as string) ?? null,
    reasoning: (row.reasoning as string) ?? null,
    settlement: row.settlement == null ? null : Number(row.settlement),
    wasCorrect: row.was_correct == null ? null : Boolean(row.was_correct),
    distance: Number(row.distance),
  }));
}

// ============================================================
// ANALYSIS EMBEDDING — FORMAT FOR CLAUDE
// ============================================================

/**
 * Format similar analyses into a context block for Claude prompt injection.
 * Returns empty string if no similar analyses found.
 */
export function formatSimilarAnalysesBlock(
  analyses: SimilarAnalysis[],
): string {
  if (analyses.length === 0) return '';

  const lines: string[] = [
    '<similar_past_analyses>',
    'Historical analyses from days with similar market conditions.',
    'Use these as reference — do not copy recommendations blindly.',
    '',
  ];

  for (const a of analyses) {
    const outcomeStr =
      a.settlement != null
        ? `Settlement: ${a.settlement}` +
          (a.wasCorrect != null
            ? ` | Correct: ${a.wasCorrect ? 'yes' : 'no'}`
            : '')
        : 'Outcome: pending';

    lines.push(
      `[${a.date}] ${a.structure} ${a.suggestedDelta}Δ | ` +
        `Confidence: ${a.confidence} | ` +
        `SPX: ${a.spx ?? 'N/A'} | VIX: ${a.vix ?? 'N/A'}`,
    );
    lines.push(`  ${outcomeStr}`);
    if (a.hedge) lines.push(`  Hedge: ${a.hedge}`);
    if (a.reasoning) {
      const truncated =
        a.reasoning.length > 200
          ? a.reasoning.slice(0, 200) + '…'
          : a.reasoning;
      lines.push(`  Reasoning: ${truncated}`);
    }
    lines.push('');
  }

  lines.push('</similar_past_analyses>');
  return lines.join('\n');
}
