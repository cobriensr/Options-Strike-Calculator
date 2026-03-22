# Lessons Learned System — Design Spec

## Problem

Claude's end-of-day review analyses produce high-quality trading lessons (`review.lessonsLearned[]`), but these insights are trapped in individual JSONB blobs in the `analyses` table. They are never fed back into future analyses, so the system cannot learn from its own history. The same mistakes (e.g., holding past GEX deadlines) can repeat because Claude has no memory of prior sessions' conclusions.

## Solution

A closed-loop system with three parts:

1. **Lessons table** — A growing, append-only compendium of validated trading insights stored in Postgres
2. **Friday cron** — An automated weekly job that extracts lessons from the week's reviews, deduplicates them against the existing compendium using vector similarity + Claude judgment, and produces a changelog report
3. **System prompt injection** — At analysis time, all active lessons are fetched and injected into Claude's system prompt so it can selectively apply relevant lessons to the current session

## Database Schema

### `lessons` table

Append-only compendium. Lesson text is **never modified** after insertion.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE lessons (
  id                  SERIAL PRIMARY KEY,
  text                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'superseded', 'archived')),
  superseded_by       INTEGER REFERENCES lessons(id),
  source_analysis_id  INTEGER REFERENCES analyses(id) ON DELETE RESTRICT,
  source_date         DATE NOT NULL,
  market_conditions   JSONB,
  tags                TEXT[],
  category            TEXT CHECK (category IN (
                        'regime', 'flow', 'gamma', 'management', 'entry', 'sizing'
                      )),
  embedding           vector(2000) NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  superseded_at       TIMESTAMPTZ,

  UNIQUE (source_analysis_id, text)
);

CREATE INDEX idx_lessons_status ON lessons (status);
CREATE INDEX idx_lessons_source ON lessons (source_analysis_id);
CREATE INDEX idx_lessons_source_date ON lessons (source_date);
CREATE INDEX idx_lessons_embedding ON lessons
  USING hnsw (embedding vector_cosine_ops);
```

**Column details:**

| Column               | Purpose                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`               | The lesson itself. Immutable after insert.                                                                                                                        |
| `status`             | `active` (injected into prompts), `superseded` (replaced by a newer lesson), `archived` (manually disabled via Neon UI). CHECK-constrained to valid values.       |
| `superseded_by`      | FK to the newer lesson that replaced this one. NULL when active.                                                                                                  |
| `source_analysis_id` | FK to the review-mode `analyses` row that produced this lesson. ON DELETE RESTRICT prevents deletion of analyses that have linked lessons, preserving provenance. |
| `source_date`        | The trading date the lesson was learned from. Indexed for injection query ordering.                                                                               |
| `market_conditions`  | Snapshot of conditions when the lesson was learned. See "Market Conditions Derivation" section below.                                                             |
| `tags`               | Freeform tags for Claude's rapid scanning. e.g. `['gex', 'deeply-negative', 'friday', 'charm', 'management-timing']`                                              |
| `category`           | Broad classification. CHECK-constrained to: `regime`, `flow`, `gamma`, `management`, `entry`, `sizing`.                                                           |
| `embedding`          | OpenAI `text-embedding-3-large` vector (2000 dimensions, truncated for HNSW compatibility). NOT NULL — every lesson must have an embedding for dedup search.                                        |
| `superseded_at`      | Timestamp when status changed to `superseded`.                                                                                                                    |

**Key constraints:**

- `UNIQUE (source_analysis_id, text)` — prevents the same analysis from producing duplicate lessons on partial-failure retries
- `embedding NOT NULL` — ensures every lesson is discoverable by vector search
- `ON DELETE RESTRICT` on `source_analysis_id` — preserves provenance chain
- CHECK constraints on `status` and `category` — enforces valid values at the database level

**Index note:** HNSW is used instead of IVFFlat because it works correctly on empty tables and does not require tuning based on row count. The lessons table starts empty and grows slowly (~5-15 rows/week).

### `lesson_reports` table

