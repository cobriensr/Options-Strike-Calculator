# Periscope Chat — Manual Read + Debrief Component

## Goal

A focused dashboard panel where the user uploads 1–3 UW Periscope screenshots (Periscope chart + GEX heat map + Charm heat map), picks **Read** or **Debrief** mode, and gets back a structured Claude analysis using the `periscope` skill. The response + embedding are persisted to a new `periscope_analyses` table for future retrieval, calibration, and pattern matching. Manual capture for now — automation is a Phase 4+ stretch goal not in this plan.

The build is mostly **lift-and-refit** of existing infrastructure:

- Vision-enabled Anthropic call: lift from `api/analyze.ts` (cache_control + messages.stream pattern)
- Image upload + Vercel Blob: lift from `api/_lib/trace-live-blob.ts` (private store, base64 → Buffer pattern)
- Embedding pipeline: reuse `api/_lib/embeddings.ts` (text-embedding-3-large @ 2000 dims, HNSW index)
- Schema shape: mirror `trace_live_analyses` (migration 100)
- Test mocking: mirror `api/__tests__/analyze.test.ts`
- Drag-drop UI: lift from `src/components/ChartAnalysis/ChartControls.tsx`
- Section integration: standard `App.tsx` lazy import + `SectionNav` entry

## Phases

### Phase 1A — Foundation: migration, schema, blob helper, skill update (4 files)

Independent bits the endpoint depends on. Lands first; nothing user-visible yet.

- Migration **103** adds `periscope_analyses` table mirroring `trace_live_analyses`, plus periscope-specific columns: `mode`, `parent_id`, `calibration_quality`, `regime_tag`, `user_context`, and structured trigger/cone fields.
- Update `db.test.ts` for migration 103 (one new mock per project pattern).
- New helper `api/_lib/periscope-blob.ts` mirroring `trace-live-blob.ts` (private store, path convention `periscope/{date}/{HHmm}/{kind}.png`).
- Zod schema for the request body in `api/_lib/validation.ts`.
- Update `.claude/skills/periscope/SKILL.md` to add the "append JSON block at end" instruction so structured-field extraction works.

**Verification:** `npm run review` clean (TS + ESLint + tests).

### Phase 1B — Endpoint + endpoint test + auth wiring (3 files)

Backend-only slice. After this lands, the endpoint is callable via curl and produces complete database rows. No UI yet.

- New endpoint `api/periscope-chat.ts`: accepts `{ mode, images_base64[], context?, parent_id? }`. Uploads each image via the helper from 1A, calls Anthropic with the `periscope` skill as cached system prompt + adaptive thinking high effort, generates embedding, parses the JSON block from the response, writes row with structured fields populated, returns `{ id, prose_text, structured }`.
- Tests in `api/__tests__/periscope-chat.test.ts` mirroring `analyze.test.ts` mocking strategy (mock `@anthropic-ai/sdk`, `db.js`, `embeddings.js`, the blob helper). Cover: happy path (read mode), debrief with parent_id, JSON-block parse failure → NULL columns + Sentry, image-size limit, owner-auth rejection.
- Add `/api/periscope-chat` to the BotID `protect` array in `src/main.tsx`.

**Verification:** `npm run review` clean. Manual `curl` test against local dev with 1–3 base64-encoded screenshots returns a structured response and creates a row in `periscope_analyses` with the embedding column populated.

### Phase 2 — Frontend chat panel (depends on Phase 1)

Minimal usable UI. After this lands, you can use the feature in production.

- New folder `src/components/PeriscopeChat/`:
  - `PeriscopeChat.tsx` — the panel: mode toggle (Read / Debrief), drag-drop upload area (max 3 images), optional context textarea, submit button, streaming response display.
  - `usePeriscopeChat.ts` — state hook (selected files, mode, in-flight, response, parent_id).
  - `types.ts` — shared types between component, hook, and the API response shape.
- Lift drag-drop logic from `ChartControls.tsx` (handleDrop, handleFileSelect, removeImage).
- Lift response rendering pattern from `AnalysisHistory` (markdown / streaming).
- Wire into `src/App.tsx` as a lazy-loaded section with `Suspense` + `ErrorBoundary`.
- Add `NavSection` entry so it shows in `SectionNav`.

**Verification:** start dev server (`npm run dev:full`), upload 3 images, submit Read mode, verify response renders + DB row created. Switch to Debrief mode, submit, verify the debrief row gets a `parent_id` if one was passed.

