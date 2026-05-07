/**
 * Periscope lessons curation primitives.
 *
 * Mirrors the analyze `lessons.ts` shape but specialized for the
 * periscope debrief surface. Each periscope `mode='debrief'` row's
 * prose contains a "## What to add to the model" section; this module
 * extracts the bullet items, embeds them, dedupes against the existing
 * `periscope_lessons` table via cosine similarity, and either merges
 * (increment `citation_count`, append `source_id`) or inserts a new
 * `proposed` row.
 *
 * Active rows (manually promoted in MVP) are formatted as a
 * "## Recent lessons learned" markdown sub-section that gets appended
 * to the cached references block in `api/periscope-chat.ts`.
 *
 * See: docs/superpowers/specs/periscope-curate-lessons-2026-05-06.md
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db.js';
import logger from './logger.js';
import { Sentry } from './sentry.js';

// ============================================================
// TYPES
// ============================================================

export type PeriscopeLessonStatus = 'proposed' | 'active' | 'archived';

export interface PeriscopeLessonRow {
  id: number;
  lesson_text: string;
  source_ids: number[];
  status: PeriscopeLessonStatus;
  citation_count: number;
  created_at: string;
}

export interface UnprocessedDebrief {
  id: number;
  prose_text: string;
}

// ============================================================
// FETCH ACTIVE LESSONS (read-side, for injection)
// ============================================================

/**
 * Pull active lessons for injection into the cached references block.
 * Sorted by citation_count DESC, created_at DESC so the most-cited
 * heuristics appear first. Limit caps the active set; the cron also
 * enforces a 15-row active cap on promotion.
 */
export async function fetchActiveLessons(
  limit: number,
): Promise<PeriscopeLessonRow[]> {
  const sql = getDb();
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);

  const rows = await sql`
    SELECT id, lesson_text, source_ids, status, citation_count,
           created_at
    FROM periscope_lessons
    WHERE status = 'active'
    ORDER BY citation_count DESC, created_at DESC
    LIMIT ${safeLimit}
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    lesson_text: String(row.lesson_text),
    source_ids: ((row.source_ids as unknown[] | null) ?? []).map((n) =>
      Number(n),
    ),
    status: row.status as PeriscopeLessonStatus,
    citation_count: Number(row.citation_count),
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  }));
}

// ============================================================
// FETCH UNPROCESSED DEBRIEFS (cron-side, for extraction)
// ============================================================

/**
 * Pull debriefs since the cutoff that haven't been processed yet.
 * "Processed" = the debrief id appears in any existing
 * `periscope_lessons.source_ids` array. Uses the GIN-less array
 * containment check via `ANY(source_ids)` — at MVP volume (<=30 rows
 * total) this is fine without a dedicated index. If the lessons table
 * grows substantially, add a GIN index on `source_ids` and switch to
 * `source_ids @> ARRAY[id]`.
 */
export async function fetchUnprocessedDebriefs(
  sinceIso: string,
): Promise<UnprocessedDebrief[]> {
  const sql = getDb();

  const rows = await sql`
    SELECT pa.id, pa.prose_text
    FROM periscope_analyses pa
    WHERE pa.mode = 'debrief'
      AND pa.created_at >= ${sinceIso}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM periscope_lessons pl
        WHERE pa.id = ANY(pl.source_ids)
      )
    ORDER BY pa.created_at ASC
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    prose_text: String(row.prose_text ?? ''),
  }));
}

// ============================================================
// EXTRACTION - REGEX
// ============================================================

const HEADING_REGEX = /^#{1,6}\s+what to add to the model\b[^\n]*$/im;

/**
 * Regex-extract bullet items under the "## What to add to the model"
 * heading. Returns empty array when the heading is absent or no
 * bullets follow it. Stops at the next markdown heading (`#`-prefixed)
 * or end-of-string.
 *
 * Matches both `-`, `*`, and `+` bullet markers and tolerates indent
 * up to 4 spaces. Multi-line bullets (continuation lines indented
 * under the marker) are joined into a single candidate text.
 */
