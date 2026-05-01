# Backend Refactor — api/ cleanup pass — 2026-05-02

## Goal

Reduce duplication and decompose oversized files in `api/` (cron jobs,
endpoints, _lib utilities) without changing public behavior. Pulled from
a parallel-agent assessment of the 30 largest TS files in `api/`. Mirrors
the structure of the [src-refactor-2026-04-30](src-refactor-2026-04-30.md)
plan: shared primitives first, then file-by-file consumers, then
medium-priority cleanups.

The api/ codebase is in healthier shape than src/ was — `cronGuard()`,
`uwFetch()`, `mapWithConcurrency()`, `withRetry()` are already strong.
The remaining duplication is at the **tail of every cron handler**
(Sentry/Axiom/upsert boilerplate), inside **2 oversized cron files**
(fetch-strike-iv, build-features), and at the **endpoint preamble**
shared across 7+ data endpoints.

## Constraints

- No public API behavior change. Endpoint contracts and cron
  observable effects (DB writes, Sentry events, Axiom rows) must be
  identical before/after.
- Cache-boundary discipline: do NOT consolidate trader-context
  preambles across `analyze-prompts.ts` and `plot-analysis-prompts.ts`
  despite verbatim overlap (would destabilize Anthropic cache prefixes).
- `db-migrations.ts` is append-only by design — do NOT touch it.
- Files in `src/` imported by `api/` need explicit `.js` on relative
  imports (per CLAUDE.md). Applies to anything pulled into the api
  bundle.
- Each phase ≤5 files (CLAUDE.md `## Pre-Work`).
- Each phase ends with `npm run review` and a code-reviewer subagent
  verdict before commit.
- Commit directly to `main` (per memory `feedback_direct_to_main.md`).
- New code must ship with tests (per memory `feedback_always_test.md`).

## Files to create (new primitives)

```
api/_lib/cron-instrumentation.ts   # withCronInstrumentation HOF
api/_lib/bulk-upsert.ts             # bulkUpsert<T>(sql, table, conflict, rows)
api/_lib/format-helpers.ts          # fmtPct, fmtPrice, formatSigned, fmtOI, fmtDp, formatDollarAbbrev
api/_lib/numeric-coercion.ts        # numOrNull, parsedOrFallback (unified)
api/_lib/request-scope.ts           # withRequestScope HOF for endpoints
api/_lib/anthropic-call.ts          # runCachedAnthropicCall shell (Opus→Sonnet fallback, streaming)
api/_lib/uw-fetch-paged.ts          # uwFetchPaged paginator (closes concurrency cap bypass)
api/_lib/dark-pool-filter.ts        # passesDarkPoolQualityFilter predicate
api/_lib/strike-iv-detection.ts     # extracted from fetch-strike-iv.ts
api/_lib/build-features-upsert.ts   # extracted SQL upsert + column mapping
api/_lib/build-features-labels.ts   # extracted label extraction + upsert
api/_lib/db-strike-formatters.ts    # extracted formatters from db-strike-helpers.ts
api/_lib/positions-spreads.ts       # extracted from positions.ts
api/_lib/periscope-prompts.ts       # extracted from periscope-chat.ts
api/_lib/session-windows.ts         # lastSessionOpenUtc, sessionOpenUtcForDate
```

## Files to split (foundation)

```
api/_lib/api-helpers.ts             # split into auth + uw + cron + schwab modules
                                    # api-helpers.ts becomes barrel re-export
```

## Files to modify (consumers)

```
api/_lib/darkpool.ts                # adopt passesDarkPoolQualityFilter + uwFetchPaged
api/_lib/futures-context.ts         # SYMBOL_RENDERERS table
api/_lib/build-features-phase2.ts   # split engineerPhase2Features into 8 phase fns
api/_lib/csv-parser.ts              # adopt pairShortsWithLongs helper
api/_lib/db-strike-helpers.ts       # split formatters out
api/_lib/analyze-context-fetchers.ts # fetch/format split
api/cron/fetch-strike-iv.ts         # adopt withCronInstrumentation + new strike-iv-detection.ts
api/cron/build-features.ts          # adopt build-features-upsert.ts + build-features-labels.ts
api/cron/* (38 crons)               # adopt withCronInstrumentation
api/cron/* (8 crons)                # adopt bulkUpsert
api/cron/* (5 crons)                # adopt mapWithConcurrency for ticker fan-out
api/gex-target-history.ts           # extract duplicated SELECT + helpers
api/periscope-chat.ts               # adopt periscope-prompts.ts
api/positions.ts                    # adopt positions-spreads.ts
api/options-flow/whale-positioning.ts # collapse 2 transforms + adopt session-windows
api/analyze.ts                      # adopt runCachedAnthropicCall
api/trace-live-analyze.ts           # adopt runCachedAnthropicCall
api/* (7+ endpoints)                # adopt withRequestScope
```