### Phase 3 — History panel + calibration UI + response viewer

The data-as-learning-asset payoff phase. Full historical response viewing — mirror the pattern from the existing `AnalysisHistory` component so the user can pull up any past read alongside a current chart for comparison.

- `PeriscopeChatHistory.tsx` lists recent rows by `trading_date DESC`. Each row shows time, mode, regime tag (if set), calibration stars, and a "view" affordance.
- **Detail view (PeriscopeChatDetail.tsx)** — click any past row to render its full prose response, structured fields (spot, cone bounds, triggers), uploaded screenshots inline, and parent-link breadcrumb (for debriefs). Renders in a panel that can sit alongside the live PeriscopeChat panel for side-by-side comparison.
- Click a Read row in the listing → opens Debrief mode in the live panel with `parent_id` prefilled and the parent's structured fields loaded as context.
- Inline editing for `calibration_quality` (1–5 stars) and `regime_tag` (dropdown: pin / drift-and-cap / gap-and-rip / trap / cone-breach / other).
- New endpoint `api/periscope-chat-list.ts` (paginated fetch, owner-only).
- New endpoint `api/periscope-chat-detail.ts` (single-row fetch by id, includes signed Blob URLs for the images).
- New endpoint `api/periscope-chat-update.ts` for inline annotation updates.

**Verification:** load history panel, click any past row, see prose + structured fields + screenshots render; click "Debrief this", see parent context loaded in live panel; star a row, refresh, see persisted; update regime tag, refresh, see persisted; open a past read alongside a live chart and visually compare.

## Files to create / modify

### Phase 1A (4 files)

- `api/_lib/db-migrations.ts` — **modify**, add migration 103
- `api/__tests__/db.test.ts` — **modify**, add migration 103 mock + assertion
- `api/_lib/periscope-blob.ts` — **create** (~50 LOC)
- `api/_lib/validation.ts` — **modify**, add request schema
- `.claude/skills/periscope/SKILL.md` — **modify**, add JSON-block-output instruction

### Phase 1B (3 files)

- `api/periscope-chat.ts` — **create** (~200 LOC)
- `api/__tests__/periscope-chat.test.ts` — **create**
- `src/main.tsx` — **modify**, add `/api/periscope-chat` to BotID `protect` array

### Phase 2

- `src/components/PeriscopeChat/PeriscopeChat.tsx` — **create**
- `src/components/PeriscopeChat/usePeriscopeChat.ts` — **create**
- `src/components/PeriscopeChat/types.ts` — **create**
- `src/App.tsx` — **modify**, add lazy import + render
- `src/constants/sections.ts` (or wherever `NavSection[]` is defined) — **modify**, add nav entry

### Phase 3

- `api/periscope-chat-list.ts` — **create**
- `api/periscope-chat-detail.ts` — **create** (single-row fetch with signed Blob URLs)
- `api/periscope-chat-update.ts` — **create**
- `src/main.tsx` — **modify**, add 3 endpoints to BotID `protect` array
- `src/components/PeriscopeChat/PeriscopeChatHistory.tsx` — **create** (list view)
- `src/components/PeriscopeChat/PeriscopeChatDetail.tsx` — **create** (single-row read viewer with images + structured fields)
- `src/components/PeriscopeChat/CalibrationStars.tsx` — **create**
- `src/components/PeriscopeChat/RegimeTagSelect.tsx` — **create**

## Database schema (Phase 1)

```sql
CREATE TABLE IF NOT EXISTS periscope_analyses (
  id BIGSERIAL PRIMARY KEY,
  trading_date DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode TEXT NOT NULL CHECK (mode IN ('read', 'debrief')),
  parent_id BIGINT REFERENCES periscope_analyses(id),
  user_context TEXT,
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  prose_text TEXT NOT NULL,
  full_response JSONB NOT NULL,
  analysis_embedding vector(2000),
  -- Structured fields parsed from Claude's response (NULL on parse failure):
  spot NUMERIC,
  cone_lower NUMERIC,
  cone_upper NUMERIC,
  long_trigger NUMERIC,
  short_trigger NUMERIC,
  regime_tag TEXT,
  -- User annotations (set later via Phase 3 UI):
  calibration_quality SMALLINT CHECK (calibration_quality BETWEEN 1 AND 5),
  -- Anthropic call metadata:
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_periscope_analyses_trading_date
  ON periscope_analyses(trading_date DESC);

CREATE INDEX IF NOT EXISTS idx_periscope_analyses_parent_id
  ON periscope_analyses(parent_id) WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_periscope_analyses_calibration_quality
  ON periscope_analyses(calibration_quality DESC) WHERE calibration_quality IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_periscope_analyses_embedding
  ON periscope_analyses USING hnsw (analysis_embedding vector_cosine_ops)
  WHERE analysis_embedding IS NOT NULL;
```