export function extractCandidatesViaRegex(prose: string): string[] {
  if (!prose) return [];

  const headingMatch = HEADING_REGEX.exec(prose);
  if (!headingMatch) return [];

  // Slice from end of the heading line to either the next markdown
  // heading or end-of-text.
  const after = prose.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIdx = after.search(/^#{1,6}\s+/m);
  const section = nextHeadingIdx >= 0 ? after.slice(0, nextHeadingIdx) : after;

  const lines = section.split('\n');
  const bullets: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const merged = current.join(' ').replace(/\s+/g, ' ').trim();
    if (merged.length > 0) bullets.push(merged);
    current = [];
  };

  // Anchored, atomic-style classes throughout — no `.+` backtracking
  // (sonarjs/slow-regex). Bullet markers must sit within first 4 spaces;
  // continuation lines must start with 2+ spaces and a non-space.
  const BULLET = /^ {0,4}[-*+] +\S/;
  const CONTINUATION = /^ {2,}\S/;
  for (const line of lines) {
    if (BULLET.test(line)) {
      flush();
      // Drop the leading marker + whitespace; everything after is the
      // bullet body. Slice rather than capture to keep the regex atomic.
      const markerIdx = line.search(/[-*+]/);
      // Skip marker + at least one space.
      const bodyStart = markerIdx >= 0 ? markerIdx + 2 : 0;
      current.push(line.slice(bodyStart).trim());
      continue;
    }
    // Continuation line of an existing bullet (indented, non-empty).
    if (CONTINUATION.test(line) && current.length > 0) {
      current.push(line.trim());
      continue;
    }
    // Blank line or non-bullet text - flush the current bullet.
    flush();
  }
  flush();

  return bullets;
}

// ============================================================
// EXTRACTION - LLM FALLBACK
// ============================================================

const LLM_EXTRACTION_SYSTEM_PROMPT = `You are an extraction assistant for a 0DTE SPX trading journal.

Read the periscope debrief prose below and return ONLY the trader's lessons / model-update bullets - the items they want added to their mental model for future trading days.

Look for sections like "What to add to the model", "Lessons learned", "Update for the model", or any bulleted reflective content. Ignore:
- Trade-by-trade narration / play-by-play
- "What happened today" recaps
- Score/grade self-assessment
- Anything that's specific to today's price action only ("SPX hit 7240 today" is NOT a lesson)

Each lesson must be:
- Generalizable (a heuristic / rule / observation that applies on future days)
- Self-contained (readable without today's chart in front of you)
- Concise (one sentence, max ~30 words)

Return ONLY a JSON array of strings (no prose, no markdown fences):
["lesson 1", "lesson 2", ...]

If you find no lessons, return an empty array: []`;

/**
 * LLM-extract candidates when the regex misses. Single Sonnet call per
 * debrief. Returns empty array on any failure (best-effort - the
 * regex path remains the primary surface).
 */
export async function extractCandidatesViaLLM(
  prose: string,
): Promise<string[]> {
  if (!prose || prose.trim().length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn(
      'extractCandidatesViaLLM: ANTHROPIC_API_KEY missing - skipping LLM fallback',
    );
    return [];
  }

  try {
    const anthropic = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-7',
      max_tokens: 2048,
      system: LLM_EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prose }],
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    let raw = textBlocks
      .map((b) => ('text' in b ? b.text : ''))
      .join('')
      .trim();

    // Defensive: strip markdown code fences if Sonnet added them despite
    // the system prompt's instructions.
    if (raw.startsWith('```')) {
      raw = raw.slice(raw.indexOf('\n') + 1);
    }
    if (raw.endsWith('```')) {
      raw = raw.slice(0, raw.lastIndexOf('```'));
    }
    raw = raw.trim();

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      logger.warn(
        { rawPreview: raw.slice(0, 200) },
        'extractCandidatesViaLLM: response is not a JSON array',
      );
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { module: 'periscope-lessons', stage: 'llm_fallback' },
    });
    logger.error({ err }, 'extractCandidatesViaLLM failed');
    return [];
  }
}

// ============================================================
// DEDUP - COSINE SEARCH
// ============================================================

