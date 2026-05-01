/**
 * Calibration prompt augmentation for /api/periscope-chat.
 *
 * The user can star past reads (calibration_quality 1-5) to mark them
 * as gold examples of the kind of analysis they want. At submit time,
 * we fetch the top-N gold-starred reads of the same mode and inject
 * them as few-shot examples in the system prompt — a personal style
 * guide that shapes every new submission.
 *
 * Caching strategy:
 *   - The block sits as the SECOND cached system block, AFTER the
 *     skill text. Anthropic supports up to 4 cache breakpoints; using
 *     two keeps headroom for future additions.
 *   - The block changes only when the user stars/unstars a read OR
 *     updates a starred read's regime_tag, both rare on day-to-day
 *     usage. Cache hits stay high.
 *   - Empty (no gold-starred reads) → return null and the endpoint
 *     skips the system block entirely. Graceful for new users.
 *
 * Threshold: only rows with calibration_quality >= 4 count. Three- and
 * four-star reads might not survive a recheck; only 4-5 are durable
 * enough to act as canonical examples.
 *
 * Excluded: debriefs are not paired with reads in the calibration
 * pull. A debrief example is shown only when the current request is
 * also a debrief, and a read example only on read submissions. This
 * keeps the few-shot examples format-matched to the current task.
 */

import { getDb } from './db.js';
import logger from './logger.js';

const TOP_N = 3;
const QUALITY_THRESHOLD = 4;

interface CalibrationExampleRow {
  id: number;
  mode: 'read' | 'debrief';
  regime_tag: string | null;
  calibration_quality: number;
  prose_text: string;
}

/**
 * Fetch the top gold-starred examples for a given mode. Returns at
 * most TOP_N rows with calibration_quality >= QUALITY_THRESHOLD,
 * ordered by quality DESC then created_at DESC. Returns an empty
 * array on any DB error — calibration is best-effort, not load-bearing.
 */
export async function fetchCalibrationExamples(
  mode: 'read' | 'debrief',
): Promise<CalibrationExampleRow[]> {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT id, mode, regime_tag, calibration_quality, prose_text
      FROM periscope_analyses
      WHERE mode = ${mode}
        AND calibration_quality >= ${QUALITY_THRESHOLD}
      ORDER BY calibration_quality DESC, created_at DESC
      LIMIT ${TOP_N}
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      mode: r.mode as 'read' | 'debrief',
      regime_tag: (r.regime_tag as string | null) ?? null,
      calibration_quality: Number(r.calibration_quality),
      prose_text: (r.prose_text as string) ?? '',
    }));
  } catch (err) {
    logger.error({ err, mode }, 'fetchCalibrationExamples failed');
    return [];
  }
}

/**
 * Format the calibration block for injection into the system prompt.
 * Returns null when there are no examples (the endpoint should skip
 * the corresponding system block entirely on null).
 *
 * Each example shows the regime tag (when set) + quality + the first
 * EXAMPLE_PROSE_CHARS of prose. Truncating preserves the format/depth
 * signal Claude needs without ballooning the cached prefix.
 */
const EXAMPLE_PROSE_CHARS = 1500;

export function formatCalibrationBlock(
  examples: CalibrationExampleRow[],
  mode: 'read' | 'debrief',
): string | null {
  if (examples.length === 0) return null;

  const sections = examples.map((ex, i) => {
    const headerBits = [
      `Example ${i + 1}`,
      `${'★'.repeat(ex.calibration_quality)} (${ex.calibration_quality}/5)`,
      ex.regime_tag ? `regime: ${ex.regime_tag}` : null,
    ]
      .filter((s) => s != null)
      .join(' · ');
    const excerpt =
      ex.prose_text.length > EXAMPLE_PROSE_CHARS
        ? `${ex.prose_text.slice(0, EXAMPLE_PROSE_CHARS).trimEnd()}\n\n[…truncated for brevity…]`
        : ex.prose_text;
    return `### ${headerBits}\n\n${excerpt}`;
  });

  return `## Calibration examples — the user's gold-starred past ${mode}s

The user has marked these past analyses as exemplary. **Match this format, depth, and structural read style in your response.** They reflect the kind of analysis the user finds most useful. Treat them as the canonical voice and structure for this kind of analysis — not as inputs to mimic verbatim, but as the calibration target for tone, level of detail, and the way structured fields are integrated into the prose.

${sections.join('\n\n---\n\n')}`;
}

/**
 * Convenience wrapper: fetch + format in one call. Returns the
 * formatted block (string) or null when there are no examples.
 */
export async function buildCalibrationBlock(
  mode: 'read' | 'debrief',
): Promise<string | null> {
  const examples = await fetchCalibrationExamples(mode);
  return formatCalibrationBlock(examples, mode);
}
