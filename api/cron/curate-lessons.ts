/**
 * Friday cron handler — automated lesson curation pipeline.
 *
 * Runs Saturday 3 AM UTC via Vercel Cron. Processes all unreviewed
 * analyses from the past week through a two-phase pipeline:
 *   Phase A: Generate embeddings + Claude curation decisions (external API calls)
 *   Phase B: Persist ADD/SUPERSEDE results to the lessons table
 *
 * Auth: Bearer token via CRON_SECRET env var (Vercel crons use GET).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../_lib/db.js';
import {
  upsertReport,
  updateReport,
  buildMarketConditions,
  type MarketConditions,
} from '../_lib/lessons.js';
import { generateEmbedding, findSimilarLessons } from '../_lib/embeddings.js';
import type { SimilarLesson } from '../_lib/embeddings.js';
import logger from '../_lib/logger.js';

export const config = { maxDuration: 780 };

// ============================================================
// CURATION SYSTEM PROMPT
// ============================================================

const CURATION_SYSTEM_PROMPT = `You are curating a trading lessons compendium. For each candidate lesson,
you will receive:
- The candidate lesson text
- The 5 most similar existing lessons (by vector similarity)
- The market conditions when the candidate was learned

Your job is to decide: ADD, SUPERSEDE, or SKIP.

RULES:
1. You may NEVER edit the text of an existing lesson.
2. You may NEVER merge two lessons into a new combined lesson.
3. SUPERSEDE means the new lesson says the SAME thing as an existing
   lesson but with more specificity, accuracy, or additional context.
   If two lessons cover DIFFERENT aspects of the same topic, ADD the
   new one — do not supersede.
4. SKIP means the candidate is a near-exact duplicate of an existing
   lesson — same insight, same level of detail. Only skip when the
   existing lesson already captures everything the candidate says.
5. When in doubt, ADD rather than SUPERSEDE. Redundancy is safer than
   lost knowledge. This compendium informs real trading decisions.
6. Assign tags (lowercase, hyphenated) that describe the key concepts.
7. Assign exactly one category from: regime, flow, gamma, management,
   entry, sizing.

Respond with ONLY valid JSON. No markdown, no explanation outside the JSON.`;

// ============================================================
// TYPES
// ============================================================

interface CurationDecision {
  action: 'add' | 'supersede' | 'skip';
  reason: string;
  supersedes_id: number | null;
  tags: string[];
  category: string;
}

interface AddedLesson {
  id: number;
  text: string;
  sourceDate: string;
  tags: string[];
  category: string;
}

interface SupersededLesson {
  id: number;
  oldText: string;
  supersededBy: number;
  reason: string;
}

interface SkippedLesson {
  text: string;
  reason: string;
  existingId?: number;
}

interface LessonError {
  text: string;
  error: string;
  sourceAnalysisId: number;
}

interface PreparedLesson {
  text: string;
  embedding: number[];
  decision: CurationDecision;
  marketConditions: Record<string, unknown>;
  sourceAnalysisId: number;
  sourceDate: string;
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Method check — Vercel crons use GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth check
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Step 0: Bootstrap report
    const weekEnding = getPrecedingFriday();
    await upsertReport(weekEnding);

    // Step 1: Query current active lesson count (for unchanged calculation)
    const sql = getDb();
    const activeCountRows = await sql`
      SELECT COUNT(*)::int AS count FROM lessons WHERE status = 'active'
    `;
    const activeCountBefore = (activeCountRows[0]?.count as number) ?? 0;

    // Step 2: Query unprocessed reviews
    // ?backfill=true skips the 7-day window and processes ALL historical reviews
    const backfill = req.query.backfill === 'true';
    const reviews = backfill
      ? await sql`
          SELECT a.id, a.date, a.full_response, a.snapshot_id, a.spx, a.vix, a.vix1d,
                 a.structure, a.confidence
          FROM analyses a
          LEFT JOIN lessons l ON l.source_analysis_id = a.id
          WHERE a.mode = 'review'
            AND l.id IS NULL
          ORDER BY a.date ASC
        `
      : await sql`
          SELECT a.id, a.date, a.full_response, a.snapshot_id, a.spx, a.vix, a.vix1d,
                 a.structure, a.confidence
          FROM analyses a
          LEFT JOIN lessons l ON l.source_analysis_id = a.id
          WHERE a.mode = 'review'
            AND a.date >= CURRENT_DATE - INTERVAL '7 days'
            AND l.id IS NULL
          ORDER BY a.date ASC
        `;

    // Step 3: No reviews — update report and return
    if (reviews.length === 0) {
      await updateReport(weekEnding, {
        reviewsProcessed: 0,
        lessonsAdded: 0,
        lessonsSuperseded: 0,
        lessonsSkipped: 0,
        report: {
          reviewsProcessed: 0,
          added: [],
          superseded: [],
          skipped: [],
          errors: [],
          unchanged: activeCountBefore,
        },
      });

      logger.info({ weekEnding }, 'Curation complete — no unprocessed reviews');
      return res.status(200).json({ reviewsProcessed: 0 });
    }

    // Initialize Anthropic client
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Stream NDJSON progress so the connection stays alive and progress is visible
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    const progress = (data: Record<string, unknown>) => {
      res.write(JSON.stringify(data) + '\n');
    };

    progress({ event: 'start', reviews: reviews.length, backfill });

    // Accumulators for the final report
    const added: AddedLesson[] = [];
    const superseded: SupersededLesson[] = [];
    const skipped: SkippedLesson[] = [];
    const errors: LessonError[] = [];

    // Step 3: Process each review
    let reviewIndex = 0;
    for (const review of reviews) {
      reviewIndex++;
      const fullResponse =
        typeof review.full_response === 'string'
          ? JSON.parse(review.full_response as string)
          : review.full_response;

      const reviewData = fullResponse?.review ?? fullResponse ?? {};
      const lessonsLearned: string[] = Array.isArray(reviewData.lessonsLearned)
        ? reviewData.lessonsLearned
        : [];

      if (lessonsLearned.length === 0) continue;

      progress({
        event: 'review',
        reviewIndex,
        totalReviews: reviews.length,
        date: review.date,
        lessons: lessonsLearned.length,
      });

      // Fetch snapshot for market conditions
      let snapshotRow: Record<string, unknown> | null = null;
      if (review.snapshot_id != null) {
        const snapRows = await sql`
          SELECT * FROM market_snapshots WHERE id = ${review.snapshot_id}
        `;
        snapshotRow =
          snapRows.length > 0 ? (snapRows[0] as Record<string, unknown>) : null;
      }

      const analysisRow = review as unknown as Record<string, unknown>;

      // Phase A: External API calls — two sub-phases:
      //   A1: Generate all embeddings in parallel (independent, fast)
      //   A2: Claude curation sequentially (each decision affects dedup context)

      // A1: Batch all embeddings concurrently
      const embeddingResults = await Promise.all(
        lessonsLearned.map(async (text) => ({
          text,
          embedding: await generateEmbedding(text),
        })),
      );

      const embeddingSuccessCount = embeddingResults.filter(
        (r) => r.embedding,
      ).length;
      progress({
        event: 'embeddings_done',
        reviewIndex,
        total: lessonsLearned.length,
        succeeded: embeddingSuccessCount,
        failed: lessonsLearned.length - embeddingSuccessCount,
      });

      // Separate successes from failures
      const withEmbeddings: { text: string; embedding: number[] }[] = [];
      for (const result of embeddingResults) {
        if (!result.embedding) {
          errors.push({
            text: result.text,
            error: 'Embedding generation failed',
            sourceAnalysisId: review.id as number,
          });
        } else {
          withEmbeddings.push({
            text: result.text,
            embedding: result.embedding,
          });
        }
      }

      // A2: Claude curation — sequential because each decision
      // affects what's "already in the compendium" for subsequent lessons
      const marketConditions = buildMarketConditions(analysisRow, snapshotRow);
      const prepared: PreparedLesson[] = [];

      let curationIndex = 0;
      for (const { text: lessonText, embedding } of withEmbeddings) {
        curationIndex++;
        progress({
          event: 'curating',
          reviewIndex,
          lessonIndex: curationIndex,
          totalLessons: withEmbeddings.length,
          lessonPreview: lessonText.slice(0, 80) + '...',
        });

        // Find similar existing lessons
        const similar = await findSimilarLessons(embedding);

        // Call Claude for curation decision
        const decision = await curateLesson(
          anthropic,
          lessonText,
          similar,
          marketConditions,
        );

        if (!decision) {
          progress({
            event: 'curation_failed',
            reviewIndex,
            lessonIndex: curationIndex,
            error: 'Malformed Claude response',
          });
          errors.push({
            text: lessonText,
            error: 'Malformed Claude response',
            sourceAnalysisId: review.id as number,
          });
          continue;
        }

        progress({
          event: 'curated',
          reviewIndex,
          lessonIndex: curationIndex,
          action: decision.action,
          reason: decision.reason,
        });

        prepared.push({
          text: lessonText,
          embedding,
          decision,
          marketConditions: marketConditions as unknown as Record<
            string,
            unknown
          >,
          sourceAnalysisId: review.id as number,
          sourceDate: review.date instanceof Date
            ? review.date.toISOString().split('T')[0]!
            : String(review.date).split('T')[0]!,
        });
      }

      // Phase B: Atomic DB writes for this review (all-or-nothing per review)
      try {
        // Collect skip decisions first (no DB writes needed)
        const writeActions: PreparedLesson[] = [];
        for (const lesson of prepared) {
          if (lesson.decision.action === 'skip') {
            skipped.push({
              text: lesson.text,
              reason: lesson.decision.reason,
              existingId: lesson.decision.supersedes_id ?? undefined,
            });
          } else {
            writeActions.push(lesson);
          }
        }

        if (writeActions.length > 0) {
          // Pre-allocate IDs and fetch old lesson texts before the transaction
          const preAllocated: {
            lesson: PreparedLesson;
            newId: number;
            oldText?: string;
          }[] = [];

          for (const lesson of writeActions) {
            const seqRows = await sql`SELECT nextval('lessons_id_seq') AS id`;
            const newId = Number(seqRows[0]!.id);

            let oldText: string | undefined;
            if (
              lesson.decision.action === 'supersede' &&
              lesson.decision.supersedes_id != null
            ) {
              const oldRows = await sql`
                SELECT text FROM lessons WHERE id = ${lesson.decision.supersedes_id}
              `;
              oldText = oldRows.length > 0 ? String(oldRows[0]!.text) : '';
            }

            preAllocated.push({ lesson, newId, oldText });
          }

          // Build the transaction batch: all INSERTs and UPDATEs for this review
          const txStatements = [];
          for (const { lesson, newId } of preAllocated) {
            const embeddingStr = `[${lesson.embedding.join(',')}]`;
            const mcJson = lesson.marketConditions
              ? JSON.stringify(lesson.marketConditions)
              : null;

            // INSERT the new lesson (for both ADD and SUPERSEDE)
            txStatements.push(sql`
              INSERT INTO lessons (
                id, text, embedding, tags, category,
                market_conditions, source_analysis_id, source_date
              ) VALUES (
                ${newId},
                ${lesson.text},
                ${embeddingStr}::vector,
                ${lesson.decision.tags},
                ${lesson.decision.category},
                ${mcJson},
                ${lesson.sourceAnalysisId},
                ${lesson.sourceDate}
              )
            `);

            // For SUPERSEDE, also UPDATE the old lesson
            if (
              lesson.decision.action === 'supersede' &&
              lesson.decision.supersedes_id != null
            ) {
              txStatements.push(sql`
                UPDATE lessons
                SET status = 'superseded',
                    superseded_by = ${newId},
                    superseded_at = NOW()
                WHERE id = ${lesson.decision.supersedes_id}
              `);
            }
          }

          // Execute all statements atomically
          await sql.transaction(txStatements);

          // On success, populate the report accumulators
          for (const { lesson, newId, oldText } of preAllocated) {
            if (lesson.decision.action === 'add') {
              added.push({
                id: newId,
                text: lesson.text,
                sourceDate: lesson.sourceDate,
                tags: lesson.decision.tags,
                category: lesson.decision.category,
              });
            } else if (
              lesson.decision.action === 'supersede' &&
              lesson.decision.supersedes_id != null
            ) {
              superseded.push({
                id: lesson.decision.supersedes_id,
                oldText: oldText ?? '',
                supersededBy: newId,
                reason: lesson.decision.reason,
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown DB error';
        logger.error(
          { err, reviewId: review.id },
          'DB write failed for review',
        );
        errors.push({
          text: `Review ID ${review.id}`,
          error: msg,
          sourceAnalysisId: review.id as number,
        });
      }
    }

    // Step 5: Build final report
    const reportData = {
      reviewsProcessed: reviews.length,
      lessonsAdded: added.length,
      lessonsSuperseded: superseded.length,
      lessonsSkipped: skipped.length,
      report: {
        reviewsProcessed: reviews.length,
        added,
        superseded,
        skipped,
        errors,
        unchanged: activeCountBefore - superseded.length,
      },
    };

    await updateReport(weekEnding, reportData);

    logger.info(
      {
        weekEnding,
        reviewsProcessed: reviews.length,
        added: added.length,
        superseded: superseded.length,
        skipped: skipped.length,
        errors: errors.length,
      },
      'Curation complete',
    );

    progress({
      event: 'complete',
      reviewsProcessed: reviews.length,
      lessonsAdded: added.length,
      lessonsSuperseded: superseded.length,
      lessonsSkipped: skipped.length,
      errors: errors.length,
    });
    return res.end();
  } catch (err) {
    logger.error({ err }, 'Curation cron failed');
    return res.status(500).json({
      error: 'Curation failed',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Calculate the preceding Friday date from today.
 * When the cron runs Saturday 3 AM UTC, this returns the previous day (Friday).
 */
