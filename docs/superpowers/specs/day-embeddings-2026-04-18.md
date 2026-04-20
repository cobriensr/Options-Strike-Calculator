# Day Embeddings for Historical Analogs

## Goal

Give Claude historical precedents for today's setup. For each analyze call, retrieve the top-k trading days whose morning shape most closely matches today's, and inject them into the analyze prompt. Ships in two swappable backends on top of one shared pgvector infrastructure:

- **Phase B — OpenAI text embedding** (simple, ships fast)
- **Phase C — Engineered feature vector** (richer similarity, swaps in later)

Same retrieval path, same table schema seam, same consumer code. Only the embedding computation differs.

## Why (not scalar-delta analogs)

The sidecar already has `/archive/analog-days` returning k-nearest by first-hour delta. That's interpretable but lossy: a gap-down morning and a slow-grind morning with identical 1h deltas are structurally different trading situations. Embeddings capture the *shape*; scalar deltas only capture one scalar.

## Architecture (shared for B and C)

```
┌───────────────────────┐
│  Neon Postgres        │
│  day_embeddings table │   <─── pgvector cosine query
│  (pgvector extension) │
└───────────────────────┘
           ▲
           │ writes (backfill + nightly)
           │
┌───────────────────────┐   ┌───────────────────────┐
│  Sidecar (Railway)    │   │  Vercel analyze call  │
│  /archive/day-summary │──▶│  embed today's sum    │
│  (DuckDB over volume) │   │  cosine-k from Neon   │
└───────────────────────┘   │  format + inject      │
                            └───────────────────────┘
                                      │
                                      ▼
                              Claude sees top-k
                              historical analogs
                              in user message
```

**Split of responsibilities**:

- **Sidecar**: owns archive → produces a canonical text summary per date (feature-extraction boundary).
- **Vercel**: owns Claude + user-facing LLM work → calls OpenAI for embedding, queries pgvector, formats for the prompt.
- **Neon**: owns state → `day_embeddings` table with vector column + date + metadata.

## Data dependencies

- **pgvector extension** must be enabled on Neon. *Open question*: is it already? Check with `SELECT * FROM pg_available_extensions WHERE name = 'vector';` before Phase B-1.
- `OPENAI_API_KEY` — already in Vercel env (used by `embeddings.ts`).
- Sidecar `/archive/day-summary?date=X` — new endpoint, Phase B-2.

## Open questions (default picks noted)

- **Embedding model for Phase B** — default: `text-embedding-3-small` (1536-dim, $0.02 / 1M tokens). Used by existing `embeddings.ts`. Alternative: `text-embedding-3-large` (3072-dim, $0.13 / 1M) — more accurate, more storage. Start small.
- **Backfill cost** — 4000 days × ~100 tokens per summary = 400K tokens → **~$0.008 total on 3-small**. Negligible.
- **Similarity metric** — pgvector supports `<->` (L2), `<=>` (cosine), `<#>` (negative inner product). Default cosine (`<=>`) for OpenAI embeddings per their docs.
- **Temporal scope** — default: don't filter by era. A 2020 COVID day can be a legitimate analog for a 2025 volatility day. If era bias hurts signal quality, add a `--since` filter later.
- **Analog exclusion window** — skip the last N trading days to avoid "analog = yesterday, obviously". Default: 5 days.
- **Cache today's embedding?** — default: no. Regenerate every analyze call. Embedding call is 50-100ms and we want today's summary to reflect the latest minute.

## Files created / modified

