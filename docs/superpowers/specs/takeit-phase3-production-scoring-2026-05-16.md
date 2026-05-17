---
status: Likely Shipped
date: 2026-05-16
---

# Take-It Phase 3 — Production Scoring Pipeline — 2026-05-16

## Goal

Every new Lottery Finder / Silent Boom alert lands in Postgres with `takeit_prob` populated at detect time, and `takeit_top_features` populated within ≤2 minutes. The TypeScript hot path stays free of native binaries and Python. A nightly GH Actions retrain refreshes the model bundle in Vercel Blob.

Spec is a follow-on to `docs/superpowers/specs/alert-takeit-score-2026-05-16.md` (Phases 1-2 shipped in commits 5b8d6b5d and edd6dda4).

## Decisions Made During Scoping

1. **Pure TS tree traversal for prob scoring.** Implement XGBoost JSON tree walking (~200 LOC) in `api/_lib/takeit-score.ts`. No native deps, no Python in the hot path, deterministic byte-identical-to-Python output (gated by parity test). Rejected: `xgboost-node` (native binding compat risk), `onnxruntime-node` (extra export step, isotonic still needs custom code), Railway-HTTP-per-fire (network failure modes).
2. **Hybrid SHAP path** — and this is the only deviation from the original spec. TreeSHAP in TS is ~500 LOC done right and well-known for subtle correctness bugs (handling missing values, interventional vs path-dependent). Instead:
   - TS scorer computes `prob` real-time at detect (the critical path).
   - A new `api/cron/takeit-fill-shap.ts` runs every 2 min, finds rows where `takeit_prob IS NOT NULL AND takeit_top_features IS NULL`, calls the Railway sidecar's `/takeit/explain` endpoint, UPDATEs the JSONB column.
   - If sidecar is down, prob still lands; flags can backfill later. Graceful degradation, not a hard dependency.
3. **All features computed at detect time** (full model fidelity). The detect cron does 4 extra small SQL roundtrips per fire to populate `burst_storm_distinct_count`, `silent_boom_cofire_within_5min`, `n_same_dir_fires_last_30min`, `prior_session_win_rate_same_ticker`. Detect runs every 5 min and writes ~10-50 rows per run; the extra ~50-100ms of lookups is irrelevant.
4. **Backfill all 641K labeled fires.** One-shot Python script (`scripts/backfill_takeit.py`) loads the v1 bundle, runs `build_lottery_from_raw` + `explain_batch` over the existing rows, and UPSERTs via batched (1000-row) `COPY ... ON CONFLICT`. ~5-10 min total; Phase 5 monitoring needs the populated history for drift detection.
5. **Retrain runs on GitHub Actions, not Vercel.** Matches the existing nightly ML pipeline (`.github/workflows/ml-pipeline.yml`) which already has the Python venv + database access pattern. Adds a new step after the existing nightly that runs `build_training_set → train → export_model` and pushes the bundle to Vercel Blob. Vercel function timeout of 780s on the Pro plan would be enough to run training inline, but it's the wrong place: training shouldn't share a deploy pod with request-path code, and the existing GH Actions pattern is already wired with all the deps.

## Architecture

```text
                ┌────────────────────────────────────────────────────────┐
                │                  GitHub Actions (nightly)              │
                │  ml-pipeline.yml step: takeit-retrain                  │
                │  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐   │
                │  │ build_   │→ │ train.py │→ │ export_model.py     │   │
                │  │ training │  │          │  │  → bundle.json       │   │
                │  │ _set     │  │          │  │  → upload to Blob   │   │
                │  └──────────┘  └──────────┘  └─────────────────────┘   │
                └────────────────────────────────────────────────────────┘
                                            │
                                            │ Vercel Blob (private)
                                            │ takeit/{alert_type}_classifier_v{N}.json
                                            ▼
┌──────────────────────────┐    ┌─────────────────────────────────────────┐
│ detect-lottery-fires.ts  │ →  │ api/_lib/takeit-score.ts                │
│ detect-silent-boom.ts    │    │ - loadBundleFromBlob() on cold start    │
│ (every 5 min)            │    │ - traverseTrees(features) → raw_logit   │
│                          │    │ - applyIsotonic() → prob ∈ [0, 1]       │
│ INSERT row with:         │    └─────────────────────────────────────────┘
│  - heuristic score       │
│  - takeit_prob           │           ↓
│  - takeit_top_features=  │
│     NULL (filled later)  │    Postgres: takeit_prob populated at INSERT
└──────────────────────────┘
                                            │
                                            ▼
┌──────────────────────────┐    ┌─────────────────────────────────────────┐
│ takeit-fill-shap.ts cron │ →  │ Railway sidecar /takeit/explain         │
│ (every 2 min)            │    │ - loads same Blob bundle                │
│ Find rows with prob set  │    │ - runs ml.src.takeit.shap_explainer     │
│ but features IS NULL,    │    │ - returns top-3 pos + top-3 neg per row │
│ POST batch to sidecar,   │    └─────────────────────────────────────────┘
│ UPDATE takeit_top_       │
│ features = ...           │
└──────────────────────────┘
```

