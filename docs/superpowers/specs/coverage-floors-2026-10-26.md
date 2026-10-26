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

### Phase 1: per-file floor script (small)

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
- **Files:** `vite.config.ts`, `CLAUDE.md`.

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
