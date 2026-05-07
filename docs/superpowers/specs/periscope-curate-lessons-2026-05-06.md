# Periscope Curate-Lessons — Continuous Learning From Debrief Sections

**Status:** Spec — ready to build
**Author / owner:** Charles
**Date:** 2026-05-06
**Parent specs:**

- `docs/superpowers/specs/periscope-chat-overhaul-2026-05-05.md` (3-mode lifecycle, `mode='debrief'` produces the "What to add to the model" section)
- `api/cron/curate-lessons.ts` (analyze cron — structural mirror for this one)

## Goal

Establish a continuous-learning loop for the periscope chat surface that mirrors the existing analyze curate-lessons pattern. Each periscope debrief produces a "What to add to the model" section as part of its prose; this cron extracts those bullets across recent debriefs, dedupes / persists them, and the active rows get injected into future periscope reads as additional cached context. End state: the trader's debrief observations compound into the next morning's pre_trade read without any manual transcription.

## Non-goals

- **No UI for review / promotion in MVP.** Manual SQL (`UPDATE periscope_lessons SET status='active' WHERE id=N`) at small lesson counts (≤30) is fine.
- **No LLM-based curation** (e.g. asking Claude to summarize / rank candidates). Future work.
- **No backfill against historical debriefs in the migration.** The cron runs forward — first run picks up new debriefs only. Manual `?since=YYYY-MM-DD` flag is the escape hatch when the user wants historical data ingested.
- **No regime-tag matching for relevance-aware injection.** All active lessons inject for every read in MVP; per-regime filtering is Phase 2.
- **No outcome-correlation tracking** (which lessons fired and were borne out by realized R). Phase 2.

## Locked decisions