/**
 * Cosine-search existing lessons; return the id of the best match if
 * its similarity is at or above the threshold. Otherwise null.
 *
 * Uses pgvector's `<=>` cosine-distance operator (similarity = 1 -
 * distance). Index is HNSW with a partial WHERE on non-archived rows
 * so dedup naturally ignores demoted lessons.
 */
export async function findSimilarLesson(
  embedding: number[],
  threshold: number,
): Promise<number | null> {
  if (embedding.length === 0) return null;
  if (!embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('Invalid embedding: all values must be finite numbers');
  }

  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await sql`
    WITH q AS (SELECT ${vectorLiteral}::vector AS v)
    SELECT id, 1 - (embedding <=> q.v) AS similarity
    FROM periscope_lessons, q
    WHERE embedding IS NOT NULL
      AND status != 'archived'
    ORDER BY embedding <=> q.v ASC
    LIMIT 1
  `;

  const top = rows[0];
  if (!top) return null;
  const sim = Number(top.similarity);
  if (!Number.isFinite(sim) || sim < threshold) return null;
  return Number(top.id);
}

// ============================================================
// IN-BATCH DEDUP - merge near-duplicates BEFORE any DB write
// ============================================================

/**
 * Pure cosine similarity between two equal-length numeric vectors.
 * Returns 0 for zero-magnitude inputs (degenerate). No allocations.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Input shape for {@link dedupCandidatesInBatch}. */
export interface BatchCandidate {
  debriefId: number;
  lessonText: string;
  embedding: number[];
}

/** Output shape — each survivor carries every debriefId that mapped to it. */
export interface DedupedCandidate {
  lessonText: string;
  embedding: number[];
  sourceIds: number[];
}

/**
 * Collapse near-duplicate candidates from a single cron batch BEFORE any
 * DB write. Eliminates the race where two near-identical candidates from
 * the same batch both miss the existing-lesson cosine search (because
 * neither has been INSERTed yet) and end up as two separate rows.
 *
 * Algorithm (O(n²) — fine at MVP volume of <30 candidates per cron run):
 *   - Walk candidates in input order.
 *   - For each candidate, check cosine vs every existing group's
 *     representative embedding. If max similarity ≥ threshold, fold the
 *     candidate's debriefId into that group's sourceIds (de-duplicated).
 *     Otherwise create a new group with this candidate as representative.
 *   - First-seen text wins (representative is the earlier candidate).
 *
 * Returns a list of survivor candidates with combined sourceIds. The
 * caller upserts each survivor against the DB; subsequent same-batch
 * duplicates are already absorbed into the survivor's sourceIds and
 * won't trigger a duplicate INSERT.
 */