## Phases

### Phase 1 — Cross-cutting primitives (highest leverage)

These are the foundation. Greenfield modules + tests, no consumer
modification yet.

**1a. `withCronInstrumentation` HOF** (≤3 files)

- Create `api/_lib/cron-instrumentation.ts` exporting
  `withCronInstrumentation(name: string, handler: (ctx: CronContext) => Promise<CronResult>)`.
  Wraps the Sentry tag + captureException + reportCronRun + duration
  pattern. `CronContext` provides `today`, `apiKey`, `startTimeMs`,
  `logger` (scoped to the cron name).
- Tests cover: success path (reportCronRun called with status='success'),
  exception path (captureException + reportCronRun status='error'),
  return value passthrough, duration accuracy.
- **Do not adopt yet.** Adoption is Phase 3a.

**1b. `bulkUpsert<T>` helper** (≤3 files)

- Create `api/_lib/bulk-upsert.ts` exporting `bulkUpsert<T>({ sql, table, columns, rows, conflictTarget, conflictUpdateColumns })`. Uses `sql.transaction((txn) => ...)` to issue all upserts in one round-trip.
- Tests cover: empty rows (no-op), single row, multi-row, conflict
  resolution, transaction rollback on partial failure.
- **Do not adopt yet.** Adoption is Phase 3b.

**1c. `format-helpers.ts`** (≤2 files)

- Extract `fmtPct`, `fmtPrice`, `formatSigned`, `fmtOI`, `fmtDp`,
  `formatDollarAbbrev` from their reinvented homes (`futures-context.ts`,
  `uw-deltas.ts`, `microstructure-signals.ts`, `darkpool.ts`). Diff them
  first; some have parameter differences.
- Tests cover boundary cases: zero, null, very large, very small,
  negative.
- **Do not adopt yet.** Adoption is Phase 5d.

**1d. Numeric coercion (`numeric-coercion.ts`)** (≤2 files)

- Standardize on `numOrNull(value): number | null` and
  `parsedOrFallback(value, fallback): number`. Diff the existing
  `toNum`/`num`/`toNumber` reimplementations; resolve the
  null-vs-zero divergence by always defaulting to nullable.
- Tests cover: null, undefined, NaN, Infinity, string numbers, BigInt
  (Postgres returns BigInt for large counts).
- **Do not adopt yet.** Adoption is Phase 5e.

**1e. `dark-pool-filter.ts` + `uw-fetch-paged.ts`** (≤4 files)

- Create `passesDarkPoolQualityFilter(trade, opts?)` from the duplicated
  12-line filter in `darkpool.ts:146-161` and `darkpool.ts:302-317`.
- Create `uwFetchPaged({ endpoint, params, maxPages, onPage })` that
  routes through `uwFetch()` and respects the rate + concurrency gates
  (closes the silent UW concurrency cap bypass).
- Tests for both.
- **Adopt in `darkpool.ts` in this same phase** (only 1 consumer, tightly coupled to the new helpers).

**1f. `request-scope.ts` + `anthropic-call.ts`** (≤4 files)

- Create `withRequestScope(method, path, handler)` HOF wrapping
  `Sentry.withIsolationScope` + `metrics.request` + 405 method check.
- Create `runCachedAnthropicCall({ system, messages, primaryModel, fallbackModel, onUsage })` consolidating the streaming + cache-blocks
  + Opus→Sonnet fallback + usage logging pattern.
- Tests for both.
- **Do not adopt yet.** `withRequestScope` adoption is Phase 5j;
  `runCachedAnthropicCall` adoption is Phase 5i.

### Phase 2 — `api-helpers.ts` split (foundation, ≤5 files)

Split the 866-LOC god-file into:

- `api/_lib/auth-helpers.ts` — owner cookie + bot check + guards
- `api/_lib/uw-fetch.ts` — uwFetch + parseUwHttpStatus + 429 classifier + withRetry (UW-specific)
- `api/_lib/cron-helpers.ts` — cronGuard + cronJitter + checkDataQuality + isMarketHours + isAfterClose
- `api/_lib/schwab-fetch.ts` — Schwab fetch wrapper
- `api/_lib/api-helpers.ts` — barrel re-export of all above (callers don't churn)

Public re-export surface stays identical. All callers continue to import from `api/_lib/api-helpers.ts`. A future phase can migrate callers to direct imports if desired.

### Phase 3 — Cron job adoption

**3a. Adopt `withCronInstrumentation` in 38 crons** (multiple ≤5-file phases)

This is the biggest mechanical refactor. Done in batches of 5 crons each
to stay under the file budget. Estimated 8 batches (3a-1 through 3a-8).

**3b. Adopt `bulkUpsert` in per-row INSERT sites** (≤5 files per batch)

Targets: `fetch-darkpool`, `fetch-nope`, `fetch-spx-candles-1m`,
`fetch-strike-iv` (`persistSqueezeFlags`, `insertRows`),
`fetch-strike-exposure`. ~8 sites total.

**3c. Adopt `mapWithConcurrency` for ticker fan-out** (≤5 files)

Targets: `fetch-strike-iv` (13 tickers), `fetch-strike-exposure`,
`fetch-market-internals`, `fetch-strike-trade-volume`, `monitor-vega-spike`.

### Phase 4 — High-priority single-file refactors

**4a. `gex-target-history.ts` extract SELECT + helpers** (≤3 files)

- Move the duplicated 50-line SELECT (lines 527-571 + 612-656) into a
  named function in `api/_lib/gex-target-features.ts` (sibling already
  exists).
- Move pure helpers (`rowToStrikeScore`, `groupRowsByMode`, `toIso`,
  `toDateString`, `num`, `numOrNull`) to the same module.
- Handler shrinks ~290 → ~150 LOC.
- Add tests for the extracted helpers.

**4b. `fetch-strike-iv.ts` extract detection helpers** (≤3 files)

- Move `loadSqueezeWindowForTicker`, `loadNetDealerGammaForTicker`,
  `enrichSingleFlag`, `persistSqueezeFlags`, etc. into
  `api/_lib/strike-iv-detection.ts`.
- Add `withTickerScope(ticker, fn)` Sentry-tag wrapper to collapse the 5
  per-ticker tag sites.
- Existing tests must pass.

**4c. `build-features.ts` finish extraction** (≤4 files)

- Move 350-LOC `upsertFeatures` SQL + column mapping to
  `api/_lib/build-features-upsert.ts` (pure schema mapping).
- Move `extractLabelsForDate` + `upsertLabels` to
  `api/_lib/build-features-labels.ts`.
- Move `NULLABLE_FEATURE_KEYS` set + `computeCompleteness` to a
  `build-features-types.ts` module or co-locate with phase modules.
- Delete the 130-LOC dead `[Phase 2] Implement once...` comment block.
- Handler shrinks to ~250 LOC of date-loop orchestration.

### Phase 5 — Medium-priority cleanups

**5a. `build-features-phase2.ts` split** (1 file + tests)

- Split `engineerPhase2Features` (490 LOC, 8 phases) into 8 named
  helpers: `addPrevDayFeatures`, `addRealizedVolFeatures`,
  `addRealizedIvFeatures`, `addTermSlopeFeatures`,
  `addVvixPercentileFeatures`, `addMaxPainFeatures`,
  `addDarkPoolFeatures`, `addOptionsVolumeFeatures`. Orchestrator
  becomes a 30-LOC sequence.

**5b. `csv-parser.ts` shared `pairShortsWithLongs` helper** (1 file + tests)

- Extract the duplicated `MAX_RECOGNIZED_SPREAD_WIDTH` matching loop from
  `pairForDisplay` and `computeSideMaxRisk` into one shared helper.

**5c. `futures-context.ts` SYMBOL_RENDERERS table** (1 file + tests)

- Replace 7 hardcoded symbol blocks with a `SYMBOL_RENDERERS: Record<symbol, (sym, derived) => string[]>` table; orchestrator iterates symbols.

**5d. Adopt `format-helpers.ts` in 4-5 _lib files** (≤5 files)

- Replace inline formatters in `futures-context.ts`, `uw-deltas.ts`,
  `microstructure-signals.ts`, `darkpool.ts`. Verify output parity.

**5e. Adopt `numeric-coercion.ts` in 5 _lib files** (≤5 files)

- Replace inline `toNum`/`num`/`toNumber` reimplementations.

**5f. `db-strike-helpers.ts` split** (≤3 files)

- Move 5 formatters (~700 LOC) to `api/_lib/db-strike-formatters.ts`.
- Mirrors existing `db-flow.ts` / `analyze-context-formatters.ts` pair.

**5g. `analyze-context-fetchers.ts` fetch/format split** (≤4 files)

- Move `lines.push(...)` blocks from fetchers into
  `analyze-context-formatters.ts`. Fetchers return typed rows;
  formatters own all prose.

**5h. `periscope-chat.ts` extract parse helpers** (≤3 files)

- Move `parseStructuredFields`, `synthesizeStructuralProse`,
  `buildUserContent` to `api/_lib/periscope-prompts.ts`.

**5i. `positions.ts` extract helpers** (≤3 files)

- Move `groupIntoSpreads` (74 LOC), `buildSummary` (92 LOC),
  `buildPositionResponse` to `api/_lib/positions-spreads.ts`.
- Consolidate the duplicated DB-save block between `handleCSVUpload` and
  `handleSchwabFetch` into a shared `persistPositions` helper.

**5j. `whale-positioning.ts` collapse transforms + session-windows** (≤4 files)

- Collapse `dbRowToWhaleAlert` + `toWhaleAlert` into one transform via a
  normalized intermediate.
- Move `lastSessionOpenUtc` + `sessionOpenUtcForDate` to
  `api/_lib/session-windows.ts` (sibling of `src/utils/timezone.ts`).

**5k. Adopt `runCachedAnthropicCall` in 3 endpoints** (≤4 files)

- `api/analyze.ts`, `api/trace-live-analyze.ts`, `api/periscope-chat.ts`.
  Each replaces ~50-80 LOC of streaming + cache-blocks + fallback shell.

**5l. Adopt `withRequestScope` in 7+ endpoints** (≤5 files per batch)

- `gex-target-history.ts`, `whale-positioning.ts`, `gamma-squeezes.ts`,
  `top-strikes.ts`, `events.ts`, `chain.ts`, `futures/snapshot.ts`.
  Done in 2 batches.

**5m. Session-hours gate consolidation** (≤3 files)

- `INTRADAY_START_MIN_CT` (`darkpool.ts`) + `MARKET_MINUTES.OPEN` in ET
  (`api-helpers.ts`/`cron-helpers.ts`) + `RTH_OPEN_HOUR_UTC`
  (`uw-deltas.ts`) → one source of truth in `cron-helpers.ts` (or
  `constants.ts`) with timezone-aware accessors.

### Verification (always last)

- `npm run review` — full pipeline (tsc + eslint + prettier + vitest).
- Manual smoke: `npm run dev`, hit a few endpoints; check Sentry/Axiom
  for any new error rates after cron deploys.
- Final code-reviewer subagent on the full diff.

## Open questions

- **Q1: api-helpers split — barrel or no barrel?** Default: barrel
  re-export so callers don't churn. Alternative: migrate callers in the
  same phase. Going with barrel.
- **Q2: `withCronInstrumentation` adoption order.** Default:
  alphabetical batches of 5 crons each. Alternative: highest-traffic
  first. Going with alphabetical (mechanical, low cognitive load).
- **Q3: Anthropic call shell — should it support tool use?** Default:
  no, only the streaming + system-blocks + fallback shape.
  `analyze.ts` doesn't use tools today; if it adds them later, extend
  the helper.
- **Q4: Dark-pool filter — predicate or middleware?** Default:
  predicate (`(trade) => boolean`). Easier to compose with other
  filters; testable in isolation.
- **Q5: `bulkUpsert` — does it accept a `chunkSize` param?** Neon has
  query size limits; default chunk to 500 rows but allow override.

## Thresholds / constants to name

- `BULK_UPSERT_DEFAULT_CHUNK_SIZE = 500` (bulk-upsert.ts)
- `UW_PAGED_DEFAULT_MAX_PAGES = 50` (uw-fetch-paged.ts)
- `CRON_TICKER_DEFAULT_CONCURRENCY = 4` (mapWithConcurrency adoption sites)
- `DARK_POOL_FILTER_VERSION = '2026-05-02'` (dark-pool-filter.ts — bumps
  when filter list changes; surfaced in metrics for drift detection)

## Skip / defer

- `db-migrations.ts` — append-only by design.
- `analyze-prompts.ts` / `plot-analysis-prompts.ts` — cache-boundary
  preservation; do NOT consolidate.
- `spotgamma-mechanics.ts` / `market-mechanics.ts` — single template
  literals; not refactorable.
- `validation.ts` — flat Zod, structural by nature.
- `uw-deltas.ts` / `microstructure-signals.ts` — exemplary structure;
  model the others should aspire to.
- `flow-scoring.ts` / `gex-target-features.ts` / `gamma-squeeze.ts` /
  `anomaly-context.ts` — already well-decomposed.
- `gamma-squeezes.ts` (endpoint) / `chain.ts` (endpoint) — already lean
  orchestrators.

## Done when

- All Phase 1-5 sub-tasks committed to `main`.
- `npm run review` green.
- Final code-reviewer subagent verdict = `pass`.
- No production regressions observed in Sentry/Axiom in the 24h after
  the last commit lands.