Weekly changelog for human review.

```sql
CREATE TABLE lesson_reports (
  id                  SERIAL PRIMARY KEY,
  week_ending         DATE NOT NULL UNIQUE,
  reviews_processed   INTEGER DEFAULT 0,
  lessons_added       INTEGER DEFAULT 0,
  lessons_superseded  INTEGER DEFAULT 0,
  lessons_skipped     INTEGER DEFAULT 0,
  report              JSONB NOT NULL DEFAULT '{}',
  error               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

**Report JSONB structure:**

```json
{
  "reviewsProcessed": 3,
  "added": [
    {
      "id": 45,
      "text": "When charm exceeds +10M on a positive gamma wall...",
      "sourceDate": "2026-03-20",
      "tags": ["charm", "gex"],
      "category": "gamma"
    }
  ],
  "superseded": [
    {
      "id": 12,
      "oldText": "Positive charm walls are reliable...",
      "supersededBy": 45,
      "reason": "New lesson from 2026-03-20 is more specific — adds the +10M threshold and GEX context"
    }
  ],
  "skipped": [
    {
      "text": "Rule 10 hedging divergence is valuable...",
      "reason": "Duplicate of existing lesson #8",
      "existingId": 8
    }
  ],
  "errors": [
    {
      "text": "Some lesson that failed embedding...",
      "error": "OpenAI API timeout",
      "sourceAnalysisId": 99
    }
  ],
  "unchanged": 41
}
```

## Market Conditions Derivation

The `market_conditions` JSONB is populated from **two source tables**:

| Field          | Source Table       | Source Column                     | Notes                                                                                                      |
| -------------- | ------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `vix`          | `market_snapshots` | `vix`                             |                                                                                                            |
| `vix1d`        | `market_snapshots` | `vix1d`                           |                                                                                                            |
| `spx`          | `analyses`         | `spx`                             | From the analysis row, not snapshot                                                                        |
| `gexRegime`    | `market_snapshots` | `regime_zone`                     | Stored as human-readable strings: `'go'`, `'caution'`, `'stop'`, `'danger'` — mapped from VIX bucket zones |
| `structure`    | `analyses`         | `structure`                       | e.g. `'CALL CREDIT SPREAD'`, `'IRON CONDOR'`                                                               |
| `dayOfWeek`    | `market_snapshots` | `dow_label`                       | e.g. `'Monday'`, `'Friday'`                                                                                |
| `wasCorrect`   | `analyses`         | `full_response.review.wasCorrect` | Extracted from the review's JSONB                                                                          |
| `confidence`   | `analyses`         | `confidence`                      | e.g. `'HIGH'`, `'MODERATE'`                                                                                |
| `vixTermShape` | `market_snapshots` | `vix_term_signal`                 | e.g. `'calm'`, `'elevated'`, `'extreme'`                                                                   |

**Derivation query:**

```sql
SELECT
  ms.vix, ms.vix1d, ms.regime_zone, ms.dow_label, ms.vix_term_signal,
  a.spx, a.structure, a.confidence, a.full_response
FROM analyses a
LEFT JOIN market_snapshots ms ON ms.id = a.snapshot_id
WHERE a.id = $analysisId
```

The `wasCorrect` field is extracted from `a.full_response->'review'->'wasCorrect'` in application code after the query.

## Runtime Paths

### Path 1: Analysis Time (modification to `/api/analyze`)

1. At the top of the handler, before building the system prompt, query:

   ```sql
   SELECT id, text, source_date, market_conditions, tags, category
   FROM lessons WHERE status = 'active'
   ORDER BY source_date DESC
   ```

2. Format as a `<lessons_learned>` XML block (numbered, with context parenthetical)
3. **Injection method:** Split the existing `SYSTEM_PROMPT` constant into two parts at the `</structure_selection_rules>` / `<data_handling>` boundary. Concatenate at runtime: `SYSTEM_PROMPT_PART1 + lessonsBlock + SYSTEM_PROMPT_PART2`. This avoids placeholder replacement complexity and keeps the prompt as a simple string concatenation.
4. No changes to the response schema — Claude naturally references applicable lessons
5. **Prompt cache note:** The lessons block changes only after the Friday cron, so the system prompt is stable throughout each trading week. The first analysis call after a cron run will miss the cache; subsequent calls that week will hit it.

**Injection format:**

```text
<lessons_learned>
Validated lessons from past trading sessions. Reference by number
when applicable to today's setup. Do not force-apply lessons that
don't match current conditions.

