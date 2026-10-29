# Deployment & Testing

How the app deploys to production, and what the test suite looks like. For local dev see [LOCAL_DEV.md](LOCAL_DEV.md).

## Deployment

### Vercel (Production)

Pushing to `main` deploys. Vercel builds the push unless the ignore command (below) skips it, and each Railway service redeploys when a file under its watch paths changes. There is no manual `vercel deploy` step.

**Runtime**: Node 24 (`package.json` `engines`, `.nvmrc`), with Fluid Compute (a project setting, not in `vercel.json`).

**Requirements**: Vercel Pro plan. Four functions set `maxDuration` above 300 s (listed below).

**Framework Preset**: Must be set to "Other" (not Vite) for API routes to work alongside SPA. `vercel.json` sets `outputDirectory: dist` and the `installCommand`; the build is `npm run build`.

**Ignore command** (`vercel.json` `ignoreCommand`):

```sh
BASE="$VERCEL_GIT_PREVIOUS_SHA"; [ -n "$BASE" ] && git cat-file -e "$BASE^{commit}" 2>/dev/null || exit 1; git diff --quiet "$BASE" HEAD -- ':!sidecar' ':!ml' ':!uw-stream' ':!nightly' ':!docs' ':!scripts' ':!pine' ':!*.md' || exit 1
```

It diffs `HEAD` against the last deployed commit. If the only changes are under `sidecar/`, `ml/`, `uw-stream/`, `nightly/`, `docs/`, `scripts/` or `pine/`, or are `*.md` files, the build is skipped. If that commit is unset or not in the clone, it builds.

**Long-running functions** (`vercel.json` `functions` sets `maxDuration` for 25 functions; the rest use the platform default):

- `api/cron/backfill-futures-gaps.ts`: 800 s (repairs `futures_bars` holes from UW REST candles)
- `api/analyze.ts`: 780 s (Claude Opus 4.7 with adaptive thinking, Sonnet 4.6 fallback)
- `api/cron/curate-lessons.ts`: 780 s (lesson curation pipeline)
- `api/cron/curate-periscope-lessons.ts`: 780 s (Periscope debrief lesson curation)
- `api/cron/build-features.ts`, `enrich-lottery-outcomes.ts`, `rollup-ws-gex-strike-expiry.ts` and `archive-gexbot.ts`: 300 s

**Cron jobs**: `vercel.json` registers 83 schedules across 77 paths: 76 handlers in `api/cron/` plus `/api/health` (13:25 UTC weekdays). `fetch-gexbot-fast`, `fetch-gexbot-strikes` and `populate-periscope-from-gexbot` each have three entries. Schedules are UTC, and every handler checks `CRON_SECRET`.

**Headers and rewrites** (`vercel.json`): security headers, including the CSP, on every path except the BotID proxy; `Cache-Control: no-cache, no-store, must-revalidate` on `/sw.js`; two BotID rewrites to Vercel's bot-protection service; and a last SPA fallback that sends every non-`/api/` path with no file extension to `/index.html`.

### Railway (sidecar + uw-stream + nightly + ws-canary)

Two long-running Railway services, each with its own Dockerfile, `railway.toml` `watchPatterns` and env vars, plus one cron service and one temporary service:

- [sidecar/README.md](../sidecar/README.md): Take-It SHAP + frozen archive (Theta and the multileg-classify fallback were removed 2026-10-02)
- [uw-stream/README.md](../uw-stream/README.md): UW websocket consumer (also the live source of `futures_bars`)
- [nightly/README.md](../nightly/README.md): a cron service that lands the UW options Full Tape in Cloudflare R2, one Parquet per trading day, then exits. It has no `railway.toml`: its schedule (`15 7 * * 2-6` UTC, Tue–Sat), restart policy (`NEVER`) and watch paths are set on the Railway service. Env: `UW_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`, optional `SENTRY_DSN`. Its README is the runbook: alert meanings, markers, re-lands.
- [scripts/ws-canary/README.md](../scripts/ws-canary/README.md): a temporary canary that holds test websockets from uw-stream's Railway region, to find which network hop resets uw-stream's connections. It is deleted once the verdict is in.

Watch paths: `sidecar/**`, `uw-stream/**`, `/nightly/Dockerfile`, `/nightly/requirements.txt` and `/nightly/src/**` (only the image inputs), and `/scripts/ws-canary/**`. Railway doesn't read config-as-code for a new service, so the canary's settings are set on the service and its `railway.toml` only records them. A change under `scripts/` alone redeploys the canary without building Vercel, since the ignore command leaves that folder out.

