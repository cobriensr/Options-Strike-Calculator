/**
 * Weekly cron handler - curates trader-supplied lessons from periscope
 * debrief prose into the `periscope_lessons` table.
 *
 * Schedule: 0 3 * * 1 (UTC Monday 03:00 = Sunday 22:00 CT) - mirrors
 * the analyze curate-lessons cron offset by 2 days so the two pipelines
 * don't race for embedding-API budget on the same wall-clock minute.
 *
 * Auth: Bearer token via CRON_SECRET (Vercel crons use GET).
 *
 * Flow per debrief:
 *   1. fetchUnprocessedDebriefs(since=now-7d)
 *   2. For each debrief:
 *      a. extractCandidatesViaRegex(prose) - primary surface
 *      b. extractCandidatesViaLLM(prose)   - Sonnet fallback when regex misses
 *      c. for each candidate -> embed -> dedup (cosine >=0.8) -> upsert
 *
 * Query flags:
 *   ?since=YYYY-MM-DD   - manual backfill cutoff (default: now-7d)
 *   ?dry=true           - skip upserts; still embeds (so dedup-threshold
 *                         tuning data is preserved)
 *
 * Promotion in MVP is manual SQL:
 *   UPDATE periscope_lessons SET status='active', promoted_at=now() WHERE id=N;
 *
 * See: docs/superpowers/specs/periscope-curate-lessons-2026-05-06.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry } from '../_lib/sentry.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import logger from '../_lib/logger.js';
import {
  extractCandidatesViaLLM,
  extractCandidatesViaRegex,
  fetchUnprocessedDebriefs,
  upsertLesson,
} from '../_lib/periscope-lessons.js';

export const config = { maxDuration: 780 };

interface RunReport {
  ok: true;
  debriefsScanned: number;
  candidates: number;
  inserted: number;
  merged: number;
  embedFailures: number;
  dryRun: boolean;
  sinceIso: string;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function defaultSinceIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString();
}

/**
 * Resolve the `?since=YYYY-MM-DD` query flag to an ISO timestamp.
 * Returns null when the flag is malformed (caller responds 400).
 */
function resolveSinceIso(rawSince: unknown): string | null {
  if (rawSince == null) return defaultSinceIso();
  if (typeof rawSince !== 'string') return null;
  const trimmed = rawSince.trim();
  if (trimmed.length === 0) return defaultSinceIso();
  // Accept YYYY-MM-DD; pin to UTC midnight so the SQL `>=` filter is
  // stable regardless of server timezone.
  if (ISO_DATE_PATTERN.test(trimmed)) return `${trimmed}T00:00:00.000Z`;
  // Accept full ISO timestamps too.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;

  const sinceIso = resolveSinceIso(req.query.since);
  if (sinceIso == null) {
    res.status(400).json({
      error: 'Invalid ?since= value. Use YYYY-MM-DD or a full ISO timestamp.',
    });
    return;
  }

  const dryRun = req.query.dry === 'true';

  let candidates = 0;
  let inserted = 0;
  let merged = 0;
  let embedFailures = 0;

  try {
    const debriefs = await fetchUnprocessedDebriefs(sinceIso);
    const debriefsScanned = debriefs.length;

    logger.info(
      { sinceIso, debriefsScanned, dryRun },
      'curate-periscope-lessons start',
    );

    for (const debrief of debriefs) {
      let extracted = extractCandidatesViaRegex(debrief.prose_text);
      if (extracted.length === 0) {
        extracted = await extractCandidatesViaLLM(debrief.prose_text);
        if (extracted.length > 0) {
          logger.info(
            { debriefId: debrief.id, count: extracted.length },
            'curate-periscope-lessons: LLM fallback yielded candidates',
          );
        }
      }

      if (extracted.length === 0) {
        logger.info(
          { debriefId: debrief.id },
          'curate-periscope-lessons: no candidates extracted (skipping)',
        );
        continue;
      }

      for (const lessonText of extracted) {
        candidates++;
        const embedding = await generateEmbedding(lessonText);
        if (embedding == null || embedding.length === 0) {
          embedFailures++;
          logger.warn(
            { debriefId: debrief.id, lessonText: lessonText.slice(0, 80) },
            'curate-periscope-lessons: embedding generation failed (skipping)',
          );
          continue;
        }

        if (dryRun) {
          logger.info(
            {
              debriefId: debrief.id,
              lessonText: lessonText.slice(0, 100),
              embeddingDim: embedding.length,
            },
            'curate-periscope-lessons: dry-run candidate (no upsert)',
          );
          continue;
        }

        try {
          const result = await upsertLesson({
            lessonText,
            embedding,
            sourceId: debrief.id,
          });
          if (result.inserted) {
            inserted++;
            logger.info(
              { debriefId: debrief.id, lessonId: result.lessonId },
              'curate-periscope-lessons: inserted new proposed lesson',
            );
          } else {
            merged++;
            logger.info(
              { debriefId: debrief.id, lessonId: result.lessonId },
              'curate-periscope-lessons: merged into existing lesson',
            );
          }
        } catch (err) {
          Sentry.setTag('cron.job', 'curate-periscope-lessons');
          Sentry.captureException(err, {
            tags: { stage: 'upsert', debriefId: String(debrief.id) },
          });
          logger.error(
            { err, debriefId: debrief.id },
            'curate-periscope-lessons: upsert failed',
          );
        }
      }
    }

    const report: RunReport = {
      ok: true,
      debriefsScanned,
      candidates,
      inserted,
      merged,
      embedFailures,
      dryRun,
      sinceIso,
    };
    logger.info(report, 'curate-periscope-lessons complete');
    res.status(200).json(report);
  } catch (err) {
    Sentry.setTag('cron.job', 'curate-periscope-lessons');
    Sentry.captureException(err);
    logger.error({ err }, 'curate-periscope-lessons cron failed');
    res.status(500).json({ error: 'Internal error' });
  }
}
