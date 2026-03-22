/**
 * Lessons learned CRUD module.
 *
 * Provides functions for managing validated trading lessons:
 *   - getActiveLessons / formatLessonsBlock — read + format for prompt injection
 *   - buildMarketConditions — derive JSONB context from analysis + snapshot rows
 *   - insertLesson / supersedeLesson — write operations
 *   - upsertReport / updateReport — lesson_reports bookkeeping
 */

import { getDb } from './db.js';

// ============================================================
// TYPES
// ============================================================

export interface Lesson {
  id: number;
  text: string;
  sourceDate: string;
  marketConditions: Record<string, unknown> | null;
  tags: string[];
  category: string | null;
}

export interface MarketConditions {
  vix: number | null;
  vix1d: number | null;
  spx: number | null;
  gexRegime: string | null;
  structure: string | null;
  dayOfWeek: string | null;
  wasCorrect: boolean | null;
  confidence: string | null;
  vixTermShape: string | null;
}

export interface InsertLessonParams {
  text: string;
  embedding: number[];
  tags: string[];
  category: string | null;
  marketConditions: Record<string, unknown> | null;
  sourceAnalysisId: number | null;
  sourceDate: string;
}

export interface ReportData {
  reviewsProcessed: number;
  lessonsAdded: number;
  lessonsSuperseded: number;
  lessonsSkipped: number;
  report: Record<string, unknown>;
  error?: string | null;
}

// ============================================================
// READ
// ============================================================

/**
 * Query all active lessons ordered by source_date DESC.
 */
export async function getActiveLessons(): Promise<Lesson[]> {
  const sql = getDb();

  const rows = await sql`
    SELECT id, text, TO_CHAR(source_date, 'YYYY-MM-DD') AS source_date,
           market_conditions, tags, category
    FROM lessons
    WHERE status = 'active'
    ORDER BY source_date DESC
  `;

  return rows.map((row) => ({
    id: row.id as number,
    text: row.text as string,
    sourceDate: row.source_date as string,
    marketConditions:
      (row.market_conditions as Record<string, unknown>) ?? null,
    tags: (row.tags as string[]) ?? [],
    category: (row.category as string) ?? null,
  }));
}

// ============================================================
// FORMAT
// ============================================================

/**
 * Format lessons into a <lessons_learned> XML block for system prompt injection.
 * Returns empty string if no lessons.
 */
export function formatLessonsBlock(lessons: Lesson[]): string {
  if (lessons.length === 0) return '';

  const lines: string[] = [
    '<lessons_learned>',
    'Validated lessons from past trading sessions. Reference by number',
    "when applicable to today's setup. Do not force-apply lessons that",
    "don't match current conditions.",
    '',
  ];

  lessons.forEach((lesson, index) => {
    const context = buildContextString(lesson);
    lines.push(`[${index + 1}] ${context}`);
    lines.push(lesson.text);
    if (lesson.tags.length > 0) {
      lines.push(`Tags: ${lesson.tags.join(', ')}`);
    }
    // Add blank line between lessons (but not after the last one)
    if (index < lessons.length - 1) {
      lines.push('');
    }
  });

  lines.push('</lessons_learned>');

  return lines.join('\n');
}

/**
 * Build the parenthetical context string for a lesson.
 * Omits fields that are missing rather than showing undefined.
 */
function buildContextString(lesson: Lesson): string {
  const mc = lesson.marketConditions;
  if (!mc) return `(${lesson.sourceDate})`;

  const parts: string[] = [];

  if (lesson.sourceDate) parts.push(lesson.sourceDate);
  if (mc.structure != null) parts.push(String(mc.structure));
  if (mc.vix != null) parts.push(`VIX:${mc.vix}`);
  if (mc.gexRegime != null) parts.push(`GEX:${mc.gexRegime}`);
  if (mc.dayOfWeek != null) parts.push(String(mc.dayOfWeek));
  if (mc.wasCorrect != null)
    parts.push(`correct:${mc.wasCorrect ? 'yes' : 'no'}`);

  return `(${parts.join(' | ')})`;
}

// ============================================================
// BUILD MARKET CONDITIONS
// ============================================================

/**
 * Derive the market conditions JSONB from analysis + snapshot source rows.
 * Handles null snapshots gracefully.
 */