## Data Dependencies

| Source                       | Path / Table                                                      | Coverage                       |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| Trained model bundles        | Vercel Blob (private): `takeit/{alert_type}_classifier_v{N}.json` | Latest weekly retrain          |
| Alert tables (write target)  | Postgres `lottery_finder_fires`, `silent_boom_alerts`             | All-time                       |
| Phase 1 training parquets    | `ml/data/takeit/{alert_type}_training.parquet`                    | Built on demand by GH Actions  |
| Existing GH Actions workflow | `.github/workflows/ml-pipeline.yml`                               | Tue-Sat 01:45 UTC              |
| Sidecar service              | Railway (existing — `sidecar/` or `uw-stream/`)                   | Add `/takeit/explain` endpoint |

## Phases

### Phase 3a — DB migration + Python model export

Output: schema is ready; Python bundle format is locked.

Files:

- DB migration #154 — adds `takeit_prob NUMERIC`, `takeit_top_features JSONB`, `takeit_model_version TEXT` to both `lottery_finder_fires` and `silent_boom_alerts`. Adds partial index `(date DESC, takeit_prob DESC) WHERE takeit_prob IS NOT NULL` on each table for "sort feed by prob" queries.
- `ml/src/takeit/export_model.py` — emits the bundle JSON: XGBoost tree dump (`model.save_model(io.StringIO())`), isotonic spline (knots + values), `feature_cols`, `top_tickers`, `categorical_cols`, `xgb_params`, version string (timestamp + git SHA), and a schema hash used by the TS scorer to fail closed on drift.
- `ml/src/takeit/train.py` — extend `train_one_alert_type` to also call `export_model.export(...)` and write `bundle.json` to `ml/data/takeit/`.
- `ml/tests/test_takeit_export.py` — verify bundle round-trip in Python (load → predict same as in-memory model on 50 fixture rows to 1e-12).
- `api/__tests__/db.test.ts` — mock the migration so existing test sequence still passes (3 new SQL calls per table = 6 mock entries appended).

Verify: `npm run test:run` passes; running `python -m ml.src.takeit.train` produces `lottery_classifier.joblib` + `lottery_bundle.json` side by side.

### Phase 3b — TS scorer (pure tree traversal) + Blob loader

Output: `computeTakeitScore(features)` works in any TS function with byte-identical output to Python.

Files:

- `api/_lib/takeit-bundle-loader.ts` — fetches the latest bundle JSON from Vercel Blob, caches in module scope, refreshes on a TTL (15 min). Uses `@vercel/blob` private read.
- `api/_lib/takeit-score.ts` — pure functions:
  - `traverseTree(tree, features) → leaf_value`
  - `xgbPredictLogit(trees, features) → number`
  - `applyIsotonic(spline, raw) → calibrated_prob`
  - `computeTakeitScore(bundle, features) → number`
- `api/_lib/takeit-features.ts` — builds the feature object from an alert row + per-fire SQL helpers (`getBurstStormDistinct`, `getCofireFlag`, `getSameDirCount30min`, `getPriorSessionWinRate`). One-hot expansion of categoricals here too.
- `api/__tests__/takeit-score.parity.test.ts` — **the gate**: load the Python bundle, generate 50 fixture rows via `ml/src/takeit/build_training_set.derive_common_features`, score in Python and TS, assert max abs diff < 1e-6 for every row.
- `api/__tests__/takeit-features.test.ts` — unit tests for each lookup helper using mocked `getDb()`.

Verify: parity test passes; bundle loader cold-start adds < 500ms (one Blob fetch).

### Phase 3c — Wire into detect crons + backfill

Output: every new alert from this point forward has `takeit_prob` at INSERT time; history is backfilled.

Files:

- `api/cron/detect-lottery-fires.ts` — after `computeLotteryScore`, call `buildTakeitFeatures(alertRow)` + `computeTakeitScore(bundle, features)`, INSERT `takeit_prob` + `takeit_model_version`. Leave `takeit_top_features` as NULL.
- `api/cron/detect-silent-boom.ts` — same pattern with the silent-boom feature set.
- `scripts/backfill_takeit.py` — one-shot. Loads both bundles, runs Phase 1's `build_lottery_from_raw` / `build_silentboom_from_raw` over all enriched fires, computes prob + SHAP in batches of 1000, UPSERTs via Neon batched VALUES. Idempotent (only updates rows where `takeit_model_version IS NULL OR != current_version`).
- `scripts/backfill_takeit.test.py` — fixture verifies idempotency: running twice produces identical rows.
- `api/cron/cron-detect.test.ts` updates — mock the bundle loader + extend mock sequence for the new INSERT columns.