## Data dependencies

- `pgvector` extension — already enabled (migration 2). No new install.
- Vercel Blob — `BLOB_READ_WRITE_TOKEN` already set. Reuse the existing private store.
- `ANTHROPIC_API_KEY` — already set.
- `OPENAI_API_KEY` — already set (for embeddings).
- BotID `protect` list — must include the new endpoints (project convention from CLAUDE.md).
- **No new env vars required.**

## Decisions (confirmed 2026-04-30)

1. **Default model:** **Claude Opus 4.7** with **adaptive thinking, high effort**. Use the Anthropic SDK's extended-thinking parameter set to high effort. Mirror the configuration pattern in `api/analyze.ts` (which already uses Opus). No model toggle — Opus is the only option for now.

2. **Structured-field extraction:** **JSON code block at end of response.** Skill instruction adds: _"After your prose response, append a fenced ` ```json ` code block with these exact keys: `spot`, `cone_lower`, `cone_upper`, `long_trigger`, `short_trigger`, `regime_tag`. Use null for any field not applicable to the current chart."_ Server-side, regex-extract the last fenced JSON block, `JSON.parse` it, populate the typed DB columns. On parse failure, log a Sentry event and store the row with NULLs in those columns (response prose is still saved). The UI also strips the trailing JSON block before rendering the prose so it doesn't show in the response display. The skill file at `.claude/skills/periscope/SKILL.md` will be updated as part of Phase 1A to include this instruction.

3. **Debrief without parent_id:** allow standalone. `parent_id` optional in request schema.

4. **Periscope skill loading:** deploy-time inline via `fs.readFileSync` at module load on the API side; Vite `?raw` import on the frontend if ever needed (not in current scope).

5. **Image size limits:** max 10 MB per file, max 30 MB combined. Reject with 400 if exceeded.

6. **Auth:** **Owner-only**. Use `rejectIfNotOwnerOrGuest` with the guest path explicitly disabled (this is a Claude-API-backed endpoint with cost; matches the analyze.ts auth model).

7. **Phase scope:** **All 3 phases** are in scope. Phase 3 includes a full **historical response viewer** mirroring the existing `AnalysisHistory` component pattern — list past reads, click to open a detail view that renders the prose response (and any structured fields) so the user can compare past reads against today's chart side-by-side.

## Thresholds / constants

- Max images per submission: **3**
- Max image file size: **10 MB** per image
- Max combined upload size: **30 MB**
- Anthropic timeout: **600s** (Opus + adaptive thinking can take longer)
- Anthropic max retries: **3** (SDK default)
- Anthropic thinking config: **adaptive thinking, high effort** (mirror the SDK params used in `analyze.ts`)
- Embedding model: `text-embedding-3-large`, **2000 dims** (existing pattern in `embeddings.ts`)
- Default Anthropic model: **`claude-opus-4-7`** (only model — no toggle)
- Blob path convention: `periscope/{YYYY-MM-DD}/{HHmmss}/{kind}.png` (kind = `chart` | `gex` | `charm`)
- HNSW index params: same as `trace_live_analyses.analysis_embedding` (project default)
- Cache TTL: **1h** ephemeral cache (matches `analyze.ts`)

## Out of scope (deferred)

- Automated 10-min capture via Playwright (Phase 4+ if ever)
- Event detection on extracted vectors
- Backfill of historical Periscope screenshots
- Retrieval UI ("today looks like X") — needs ≥30 days of data first
- Cluster-based regime auto-tagging — needs ≥100 calibrated reads first
- Cross-day analytics / trade journal export

These are intentionally deferred until Phase 1–3 produce real data to work with.

## Done when

- Phase 1: endpoint live, DB row created end-to-end via curl, all tests passing.
- Phase 2: dashboard panel functional, manual upload + read/debrief works in browser, response renders cleanly, DB row visible.
- Phase 3: history panel browsable, calibration stars + regime tag persist, debrief link from a past read prefills `parent_id`.

After Phase 3 the feature is "complete" for the manual flow. Future phases (automation, retrieval, clustering) build on top of the data accumulated.
