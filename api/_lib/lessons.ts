/**
 * Lessons learned CRUD module.
 *
 * Provides functions for managing validated trading lessons:
 *   - getActiveLessons / formatLessonsBlock — read + format for prompt injection
 *   - buildMarketConditions — derive JSONB context from analysis + snapshot rows
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
 * Maximum number of active lessons returned by `getActiveLessons()`.
 * Bounds the size of the lessons block injected into the analyze prompt
 * so a multi-year backlog can't silently inflate token cost. Recency
 * wins ties because the curator emits one new lesson per Friday review.
 */
export const MAX_ACTIVE_LESSONS = 20;

/**
 * Per-lesson character cap applied in `formatLessonsBlock()`. Safety net
 * against a single verbose lesson consuming disproportionate prompt
 * cache space — actual curated lessons should be 1–3 sentences.
 */
export const MAX_LESSON_CHARS_EACH = 500;

/**
 * Query the most recent active lessons, ordered source_date DESC and
 * capped at MAX_ACTIVE_LESSONS. The curator (`curate-lessons.ts`) does
 * NOT call this — it manages the full active set directly via its own
 * queries — so the cap only affects analyze-context injection.
 */
export async function getActiveLessons(): Promise<Lesson[]> {
  const sql = getDb();

  const rows = await sql`
    SELECT id, text, TO_CHAR(source_date, 'YYYY-MM-DD') AS source_date,
           market_conditions, tags, category
    FROM lessons
    WHERE status = 'active'
    ORDER BY source_date DESC
    LIMIT ${MAX_ACTIVE_LESSONS}
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
// HISTORICAL WIN RATE
// ============================================================

export interface WinRateResult {
  total: number;
  wins: number;
  winRate: number;
  avgVix: number | null;
  structures: string[];
}

/**
 * Query historical win rate for lessons matching similar market conditions.
 * Matches on VIX range (±5), GEX regime, structure, and day of week.
 * Returns null if fewer than 5 matching sessions (insufficient sample).
 */
export async function getHistoricalWinRate(conditions: {
  vix?: number | undefined;
  gexRegime?: string | undefined;
  structure?: string | undefined;
  dayOfWeek?: string | undefined;
}): Promise<WinRateResult | null> {
  const sql = getDb();

  // SECURITY: prior version string-concatenated `conditions.gexRegime`
  // etc. into a SQL fragment that was then run via `sql.unsafe(...)`.
  // Even though the endpoint is owner-gated, the values originate from
  // `req.body.context` (typed as `z.record(z.string(), z.unknown())`
  // — no Zod constraints on the string values), so a single quote in
  // any value would corrupt the query and a malicious value would have
  // been a textbook SQL injection. Audit finding 2026-05-19.
  //
  // Fix: bind every value through a `$N` parameter via the Neon tagged
  // template. The optional filters use the
  // `(${param}::T IS NULL OR col = ${param})` idiom so a NULL bind
  // short-circuits to TRUE without any string templating.
  const vixLo = conditions.vix != null ? Math.floor(conditions.vix - 5) : null;
  const vixHi = conditions.vix != null ? Math.ceil(conditions.vix + 5) : null;
  const gexRegime = conditions.gexRegime ?? null;
  const structure = conditions.structure ?? null;
  const dayOfWeek = conditions.dayOfWeek ?? null;

  const rows = (await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE (market_conditions->>'wasCorrect')::boolean = true)::int AS wins,
      AVG((market_conditions->>'vix')::numeric)::numeric AS avg_vix,
      ARRAY_AGG(DISTINCT market_conditions->>'structure') AS structures
    FROM lessons
    WHERE status = 'active'
      AND market_conditions->>'wasCorrect' IS NOT NULL
      AND (
        ${vixLo}::numeric IS NULL
        OR (market_conditions->>'vix')::numeric
             BETWEEN ${vixLo}::numeric AND ${vixHi}::numeric
      )
      AND (
        ${gexRegime}::text IS NULL
        OR market_conditions->>'gexRegime' = ${gexRegime}
      )
      AND (
        ${structure}::text IS NULL
        OR market_conditions->>'structure' = ${structure}
      )
      AND (
        ${dayOfWeek}::text IS NULL
        OR market_conditions->>'dayOfWeek' = ${dayOfWeek}
      )
  `) as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row || (row.total as number) < 5) return null;

  const total = row.total as number;
  const wins = row.wins as number;

  return {
    total,
    wins,
    winRate: Math.round((wins / total) * 100),
    avgVix:
      row.avg_vix == null ? null : Math.round(Number(row.avg_vix) * 10) / 10,
    structures: (row.structures as string[]) ?? [],
  };
}

/**
 * Format win rate data for Claude context injection.
 */
export function formatWinRateForClaude(
  result: WinRateResult,
  conditions: {
    vix?: number | undefined;
    gexRegime?: string | undefined;
    structure?: string | undefined;
    dayOfWeek?: string | undefined;
  },
): string {
  const condParts: string[] = [];
  if (conditions.vix != null)
    condParts.push(
      `VIX ${Math.floor(conditions.vix - 5)}-${Math.ceil(conditions.vix + 5)}`,
    );
  if (conditions.gexRegime) condParts.push(`GEX: ${conditions.gexRegime}`);
  if (conditions.structure) condParts.push(conditions.structure);
  if (conditions.dayOfWeek) condParts.push(conditions.dayOfWeek);

  let signal: string;
  if (result.winRate >= 75)
    signal = 'Supports upgrading confidence by one level.';
  else if (result.winRate >= 50)
    signal = 'No confidence adjustment — historical rate is neutral.';
  else signal = 'Supports downgrading confidence by one level.';

  return [
    `Historical Base Rate (${condParts.join(', ')}):`,
    `  Matching sessions: ${result.total}`,
    `  Win rate: ${result.winRate}% (${result.wins}/${result.total})`,
    `  Avg VIX: ${result.avgVix ?? 'N/A'}`,
    `  Signal: ${signal}`,
  ].join('\n');
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
    const text =
      lesson.text.length > MAX_LESSON_CHARS_EACH
        ? lesson.text.slice(0, MAX_LESSON_CHARS_EACH - 1) + '…'
        : lesson.text;
    lines.push(`[${index + 1}] ${context}`, text);
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
  if (mc.vix != null) parts.push(`VIX:${String(mc.vix)}`);
  if (mc.gexRegime != null) parts.push(`GEX:${String(mc.gexRegime)}`);
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
    vix: snapshotRow?.vix == null ? null : Number(snapshotRow.vix),
    vix1d: snapshotRow?.vix1d == null ? null : Number(snapshotRow.vix1d),
    spx: analysisRow.spx == null ? null : Number(analysisRow.spx),
    gexRegime:
      snapshotRow?.regime_zone == null ? null : String(snapshotRow.regime_zone),
    structure:
      analysisRow.structure == null ? null : String(analysisRow.structure),
    dayOfWeek:
      snapshotRow?.dow_label == null ? null : String(snapshotRow.dow_label),
    wasCorrect: review.wasCorrect == null ? null : Boolean(review.wasCorrect),
    confidence:
      analysisRow.confidence == null ? null : String(analysisRow.confidence),
    vixTermShape:
      snapshotRow?.vix_term_signal == null
        ? null
        : String(snapshotRow.vix_term_signal),
  };
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