Verify: deploy to preview, run detect crons against staging DB, confirm prob lands within [0, 1] on every new row. Run the backfill against a 1000-row staging subset, verify prob distribution matches the Phase 2 training distribution (KS test, p > 0.05).

### Phase 3d — Hybrid SHAP fill cron + sidecar endpoint

Output: `takeit_top_features` is populated within ~2 min of INSERT; graceful degradation if sidecar is down.

Files:

- Sidecar endpoint (as shipped: lives in `sidecar/src/takeit_server.py`, dispatched from the existing health HTTP server in `sidecar/src/health.py` on the single public port `8080` — Railway only exposes one public port per service, so a separate Flask process on 8123 was dropped during 3d and folded into the stdlib `http.server` HealthHandler. All SHAP code stays inside `sidecar/`):
  - `POST /takeit/explain { alert_type, rows: [{ alert_id, features: {...} }] }` → array of `{ alert_id, top_features: { positive: [...], negative: [...] } }`.
  - Loads the same Blob bundle (Python side reads the joblib via urllib, not the JSON dump, for speed). xgboost/shap/joblib are lazy-imported on first request so cold paths don't pay the load cost.
  - The `/takeit/health` and `/takeit/explain` routes both short-circuit with 503 when `takeit_server.is_enabled()` is False (env flag missing) so the rest of the sidecar keeps serving.
- `api/cron/takeit-fill-shap.ts` — every 2 min, query `SELECT id, ...features FROM <table> WHERE takeit_prob IS NOT NULL AND takeit_top_features IS NULL ORDER BY id DESC LIMIT 500`, batch-POST to sidecar, UPDATE the JSONB column. Sentry-log if sidecar returns non-200.
- `vercel.json` — register the new cron (every 2 min).
- `api/__tests__/takeit-fill-shap.test.ts` — mock fetch + DB; verify batch query, sidecar call, UPDATE sequence, error handling.

Verify: with sidecar up, freshly-inserted fires get `takeit_top_features` populated within one cron tick. Kill the sidecar; INSERTs still write prob; cron logs error; resume sidecar, queue drains within minutes.

### Phase 3e — GH Actions nightly retrain

Output: `ml/data/takeit/{alert_type}_classifier_v{ISO_DATE}.json` lands in Vercel Blob every Tue-Sat at 01:45 UTC. Cold-start `takeit-bundle-loader.ts` picks it up.

Files:

- `.github/workflows/ml-pipeline.yml` — add a new job `takeit-retrain` that runs after the existing pipeline:

```yaml
takeit-retrain:
  needs: pipeline
  runs-on: ubuntu-latest
  timeout-minutes: 30
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    BLOB_READ_WRITE_TOKEN: ${{ secrets.BLOB_READ_WRITE_TOKEN }}
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-python@v6
      with: { python-version: '3.14' }
    - run: pip install -e ml/
    - run: python -m ml.src.takeit.build_training_set
    - run: python -m ml.src.takeit.train
    - run: python -m ml.src.takeit.upload_to_blob
```

- `ml/src/takeit/upload_to_blob.py` — POSTs both bundles + a `latest.json` manifest pointer to the Blob private store using the `vercel-blob-rest` API (or via the `@vercel/blob` Python equivalent if needed; falls back to raw HTTPS PUT).
- `api/_lib/takeit-bundle-loader.ts` — reads `latest.json` first to pick the freshest version, then fetches the model bundle by URL.
- Sentry hook in `upload_to_blob.py` — alert if Brier on the new model > `BRIER_ALERT_THRESHOLD` (already in `ml/src/takeit/config.py`).

Verify: trigger workflow manually with `workflow_dispatch`, confirm new bundle lands in Blob, cold-start a Vercel function and confirm `takeit-bundle-loader` picks it up.

## Thresholds / Constants

```typescript
// api/_lib/takeit-score.ts
const BUNDLE_REFRESH_TTL_MS = 15 * 60 * 1000; // 15 min in-process cache
const PARITY_TOLERANCE = 1e-6; // TS vs Python max abs diff
const SHAP_FILL_CRON = '*/2 * * * *'; // every 2 min
const SHAP_FILL_BATCH_SIZE = 500; // per cron tick
const SHAP_FILL_LOOKBACK_MIN = 30; // don't bother filling old rows
```

```python
# ml/src/takeit/upload_to_blob.py
BLOB_PATH_TEMPLATE = "takeit/{alert_type}_classifier_v{iso_date}.json"
BLOB_MANIFEST_PATH = "takeit/latest.json"
```

