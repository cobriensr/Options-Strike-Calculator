# Coverage floors (2026-10-26)

## Goal

Stop files with bad coverage from hiding behind the repo-wide average. Add a per-file minimum and per-folder minimums, both set at today's levels, so no file or folder can quietly slide below where it is now.

## Background

- **Today there's only an aggregate floor.** `vite.config.ts` sets global thresholds of statements 90 / branches 80 / functions 90 / lines 90. Overall branch coverage is 87.7%, not falling (it was 87.4% on 2026-06-11). But the average hides a tail: 117 of the 749 files with branches are under 80%, and 43 of those are between 50% and 70%.
- **Lowest folders by branch coverage:** api/cron 85.1%, src/components 85.6%, src/hooks 86.0%, api endpoints 87.5%, api/_lib 90.4%, src/utils 93.4%.
- **Lowest single files today:** lines 63.6% (`src/components/PeriscopeChat/PlaybookView.tsx`), functions 50.0%, branches 50.0%.
- **What Vitest supports**, verified against the installed vitest 4.1.12 (`node_modules/vitest/dist/chunks/coverage.*.js`, `resolveThresholds` / `checkThresholds` / `resolveGlobThresholds`), not only the docs:
  - `thresholds.perFile` is ONE global flag (`this.options.thresholds?.perFile`) that applies to every threshold set, the global set and every glob alike. You can't combine a per-file floor with aggregate floors through config alone.
  - With `perFile` off, glob-pattern thresholds are checked as aggregates over the files they match.
  - Glob entries do NOT inherit the global numbers: `resolveGlobThresholds` keeps only the metrics set on the entry, even though one docs passage suggests otherwise.
- **Side finding:** `api/__tests__/insert-binds.ts`, a test helper, is counted as source code. The coverage `exclude` drops only `api/**/*.{test,spec}.{ts,tsx}`, while `src/__tests__/**` is excluded wholesale.

## Design

- **Per-folder floors:** Vitest's built-in glob thresholds, checked as aggregates.
- **Per-file floor:** a small check script that `npm run review` runs after vitest. It reads `coverage/lcov.info` (the lcov reporter is already on) and fails on any file below the floor.
- **No change to the global 90/80/90/90.**

## Phases

### Phase 1: per-file floor script (small) — DONE (6714356d)

- `scripts/_lib/coverage-floor.mjs` is pure logic with no I/O. It:
  - parses lcov text into per-file `{file, lines, functions, branches}` hit/found counts;
  - checks each file against the floors;
  - returns the violations.
  
  A metric with 0 found counts as passing, since there's nothing to cover.
- `scripts/check-coverage-floor.mjs` is the CLI. It:
  - reads `coverage/lcov.info`;
  - prints each violation as `file: branches 42.0% < 50%`, using repo-relative forward-slash paths;
  - exits 1 on any violation;
  - exits 1 with a clear message if the report is missing or empty, rather than passing silently.
- **Tests:** `scripts/_lib/coverage-floor.test.mjs`. Vitest already includes `scripts/_lib/**/*.{test,spec}.{ts,mjs}`. Cover parse and threshold logic as an input/output table, including:
  - the 0-found case
  - Windows backslash paths
  - a malformed record
  - an empty input
- **`package.json`:** append `&& node scripts/check-coverage-floor.mjs` to `review`, after `vitest run --coverage`.
- **Files:** the 3 new files above, plus `package.json`.

### Phase 2: per-folder floors and exclusion fix (small)

- **Folder floors.** Add glob thresholds in `vite.config.ts`, set at floor(current aggregate) − 1 for **branches and lines**. Recompute the aggregates from a fresh `npm run review`, since the numbers above predate the bwb-anchor change. Expected roughly:
  - `api/cron/**`: branches 84
  - `api/_lib/**`: branches 89
  - `src/components/**`: branches 84
  - `src/hooks/**`: branches 85
  - `src/utils/**`: branches 92
  - lines: the same rule
  
  Endpoints sit in `api/*.ts` plus subfolders (`api/auth/`, `api/journal/`, `api/ml/` …). Use one picomatch glob that excludes `_lib`, `cron` and `__tests__`, or skip the endpoints floor if picomatch can't express it cleanly. Verify that whatever pattern is used matches the intended files.
- **Exclusion fix.** Add `'api/__tests__/**'` to the coverage `exclude`.
- **Docs.** Update the `vite.config.ts` comment, and add one line to CLAUDE.md "Testing" describing the per-file and per-folder floors and how to raise them.
- **Guard test.** `scripts/_lib/coverage-thresholds.test.mjs` fails when a glob key matches no files, since vitest passes such a key silently.
- **Files:** `vite.config.ts`, `CLAUDE.md`, `.github/workflows/ci.yml` (Review step name only), `scripts/_lib/coverage-thresholds.test.mjs`.

#### Phase 2 results (2026-10-26)

