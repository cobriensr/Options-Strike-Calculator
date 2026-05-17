---
status: Likely Shipped
date: 2026-05-10
---

# Refactor: Split validation.ts and csv-parser.ts

**Date:** 2026-05-10
**Status:** In progress

## Goal

Reduce two monolithic api/\_lib/ modules to manageable, domain-grouped files
without breaking any consumer imports and without altering runtime behavior.
Both files have grown to >1,000 LOC; review/diff friction is the proximate
trigger. The split must be byte-for-byte equivalent in semantics — this is a
refactor, not a redesign.

## Why these two (and not the others flagged)

- `db-migrations.ts` — 142 small append-only entries, already indexed by id.
  Splitting yields no real review-time benefit. Skip.
- `analyze-prompts.ts` — two big template literals; restructuring risks
  breaking `cache_control: ephemeral` prefix stability. Skip.
- `validation.ts` (1,118 LOC, ~35 schemas) — clean domain clustering, real
  win.
- `csv-parser.ts` (1,056 LOC) — one clean seam at line ~548 between parsing
  and summary/pairing logic.

## Approach: barrel re-export

Both originals stay as **barrel files** that `export *` from new sub-files.
Consumers keep their existing import paths (`from './validation.js'`,
`from './csv-parser.js'`). Zero blast radius on the 27 + 6 importers.

Tests target the new sub-files directly so coverage maps to the right module.

## Phase 1 — validation.ts split

### Target layout

```
api/_lib/validation.ts           # barrel — re-exports from validation/*
api/_lib/validation/
  common.ts                      # guestKey, alertAck, shared zod helpers
  periscope.ts                   # all periscope* schemas + types
  lottery.ts                     # lottery*, silentBoom*
  snapshot.ts                    # snapshotBody, analyzeBody, analysisResponse,
                                 # analyzeImage, positionCsv, preMarket
  market-data.ts                 # zeroGamma, greekFlow, gexStrikeExpiry,
                                 # dealerRegime, ivAnomalies, ivAnomaliesCrossAsset,
                                 # strikeTradeVolume, netFlowHistory,
                                 # tickerCandles, lotteryContractTape
```

### Schema domain groupings (35 schemas → 5 files)

**common.ts** — broadly shared / infra

- `guestKeySchema`, `alertAckSchema`
- `num`, `str`, `bool` zod nullable-optional helpers
- Any cross-cutting type aliases re-exported

**periscope.ts** — 7 schemas

- `periscopeImageSchema`, `periscopeChatBodySchema`,
- `periscopeChatListQuerySchema`, `periscopeChatDetailQuerySchema`,
- `periscopeChatImageQuerySchema`, `periscopeChatUpdateBodySchema`,
- `periscopeLessonsUpdateBodySchema`

**lottery.ts** — 5 schemas

- `lotteryFinderQuerySchema`, `lotteryExportQuerySchema`,
- `lotteryContractTapeQuerySchema`,
- `silentBoomFeedQuerySchema`, `silentBoomExportQuerySchema`

**snapshot.ts** — 5 schemas (analyze/snapshot/positions cluster)

- `snapshotBodySchema`, `analyzeBodySchema`, `analyzeImageSchema`,
- `analysisResponseSchema`, `positionCsvSchema`, `preMarketBodySchema`

**market-data.ts** — 10 schemas (all UW/market-flow query inputs)

- `zeroGammaQuerySchema`, `greekFlowQuerySchema`, `gexStrikeExpiryQuerySchema`,
- `dealerRegimeQuerySchema`, `ivAnomaliesQuerySchema`,
- `ivAnomaliesCrossAssetBodySchema`, `strikeTradeVolumeQuerySchema`,
- `netFlowHistoryQuerySchema`, `tickerCandlesQuerySchema`

### Rules

- Every `export const xSchema` keeps its name and shape. No constant renames.
- Every `export type X = z.infer<...>` follows its schema into the same file.
- `validation.ts` becomes: `export * from './validation/common.js'; export *
from './validation/periscope.js'; ...` (with explicit `.js` extensions per
  project policy).