[1] (2026-03-20 | CCS | VIX:26.2 | GEX:danger | Fri | correct:yes)
When charm exceeds +10M on a positive gamma wall, that wall can be
trusted for all-day management even in deeply negative GEX environments.
Tags: charm, gex, management

[2] (2026-03-20 | CCS | VIX:26.2 | GEX:danger | Fri | correct:yes)
Rule 10 hedging divergence is the most valuable analytical tool on selloff
days: SPX NCP can stay positive or rise to +300M+ while SPX drops 80+ pts.
Tags: flow, rule-10, divergence
</lessons_learned>
```

**Token budget estimate:** Each lesson with parenthetical context is ~50-80 tokens. At 50 active lessons: ~2,500-4,000 tokens. At 100 active lessons: ~5,000-8,000 tokens. The existing system prompt is ~3,000 tokens. The combined prompt stays well within Claude's context window. When approaching ~100 active lessons, consider switching to retrieval-based injection (see Future Enhancement).

### Path 2: Friday Cron (`/api/cron/curate-lessons`)

**Schedule:** `0 3 * * 6` (3:00 AM UTC Saturday = 10:00 PM ET Friday)

**Auth:** Verified via `Authorization: Bearer <CRON_SECRET>` header. The handler must check:

```typescript
if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

**Max duration:** 780s (Vercel Pro supports up to 800s for cron-triggered serverless functions). The cron processes ~5-15 lessons per week with one Claude Opus call + one OpenAI embedding call per lesson — typically completes in 30-60s.

**Process:**

0. **Bootstrap report row.** Upsert a `lesson_reports` row at the start of the cron using `INSERT ... ON CONFLICT (week_ending) DO UPDATE`. The `week_ending` value is the preceding Friday: `CURRENT_DATE - INTERVAL '1 day'` (since the cron runs early Saturday). This ensures observability even if the cron crashes, and allows safe re-runs after a crash without violating the UNIQUE constraint.

1. Query `analyses` for unprocessed review-mode entries from the current week:

   ```sql
   SELECT a.id, a.date, a.full_response, a.snapshot_id, a.spx, a.vix, a.vix1d,
          a.structure, a.confidence
   FROM analyses a
   LEFT JOIN lessons l ON l.source_analysis_id = a.id
   WHERE a.mode = 'review'
     AND a.date >= CURRENT_DATE - INTERVAL '7 days'
     AND l.id IS NULL
   ORDER BY a.date ASC
   ```

2. **If no reviews found:** Update the report row with `reviews_processed: 0`, count of existing active lessons as `unchanged`, and exit cleanly. This is not an error condition.