- **Measured** from a fresh `vitest run --coverage` with the `api/__tests__/**` exclusion in place: 804 files in the coverage map, none under `api/__tests__/`. Aggregates come from `coverage/coverage-final.json` via istanbul-lib-coverage `getCoverageSummary()`, the same call vitest's threshold check uses. The percentages below are that summary's `pct`, the value vitest compares to the floor. istanbul rounds it DOWN to 2 dp (`lib/percent.js`), so it can sit 0.01 under covered/total rounded normally (e.g. cron lines 96.46, not 96.47).

  | Folder (glob key) | Files | Branches `pct` (covered/total) | Lines `pct` (covered/total) | Branch floor | Line floor |
  | --- | --- | --- | --- | --- | --- |
  | `api/cron/**` | 76 | 85.11% (2367/2781) | 96.46% (4781/4956) | 84 | 95 |
  | `api/_lib/**` | 184 | 90.40% (7394/8179) | 98.09% (10163/10360) | 89 | 97 |
  | endpoints `api/!({_lib,cron,__tests__}/**)` | 92 | 88.13% (2465/2797) | 95.80% (3651/3811) | 87 | 94 |
  | `src/components/**` | 297 | 85.64% (8324/9719) | 94.87% (7977/8408) | 84 | 93 |
  | `src/hooks/**` | 84 | 86.00% (2250/2616) | 97.35% (3564/3661) | 85 | 96 |
  | `src/utils/**` | 59 | 93.34% (1389/1488) | 98.13% (1948/1985) | 92 | 97 |

- **Endpoints glob.** One key, `api/!({_lib,cron,__tests__}/**)`, covers `api/*.ts` and every other `api/` subfolder (auth, futures, gamma-setups, journal, ml, push, tracker). Two rejected alternatives, from probing picomatch 4.0.4:
  - `api/!(_lib|cron|__tests__)/**`: the negation compiles to an unanchored lookahead, so it also drops any sibling whose name starts with `_lib`, `cron` or `__tests__` (a future `api/cron-foo/`).
  - `api/!(_lib/**|cron/**|__tests__/**)`: still matches `api/_lib/sub/a.ts`, because picomatch compiles the first alternatives' `**` as one segment.
- **Match proof.** Each key was run through `picomatch(glob)` with no options on `pathe.relative(root, file)`, exactly as vitest 4.1.12 `resolveThresholds()` does. Every key matched exactly its folder's files (76 / 184 / 92 / 297 / 84 / 59), and every one of the 352 `api/` files fell in exactly one of the three api buckets.
- **Fire proof.** A scratch config that imports `vite.config.ts` and raises the cron and endpoints branch floors to 99 made vitest exit 1, with one error per raised glob and no others.
- **Zero-match guard.** A glob that matches nothing gets an empty coverage map, whose summary `pct` is `'Unknown'`, and `'Unknown' < 84` is false. So a renamed folder would switch its floor off without a failure, and a renamed `api/cron/` would also push its files into the endpoints bucket. `scripts/_lib/coverage-thresholds.test.mjs` reads the keys from `vite.config.ts` and checks five things:
  - there are exactly 6 glob keys, 3 under `api/`, one of them the endpoints key, so an added or deleted floor fails;
  - each key matches at least one covered file;
  - every `api/` file is in exactly one of the three api keys;
  - the endpoints key routes the edge cases (`api/cron-x/`, `api/cron.ts`, nested `cron/`) correctly;
  - its own matcher counts 0 for a bogus key.

  It loads picomatch and tinyglobby through vitest's own dependency tree. Its file listing equals the real coverage map exactly (804 files). Run against a scratch config with `src/hooks/**` and `api/cron/**` renamed, it failed 3 tests: both keys matched nothing, and the 76 cron files were in no api key.
- **Exclusion side effect.** `api/__tests__/{helpers,insert-binds,pglite-migrations}.ts` left the coverage map, so the per-file floor's lowest-branch file is now `api/_lib/db-flow-alerts.ts` at 50.0%, exactly on the floor.
- **Run-to-run noise.** Two runs a few minutes apart differed by one covered branch, in `src/hooks/**` (`pct` 86.00% vs 86.04%), far inside the one-point margin.

## Thresholds / constants

- **Per-file floors:** branches 50, functions 50, lines 60. These are today's minimums rounded down (50.0 / 50.0 / 63.6), so every file passes on day one. Keep them as named constants in `scripts/_lib/coverage-floor.mjs`, not env vars (R7).
- **Per-folder floors:** floor(current aggregate) − 1 for branches and lines. The −1 margin keeps one new, slightly-under file from failing a folder.
- **Global:** unchanged at 90 / 80 / 90 / 90.

## Data dependencies

None.

## Open questions

- **Raising the floors.** By hand when a test pass lands, and when to do it is the owner's call. Default: no `autoUpdate`. It would rewrite `vite.config.ts` on every run.
- **The test-writing pass**, in risk order: cron and `_lib` failure paths, then the statement parser, then large UI components. Not in scope; the owner chose floors only for now.
- **`src/App.tsx`:** about 1,333 lines of code, excluded from coverage. Not in scope.
