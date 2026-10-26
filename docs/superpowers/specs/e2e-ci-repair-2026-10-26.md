# E2E CI repair (2026-10-26)

## Goal

Get the "E2E Tests" CI job to finish and give a real verdict. It has never once completed: every run since 2026-04-04 was cancelled or hit its time limit. After this, a broken suite should fail red in minutes, and a green one should finish well inside its timeout.

## Background

A diagnosis on 2026-10-26 traced the failure. Logs, a standalone Playwright probe and the run history are in `C:\Users\Charlie\AppData\Local\Temp\claude\f--dev-strike-calculator\3fec101d-6b2e-47dc-9b51-4b0c9d785baa\scratchpad\e2e-diag\`.

- **The app never mounts in 30 of the 39 specs.**
  - Since f513094d (2026-06-07), `src/components/FlowRegimeBadge/classify.ts:15` statically imports `api/_lib/flow-regime-baseline.json`. Vite dev serves that to the browser as the module `/api/_lib/flow-regime-baseline.json?import`.
  - The import chain is static from `main.tsx` through `App`, `MarketRegimeSection` and `FlowRegimeBadge` to `classify`.
  - Those 30 specs call `page.route('**/api/**', …abort or fulfill)`. That glob also catches the module request. Abort gives `ERR_FAILED`; fulfilling with `{}` gives a MIME error. Either way React never mounts.
  - The Vite proxy bypass added in 226cbe5a (06-16) fixed only the dev-server side.
- **Every test then fails slowly.** The config uses 1 worker on CI and `retries: 2`. Each test fails 3 times at 10 s (an expect timeout) or 30 s (the test timeout). That is about 46 s per test across 570 tests (190 per browser × 3), so the job can't finish in 30 minutes. In June, with no job timeout, runs went to the 6-hour limit. In four timed-out runs the symbol string is identical, so the failure is deterministic.
- **The failures are invisible.** The only reporter is `html`, so CI falls back to `dot`, which prints no test names. Upload runs `if: !cancelled()`, and a timeout counts as cancelled, so no report has ever been uploaded.
- **There is an older, separate break.** E2E was already hitting the 6-hour limit from 2026-05-28, before the JSON import. Those logs have expired, so expect more failures once the app boots.
- **Even green, it's tight.** The estimate, not measured, is 20–38 minutes for 570 tests at 1 worker.

## Phases

### Phase 1: unblock app boot, fail fast, make failures visible (small)

- Move `api/_lib/flow-regime-baseline.json` to `src/data/flow-regime-baseline.json`, so no browser module lives under `/api/`. Update the imports:
  - `src/components/FlowRegimeBadge/classify.ts:15`;
  - `api/_lib/flow-regime.ts:26`, keeping `with { type: 'json' }`. `api/` already imports `src/` modules, so this follows an existing pattern.
  - `scripts/build-flow-regime-baseline.py` (`OUT_JSON`, around line 92).
- Remove the `vite.config.ts` proxy bypass for `?import` and `?url` (around lines 131-135) if nothing else needs it. Check that before removing it.
- `playwright.config.ts`, CI only:
  - `maxFailures: 10`, so a broken suite fails red in a few minutes;
  - a `list` (or `github`) reporter alongside `html`, so test names show in the log.
- `.github/workflows/ci.yml`:
  - the report upload uses `if: always()`;
  - give the `playwright test` step its own `timeout-minutes`, below the job's, so the upload still runs.
- **Verify:**
  - `npm run review`;
  - the flow-regime cron tests;
  - `vite build`, then check the built function still bundles the JSON: `api/_lib/flow-regime.ts` resolves it.
  - Run a few previously failing specs locally against `vite dev` (for example `calculator-flow`, `accessibility`) to see the app mount. Only if that's quick; don't run the whole suite.
- **Deploy:** this touches the import path for the `capture-flow-regime` crons, so hold the push until after the 15:00 CT close.

- **Owner decisions folded into Phase 1** (2026-10-26):
  - **Remove the App Quality Gate's "Build" step.** Review already runs the type checks and `vite build`, and Vercel runs `npm run build` itself on every push.
  - **Chromium only in ci.yml (PRs, pushes to main, manual dispatch).** All 3 browsers run in a new `.github/workflows/e2e-nightly.yml`, nightly and on `workflow_dispatch`.
  - **Drop `api/**` from the E2E path filter.** E2E never runs API handler code: specs stub `**/api/**`, and the Vite dev proxy targets an unused `localhost:3000`. The filter becomes what the browser loads: `src/**`, `e2e/**`, `playwright.config.ts`, `vite.config.ts`, `tsconfig.json` (Vite's esbuild reads its compilerOptions), `index.html`, `public/**`, `package.json`/`package-lock.json` and the workflow files.
  - **The `app` filter gains `e2e/**`, `playwright.config.ts`, `tsconfig.api.json` and `tsconfig.scripts.json`.** The E2E job `needs: app`, so a change to only `e2e/` or the Playwright config used to skip app and E2E with it. Review lints both and type-checks `e2e/`.
  - **Lint guard `import-x/no-restricted-paths`** in `eslint.config.ts`. Non-test `src/` code may not import `api/` (type-only imports included), so the filter's assumption can't silently break again. The `src/` files that `api/` compiles keep a `.js`-only resolver so the extension rule still works, and they add a `no-restricted-imports` pattern (`^(\.\./)+api(/|$)`) to catch extension-less `import type` from `api/`, which neither import-x rule sees there. A regression test (`scripts/_lib/eslint-api-guard.test.mjs`) lints sample imports with the real config, so a resolver or glob change can't silently switch the guard off.
  - **The nightly run passes `--max-failures=0`.** With 1 worker, Chromium runs first, and the CI stop-after-10 would end the run before Firefox and WebKit start.
  - **CI concurrency groups per commit on main** (review round 1). `cancel-in-progress` on `github.ref` meant every later push to main cancelled the running E2E. Of the last 100 main runs, 31 E2E jobs were superseded and 13 timed out. Main now groups by `github.sha`, so each commit gets its own verdict; PRs still group by ref and cancel superseded runs.

### Phase 2: triage what the boot fix reveals (size unknown)

- Let CI run the suite, now visible and failing fast. Triage the remaining failures, including the pre-06-07 break, into real app bugs and stale specs.
- Fix them spec by spec, at most 5 files per commit.

### Phase 3: speed and scope (needs owner decisions)

- **Parallelism.** Use 2–4 workers on CI (ubuntu-latest has 4 vCPU), or a matrix per browser. Runner minutes are free for a public repo.
- **Optional:** run E2E against `vite build` + `vite preview` instead of `vite dev`. JSON gets bundled, which removes this whole class of bug, and pages load faster. It needs `serviceWorkers: 'block'` for the PWA.

## Files

- **Phase 1:**
  - `src/data/flow-regime-baseline.json` (moved)
  - `src/components/FlowRegimeBadge/classify.ts`
  - `api/_lib/flow-regime.ts`
  - `scripts/build-flow-regime-baseline.py`
  - `vite.config.ts`
  - `docs/superpowers/specs/flow-regime-badge-2026-06-06.md` (baseline runbook path)
  - `playwright.config.ts`, `.github/workflows/ci.yml`, `.github/workflows/e2e-nightly.yml` (new), `eslint.config.ts` and `scripts/_lib/eslint-api-guard.test.mjs` (new), as a separate commit
- **Phase 2:** specs under `e2e/`, case by case.
- **Phase 3:** `playwright.config.ts` and `.github/workflows/ci.yml`.

## Data dependencies

None. The JSON content is unchanged; only its path moves.

## Open questions

- **Browser scope on push.** Decided: Chromium only in ci.yml (PRs, pushes to main, manual dispatch), all 3 browsers nightly (moved into Phase 1). Parallel workers remain a Phase 3 option.
- **Moving the JSON or a test helper.** Decided: move the JSON (option A). The alternative was a shared e2e helper that only blocks fetch and XHR (option B), but that touches 30 spec files and leaves the trap in place for the next `src` import from `api/`. B can still be added later as an extra guard.