## Resolved Decisions

1. **Bundle versioning:** **manifest.** Upload `takeit/{alert_type}_classifier_v{ISO_DATE}.json` (immutable, dated) + `takeit/latest.json` pointing to current versions. Rollback = edit `latest.json`.
2. **SHAP service location:** **sidecar/**, with **all SHAP code contained inside `sidecar/`** (no imports from `ml/src/takeit/`). The sidecar's `pyproject.toml` is the deployable artifact; vendor or duplicate the small amount of SHAP wrapper code needed. Add xgboost + shap to sidecar's requirements.
3. **Bundle-missing behaviour:** **fail-open with stale-cache fallback + Sentry alert.** First-ever cold start with no bundle → write `takeit_prob = NULL`, capture Sentry error. Subsequent refresh failures → keep stale in-process bundle, log Sentry warning. Hard requirement: every fail path emits a Sentry event so the operator notices.
4. **Backfill timing:** **Saturday (today), 1000-row batches + `LOCK_TIMEOUT 5s` + retry + `VACUUM (ANALYZE)` after.** Saturday evening avoids both market hours and the GH Actions retrain window (01:45 UTC Tue-Sat).
5. **Parity-test fixture:** **real-data sample.** Pull 50 random labeled fires from production once via a one-shot script; persist as `ml/tests/fixtures/takeit_parity_rows.parquet`. Fixture is input-only (feature columns); Python and TS each score these rows through the current bundle and must agree to 1e-6. Regenerate the fixture only when the feature set changes.
6. **XGBoost format pinning:** **bundle carries `xgb_json_schema` version.** TS loader asserts the field matches a hard-coded supported set; mismatch fails closed (refuses to load that bundle) with a Sentry alert. Silent miscompute is worse than visibly stuck.

## Out of Scope (v1)

- Replacing the heuristic `score` column with `takeit_prob` outright (explicit non-goal until 2 weeks of side-by-side data).
- Historical-analogs panel ("last 12 similar fires") — Phase 5+.
- Auto-suppression of low-prob alerts from the feed — explicitly rejected; score-only contract.

### Shipped after v1 (originally out-of-scope, then promoted)

- The UI tile / color bands — **Phase 4** shipped 2026-05-16 (`cb62ce62`); `src/components/TakeItScore/` renders `takeit_prob` chip with the spec decision #6 colour bands and the SHAP top-K positive/negative flag chips on every Lottery + Silent Boom row.
- Calibration drift monitoring + Sentry weekly metric — **Phase 5** shipped 2026-05-16 (`4aa24d05`); `api/cron/audit-takeit-calibration.ts` emits Brier / AUC / per-bucket residual distributions and pages on Brier > 0.27. Cron registered Monday 11:00 UTC.

## Risks

1. **TS vs Python parity drift.** Tree traversal in TS has edge cases around missing-value handling (XGBoost's `DEFAULT_LEFT` / `DEFAULT_RIGHT`) and float comparison at split thresholds (use `<=` not `<`, match XGBoost's `>=`). The 1e-6 parity test in Phase 3b is the only thing standing between "looks right" and "subtly wrong"; failures must block merge.
2. **Feature derivation drift at detect time.** The TS feature builder (`takeit-features.ts`) re-implements logic from the Python `derive_common_features`. Any divergence (e.g. timezone handling, ITM tie-breaker) shifts the scoring. Mitigation: same 50-fixture parity test cross-checks the feature objects byte-for-byte before scoring.
3. **Blob cold-start cost.** Vercel Fluid Compute amortizes cold starts but the first request after deploy pays the ~5-10 MB bundle fetch. Mitigation: prefetch via a warming cron, OR ship a stale-but-working fallback bundle baked into the deploy.
4. **Backfill creates dead tuples.** Updating 641K rows generates Postgres bloat. Mitigation: `VACUUM ANALYZE` both tables after backfill; pre-Neon-autoscale check.
5. **SHAP sidecar latency.** If the 2-min cron falls behind (sidecar slow, lots of new fires), `takeit_top_features` can stay NULL for the freshest rows. Mitigation: cron processes newest-first; UI can render with prob only and flag "flags loading" if features absent. Phase 4 picks this up.

## Effort Estimate

- Phase 3a: ~3 hr (migration + Python export)
- Phase 3b: ~6 hr (TS scorer + Blob loader + parity test — the heart of Phase 3)
- Phase 3c: ~4 hr (cron wiring + backfill script)
- Phase 3d: ~3 hr (SHAP fill cron + sidecar endpoint)
- Phase 3e: ~2 hr (GH Actions workflow update)

Total: ~18 hr if everything goes smoothly. Realistic with debugging + parity-test thrash: 24-30 hr spread over 2-3 sessions.