export function getPrecedingFriday(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  // Days since last Friday: Sat=1, Sun=2, Mon=3, Tue=4, Wed=5, Thu=6, Fri=0(or 7)
  const daysSinceFriday = (day + 2) % 7 || 7;
  const friday = new Date(now);
  friday.setUTCDate(friday.getUTCDate() - daysSinceFriday);
  return friday.toISOString().split('T')[0]!;
}

/**
 * Call Claude Opus to make a curation decision for a single candidate lesson.
 * Returns null if the response is malformed.
 */
async function curateLesson(
  anthropic: Anthropic,
  candidateText: string,
  similar: SimilarLesson[],
  marketConditions: MarketConditions,
): Promise<CurationDecision | null> {
  // Build similar lessons block
  let similarBlock: string;
  if (similar.length === 0) {
    similarBlock =
      'No existing lessons match — this is a new topic area. Likely ADD.';
  } else {
    similarBlock = similar
      .map((s, i) => `[${i + 1}] (ID: ${s.id}) "${s.text}"`)
      .join('\n');
  }

  const userMessage = `Candidate lesson:
"${candidateText}"

Market conditions when learned:
${JSON.stringify(marketConditions)}

Most similar existing lessons:
${similarBlock}

If no existing lessons match, this is a new topic area — likely ADD.

Respond with JSON:
{
  "action": "add" | "supersede" | "skip",
  "reason": "explanation",
  "supersedes_id": null | <existing lesson ID>,
  "tags": ["tag1", "tag2"],
  "category": "regime" | "flow" | "gamma" | "management" | "entry" | "sizing"
}`;

  // Use streaming to prevent TCP idle timeouts on long Opus + thinking calls
  const response = await anthropic.messages
    .stream({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: CURATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    } as Parameters<typeof anthropic.messages.stream>[0])
    .finalMessage();

  // Extract text content (skip thinking blocks)
  const textBlocks = response.content.filter((block) => block.type === 'text');
  let rawText = textBlocks.map((b) => ('text' in b ? b.text : '')).join('');

  // Strip markdown code fences if Claude wraps the JSON
  rawText = rawText.trim();
  if (rawText.startsWith('```')) {
    rawText = rawText.slice(rawText.indexOf('\n') + 1);
  }
  if (rawText.endsWith('```')) {
    rawText = rawText.slice(0, rawText.lastIndexOf('```'));
  }
  rawText = rawText.trim();

  // Parse the JSON response
  try {
    const parsed = JSON.parse(rawText) as CurationDecision;

    // Validate required fields
    if (
      !parsed.action ||
      !['add', 'supersede', 'skip'].includes(parsed.action)
    ) {
      console.error('Invalid curation action:', rawText.slice(0, 200));
      return null;
    }

    return parsed;
  } catch {
    console.error('Failed to parse curation JSON:', rawText.slice(0, 200));
    return null;
  }
}
