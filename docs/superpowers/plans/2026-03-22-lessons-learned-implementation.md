# Lessons Learned System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-improving lessons system where Claude's review-mode analyses produce lessons that are curated weekly via cron and injected into future analyses.

**Architecture:** Three components — (1) Postgres tables for lessons + reports via existing migration system, (2) a Friday cron serverless function that extracts/deduplicates lessons using OpenAI embeddings + Claude Opus (`claude-opus-4-6`), (3) system prompt injection in the existing `/api/analyze` endpoint. Two-phase cron processing separates external API calls from atomic DB writes.

**Tech Stack:** Neon Postgres with pgvector, OpenAI `text-embedding-3-small`, Anthropic Claude Opus (`claude-opus-4-6`), Vercel Cron Jobs, existing Vitest test infrastructure.

**Spec:** `docs/superpowers/specs/2026-03-22-lessons-learned-system-design.md`

---

### Task 1: Database Migration — Create Tables

**Files:**
- Modify: `api/_lib/db.ts` (add migration #2 to `MIGRATIONS` array)
- Test: `api/__tests__/db.test.ts`

- [ ] **Step 1: Write the failing test for migration #2**

Add a test in `api/__tests__/db.test.ts` that calls `migrateDb()` and verifies migration #2 runs. The test should mock the SQL calls and verify the correct CREATE EXTENSION, CREATE TABLE, and CREATE INDEX statements are executed.

```typescript
it('runs migration #2: lessons and lesson_reports tables', async () => {
  // Mock schema_migrations to return only migration #1 applied
  mockSql.mockResolvedValueOnce([]); // CREATE TABLE schema_migrations
  mockSql.mockResolvedValueOnce([{ id: 1 }]); // SELECT applied migrations
  // Migration #2 will call run() which executes multiple SQL statements
  mockSql.mockResolvedValue([]); // all subsequent CREATE calls

  const applied = await migrateDb();
  expect(applied).toContainEqual(
    expect.stringContaining('lessons'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/db.test.ts -t "migration #2"`
Expected: FAIL — migration #2 does not exist yet.

- [ ] **Step 3: Add migration #2 to the MIGRATIONS array in `api/_lib/db.ts`**

Add after the existing migration #1 comment block. The migration enables pgvector, creates the `lessons` table with all constraints and indexes (HNSW for vectors), and creates the `lesson_reports` table. Use the exact SQL from the spec.

```typescript
{
  id: 2,
  description: 'Create lessons and lesson_reports tables with pgvector',
  run: async (sql) => {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;

    await sql`
      CREATE TABLE IF NOT EXISTS lessons (
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
        embedding           vector(1536) NOT NULL,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        superseded_at       TIMESTAMPTZ,
        UNIQUE (source_analysis_id, text)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons (status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_lessons_source ON lessons (source_analysis_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_lessons_source_date ON lessons (source_date)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_lessons_embedding ON lessons USING hnsw (embedding vector_cosine_ops)`;

    await sql`
      CREATE TABLE IF NOT EXISTS lesson_reports (
        id                  SERIAL PRIMARY KEY,
        week_ending         DATE NOT NULL UNIQUE,
        reviews_processed   INTEGER DEFAULT 0,
        lessons_added       INTEGER DEFAULT 0,
        lessons_superseded  INTEGER DEFAULT 0,
        lessons_skipped     INTEGER DEFAULT 0,
        report              JSONB NOT NULL DEFAULT '{}',
        error               TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/db.test.ts -t "migration #2"`
Expected: PASS

- [ ] **Step 5: Run full DB test suite**

Run: `npx vitest run api/__tests__/db.test.ts`
Expected: All tests PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add api/_lib/db.ts api/__tests__/db.test.ts
git commit -m "feat: add migration #2 for lessons and lesson_reports tables with pgvector"
```

---

### Task 2: Lessons CRUD Module — `api/_lib/lessons.ts`

**Files:**
- Create: `api/_lib/lessons.ts`
- Test: `api/__tests__/lessons.test.ts`

- [ ] **Step 1: Write failing tests for `getActiveLessons()`**

Create `api/__tests__/lessons.test.ts`. Start with `// @vitest-environment node` (required — all API test files use this directive since Vitest defaults to jsdom). Mock `@neondatabase/serverless` the same way as `db.test.ts`. Test that `getActiveLessons()` queries lessons with `status = 'active'` ordered by `source_date DESC` and returns formatted results.

```typescript
describe('getActiveLessons', () => {
  it('returns active lessons ordered by source_date desc', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1, text: 'Charm walls hold', source_date: '2026-03-20',
        market_conditions: { vix: 26.2, structure: 'CCS' },
        tags: ['charm'], category: 'gamma',
      },
    ]);
    const lessons = await getActiveLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0].text).toBe('Charm walls hold');
  });

  it('returns empty array when no lessons exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const lessons = await getActiveLessons();
    expect(lessons).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/lessons.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `getActiveLessons()` in `api/_lib/lessons.ts`**

```typescript
import { getDb } from './db.js';

export interface Lesson {
  id: number;
  text: string;
  sourceDate: string;
  marketConditions: Record<string, unknown> | null;
  tags: string[];
  category: string | null;
}

export async function getActiveLessons(): Promise<Lesson[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, text, TO_CHAR(source_date, 'YYYY-MM-DD') AS source_date,
           market_conditions, tags, category
    FROM lessons WHERE status = 'active'
    ORDER BY source_date DESC
  `;
  return rows.map((r) => ({
    id: r.id as number,
    text: r.text as string,
    sourceDate: r.source_date as string,
    marketConditions: (r.market_conditions ?? null) as Record<string, unknown> | null,
    tags: (r.tags ?? []) as string[],
    category: (r.category ?? null) as string | null,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/lessons.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for `formatLessonsBlock()`**

Test that the formatter produces the `<lessons_learned>` XML block with numbered entries and context parentheticals. Test empty lessons returns empty string. Test that missing `marketConditions` fields are handled gracefully (omitted or shown as `N/A`, never `undefined`).

- [ ] **Step 6: Implement `formatLessonsBlock()` in `api/_lib/lessons.ts`**

Takes a `Lesson[]` and returns the formatted string for system prompt injection. Each lesson gets `[N] (date | structure | VIX:X | GEX:zone | day | correct:yes/no)` followed by the text and tags.

- [ ] **Step 7: Run tests to verify passing**

Run: `npx vitest run api/__tests__/lessons.test.ts`
Expected: All PASS

- [ ] **Step 8: Write failing tests for `buildMarketConditions()`**

Test that it correctly derives the market conditions JSONB from an analysis row + snapshot row, extracting `wasCorrect` from the full_response JSONB.

- [ ] **Step 9: Implement `buildMarketConditions()` in `api/_lib/lessons.ts`**

Takes analysis row data + snapshot row data and returns the `MarketConditions` object per the spec's derivation table.

- [ ] **Step 10: Run tests and verify passing**

Run: `npx vitest run api/__tests__/lessons.test.ts`
Expected: All PASS

- [ ] **Step 11: Write failing tests for `insertLesson()` and `supersedeLesson()`**

Test that `insertLesson()` inserts a row with all required fields. Test that `supersedeLesson()` calls `nextval` outside the transaction, then batches the INSERT + UPDATE inside `sql.transaction()`.

- [ ] **Step 12: Implement `insertLesson()` and `supersedeLesson()`**

`insertLesson()` does a single INSERT. `supersedeLesson()` calls `nextval('lessons_id_seq')` as a **separate query outside the transaction** (Phase A), then batches the INSERT (using the pre-allocated ID) + UPDATE in `sql.transaction()` (Phase B). The `nextval` must happen before `sql.transaction()` because the Neon HTTP driver's non-interactive transactions cannot inspect intermediate results.

- [ ] **Step 13: Write failing tests for `upsertReport()` and `updateReport()`**

Test bootstrap upsert creates/updates a report row. Test `updateReport()` updates counts and JSONB.

- [ ] **Step 14: Implement `upsertReport()` and `updateReport()`**

`upsertReport()` uses `INSERT ... ON CONFLICT (week_ending) DO UPDATE`. `updateReport()` updates the row with final counts and report JSONB.

- [ ] **Step 15: Run full test suite**

Run: `npx vitest run api/__tests__/lessons.test.ts`
Expected: All PASS

- [ ] **Step 16: Commit**

```bash
git add api/_lib/lessons.ts api/__tests__/lessons.test.ts
git commit -m "feat: add lessons CRUD module with getActiveLessons, insertLesson, supersedeLesson, reports"
```

---

### Task 3: Embeddings Helper — `api/_lib/embeddings.ts`

**Files:**
- Create: `api/_lib/embeddings.ts`
- Test: `api/__tests__/embeddings.test.ts`
- Modify: `package.json` (add `openai` dependency)

- [ ] **Step 1: Install OpenAI SDK**

Run: `npm install openai`

- [ ] **Step 2: Write failing tests for `generateEmbedding()`**

Create `api/__tests__/embeddings.test.ts`. Start with `// @vitest-environment node`. Mock the OpenAI client. Also mock `@neondatabase/serverless` (needed for `findSimilarLessons()` tests later in this task — set up both mocks upfront). Test that `generateEmbedding()` calls `text-embedding-3-small` with the input text and returns the embedding vector. Test error handling — returns null on API failure.

```typescript
describe('generateEmbedding', () => {
  it('returns a 1536-dimension vector for valid text', async () => {
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: new Array(1536).fill(0.1) }],
    });
    const result = await generateEmbedding('test text');
    expect(result).toHaveLength(1536);
  });

  it('returns null when the API fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API timeout'));
    const result = await generateEmbedding('test text');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run api/__tests__/embeddings.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `generateEmbedding()` in `api/_lib/embeddings.ts`**

```typescript
import OpenAI from 'openai';

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await getClient().embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run api/__tests__/embeddings.test.ts`
Expected: PASS

- [ ] **Step 6: Write failing test for `findSimilarLessons()`**

Test that it queries active lessons ordered by cosine distance and returns top 5.

- [ ] **Step 7: Implement `findSimilarLessons()` in `api/_lib/embeddings.ts`**

Takes an embedding vector, queries lessons table with `ORDER BY embedding <=> $1 LIMIT 5`.

- [ ] **Step 8: Run tests and verify passing**

Run: `npx vitest run api/__tests__/embeddings.test.ts`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add api/_lib/embeddings.ts api/__tests__/embeddings.test.ts package.json package-lock.json
git commit -m "feat: add OpenAI embeddings helper with generateEmbedding and findSimilarLessons"
```

---

### Task 4: System Prompt Injection — Modify `/api/analyze`

**Files:**
- Modify: `api/analyze.ts` (split SYSTEM_PROMPT, add lesson fetch + injection)
- Test: `api/__tests__/analyze.test.ts` (add test for lesson injection)

- [ ] **Step 1: Write failing test for lesson injection**

Add a test in `api/__tests__/analyze.test.ts` that verifies when active lessons exist in the DB, the system prompt sent to Anthropic includes the `<lessons_learned>` block. Mock `getActiveLessons()` to return test lessons. Check the prompt passed to `mockStream`.

```typescript
it('injects active lessons into system prompt', async () => {
  const { getActiveLessons } = await import('../_lib/lessons.js');
  vi.mocked(getActiveLessons).mockResolvedValueOnce([
    {
      id: 1, text: 'Test lesson about charm',
      sourceDate: '2026-03-20',
      marketConditions: { vix: 26.2, structure: 'CCS', gexRegime: 'danger', dayOfWeek: 'Friday', wasCorrect: true },
      tags: ['charm', 'gex'], category: 'gamma',
    },
  ]);

  // ... trigger handler with valid body ...

  const systemPrompt = mockStream.mock.calls[0][0].system[0].text;
  expect(systemPrompt).toContain('<lessons_learned>');
  expect(systemPrompt).toContain('Test lesson about charm');
  expect(systemPrompt).toContain('</lessons_learned>');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/analyze.test.ts -t "injects active lessons"`
Expected: FAIL — no lessons injection exists yet.

- [ ] **Step 3: Split the SYSTEM_PROMPT constant**

In `api/analyze.ts`, find line 346 (`</structure_selection_rules>`) and line 348 (`<data_handling>`). Split into `SYSTEM_PROMPT_PART1` (up to and including `</structure_selection_rules>`) and `SYSTEM_PROMPT_PART2` (from `<data_handling>` onward).

- [ ] **Step 4: Add lesson fetch and injection in the handler**

At the top of the handler (after auth checks, before the Anthropic call), fetch active lessons and build the combined prompt:

```typescript
import { getActiveLessons, formatLessonsBlock } from './_lib/lessons.js';

// Inside handler, before building messages:
const lessons = await getActiveLessons();
const lessonsBlock = formatLessonsBlock(lessons);
const systemPrompt = SYSTEM_PROMPT_PART1 + '\n' + lessonsBlock + '\n' + SYSTEM_PROMPT_PART2;
```

- [ ] **Step 5: Add mock for lessons module in test file**

Add `getActiveLessons` and `formatLessonsBlock` to the existing `vi.mock('../_lib/db.js')` block or add a separate mock for `../_lib/lessons.js`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run api/__tests__/analyze.test.ts -t "injects active lessons"`
Expected: PASS

- [ ] **Step 7: Write test for empty lessons (no injection)**

Verify that when `getActiveLessons()` returns `[]`, the system prompt does NOT contain `<lessons_learned>` (the block is empty/omitted).

- [ ] **Step 8: Run full analyze test suite**

Run: `npx vitest run api/__tests__/analyze.test.ts`
Expected: All PASS (no regressions).

- [ ] **Step 9: Commit**

```bash
git add api/analyze.ts api/__tests__/analyze.test.ts
git commit -m "feat: inject active lessons into analysis system prompt"
```

---

### Task 5: Cron Handler — `api/cron/curate-lessons.ts`

**Files:**
- Create: `api/cron/curate-lessons.ts`
- Test: `api/__tests__/curate-lessons.test.ts`

- [ ] **Step 1: Write failing test for auth verification**

Create `api/__tests__/curate-lessons.test.ts`. Start with `// @vitest-environment node`. Note: the `api/cron/` directory does not exist yet — it will be created when the handler file is written. Test that requests without `Authorization: Bearer <CRON_SECRET>` get 401.

- [ ] **Step 2: Write failing test for no-reviews-found path**

Mock `getDb()` to return empty results for the unprocessed reviews query. Verify the handler returns 200 with `reviewsProcessed: 0` and upserts a report row.

- [ ] **Step 3: Implement the cron handler skeleton**

Create `api/cron/curate-lessons.ts` with:
- Auth check (`CRON_SECRET`)
- `export const config = { maxDuration: 780 }`
- Bootstrap report upsert (step 0)
- Unprocessed reviews query (step 1)
- Early exit for no reviews (step 2)
- Empty processing loop placeholder

- [ ] **Step 4: Run tests to verify auth and no-reviews tests pass**

Run: `npx vitest run api/__tests__/curate-lessons.test.ts`
Expected: Auth and no-reviews tests PASS

- [ ] **Step 5: Write failing test for the full processing loop**

Mock a single review with `lessonsLearned: ['Test lesson']`. Mock `generateEmbedding()` to return a vector. Mock `findSimilarLessons()` to return empty (no existing lessons). Mock Anthropic to return `{ action: 'add', reason: 'New', tags: ['test'], category: 'management' }`. Verify `insertLesson()` is called and the report contains the added lesson.

- [ ] **Step 6: Implement Phase A — preparation (embedding + Claude curation)**

For each review's `lessonsLearned[]`:
1. Call `generateEmbedding()` — skip on null (record in errors)
2. Call `findSimilarLessons()` with the embedding
3. Call Claude Opus (`claude-opus-4-6`) with `thinking: { type: 'adaptive' }` and `output_config: { effort: 'high' }`, passing the candidate + similar lessons + market conditions
4. Parse Claude's JSON response — on malformed, treat as SKIP
5. Collect all prepared lessons for this review

- [ ] **Step 7: Implement Phase B — atomic DB writes per review**

For each review's prepared lessons:
1. Pre-allocate IDs via `nextval`
2. Batch INSERT + UPDATE in `sql.transaction()`
3. On transaction failure, record error and continue

- [ ] **Step 8: Implement report finalization**

Update the bootstrapped report row with final counts and full changelog JSONB.

- [ ] **Step 9: Run full cron test suite**

Run: `npx vitest run api/__tests__/curate-lessons.test.ts`
Expected: All PASS

- [ ] **Step 10: Write test for embedding failure handling**

Mock `generateEmbedding()` to return null for one lesson. Verify it's skipped and recorded in report errors, but other lessons in the same review still process.

- [ ] **Step 11: Write test for malformed Claude response**

Mock Claude to return invalid JSON. Verify the lesson is treated as SKIP with the raw response logged in errors.

- [ ] **Step 12: Write test for supersede action**

Mock Claude to return `{ action: 'supersede', supersedes_id: 1, ... }`. Verify both the new INSERT and the old UPDATE happen via `supersedeLesson()`.

- [ ] **Step 13: Write test for transaction failure and rollback**

Mock `sql.transaction()` to throw an error for one review. Verify: that review's lessons are not inserted, the error is recorded in the report, but the next review's lessons are processed successfully. This confirms the per-review atomicity guarantee.

- [ ] **Step 14: Run full cron test suite**

Run: `npx vitest run api/__tests__/curate-lessons.test.ts`
Expected: All PASS

- [ ] **Step 15: Commit**

```bash
git add api/cron/curate-lessons.ts api/__tests__/curate-lessons.test.ts
git commit -m "feat: add Friday cron for automated lesson curation with two-phase processing"
```

---

### Task 6: Configuration — vercel.json and env vars

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add cron schedule and function config to `vercel.json`**

Add the `crons` array and extend the `functions` block:

```json
"crons": [{
  "path": "/api/cron/curate-lessons",
  "schedule": "0 3 * * 6"
}],
"functions": {
  "api/analyze.ts": { "maxDuration": 800 },
  "api/cron/curate-lessons.ts": { "maxDuration": 780 }
}
```

- [ ] **Step 2: Add OPENAI_API_KEY to .env.example**

Add `OPENAI_API_KEY=` and `CRON_SECRET=` to the `.env.example` file. Add a comment noting `CRON_SECRET` is auto-provided by Vercel in production but needed for local cron testing.

- [ ] **Step 3: Run lint to verify no issues**

Run: `npx tsc --noEmit && npx eslint .`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add vercel.json .env.example
git commit -m "config: add cron schedule for lesson curation and OPENAI_API_KEY to env example"
```

---

### Task 7: Integration Test — Full Pipeline

**Files:**
- Test: `api/__tests__/lessons-integration.test.ts`

- [ ] **Step 1: Write an integration test that exercises the full pipeline**

Test the complete flow: save an analysis with review mode → run cron handler → verify lessons table populated → call analyze handler → verify lessons appear in system prompt.

All external services (Neon, OpenAI, Anthropic) are mocked. The test verifies the wiring between modules.

- [ ] **Step 2: Run integration test**

Run: `npx vitest run api/__tests__/lessons-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run the entire test suite**

Run: `npx vitest run`
Expected: All PASS (no regressions across any test file).

- [ ] **Step 4: Commit**

```bash
git add api/__tests__/lessons-integration.test.ts
git commit -m "test: add integration test for lessons learned pipeline"
```

---

### Task 8: Deploy and Run Migration

- [ ] **Step 1: Add OPENAI_API_KEY to Vercel environment variables**

Run: `vercel env add OPENAI_API_KEY` (paste the API key when prompted)

- [ ] **Step 2: Deploy to preview**

Run: `vercel deploy`

- [ ] **Step 3: Run migration on the deployed preview**

Call `POST /api/journal/migrate` on the preview URL to apply migration #2.

- [ ] **Step 4: Verify tables exist**

Check Neon UI — confirm `lessons` and `lesson_reports` tables are created with correct columns and indexes.

- [ ] **Step 5: Deploy to production**

Run: `vercel --prod`

- [ ] **Step 6: Run migration on production**

Call `POST /api/journal/migrate` on the production URL.

- [ ] **Step 7: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: deployment verification complete"
```