| File | Phase | Purpose |
|---|---|---|
| `api/_lib/db-migrations.ts` | B-1 | Migration N+1: `day_embeddings` table + pgvector index |
| `api/__tests__/db.test.ts` | B-1 | Bump mock call counts, add migration to expected list |
| `sidecar/src/archive_query.py` | B-2 | Add `day_summary_text(date)` function |
| `sidecar/src/health.py` | B-2 | Add `GET /archive/day-summary?date=...` route |
| `sidecar/tests/test_archive_query.py` | B-2 | 2-3 tests for the new function |
| `api/_lib/archive-sidecar.ts` | B-3 | NEW. `fetchDaySummary(date)` helper that calls sidecar |
| `api/_lib/day-embeddings.ts` | B-4 | NEW. `embedDaySummary()`, `findSimilarDays()`, `upsertDayEmbedding()` |
| `api/_lib/analyze-context-formatters.ts` | B-5 | Add `formatSimilarDaysForClaude()` |
| `api/_lib/analyze-context-fetchers.ts` | B-5 | Add `fetchSimilarDaysContext()` |
| `api/_lib/analyze-context.ts` | B-5 | Wire `fetchSimilarDaysContext` into the parallel fetch block |
| `scripts/backfill-day-embeddings.mjs` | B-6 | NEW. One-shot over 4000 historical dates |
| `api/cron/embed-yesterday.ts` | B-7 | Nightly cron (runs once/day, embeds prior trading day) |
| `vercel.json` | B-7 | Register the cron |
| *(same files, swap bodies)* | C | Replace OpenAI embedding with engineered feature vector |

## Thresholds / constants

- Default `k = 15` for similar-days retrieval (sweet spot: large enough cohort, small enough Claude prompt)
- Embedding column: `vector(1536)` for B (3-small); `vector(70)` for C (engineered). Store in separate columns or separate tables; pick in B-1.
- Similarity threshold: none on retrieve path. Claude can ignore weak analogs; we don't want to silently return `[]`.
- Retrieval timeout: 2000ms. If it trips, skip the block and log — never block an analyze call.

## Phases

### Phase B-1 — Schema + migration