export function buildMarketConditions(
  analysisRow: Record<string, unknown>,
  snapshotRow: Record<string, unknown> | null,
): MarketConditions {
  const fullResponse =
    typeof analysisRow.full_response === 'string'
      ? (JSON.parse(analysisRow.full_response) as Record<string, unknown>)
      : ((analysisRow.full_response as Record<string, unknown>) ?? {});

  const review = (fullResponse.review as Record<string, unknown>) ?? {};

  return {
    vix: snapshotRow?.vix != null ? Number(snapshotRow.vix) : null,
    vix1d: snapshotRow?.vix1d != null ? Number(snapshotRow.vix1d) : null,
    spx: analysisRow.spx != null ? Number(analysisRow.spx) : null,
    gexRegime:
      snapshotRow?.regime_zone != null ? String(snapshotRow.regime_zone) : null,
    structure:
      analysisRow.structure != null ? String(analysisRow.structure) : null,
    dayOfWeek:
      snapshotRow?.dow_label != null ? String(snapshotRow.dow_label) : null,
    wasCorrect: review.wasCorrect != null ? Boolean(review.wasCorrect) : null,
    confidence:
      analysisRow.confidence != null ? String(analysisRow.confidence) : null,
    vixTermShape:
      snapshotRow?.vix_term_signal != null
        ? String(snapshotRow.vix_term_signal)
        : null,
  };
}

// ============================================================
// WRITE
// ============================================================

/**
 * Insert a new lesson row. Returns the new lesson ID.
 */
export async function insertLesson(
  params: InsertLessonParams,
): Promise<number> {
  const sql = getDb();

  const embeddingStr = `[${params.embedding.join(',')}]`;

  const rows = await sql`
    INSERT INTO lessons (
      text, embedding, tags, category,
      market_conditions, source_analysis_id, source_date
    ) VALUES (
      ${params.text},
      ${embeddingStr}::vector,
      ${params.tags},
      ${params.category},
      ${params.marketConditions ? JSON.stringify(params.marketConditions) : null},
      ${params.sourceAnalysisId},
      ${params.sourceDate}
    )
    RETURNING id
  `;

  return rows[0]!.id as number;
}

/**
 * Supersede an old lesson with a new one in a single transaction.
 *
 * The Neon HTTP driver does NOT have sql.begin(). We:
 * 1. Pre-allocate the new ID via nextval() outside the transaction
 * 2. Use sql.transaction() to batch INSERT + UPDATE atomically
 */
export async function supersedeLesson(
  newLesson: InsertLessonParams,
  oldLessonId: number,
): Promise<number> {
  const sql = getDb();

  // Step 1: Pre-allocate the new lesson ID
  const seqRows = await sql`SELECT nextval('lessons_id_seq') AS id`;
  const newId = Number(seqRows[0]!.id);

  const embeddingStr = `[${newLesson.embedding.join(',')}]`;

  // Step 2: Atomic transaction — INSERT new lesson + UPDATE old lesson
  await sql.transaction([
    sql`
      INSERT INTO lessons (
        id, text, embedding, tags, category,
        market_conditions, source_analysis_id, source_date
      ) VALUES (
        ${newId},
        ${newLesson.text},
        ${embeddingStr}::vector,
        ${newLesson.tags},
        ${newLesson.category},
        ${newLesson.marketConditions ? JSON.stringify(newLesson.marketConditions) : null},
        ${newLesson.sourceAnalysisId},
        ${newLesson.sourceDate}
      )
    `,
    sql`
      UPDATE lessons
      SET status = 'superseded',
          superseded_by = ${newId},
          superseded_at = NOW()
      WHERE id = ${oldLessonId}
    `,
  ]);

  return newId;
}

// ============================================================
// REPORTS
// ============================================================

/**
 * Bootstrap a report row using ON CONFLICT upsert.
 * Used at cron start for crash observability.
 */
export async function upsertReport(weekEnding: string): Promise<void> {
  const sql = getDb();

  await sql`
    INSERT INTO lesson_reports (week_ending)
    VALUES (${weekEnding})
    ON CONFLICT (week_ending) DO UPDATE SET created_at = NOW()
  `;
}

/**
 * Update the report row with final counts and JSONB changelog.
 */
export async function updateReport(
  weekEnding: string,
  data: ReportData,
): Promise<void> {
  const sql = getDb();

  await sql`
    UPDATE lesson_reports
    SET reviews_processed = ${data.reviewsProcessed},
        lessons_added = ${data.lessonsAdded},
        lessons_superseded = ${data.lessonsSuperseded},
        lessons_skipped = ${data.lessonsSkipped},
        report = ${JSON.stringify(data.report)},
        error = ${data.error ?? null}
    WHERE week_ending = ${weekEnding}
  `;
}