Hold pushes that touch `uw-stream/` or `sidecar/` until after the 15:00 CT close: a redeploy drops the websocket mid-session and briefly takes down Take-It scoring. Keep pushes to `nightly/src` out of its run window (about 07:15 to 12:30 UTC): a redeploy can stop the run, and a stopped run waits for the next night unless someone runs `railway cron run --service nightly`.

### Post-Deploy Setup

1. Add Neon Postgres: Vercel Marketplace → Connect Database → Neon
2. Add Upstash Redis: Vercel Marketplace → Connect Database → Upstash for Redis
3. Add Vercel Blob: Vercel Storage → Connect → Blob (ML plots, Take-It model bundles, GEXBot and Periscope archives, table backups, archive seeding)
4. Add Sentry: Vercel Integrations → Sentry (auto-sets `SENTRY_DSN`)
5. Set environment variables: `OWNER_SECRET`, `CRON_SECRET`, `APP_URL` (the public origin; the Schwab OAuth redirect is built from it), `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `OWNER_SCHWAB_ACCOUNT_SHA256` (sha256 of the owner's Schwab account number; Schwab logins are refused while it is unset), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `UW_API_KEY`, `GEXBOT_API_KEY`. See [.env.example](../.env.example) for the full list.
6. Authenticate: visit `/api/auth/init` → Schwab login → the callback sets the owner cookie. This needs Redis, not the database.
7. Initialize tables: `POST /api/journal/init` with the owner cookie. It creates the base tables and runs every migration. Idempotent.
8. Later schema changes: nothing applies migrations on deploy. Apply them with `POST /api/journal/migrate` (owner cookie), or locally with `DATABASE_URL=... npx tsx scripts/migrate-db.ts`. The `DATABASE_URL` that `vercel env pull` writes to `.env.local` is the production database. The `audit-migration-drift` cron (12:00 UTC daily) raises a Sentry warning for any migration in code that is missing from `schema_migrations`.
9. Run backfill scripts for historical data ingestion if needed: see [scripts/README.md](../scripts/README.md).

---

## Testing

As of 2026-10-29: **about 14,960 Vitest tests in 686 files**, plus 41 Playwright spec files (three browser projects: CI runs Chromium, the nightly job runs all three), all type-checked in strict mode. Python: 88 pytest files across ml (52), uw-stream (26) and sidecar (10), plus 7 in the retired `classifier/` folder, which CI no longer runs. Coverage on the 2026-10-29 gate run: 95.2% statements / 88.0% branches / 96.1% functions / 96.9% lines.

### Unit Tests (Vitest)

Tests are organized by source type:

```text
src/__tests__/       313 test files: components, hooks, utils, data
src/** (co-located)   28 test files: next to their component, hook or constant
api/__tests__/       336 test files: API endpoints, cron jobs, _lib modules
scripts/_lib/          9 test files: review and backfill tooling (coverage floors, build output, worktree pruning, trading days)
```

| File (under `src/__tests__/`)       | Focus                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `utils/calculator.test.ts`          | 176 tests: BS pricing, Greeks (delta/gamma/theta/vega), strikes, kurtosis, stressed sigma |
| `utils/bwb.test.ts`                 | 130 tests: BWB construction, P&L scenarios, Greeks, wing widths                           |
| `components/ChartAnalysis.test.tsx` | 109 tests: image management, confirmation, cancel, analyze flow, modes, error handling    |
| `hooks/useComputedSignals.test.ts`  | 77 tests: regime, DOW, range, opening range, term shape, RV/IV, directional clustering    |
| `utils/skewAndIC.test.ts`           | 73 tests: convex skew, IC legs, per-side PoP, breakevens                                  |
| `utils/hedge.test.tsx`              | 63 tests: hedge sizing, scenarios, DTE pricing, breakevens, real-world scenario           |
| `utils/settlement.test.ts`          | 23 tests: survived/breached cases, cushion calculations, settledSafe                      |
| `utils/pin-risk.test.ts`            | 23 tests: OI aggregation, top-N sorting, side classification, formatting                  |
| `hooks/useImageUpload.test.ts`      | 19 tests: add/remove/clear, drag-drop, paste, label management, 2-image limit             |
| `hooks/useChartAnalysis.test.ts`    | 16 tests: fetch, retry, abort, timeout, mode completion, elapsed timer                    |
| `utils/classifiers.test.ts`         | 14 tests: opening range classification, boundary values                                   |
| `utils/analysis.test.ts`            | 11 tests: buildPreviousRecommendation with all field combinations                         |

Per-file counts as of 2026-10-29.

### E2E Tests (Playwright: Chromium, Firefox, WebKit)

41 spec files. CI runs them on Chromium, the nightly job on all three browsers. See [e2e/README.md](../e2e/README.md) for run and convention details.

| File                                | Coverage                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `a11y-automated.spec.ts`            | Axe scans (tags `wcag2a`, `wcag2aa`; fails on critical/serious) of home, results and dark mode |
| `a11y-live-data.spec.ts`            | Axe scans with mocked live data on polling panels                                              |
| `accessibility.spec.ts`             | Keyboard navigation, ARIA attributes, focus management                                         |
| `advanced-section.spec.ts`          | Skew slider, wing width, contracts counter                                                     |
| `calculator-flow.spec.ts`           | Full calculation flow, mode switching, dark mode                                               |
| `chart-analysis.spec.ts`            | Section visibility, mode selector, drop zone                                                   |
| `chart-analysis-flow.spec.ts`       | Full chart analysis flow with a mocked analyze response                                        |
| `cross-section.spec.ts`             | Input changes cascading through strikes, IC, hedge, regime and parameter summary               |
| `date-lookup.spec.ts`               | Date picker, historical VIX OHLC lookup, calculating on a past date                            |
| `delta-regime-guide.spec.ts`        | Range and delta threshold tables, ceiling recommendation                                       |
| `entry-time.spec.ts`                | Time selects, AM/PM, timezone, recalculation                                                   |
| `error-recovery.spec.ts`            | Invalid input sequences, clearing, rapid changes, IV mode switches                             |
| `event-day-warning.spec.ts`         | Event-day banners by severity, market-closed banner                                            |
| `export-download.spec.ts`           | Excel (`.xlsx`) export: download, non-zero size, dated filename                                |
| `extreme-inputs.spec.ts`            | Edge cases: extreme values, boundary inputs                                                    |
| `fat-tail-pop.spec.ts`              | Fat-tail-adjusted vs log-normal PoP in the P&L table                                           |
| `hedge-dte.spec.ts`                 | DTE selector, EOD recovery, net cost labels, scenarios                                         |
| `iron-condor.spec.ts`               | IC legs, hedge toggle, contracts, hide/show                                                    |
| `iv-acceleration.spec.ts`           | σ multiplier by time of day, late-session warning                                              |
| `malformed-payloads.spec.ts`        | A 200 with a malformed body degrades one panel, not the whole page                             |
| `market-regime-new.spec.ts`         | Market Regime manual input: VIX, volatility clustering, term-structure inputs                  |
| `market-regime-term-shape.spec.ts`  | Term-structure shapes (contango, fear spike, flat) from mocked quotes                          |
| `opening-range.spec.ts`             | Opening range check: RANGE INTACT and RANGE EXHAUSTED signals                                  |
| `options-alerts.spec.ts`            | Options Alerts view (Lottery Finder + Silent Boom) with an axe scan                            |
| `options-alerts-responsive.spec.ts` | Options Alerts panes stack below `xl` (1280px) and sit side by side at `xl` and wider          |
| `panel-reorder.spec.ts`             | Panel-prefs modal drag-to-reorder with an axe scan                                             |
| `parameter-summary.spec.ts`         | Parameter summary: hours left, σ, live updates                                                 |
| `pnl-profile.spec.ts`               | P&L profile table: structure, RoR, break-evens                                                 |
| `positions-upload.spec.ts`          | PaperMoney CSV upload: success and API-failure paths                                           |
| `pre-market.spec.ts`                | Pre-market input: Globex range and ES-vs-SPX gap previews, validation                          |
| `pre-trade-signals.spec.ts`         | RV/IV, overnight gap and move-breadth signals                                                  |
| `regime-0dte.spec.ts`               | 0DTE Gamma Regime panel (closed-market placeholder) with an axe scan                           |
| `responsive.spec.ts`                | Mobile, tablet and desktop viewports                                                           |
| `risk-calculator.spec.ts`           | Risk tiers, buy/sell modes, position sizing                                                    |
| `strike-table.spec.ts`              | Delta rows, ordering invariants, VIX sensitivity                                               |
| `theme-persistence.spec.ts`         | Dark and light mode persistence across reloads                                                 |
| `toolbar-export-row.spec.ts`        | Lottery Finder and Silent Boom toolbar export cluster stays on one line                        |
| `tracker.spec.ts`                   | Contract Tracker: Active tab, add-contract modal (inline `route.fulfill` mocks)                |
| `validation-errors.spec.ts`         | Input validation, error states, clearing                                                       |
| `vega-spike-feed.spec.ts`           | Vega Spike feed: empty and populated states, range toggle, axe scan                            |
| `vix-range-analysis.spec.ts`        | VIX range table, survive/settle toggle, fine-grained bars                                      |

Every axe scan runs on Chromium only.

### ML Tests (pytest)

```bash
make -C ml test       # 52 test files in ml/tests/
make -C ml test-cov   # same, failing under 70% coverage
```

`ml/Makefile` defaults to `PYTHON=.venv/Scripts/python` on Windows and `.venv/bin/python` elsewhere (it picks by `$(OS)`); pass `PYTHON=...` only to override.

| Files                                                                                                                                | Coverage                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `test_utils`, `test_health`, `test_milestone`, `test_explore`, `test_visualize` (5)                                                  | Pipeline plumbing: DB helpers, freshness, milestones, export, plots            |
| `test_clustering`, `test_eda`, `test_phase2`, `test_backtest`, `test_pin`, `test_calibration`, `test_nope_eda` (7)                   | Core analyses: clustering, EDA, walk-forward, backtest, pin, calibration, NOPE |
| `test_setups_backtest_*` (13)                                                                                                        | Futures setup backtest harness, loaders, metrics, setups 1–8                   |
| `test_lottery_scoring`, `test_lottery_ticker_quality`, `test_score_components`, `test_takeit_*` (7)                                  | Lottery Finder scoring and Take-It training, export, drift                     |
| `test_flow_*`, `test_fulltape_ingest` (6)                                                                                            | EOD flow archive and Full Tape ingest, EDA, outcomes, outliers                 |
| `test_imbalance_*`, `test_moc_features_loaders` (5)                                                                                  | Imbalance and MOC features                                                     |
| `test_microstructure_*`, `test_options_features_*`, `test_multileg_*`, `test_periscope_gamma_wall_lib`, `test_day_analog_parity` (9) | Microstructure, options features, multi-leg, Periscope walls, day analogs      |

### Service Tests (pytest)

- **sidecar**: 10 files. `make -C sidecar test-cov`; no coverage gate.
- **uw-stream**: 26 files. CI runs `ruff check`, `ruff format --check` and `pytest --cov`, with no gate.
- **nightly**: 9 files. CI runs `ruff check`, `ruff format --check` and `pytest --cov`, with no coverage gate; `pyproject.toml` makes pytest fail on any warning.

`make py-test-cov` (root `Makefile`) runs ml, sidecar, classifier and uw-stream; nightly runs on its own (`cd nightly && python -m pytest`). `npm run review:python` runs ml and sidecar. Six more test files sit outside any suite and CI: `scripts/test_*.py` (5) and `scripts/ws-canary/test_canary.py`.

---

## Scripts Reference

### App

| Command                                                  | Description                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                                            | Vite dev server with HMR                                                                                     |
| `npm run dev:full`                                       | Vercel dev (frontend + API functions)                                                                        |
| `npm run build`                                          | Build info + TypeScript check + production build                                                             |
| `npm run build:analyze`                                  | Production build + interactive bundle treemap                                                                |
| `npm run preview`                                        | Serve the production build                                                                                   |
| `npm test`                                               | Vitest watch mode                                                                                            |
| `npm run test:ui`                                        | Vitest UI                                                                                                    |
| `npm run test:run`                                       | Single test run                                                                                              |
| `npm run test:coverage`                                  | v8 coverage report                                                                                           |
| `npm run type-check`                                     | tsc for src, api and scripts                                                                                 |
| `npm run lint`                                           | Type-check + ESLint                                                                                          |
| `npm run review`                                         | Type-check + ESLint + Prettier (write) + vite build + build-output check + Vitest coverage + coverage floors |
| `npm run audit`                                          | audit-ci gate (`audit-ci.jsonc`; CI runs it before review)                                                   |
| `npm run test:e2e`                                       | Playwright E2E tests (Chromium, Firefox, WebKit)                                                             |
| `npm run test:e2e:ui`                                    | Playwright interactive UI mode                                                                               |
| `npm run format`                                         | Prettier write on code files (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`)                                        |
| `npm run format:check`                                   | Prettier check on the same files                                                                             |
| `npm run worktrees:prune`                                | Remove merged, idle worktrees under `.worktrees/`                                                            |
| `npm run review:ml` / `review:sidecar` / `review:python` | Python format and coverage gates                                                                             |
| `npm run db:up` / `db:down` / `db:reset`                 | Local Postgres via `docker-compose.dev.yml`                                                                  |

Coverage floors: global 90/80/90/90 (statements/branches/functions/lines); per folder, branches and lines for `api/cron`, `api/_lib`, the other `api/` endpoints, `src/components`, `src/hooks` and `src/utils` (`vite.config.ts`); per file, 50% branches / 50% functions / 60% lines (`scripts/_lib/coverage-floor.mjs`).

### ML Pipeline

| Command                  | Description                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `make -C ml all`         | Full ML pipeline: health → eda → cluster → visualize → early → backtest → pin → nope → flow → calibration |
| `make -C ml full`        | health + all + backtest + milestone                                                                       |
| `make -C ml health`      | Pipeline health check (freshness, stationarity)                                                           |
| `make -C ml eda`         | Exploratory data analysis only                                                                            |
| `make -C ml cluster`     | Clustering analysis with plots                                                                            |
| `make -C ml visualize`   | Generate all visualization plots                                                                          |
| `make -C ml early`       | Phase 2 early feasibility experiment                                                                      |
| `make -C ml early-shap`  | Phase 2 with SHAP importance plots                                                                        |
| `make -C ml backtest`    | Simplified P&L backtest                                                                                   |
| `make -C ml pin`         | Settlement pin risk / gamma correlation                                                                   |
| `make -C ml nope`        | NOPE EDA                                                                                                  |
| `make -C ml flow`        | Flow EDA                                                                                                  |
| `make -C ml calibration` | TRACE Live calibration dashboard (its table was dropped with TRACE Live, so it finds no rows)             |
| `make -C ml milestone`   | Data milestones + script recommendations                                                                  |
| `make -C ml lint`        | ruff lint + format check                                                                                  |
| `make -C ml format`      | Auto-fix formatting and lint issues                                                                       |
| `make -C ml test`        | Run ML pytest suite                                                                                       |
| `make -C ml test-cov`    | ML tests with coverage report (fails under 70%)                                                           |
| `make -C ml test-html`   | Same, with an HTML coverage report                                                                        |
| `make -C ml review`      | lint + test-cov                                                                                           |
| `make -C ml clean`       | Remove generated plots                                                                                    |

### Backfill Scripts

About 255 scripts in `scripts/` (plus `_lib/`, `ops/`, `eod-flow-analysis/` and `ws-canary/`): see [scripts/README.md](../scripts/README.md) for the categorical map. The nightly EOD flow pipeline is the root `Makefile` (`make nightly`, `make update`, `make tune`); `make help` lists its targets.

---

## CI

Four workflow files in `.github/workflows/`:

- **ci.yml**: on pushes to main, PRs and manual dispatch. A `paths-filter` job picks the gates that run. The **App Quality Gate** (`npm run audit` + `npm run review`) runs when `src/`, `api/`, `scripts/`, `e2e/`, `.github/`, config or lockfiles change. **E2E Tests** (Chromium only) runs after the app gate passes, when a file the browser loads changes (`src/`, `e2e/`, `playwright.config.ts`, `vite.config.ts`, `tsconfig.json`, `index.html`, `public/`, `package*.json`, or the two workflow files); `api/`-only changes skip it. The **ML**, **Sidecar**, **uw-stream** and **nightly** gates each run when their folder changes.
- **e2e-nightly.yml**: all three browsers, weekdays at 23:00 UTC and on manual dispatch, with no path filter.
- **ml-pipeline.yml**: 01:45 UTC Tue–Sat and manual dispatch. Job `pipeline` runs `make all`, uploads plots to Vercel Blob, calls `/api/ml/analyze-plots`, and commits `ml/findings.json` + plots. Job `takeit-retrain` then rebuilds the Take-It training set, retrains, warns when out-of-fold Brier > 0.27, and uploads bundles with `scripts/upload_takeit_bundles.mjs`. **The workflow is disabled in GitHub** (last run 2026-04-17), so neither job runs.
- **neon_workflow.yml**: creates a Neon branch per PR (expires after 14 days) and deletes it when the PR closes.

`ml-pipeline.yml` needs the repository secrets `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `VERCEL_URL`, `CRON_SECRET` and `VERCEL_BYPASS_SECRET`. `neon_workflow.yml` needs the secret `NEON_API_KEY` and the variable `NEON_PROJECT_ID`. The `ci.yml` gates need none.