3. For each review's `full_response.review.lessonsLearned[]`, process in two phases:

   **Phase A — Preparation (outside transaction, external API calls):**

   a. Generate embedding via OpenAI `text-embedding-3-large`. **If the embedding API fails:** skip this lesson, record it in the report's `errors` array with the error message, and continue to the next lesson. Do not enter the DB transaction for this lesson.

   b. Vector search existing active lessons — top 5 nearest by cosine distance (unscoped — see note below):

   ```sql
   SELECT id, text, tags, category, source_date
   FROM lessons
   WHERE status = 'active'
   ORDER BY embedding <=> $1
   LIMIT 5
   ```

   c. Send Claude (`claude-opus-4-6` with `thinking: { type: 'adaptive' }` and `output_config: { effort: 'high' }`) the candidate lesson + 5 nearest existing lessons + the review's market conditions.

   d. Claude responds with structured JSON:

   ```json
   {
     "action": "add" | "supersede" | "skip",
     "reason": "string explaining the decision",
     "supersedes_id": null | number,
     "tags": ["charm", "gex", "friday"],
     "category": "gamma"
   }
   ```

   **If Claude's response is malformed** (invalid JSON, missing `action` field, or unexpected `action` value): treat as SKIP, log the raw response in the report's `errors` array, and continue processing. Never insert a lesson based on a malformed curation response.

   **Phase B — Database writes (inside transaction, per review):**

   After all lessons for a review have been prepared (embeddings generated, Claude decisions received), execute the database writes for successfully prepared lessons in a single transaction using `sql.transaction()` from the Neon HTTP driver. Pre-allocate lesson IDs via `nextval('lessons_id_seq')` so that INSERT and UPDATE statements can be batched without interactive result inspection.
   - **ADD:** Insert new row with pre-allocated ID, text, embedding, tags, category, market_conditions, source_analysis_id, source_date
   - **SUPERSEDE:** Insert new row (as above) + UPDATE the old lesson: `status = 'superseded'`, `superseded_by = new_id`, `superseded_at = NOW()`. Both statements batched in the same `sql.transaction()` call.
   - **SKIP:** Record in report only, no DB changes

   If the transaction fails, all lesson writes for that review are rolled back. The error is recorded in the report, and processing continues to the next review.

   **Rationale for two-phase design:** The Neon HTTP driver (`neon()`) exposes `sql.transaction()` for non-interactive batched transactions — it does NOT have `sql.begin()` (that belongs to the `postgres`/`postgresjs` library). External API calls (OpenAI embeddings, Claude curation) must happen outside the transaction to avoid holding connections open during network calls. The two-phase approach cleanly separates external API calls (which can fail gracefully per-lesson) from database mutations (which are atomic per-review).

4. Derive `market_conditions` JSONB per the "Market Conditions Derivation" section above.

5. Build report JSONB and update the bootstrapped `lesson_reports` row with final counts and full changelog.

**Note on category-scoped dedup:** The vector search in step 4b is **unscoped** (searches all active lessons regardless of category). This is intentional: the candidate lesson's category is not yet known until Claude assigns it in step 4d. Cross-category matches are acceptable inputs for Claude's judgment — it can see that a "gamma" lesson is dissimilar to a "flow" lesson and make the right call. The `category` column's primary purpose is for human browsing and report organization, not for filtering the dedup search.

**Claude's curation prompt constraints (included in the cron's system prompt):**

```text
You are curating a trading lessons compendium. For each candidate lesson,
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

Respond with ONLY valid JSON. No markdown, no explanation outside the JSON.
```

### Path 3: Manual Override

No API endpoint needed for day-one. The user can flip lesson status directly in the Neon UI:

```sql
-- Undo a bad supersession
UPDATE lessons SET status = 'active', superseded_by = NULL, superseded_at = NULL WHERE id = 12;
UPDATE lessons SET status = 'archived' WHERE id = 45;
```

## Configuration Changes

### `vercel.json`

Add cron configuration and function config for the cron:

```json
{
  "crons": [
    {
      "path": "/api/cron/curate-lessons",
      "schedule": "0 3 * * 6"
    }
  ],
  "functions": {
    "api/cron/curate-lessons.ts": { "maxDuration": 780 }
  }
}
```

**Note:** The existing `api/analyze.ts` entry (`maxDuration: 800`) is unchanged. The analyze endpoint also has an in-file `export const config = { maxDuration: 780 }` — the `vercel.json` value takes precedence per Vercel's configuration hierarchy. The cron function uses `maxDuration: 780` (Vercel Pro supports up to 800s for cron-triggered functions).

### New dependencies

- `openai` — for `text-embedding-3-large` embedding generation

### New environment variables

- `OPENAI_API_KEY` — for embedding API calls
- `CRON_SECRET` — Vercel auto-provides this for cron auth verification

### Database migration