| Setting          | Value                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source           | Only the "What to add to the model" section of `mode='debrief'` rows in `periscope_analyses`. Other sections are too prose-shaped.                                                                                                                                                                                                                                    |
| Extraction       | Regex on `## What to add to the model` heading + bullet list. Sonnet fallback when regex misses (single call per debrief).                                                                                                                                                                                                                                            |
| Dedup            | Cosine similarity ≥ 0.8 against existing `periscope_lessons.embedding` → merge (increment `citation_count`, append `source_id`). Otherwise insert as `proposed`.                                                                                                                                                                                                      |
| Promotion        | MVP: manual SQL (`UPDATE periscope_lessons SET status='active' WHERE id=N`). Auto-promotion (≥2 citations) deferred to Phase 2.                                                                                                                                                                                                                                       |
| Active cap       | 15 active lessons. When promoting a 16th, demote the lowest `citation_count` active row.                                                                                                                                                                                                                                                                              |
| Cron schedule    | `0 3 * * 1` (UTC Mon 03:00 = Sunday 10 PM CT) — mirrors analyze curate-lessons but offset 2 days.                                                                                                                                                                                                                                                                     |
| Injection        | Combined with the VolSignals references file content into ONE cached system block (the existing references slot). Lessons rendered as a "## Recent lessons learned" sub-section appended to the file content at request-time. Cache invalidates when active lessons change (acceptable — Sunday cron run, Monday's first call rebuilds, all subsequent reads cached). |
| Phase 2 deferred | Auto-promotion threshold, regime-tag matching for relevance-aware injection, outcome correlation tracking.                                                                                                                                                                                                                                                            |

## Architecture overview

```text
                    ┌────────────────────────────────────┐
                    │ /api/cron/curate-periscope-lessons │
                    │ schedule: 0 3 * * 1 (Sun 10 PM CT) │
                    └────────────────────────────────────┘
                                       │
                                       ▼
            ┌──────────────────────────────────────────────────┐
            │ fetchUnprocessedDebriefs(since=now-7d)            │
            │   SELECT id, prose_text FROM periscope_analyses  │
            │   WHERE mode='debrief' AND ...not yet processed  │
            └──────────────────────────────────────────────────┘
                                       │
                                       ▼
            ┌──────────────────────────────────────────────────┐
            │ for each debrief:                                 │
            │   extractCandidatesViaRegex(prose)               │
            │     → if empty → extractCandidatesViaLLM(prose)  │
            │   for each candidate:                             │
            │     embedding = generateEmbedding(text)           │
            │     match = findSimilarLesson(embedding, 0.8)    │
            │     if match → upsert merge (++citation_count)    │
            │     else      → INSERT status='proposed'          │
            └──────────────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌────────────────────────────────────┐
                    │ periscope_lessons table            │
                    │ - status: proposed/active/archived │
                    │ - citation_count, source_ids[]     │
                    │ - embedding vector(2000)           │
                    └────────────────────────────────────┘
                                       │
                                       │ on next periscope-chat call:
                                       ▼
            ┌──────────────────────────────────────────────────┐
            │ api/periscope-chat.ts callModel()                 │
            │   fetchActiveLessons(15) [skipped if empty]       │
            │   formatLessonsBlock(rows)                        │
            │   systemBlocks.references += lessonsBlock         │
            │   (one cached block, references + lessons)        │
            └──────────────────────────────────────────────────┘
```

## Phases

### Phase 1 — DB migration + helper module

**Files:**

- `api/_lib/db-migrations.ts` (modify) — add migration 133 (next id; 132 is the most recent).
- `api/_lib/periscope-lessons.ts` (NEW) — DB helpers + extraction + formatting.
- `api/__tests__/db.test.ts` (modify) — add `{ id: 133 }` mock + migration description + SQL call count update.
- `api/__tests__/periscope-lessons.test.ts` (NEW) — unit tests.

**Migration 133 schema:**

```sql
CREATE TABLE IF NOT EXISTS periscope_lessons (
  id            BIGSERIAL PRIMARY KEY,
  lesson_text   TEXT NOT NULL,
  source_ids    BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  embedding     vector(2000),
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'active', 'archived')),
  citation_count INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at   TIMESTAMPTZ,
  archived_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_periscope_lessons_status ON periscope_lessons (status);
-- HNSW for cosine search during dedup; gated to non-archived rows.
CREATE INDEX IF NOT EXISTS idx_periscope_lessons_embedding ON periscope_lessons
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND status != 'archived';
```

### Phase 2 — Cron handler

**Files:**

- `api/cron/curate-periscope-lessons.ts` (NEW) — handler.
- `vercel.json` (modify) — register the cron + function-config entry.

**Behavior:**

- `cronGuard(req, res, { marketHours: false, requireApiKey: false })` — same shape as `curate-lessons.ts`.
- `maxDuration: 780`.
- Query string: `?since=YYYY-MM-DD` for manual backfill window override; `?dry=true` for dry-run logging.
- Default window: last 7 days.
- Flow per debrief: extract via regex → fallback to LLM → for each candidate, embed + dedup + upsert.
- Returns JSON envelope: `{ ok: true, processed: N, inserted: M, merged: K }`.
- Sentry capture on any thrown error (`Sentry.setTag('cron.job', 'curate-periscope-lessons')` + `captureException`).

### Phase 3 — Injection wiring

**Files:**

- `api/periscope-chat.ts` (modify) — defensive shape (b): in `callModel`, fetch active lessons; if rows present, append a "## Recent lessons learned" sub-section to the existing references block; skip the fetch + concat when empty.

**Cache strategy:** lessons concat into the references-block text (one cache breakpoint as today). Cache invalidates when the lessons list changes — acceptable because the cron runs Sunday night, Monday's first read rebuilds, and every subsequent read that day hits cache.

## Files to create / modify

**NEW:**

- `api/_lib/periscope-lessons.ts`
- `api/cron/curate-periscope-lessons.ts`
- `api/__tests__/periscope-lessons.test.ts`
- `docs/superpowers/specs/periscope-curate-lessons-2026-05-06.md` (this doc)

**MODIFIED:**

- `api/_lib/db-migrations.ts` (add migration 133)
- `api/__tests__/db.test.ts` (migration mocks + counts)
- `api/periscope-chat.ts` (lesson fetch + concat into references block)
- `vercel.json` (cron schedule + function config)

## Data dependencies

- Existing tables consumed:
  - `periscope_analyses` — read-only source of debrief prose (`mode='debrief'`).
- New tables:
  - `periscope_lessons` (Phase 1).
- No new env vars. `OPENAI_API_KEY` (for embeddings) and `ANTHROPIC_API_KEY` (for LLM-fallback extraction) already exist.

## Open questions

| Question                                                                                                                      | Default if not decided                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Should the LLM-fallback extraction use Sonnet or Opus?                                                                        | Sonnet (`claude-sonnet-4-7`) — extraction is structural, not analytical; cost matters when the regex misses.   |
| What's the citation_count promotion threshold for Phase 2 auto-promotion?                                                     | ≥2 distinct debriefs.                                                                                          |
| Should `?dry=true` skip embedding generation (saves OpenAI cost) or still embed but skip upserts?                             | Still embed, skip upserts. The embed step is the hot-spot for tuning the dedup threshold; skipping defeats it. |
| Should manual `?since=` override also relax the "not yet processed" filter so the same debrief can be re-extracted on tweaks? | Yes — manual override implies user intent.                                                                     |

## Thresholds / constants

| Constant                      | Value                                      | Where                         |
| ----------------------------- | ------------------------------------------ | ----------------------------- |
| Default cron window           | 7 days                                     | `curate-periscope-lessons.ts` |
| Dedup cosine similarity floor | 0.8                                        | `findSimilarLesson`           |
| Active-lessons cap            | 15                                         | `fetchActiveLessons` arg      |
| Auto-promotion threshold (P2) | citation_count ≥ 2 (deferred)              | (future)                      |
| Cron schedule                 | `0 3 * * 1` (Mon 03:00 UTC = Sun 22:00 CT) | `vercel.json` crons entry     |
| Cron `maxDuration`            | 780 s                                      | `vercel.json` functions       |

## Verification plan

### Per-phase verification

Each phase ends with focused `npx tsc --noEmit` + `npx eslint <files>` + `npx vitest run <test files>`. Pre-existing failures in `lottery-score-weights.test.ts` and `PeriscopeChatHistory.test.tsx` are NOT in scope and are pre-existing.

### Test coverage (api/**tests**/periscope-lessons.test.ts)

- Regex extracts bullets correctly when heading present.
- Regex returns empty when heading absent.
- LLM fallback called only when regex misses.
- Dedup respects similarity threshold (≥0.8 → merge, <0.8 → insert).
- Upsert merges on hit (citation_count++, source_ids append), inserts on miss.
- `formatLessonsBlock` omits archived rows + sorts by citation_count.

### Smoke / manual

- After deploy, run `curl -H "Authorization: Bearer $CRON_SECRET" https://strike.../api/cron/curate-periscope-lessons?dry=true` — confirm structured envelope, no rows touched.
- Promote first lesson via `UPDATE periscope_lessons SET status='active', promoted_at=now() WHERE id=1;` and submit a periscope read; confirm the lessons block appears in cached references on the second submission (`cache_read_input_tokens > 0`).

### Rollback plan

- Migration is additive (new table, no DROPs); rollback = `DROP TABLE periscope_lessons;` after redeploying the previous git SHA.
- All other phases are additive or modify-in-place; rollback = revert commit.

## Out of scope (future enhancements)

- UI surface for browsing / promoting / archiving lessons.
- Auto-promotion at citation_count ≥ 2.
- Per-regime injection (only inject lessons whose `regime_tag` matches today's pre_trade tag).
- Outcome correlation: track which lesson IDs were cited in a read whose `realized_r > 0` vs `< 0` to score lesson value.
- LLM-based weekly curation report (lesson freshness, drift detection, archive proposals).
