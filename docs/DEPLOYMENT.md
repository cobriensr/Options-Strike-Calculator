# Deployment & Testing

How the app deploys to production, and what the test suite looks like. For local dev see [LOCAL_DEV.md](LOCAL_DEV.md).

## Deployment

### Vercel (Production)

```bash
vercel deploy --prod     # Or push to main for auto-deploy
```

**Requirements**: Vercel Pro plan (required for 800-second function timeout on `/api/analyze`).

**Framework Preset**: Must be set to "Other" (not Vite) for API routes to work alongside SPA.

**Ignore command**: `git diff --quiet HEAD^ HEAD -- ':!sidecar' ':!ml' ':!scripts' ':!pine' ':!docs'` — skips builds when only sidecar, ML, scripts, Pine, or docs change.

**Long-running functions**:

- `api/analyze.ts` — 800s (Claude Opus 4.7 with adaptive thinking)
- `api/cron/curate-lessons.ts` — 780s (lesson curation pipeline)
- `api/cron/build-features.ts` — 300s (ML feature engineering)

### Railway (Sidecar + uw-stream)

Two separate Railway services, each with their own Dockerfile and env vars:

- [sidecar/README.md](../sidecar/README.md) — Databento + Theta + multi-leg + Takeit
- [uw-stream/README.md](../uw-stream/README.md) — UW websocket consumer

The root `vercel.json` `ignoreCommand` skips Vercel builds when only Railway-service folders change, so the two platforms deploy independently.

### Post-Deploy Setup

1. Add Neon Postgres: Vercel Marketplace → Connect Database → Neon
2. Add Upstash Redis: Vercel Marketplace → Connect Database → Upstash for Redis
3. Add Vercel Blob: Vercel Storage → Connect → Blob (for ML plots, archive seeding, DB backups)
4. Add Sentry: Vercel Integrations → Sentry (auto-sets `SENTRY_DSN`)
5. Set environment variables: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `OWNER_SECRET`, `ANTHROPIC_API_KEY`, `UW_API_KEY`. See [.env.example](../.env.example) for the full list.
6. Initialize tables: `POST /api/journal/init` (with owner cookie). Idempotent.
7. Authenticate: Visit `/api/auth/init` → Schwab login → callback sets owner cookie.
8. Run backfill scripts for historical data ingestion if needed — see [scripts/README.md](../scripts/README.md).

---

## Testing

**6,897 unit tests across 277 test files** + 32 Playwright E2E specs (Chromium, Firefox, and WebKit), all passing with TypeScript strict mode. ML pipeline has 14 additional pytest files. Overall coverage: 95.3% statements / 87.9% branches / 96.3% functions.

### Unit Tests (Vitest)

Tests are organized by source type:

```text
src/__tests__/     161 test files — components, hooks, utils, data
api/__tests__/     130 test files — API endpoints, cron jobs, _lib modules
```

| File                                | Focus                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `utils/calculator.test.ts`          | 150+ tests: BS pricing, Greeks (delta/gamma/theta/vega), strikes, kurtosis, stressed sigma |
| `components/ChartAnalysis.test.tsx` | 64 tests: image management, confirmation, cancel, analyze flow, modes, error handling      |
| `hooks/useComputedSignals.test.ts`  | 70 tests: regime, DOW, range, opening range, term shape, RV/IV, directional clustering     |
| `utils/skewAndIC.test.ts`           | 63 tests: convex skew, IC legs, per-side PoP, breakevens                                   |
| `utils/hedge.test.tsx`              | 32 tests: hedge sizing, scenarios, DTE pricing, breakevens, real-world scenario            |
| `utils/settlement.test.ts`          | 16 tests: survived/breached cases, cushion calculations, settledSafe                       |
| `utils/pin-risk.test.ts`            | 17 tests: OI aggregation, top-N sorting, side classification, formatting                   |
| `hooks/useChartAnalysis.test.ts`    | 13 tests: fetch, retry, abort, timeout, mode completion, elapsed timer                     |
| `hooks/useImageUpload.test.ts`      | 12 tests: add/remove/clear, drag-drop, paste, label management, 8-image limit              |
| `utils/analysis.test.ts`            | 10 tests: buildPreviousRecommendation with all field combinations                          |
| `utils/classifiers.test.ts`         | 14 tests: opening range classification, boundary values                                    |
| `utils/bwb.test.ts`                 | BWB P&L scenarios, wing width calculations, anchor integration                             |

### E2E Tests (Playwright — Chromium, Firefox, WebKit)

32 spec files covering user workflows, accessibility, and cross-browser compatibility. See [e2e/README.md](../e2e/README.md) for run + convention details. Coverage includes:

| File                          | Coverage                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| `calculator-flow.spec.ts`     | Full calculation flow, mode switching, dark mode             |
| `strike-table.spec.ts`        | Delta rows, ordering invariants, VIX sensitivity             |
| `iron-condor.spec.ts`         | IC legs, hedge toggle, contracts, hide/show                  |
| `hedge-dte.spec.ts`           | DTE selector, EOD recovery, net cost labels, scenarios       |
| `iv-acceleration.spec.ts`     | σ multiplier at different times, late session warning        |
| `fat-tail-pop.spec.ts`        | Adjusted PoP display, struck-through log-normal              |
| `market-regime-new.spec.ts`   | Clustering, term structure shapes (contango/fear-spike/flat) |
| `entry-time.spec.ts`          | Time selects, AM/PM, timezone, recalculation                 |
| `advanced-section.spec.ts`    | Skew slider, wing width, contracts counter                   |
| `chart-analysis.spec.ts`      | Mode selector, drop zone, mocked analysis                    |
| `chart-analysis-flow.spec.ts` | Full chart analysis flow with rendering                      |
| `risk-calculator.spec.ts`     | Risk tiers, buy/sell modes, position sizing                  |
| `pnl-profile.spec.ts`         | P&L diagram rendering                                        |
| `positions-upload.spec.ts`    | PaperMoney CSV upload and position parsing                   |
| `export-download.spec.ts`     | CSV and Excel export/download verification                   |
| `validation-errors.spec.ts`   | Input validation, error states, clearing                     |
| `extreme-inputs.spec.ts`      | Edge cases: extreme values, boundary inputs                  |
| `responsive.spec.ts`          | iPhone, iPad, desktop viewports                              |
| `theme-persistence.spec.ts`   | Dark mode persistence across page reloads                    |
| `error-recovery.spec.ts`      | Error handling and recovery                                  |
| `a11y-automated.spec.ts`      | Axe-core WCAG 2.1 AA scans (home, results, dark mode)        |
| `accessibility.spec.ts`       | Keyboard navigation, ARIA attributes, focus management       |
| `a11y-live-data.spec.ts`      | Live region testing for dynamic content                      |
| `cross-section.spec.ts`       | Cross-section interaction flows                              |
| `date-lookup.spec.ts`         | Date picker with event day integration                       |
| `delta-regime-guide.spec.ts`  | Delta guide ceiling and regime badges                        |
| `opening-range.spec.ts`       | Opening range check signals                                  |
| `parameter-summary.spec.ts`   | Parameter summary display                                    |
| `pre-market.spec.ts`          | Pre-market data analysis                                     |
| `pre-trade-signals.spec.ts`   | Signal validation                                            |
| `vix-range-analysis.spec.ts`  | VIX/range analysis with fine-grained bars                    |
| `event-day-warning.spec.ts`   | Event day alerts and severity coding                         |

### ML Tests (pytest)

```bash
cd ml && .venv/bin/pytest -v     # 14 test files covering all pipeline phases
```

| File                 | Coverage                                        |
| -------------------- | ----------------------------------------------- |
| `test_utils.py`      | Validation, formatting, DB helpers              |
| `test_clustering.py` | K-Means, GMM, dimensionality reduction          |
| `test_eda.py`        | Rule validation, correlation, confidence        |
| `test_phase2.py`     | Walk-forward validation, multi-model comparison |
| `test_backtest.py`   | P&L simulation, equity curves, drawdowns        |
| `test_pin.py`        | Gamma wall detection, pin accuracy metrics      |
| `test_health.py`     | Freshness checks, stationarity alerts           |
| `test_milestone.py`  | Milestone tracking, feature accumulation        |
| `test_visualize.py`  | Plot generation, output validation              |
| `test_explore.py`    | Data export, CSV formatting                     |

---

## Scripts Reference

### App

| Command                 | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `npm run dev`           | Vite dev server with HMR                         |
| `npm run dev:full`      | Vercel dev (frontend + API functions)            |
| `npm run build`         | TypeScript check + production build              |
| `npm run build:analyze` | Production build + interactive bundle treemap    |
| `npm test`              | Vitest watch mode                                |
| `npm run test:run`      | Single test run (CI)                             |
| `npm run test:coverage` | v8 coverage report                               |
| `npm run lint`          | TypeScript + ESLint check                        |
| `npm run review`        | tsc + ESLint + Prettier + Vitest coverage (full) |
| `npm run test:e2e`      | Playwright E2E tests (Chromium, Firefox, WebKit) |
| `npm run test:e2e:ui`   | Playwright interactive UI mode                   |
| `npm run format`        | Prettier format all files                        |
| `npm run format:check`  | Prettier check (CI)                              |

### ML Pipeline

| Command                 | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `make -C ml all`        | Full ML pipeline (health → EDA → cluster → viz) |
| `make -C ml eda`        | Exploratory data analysis only                  |
| `make -C ml early`      | Phase 2 early feasibility experiment            |
| `make -C ml early-shap` | Phase 2 with SHAP importance plots              |
| `make -C ml pin`        | Settlement pin risk / gamma correlation         |
| `make -C ml backtest`   | Simplified P&L backtest                         |
| `make -C ml health`     | Pipeline health check (freshness, stationarity) |
| `make -C ml milestone`  | Data milestones + script recommendations        |
| `make -C ml test`       | Run ML pytest suite                             |
| `make -C ml test-cov`   | ML tests with coverage report                   |

### Backfill Scripts

~125 scripts in `scripts/` — see [scripts/README.md](../scripts/README.md) for the categorical map.

---

## CI

Three GitHub Actions workflows in `.github/workflows/`:

- **ci.yml** — runs on PR and push to main. Tests the app (always), ML (if `ml/` changed), sidecar (if `sidecar/` changed), and E2E (if `e2e/` or `api/` changed).
- **ml-pipeline.yml** — nightly cron at 01:45 UTC Tue–Sat. Runs the full ML pipeline, uploads plots to Vercel Blob, triggers Claude vision, commits `findings.json`.
- **takeit-retrain.yml** — same schedule as ml-pipeline. Retrains the XGBoost model on prod data.

ML and sidecar workflows require `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` repository secrets.