Migration #2 in the existing `MIGRATIONS` array in `api/_lib/db.ts`:

- Enable `pgvector` extension
- Create `lessons` table with all constraints, indexes (including HNSW vector index)
- Create `lesson_reports` table

## New Files

| File                         | Purpose                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `api/cron/curate-lessons.ts` | Friday cron serverless function                                                                               |
| `api/_lib/embeddings.ts`     | OpenAI embedding generation helper                                                                            |
| `api/_lib/lessons.ts`        | Lesson CRUD: `getActiveLessons()`, `insertLesson()`, `supersede()`, `saveReport()`, `buildMarketConditions()` |

## Modified Files

| File             | Change                                                                            |
| ---------------- | --------------------------------------------------------------------------------- |
| `api/analyze.ts` | Split `SYSTEM_PROMPT` into two parts; add lesson fetch and injection between them |
| `api/_lib/db.ts` | Add migration #2 for lessons + lesson_reports tables + pgvector extension         |
| `vercel.json`    | Add cron schedule and function config                                             |
| `package.json`   | Add `openai` dependency                                                           |

## Safety Mechanisms

1. **Append-only** — Lesson text is never modified after insertion
2. **Provenance chain** — Every lesson traces to a specific review analysis via `source_analysis_id` with ON DELETE RESTRICT
3. **Vector-assisted dedup** — Pre-filters to 5 nearest lessons before Claude judges, reducing hallucination risk on comparison
4. **Conservative curation prompt** — "When in doubt, ADD rather than SUPERSEDE"
5. **CHECK constraints** — `status` and `category` columns are database-constrained to valid values
6. **Uniqueness constraint** — `UNIQUE (source_analysis_id, text)` prevents duplicate lessons on retry
7. **NOT NULL embedding** — Every lesson must have a vector, ensuring discoverability in dedup search
8. **Two-phase processing** — External API calls (Phase A) happen outside the transaction; database writes (Phase B) are atomic per review via `sql.transaction()`. Embedding failures skip individual lessons without rolling back others.
9. **Bootstrapped report with upsert** — Report row created at cron start via `ON CONFLICT` upsert, ensuring observability on crashes and safe re-runs
10. **Malformed response handling** — Invalid Claude responses default to SKIP, never to insert
11. **Weekly report** — Full changelog with reasoning for every add/supersede/skip decision
12. **Manual override** — Flip status directly in Neon UI
13. **Soft deletes only** — Superseded lessons retain original text indefinitely
14. **Error capture** — Embedding failures and malformed responses recorded in report's `errors` array

## Edge Cases

| Scenario                                    | Behavior                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No reviews this week                        | Report row created with `reviewsProcessed: 0`, exit cleanly                                                                                                    |
| OpenAI embedding API fails                  | Skip that lesson, record in report `errors` array, continue processing                                                                                         |
| Claude curation response malformed          | Treat as SKIP, log raw response in report `errors`, continue                                                                                                   |
| Cron crashes mid-execution                  | Bootstrapped report row exists with partial data for debugging                                                                                                 |
| Same analysis retried after partial failure | `UNIQUE (source_analysis_id, text)` prevents duplicate inserts; if a review's Phase B transaction was rolled back, all its lessons are re-processable on retry |
| Cron re-run same week after crash           | `INSERT ... ON CONFLICT` upsert on `week_ending` allows the bootstrap step to safely update the existing report row                                            |
| Analysis referenced by lesson is deleted    | ON DELETE RESTRICT prevents deletion — provenance is preserved                                                                                                 |
| Market closed for holiday week              | Cron runs, finds no reviews, creates empty report — no error                                                                                                   |

## Future Enhancement (noted, not day-one)

**Retrieval-based injection (Option A):** When the compendium exceeds ~100 active lessons, embed the current `AnalysisContext` at analysis time and inject only the top 15 most relevant lessons instead of all active lessons. The embedding column and HNSW index are already in place to support this — only the query in `/api/analyze` would change from "fetch all active" to "fetch nearest N by embedding similarity."