- Any internal `MAX_*` constants used by only one domain move with that
  domain. Constants used by multiple domains live in `common.ts`.
- Imports inside new files must use `from './common.js'` etc. with explicit
  `.js`.

### Tests (new)

Create one test file per new sub-file (5 new test files):

- `api/__tests__/validation/common.test.ts`
- `api/__tests__/validation/periscope.test.ts`
- `api/__tests__/validation/lottery.test.ts`
- `api/__tests__/validation/snapshot.test.ts`
- `api/__tests__/validation/market-data.test.ts`

Each test file covers: valid input parses, invalid input throws/returns
error, edge cases on bounded fields (size limits, enums, optional fields).
Minimum: every schema gets at least one valid + one invalid case.

## Phase 2 — csv-parser.ts split

### Target layout

```
api/_lib/csv-parser.ts           # barrel — re-exports parsing + summary
api/_lib/csv-parser/
  parse.ts                       # parseFullCSV, parseTosExpiration,
                                 # parseCSVLine, header/section parsers,
                                 # ParsedTrade/ClosedSpread/ParsedCSV types
  summary.ts                     # buildFullSummary, tradeTimeToMs,
                                 # bucketTradesByTimeWindow,
                                 # buildOpenSpreadsFromTrades, pairing logic,
                                 # ShortPairResult, computeSideMaxRisk
```

### Seam

- Line ~548 in current file is the boundary: above = parse, below = summary.
- `parse.ts` owns all CSV-line tokenization, section splitters, and the
  exported `parseFullCSV()` entry point.
- `summary.ts` consumes `ParsedCSV` (imported from `parse.ts`) and produces
  the formatted Claude-context string + pair-resolution logic for the
  positions endpoint.

### Importers (6 total)

- `api/positions.ts` — uses parseFullCSV + buildFullSummary + pairShortsWithLongs
- `api/_lib/positions-spreads.ts` — uses parseFullCSV
- `api/__tests__/csv-parser.test.ts` — tests the API surface
- `api/__tests__/positions-upload.test.ts` — integration test
- `src/components/PositionMonitor/statement-parser.ts` — frontend uses some
  parse helpers (must keep `.js` extension)

Barrel `csv-parser.ts` keeps all current exports so none of these need
changes. Tests for new sub-files import the sub-files directly.

### Tests (new)

- `api/__tests__/csv-parser/parse.test.ts` — moves the parse-only tests from
  existing `csv-parser.test.ts` (split by what they cover)
- `api/__tests__/csv-parser/summary.test.ts` — moves the buildFullSummary +
  pairShortsWithLongs tests
- Keep existing `csv-parser.test.ts` as a thin smoke test of the barrel, OR
  delete and rely on the two new files — decide during Phase 2 review.

## Open questions (defaults picked)

- **Q: should `validation.ts` survive as a barrel or get deleted with a
  codemod rewriting 27 importers?** → Default: **keep as barrel**.
  Lower risk, no downstream churn.
- **Q: should csv-parser barrel survive too?** → Default: **keep as barrel**.
  Same reasoning, plus `src/components/PositionMonitor/statement-parser.ts`
  is a `.js`-extension consumer that's annoying to retarget.

## Verification gates

1. `npm run review` after each phase (tsc + eslint + prettier + vitest).
2. New test files pass with ≥1 valid + ≥1 invalid case per schema (Phase 1)
   or full coverage of moved logic (Phase 2).
3. `git diff` of importers must be empty (proves barrel preserved API).
4. Code-reviewer subagent verdict = `pass` for each phase.
5. Final code-reviewer subagent over the combined diff before commit.

## Non-goals

- No schema semantic changes.
- No new validation rules.
- No CSV format changes.
- No consumer refactors (positions.ts etc. stay byte-identical aside from
  formatting).
- No `db-migrations.ts` or `analyze-prompts.ts` work (explicitly out of scope).
