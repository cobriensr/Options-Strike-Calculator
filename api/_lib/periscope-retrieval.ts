/**
 * Similarity-based retrieval for /api/periscope-chat.
 *
 * The endpoint passes a query string built from the extracted chart
 * fingerprint (Phase 9: `buildPeriscopeSummary` over spot + cone bounds
 * pulled by a vision-only Opus call). We embed that string and pull
 * the top-K most structurally-similar past reads via pgvector cosine
 * distance. Those analogs are formatted as a third cached system
 * block — separate from the gold-starred calibration examples.
 *
 * Calibration block (Phase 4) and retrieval block (this phase) serve
 * different purposes:
 *   - Calibration: ALL gold-starred reads of the same mode → "match
 *     this format and depth." Shown on every submission with a gold
 *     library.
 *   - Retrieval: top-K similar past reads (any quality) by cosine
 *     similarity to the chart fingerprint → "here's how similar
 *     setups played out." Skipped when extraction failed.
 *
 * We deliberately exclude already-gold-starred rows from retrieval
 * results — those are already in the calibration block. No need to
 * pay for the same prefix twice.
 */

import { getDb } from './db.js';
import { generateEmbedding } from './embeddings.js';
import logger from './logger.js';

const TOP_K = 3;

interface RetrievalRow {
  id: number;
  mode: 'read' | 'debrief';
  regime_tag: string | null;
  trading_date: string;
  prose_text: string;
  similarity: number;
}

/**
 * Fetch the K most-similar past reads of the given mode whose embedding
 * has the smallest cosine distance to the query embedding. Excludes
 * rows already gold-starred (those live in the calibration block) and
 * returns an empty array on any failure (best-effort).
 */
export async function fetchSimilarPastReads(args: {
  mode: 'read' | 'debrief';
  queryEmbedding: number[];
}): Promise<RetrievalRow[]> {
  const { mode, queryEmbedding } = args;
  if (queryEmbedding.length === 0) return [];

  try {
    const sql = getDb();
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;
    // Cosine distance via pgvector's <=> operator. The HNSW index on
    // analysis_embedding (migration 103) makes this query fast even
    // at scale. Filter out rows with no embedding (early failures
    // during generation) and rows that are gold-starred.
    const rows = await sql`
      SELECT id, mode, regime_tag, trading_date, prose_text,
             1 - (analysis_embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM periscope_analyses
      WHERE mode = ${mode}
        AND analysis_embedding IS NOT NULL
        AND (calibration_quality IS NULL OR calibration_quality < 4)
      ORDER BY analysis_embedding <=> ${vectorLiteral}::vector ASC
      LIMIT ${TOP_K}
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      mode: r.mode as 'read' | 'debrief',
      regime_tag: (r.regime_tag as string | null) ?? null,
      trading_date: r.trading_date as string,
      prose_text: (r.prose_text as string) ?? '',
      similarity: r.similarity == null ? 0 : Number(r.similarity),
    }));
  } catch (err) {
    logger.error({ err, mode }, 'fetchSimilarPastReads failed');
    return [];
  }
}

/**
 * Format the retrieval block for injection into the system prompt.
 * Returns null when there are no examples or all similarities are
 * below the floor (prevents injecting truly-unrelated rows).
 */
const EXAMPLE_PROSE_CHARS = 1200;
const SIMILARITY_FLOOR = 0.3; // cosine similarity 0.3+ ≈ "broadly related"

export function formatRetrievalBlock(
  examples: RetrievalRow[],
  mode: 'read' | 'debrief',
): string | null {
  const filtered = examples.filter((e) => e.similarity >= SIMILARITY_FLOOR);
  if (filtered.length === 0) return null;

  const sections = filtered.map((ex, i) => {
    const headerBits = [
      `Example ${i + 1}`,
      `${ex.trading_date}`,
      ex.regime_tag ? `regime: ${ex.regime_tag}` : null,
      `similarity: ${(ex.similarity * 100).toFixed(0)}%`,
    ]
      .filter((s) => s != null)
      .join(' · ');
    const excerpt =
      ex.prose_text.length > EXAMPLE_PROSE_CHARS
        ? `${ex.prose_text.slice(0, EXAMPLE_PROSE_CHARS).trimEnd()}\n\n[…truncated for brevity…]`
        : ex.prose_text;
    return `### ${headerBits}\n\n${excerpt}`;
  });

  return `## Analogous past ${mode}s — retrieved by similarity to your context note

These past analyses had context notes structurally similar to today's. **Use them as historical analogs**, not as templates to mimic. The market structure today may differ; the value here is seeing how analogous setups played out previously.

${sections.join('\n\n---\n\n')}`;
}

/**
 * Convenience wrapper: embed the query text, fetch similar rows,
 * format the block. Returns null when the query is empty, embedding
 * fails, or no rows clear the similarity floor.
 *
 * Caller passes the structural summary built from the extracted
 * chart fingerprint (see `buildPeriscopeSummary` in periscope-db.ts).
 * The wrapper is intentionally agnostic about what the text means —
 * any string in the same embedding space as stored rows works.
 *
 * Cost: one OpenAI embedding call (~$0.0001) per non-empty query.
 * Skipped entirely when the input is empty / null.
 */
export async function buildRetrievalBlock(args: {
  mode: 'read' | 'debrief';
  queryText: string | null | undefined;
}): Promise<string | null> {
  const { mode, queryText } = args;
  if (queryText == null) return null;
  const trimmed = queryText.trim();
  if (trimmed.length === 0) return null;

  let queryEmbedding: number[] | null;
  try {
    queryEmbedding = await generateEmbedding(trimmed);
  } catch (err) {
    logger.error({ err }, 'buildRetrievalBlock: embedding generation failed');
    return null;
  }
  if (queryEmbedding == null || queryEmbedding.length === 0) return null;

  const examples = await fetchSimilarPastReads({ mode, queryEmbedding });
  return formatRetrievalBlock(examples, mode);
}
