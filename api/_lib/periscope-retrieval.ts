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
import type { PeriscopeMode } from './periscope-db.js';
import { toIsoDate } from './periscope-db.js';

const TOP_K = 3;

interface RetrievalRow {
  id: number;
  mode: PeriscopeMode;
  regime_tag: string | null;
  trading_date: string;
  prose_text: string;
  similarity: number;
  /**
   * Signed R-multiple realized on the textbook execution model.
   * Null when not yet computed (post-hoc by ml/src/compute_realized_outcomes.py)
   * OR when neither trigger fired in-session.
   */
  realized_r: number | null;
  /**
   * 'long' / 'short' / 'neither' — which directional thesis fired,
   * if any. Null when realized outcomes have not yet been computed.
   */
  realized_trigger_fired: 'long' | 'short' | 'neither' | null;
}

/**
 * Fetch the K most-similar past reads of the given mode whose embedding
 * has the smallest cosine distance to the query embedding. Excludes
 * rows already gold-starred (those live in the calibration block) and
 * returns an empty array on any failure (best-effort).
 *
 * Phase 6D: the query embedding is now bound ONCE via a CTE rather
 * than embedded twice in the SQL string. The previous shape (a
 * literal `${vectorLiteral}::vector` in both the SELECT projection AND
 * the ORDER BY clause) doubled the parser cost and made it easy for a
 * future edit to drift the two literals apart. The CTE form keeps the
 * vector text in one place and lets the planner reuse it.
 */
export async function fetchSimilarPastReads(args: {
  mode: PeriscopeMode;
  queryEmbedding: number[];
}): Promise<RetrievalRow[]> {
  const { mode, queryEmbedding } = args;
  if (queryEmbedding.length === 0) return [];

  try {
    const sql = getDb();
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;
    const rows = await sql`
      WITH q AS (SELECT ${vectorLiteral}::vector AS v)
      SELECT id, mode, regime_tag, trading_date, prose_text,
             realized_r, realized_trigger_fired,
             1 - (analysis_embedding <=> q.v) AS similarity
      FROM periscope_analyses, q
      WHERE mode = ${mode}
        AND analysis_embedding IS NOT NULL
        AND (calibration_quality IS NULL OR calibration_quality < 4)
      ORDER BY analysis_embedding <=> q.v ASC
      LIMIT ${TOP_K}
    `;
    return rows.map((r) => {
      const rRaw = r.realized_r;
      const realizedR =
        rRaw == null
          ? null
          : Number.isFinite(Number(rRaw))
            ? Number(rRaw)
            : null;
      const fired = r.realized_trigger_fired;
      const realizedFired =
        fired === 'long' || fired === 'short' || fired === 'neither'
          ? fired
          : null;
      return {
        id: Number(r.id),
        mode: r.mode as PeriscopeMode,
        regime_tag: (r.regime_tag as string | null) ?? null,
        trading_date: toIsoDate(r.trading_date),
        prose_text: (r.prose_text as string) ?? '',
        similarity: r.similarity == null ? 0 : Number(r.similarity),
        realized_r: realizedR,
        realized_trigger_fired: realizedFired,
      };
    });
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

/**
 * Render the realized-outcome tag for a retrieval example header.
 *
 *   - `realized_r` populated → signed-1dp R-multiple + winner/loser tag
 *     based on which trigger fired (e.g. `+0.6R, long_winner`).
 *   - `realized_trigger_fired === 'neither'` → `no_trigger` (the read
 *     called a setup, but neither directional level was hit in-session).
 *   - both null → `pending` (post-hoc enrichment hasn't run for the row
 *     yet OR the row predates migration 132 / chose not to compute).
 */
function formatRealizedOutcome(row: RetrievalRow): string {
  if (row.realized_trigger_fired === 'neither') return 'no_trigger';
  if (row.realized_r == null || row.realized_trigger_fired == null) {
    return 'pending';
  }
  const r = row.realized_r;
  const sign = r >= 0 ? '+' : '';
  const wonOrLost = r >= 0 ? 'winner' : 'loser';
  return `${sign}${r.toFixed(1)}R, ${row.realized_trigger_fired}_${wonOrLost}`;
}

export function formatRetrievalBlock(
  examples: RetrievalRow[],
  mode: PeriscopeMode,
): string | null {
  const filtered = examples.filter((e) => e.similarity >= SIMILARITY_FLOOR);
  // Surface raw similarities for tuning even when nothing clears the floor.
  // The output is small (3 numbers) and only logs once per submission.
  logger.info(
    {
      mode,
      similarities: examples.map((e) => Number(e.similarity.toFixed(4))),
      kept: filtered.length,
    },
    'periscope retrieval similarities',
  );
  if (filtered.length === 0) return null;

  const sections = filtered.map((ex, i) => {
    const headerBits = [
      `Example ${i + 1}`,
      `${ex.trading_date}`,
      ex.regime_tag ? `regime: ${ex.regime_tag}` : null,
      `similarity: ${(ex.similarity * 100).toFixed(0)}%`,
      `realized: ${formatRealizedOutcome(ex)}`,
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
  mode: PeriscopeMode;
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