export function dedupCandidatesInBatch(
  candidates: BatchCandidate[],
  threshold: number = SIMILARITY_THRESHOLD,
): DedupedCandidate[] {
  const groups: DedupedCandidate[] = [];
  for (const c of candidates) {
    let bestIdx = -1;
    let bestSim = threshold;
    for (let i = 0; i < groups.length; i += 1) {
      const sim = cosineSimilarity(c.embedding, groups[i]!.embedding);
      if (sim >= bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const g = groups[bestIdx]!;
      if (!g.sourceIds.includes(c.debriefId)) g.sourceIds.push(c.debriefId);
    } else {
      groups.push({
        lessonText: c.lessonText,
        embedding: c.embedding,
        sourceIds: [c.debriefId],
      });
    }
  }
  return groups;
}

// ============================================================
// UPSERT - MERGE OR INSERT
// ============================================================

interface UpsertArgs {
  lessonText: string;
  embedding: number[];
  /**
   * Source debrief id(s) that surfaced this lesson. Length ≥ 1.
   * Multiple ids land here when {@link dedupCandidatesInBatch} folded
   * same-batch near-duplicates into one survivor before upsert.
   */
  sourceIds: number[];
}

interface UpsertResult {
  inserted: boolean;
  lessonId: number;
}

const SIMILARITY_THRESHOLD = 0.8;

/**
 * Insert a new proposed lesson OR merge into an existing one.
 *
 * Merge semantics:
 *   - bump citation_count by the count of source_ids NOT already present
 *     on the row (idempotent — re-running the cron with the same debrief
 *     set never double-counts).
 *   - source_ids array grows monotonically; existing entries left intact.
 *
 * Insert semantics:
 *   - status='proposed' (manual SQL promotion to 'active' in MVP).
 *   - citation_count = sourceIds.length.
 *   - source_ids = sourceIds (deduplicated input — caller's responsibility
 *     to pass a unique list; {@link dedupCandidatesInBatch} guarantees it).
 *
 * Returns `{ inserted, lessonId }`.
 */
export async function upsertLesson(args: UpsertArgs): Promise<UpsertResult> {
  const { lessonText, embedding, sourceIds } = args;
  if (sourceIds.length === 0) {
    throw new Error('upsertLesson: sourceIds must not be empty');
  }

  const matchId = await findSimilarLesson(embedding, SIMILARITY_THRESHOLD);
  const sql = getDb();

  if (matchId != null) {
    // Merge: append any source_ids not already present, bump
    // citation_count by the number of newly-added entries. Both done
    // atomically in one UPDATE so a partially-applied merge is
    // impossible.
    const sourceIdsBigint = sourceIds.map((id) => String(id));
    await sql`
      WITH incoming AS (
        SELECT UNNEST(${sourceIdsBigint}::bigint[]) AS sid
      ),
      novel AS (
        SELECT i.sid
        FROM incoming i
        WHERE NOT (i.sid = ANY(
          SELECT UNNEST(source_ids) FROM periscope_lessons WHERE id = ${matchId}
        ))
      )
      UPDATE periscope_lessons
      SET citation_count = citation_count + (SELECT COUNT(*)::int FROM novel),
          source_ids = source_ids || (SELECT ARRAY_AGG(sid) FROM novel)
      WHERE id = ${matchId}
    `;
    return { inserted: false, lessonId: matchId };
  }

  const vectorLiteral = `[${embedding.join(',')}]`;
  const sourceIdsBigint = sourceIds.map((id) => String(id));
  const rows = await sql`
    INSERT INTO periscope_lessons (
      lesson_text, source_ids, embedding, status, citation_count
    ) VALUES (
      ${lessonText},
      ${sourceIdsBigint}::bigint[],
      ${vectorLiteral}::vector,
      'proposed',
      ${sourceIds.length}
    )
    RETURNING id
  `;

  const newId = rows[0]?.id;
  if (newId == null) {
    throw new Error('upsertLesson: INSERT did not return an id');
  }
  return { inserted: true, lessonId: Number(newId) };
}

// ============================================================
// FORMAT - INJECTION BLOCK
// ============================================================

/**
 * Format active lessons as a "## Recent lessons learned" markdown
 * sub-section that gets appended to the cached references file
 * content at request-time.
 *
 * Filters out non-active rows defensively (the caller already passes
 * `fetchActiveLessons` output, but the helper is also exposed for
 * tests / future callers). Sorts by citation_count DESC so the
 * highest-cited lesson appears first - caller can also sort.
 *
 * Returns empty string when no lessons (caller can short-circuit on
 * empty to skip the concat entirely and preserve cache parity with
 * pre-MVP behavior on cold-start days).
 */
export function formatLessonsBlock(
  lessons: readonly PeriscopeLessonRow[],
): string {
  const active = lessons
    .filter((l) => l.status === 'active')
    .slice() // shallow copy before sort to avoid mutating caller's array
    .sort((a, b) => b.citation_count - a.citation_count);

  if (active.length === 0) return '';

  const lines: string[] = [
    '',
    '---',
    '',
    '## Recent lessons learned',
    '',
    "Trader-supplied heuristics extracted from past debrief sessions. Each entry has been cited at least once across recent debriefs. Treat them as informed priors, not absolute rules - apply when relevant to today's structure.",
    '',
  ];

  active.forEach((lesson, idx) => {
    const cites =
      lesson.citation_count > 1 ? ` _(cited ${lesson.citation_count}x)_` : '';
    lines.push(`${idx + 1}. ${lesson.lesson_text}${cites}`);
  });

  lines.push('');
  return lines.join('\n');
}