- [ ] Verify pgvector is available on Neon: `SELECT * FROM pg_extension WHERE extname='vector'` (run via existing DB connection).
- [ ] If unavailable: enable via `CREATE EXTENSION vector;` (no-op if Neon has it preinstalled; check the `neon_postgres_extensions` list in their docs).
- [ ] Add migration to `db-migrations.ts`:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE IF NOT EXISTS day_embeddings (
      date DATE PRIMARY KEY,
      symbol TEXT NOT NULL,
      summary TEXT NOT NULL,
      embedding vector(1536) NOT NULL,
      embedding_model TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX day_embeddings_vec_idx
      ON day_embeddings USING hnsw (embedding vector_cosine_ops);
  ```
- [ ] Update `api/__tests__/db.test.ts` — bump the applied-migrations mock + the SQL call count.
- [ ] `npm run review` — migration test passes.

### Phase B-2 — Sidecar day-summary endpoint

- [ ] Add `day_summary_text(date)` to `archive_query.py`. Produces a compact string like:
  `"2024-08-05 ESU4 | open 5324.00 | 1h delta -20.5 | 2h delta -65 | session range 204.5 pts | volume 3.25M (2.1x avg) | close 5273.75 (-50.25)"`
- [ ] Wire `GET /archive/day-summary?date=YYYY-MM-DD` route in `health.py`.
- [ ] 2-3 tests covering: correct format, date with no data → 404, invalid date → 400.
- [ ] Deploy and curl-verify against a known historical date.

### Phase B-3 — Vercel sidecar helper

- [ ] New env var `SIDECAR_URL` (Vercel env). Default to Railway public URL; override for staging/local.
- [ ] New file `api/_lib/archive-sidecar.ts` with `fetchDaySummary(date) : Promise<string | null>` — 2s timeout, returns null on error, never throws.
- [ ] Unit test with `fetch` mocked.

### Phase B-4 — OpenAI embedding + pgvector retrieval

- [ ] New file `api/_lib/day-embeddings.ts`:
  - `embedDaySummary(summary: string) : Promise<number[]>` — uses OpenAI `text-embedding-3-small`.
  - `findSimilarDays(embedding: number[], k: number, excludeDate: string) : Promise<SimilarDay[]>` — pgvector cosine query.
  - `upsertDayEmbedding(date, summary, embedding)` — for backfill + nightly cron.
- [ ] Tests: mock OpenAI, use pg-mem or real Neon test DB for the pgvector query.

### Phase B-5 — Analyze-context injection

- [ ] Add `formatSimilarDaysForClaude(target, analogs)` to `analyze-context-formatters.ts`. Output matches the sketched table format from our 9:35 PM exchange.
- [ ] Add `fetchSimilarDaysContext(analysisDate)` to `analyze-context-fetchers.ts` — orchestrates: fetchDaySummary → embed → findSimilar → format. Each step null-guarded.
- [ ] Wire into `analyze-context.ts`'s parallel fetch block, under a new content block key `similarDaysBlock`.
- [ ] Update the user message template in `analyze-context.ts` to splice `${similarDaysBlock}` at an appropriate spot (probably near the other historical/flow context).
- [ ] `npm run review` passes.

### Phase B-6 — Backfill

- [ ] `scripts/backfill-day-embeddings.mjs`: reads `convert_summary.json` from Blob (or just iterates 2010-06-06 → yesterday by weekday), skips weekends and known holidays, for each date:
  1. `fetchDaySummary(date)` via sidecar
  2. `embedDaySummary(text)`
  3. `upsertDayEmbedding(...)`
- [ ] Log progress, rate-limit to 10 req/sec against OpenAI (well under the 3000 rpm default).
- [ ] Run once: `node scripts/backfill-day-embeddings.mjs`. Expect ~10min runtime, ~$0.008 OpenAI cost.
- [ ] Verify: `SELECT COUNT(*) FROM day_embeddings` ≈ 4000.

### Phase B-7 — Nightly cron

- [ ] `api/cron/embed-yesterday.ts`: runs at 3 AM UTC, computes yesterday's trading date (or skips if weekend/holiday), calls the same fetch→embed→upsert pipeline.
- [ ] Register in `vercel.json` crons list.
- [ ] Reuse `CRON_SECRET` gate (same pattern as other crons).
- [ ] Add test in `api/__tests__/embed-yesterday.test.ts` matching the existing cron test pattern.

### Phase B-8 — Verify end-to-end

- [ ] Hit `/api/analyze` with a real setup, confirm the similar-days block appears in the outgoing Anthropic payload (enable a logging toggle or scrape Sentry).
- [ ] Ask Claude explicitly "name one date your analog pulled" in the response — sanity check the context is actually being read.
- [ ] Monitor analyze latency — if the extra fetch+embed adds > 500ms, consider parallelizing with the other fetchers (it already should be; confirm).

### Phase C — Engineered feature vector (later)

- [ ] Design feature set. Starting point: 60 normalized minute-close percent-changes (full morning) + overnight gap + VIX level at open + volume vs 20-day avg. ~65 dims.
- [ ] Add `day_features_v2` table (separate table keeps B available as fallback): `vector(65)`, same PK, same index type.
- [ ] Implement `day_features_v2(date)` in sidecar, returning the numpy array.
- [ ] New Vercel code path that uses the engineered vector when the feature flag `USE_DAY_FEATURES_V2=1` is set, else falls through to B.
- [ ] Re-backfill all historical dates into v2 table.
- [ ] A/B: run both retrievals for a week, compare analog quality by hand on ~10 known setups. Promote v2 or tune.

### Phase B-9 — Final verification (always last)

- [ ] `npm run review` green
- [ ] sidecar `pytest` green
- [ ] Cron fires successfully on a Sunday-night → Monday-morning cycle
- [ ] Analyze endpoint latency regression < 200ms

## Done when

- [ ] pgvector-backed `day_embeddings` populated for 2010-06 → yesterday
- [ ] Analyze calls include a "historical analogs" block with ≥10 rows
- [ ] Nightly cron has run cleanly for 3 consecutive days
- [ ] Claude references specific historical dates in analyze responses when the setup warrants

## Notes

- **No scalar-delta deprecation**: keep `/archive/analog-days` even after day-embeddings ships. It's cheap, interpretable, and useful as a sanity check when the embeddings return something surprising.
- **Why text embeddings over numeric first**: discovering which features to put in C's vector is the hard part. B's live usage will show where the OpenAI embedding wins vs loses — that's the empirical feedback you need to design C. Reversing the order (build C blind, then maybe B) wastes feature-engineering effort.
- **`embeddings.ts` pattern reuse**: existing `api/_lib/embeddings.ts` does an analogous thing for past *analyses* — same 3-small model, same pgvector pattern, different table. Phase B is essentially "do that, but for market days."
- **Cost math sanity check**: 4000 backfill days + 252 days/year × 5 years of steady state = negligible. A single analyze call embeds today's summary ≈ $0.000001. This is not a cost-sensitive feature.
