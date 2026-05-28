# TAKE-IT Reliability Hardening — Design

**Date:** 2026-05-28
**Status:** Draft (awaiting user review)
**Origin:** The gate-exemption shipped 2026-05-27 ([spec](2026-05-27-takeit-conditioned-gate-fix-design.md))
makes TAKE-IT load-bearing for `score_tier` decisions in production. Failure
modes that were merely cosmetic before (e.g. a brief Blob outage producing
null `takeit_prob`) now silently affect which alerts surface at their real
tier. This spec hardens the system against those failure modes — defensively
(reject bad inputs and bundles early), operationally (make every silent
failure loud the next morning), and analytically (catch model decay before
the live edge does).

## Goal

Make TAKE-IT scoring robust against operational outages, data-pipeline
drift, and slow model decay — WITHOUT touching the trained model itself.
Four phases. The first three share a daily-cron + Sentry-alert backbone
and one new `takeit_health_daily` Postgres table. The fourth is a
one-shot backfill tool that populates `takeit_prob` on historical rows
so retrospective ML analysis (and the eventual realized-target retrain)
have a complete prediction series to work against.

## Out of scope (deliberate; tracked as follow-up)

- **Retraining on a realized-with-stop label.** The current peak-target model
  has months of live history, ranks moonshots monotonically, and the
  gate-exemption built on it has out-of-sample evidence (META 5/27). Swapping
  the model now would replace a known-working component with an unvalidated
  one. The right path is a SHADOW model (score every row with both, compare
  downstream realized outcomes for N days, only flip the gate threshold if
  the realized-target model materially outperforms). Both the realized
  retrain and the champion/challenger plumbing it needs are tracked for a
  follow-up spec.
- **Ensemble / multi-seed bundle.** Variance reduction is real but it's a
  retraining-side change; defer with the above.
- **Bundle embedded in git instead of Blob.** Would eliminate the Blob
  availability failure mode entirely but couples model cadence to deploy
  cadence; revisit once we know how often retrains actually ship.

---

## Phase 1 — Defensive scoring + bundle reliability

The most direct production-risk reduction. Ships first.

### 1.1 Schema-validated bundle load (fail-closed)

`loadTakeitDetectContext()` today fetches the bundle JSON from Vercel Blob,
trusts the shape, and returns null on any failure (fail-open). After:

- Validate the JSON via a Zod schema on load: tree count > 0, calibration
  array length matches expected, every expected feature name present, no
  unexpected null fields. Schema lives in `api/_lib/takeit-bundle-schema.ts`.
- On validation failure: throw with a structured `BundleValidationError`,
  Sentry-capture the error with the bundle version + offending field.
- On Blob fetch failure: retry 2× with backoff (200ms, 800ms). If still
  failing AND a previously-validated bundle exists in module-scope memory,
  fall back to it AND Sentry-warn ("stale bundle in use, age = Xms"). If no
  cached bundle exists, throw.
- Net effect: a transient Blob blip uses the warm cache; a malformed
  upload is rejected before any row gets scored against it.

### 1.2 Active-bundle pointer in Blob (rollback lever)

Today the bundle URL is hardcoded. After:

- A `bundles/active.json` pointer file in Blob contains
  `{ "lottery": "<blob_url>", "silent_boom": "<blob_url>", "promoted_at": "..." }`.
- `loadTakeitDetectContext()` reads the pointer first, then fetches the
  named bundles. The pointer file is small and cached aggressively.
- Rollback procedure: `make takeit-rollback BUNDLE=<url>` (or the equivalent
  Makefile-idiomatic invocation — wire to whatever the existing Makefile
  patterns look like). The Make target invokes a small Node script
  `scripts/takeit-rollback.mjs` that uses `@vercel/blob` to read the
  current `bundles/active.json`, swap the named bundle URL, and re-upload.
  New cron invocations pick it up within one cycle (≤ 5 min).
- The script also supports `make takeit-rollback` with no arguments to
  print the current active.json contents (no-op read) — used to confirm
  what's live before flipping.
- Document the rollback in `docs/runbooks/takeit-rollback.md` (new) — the
  spec, the Make target usage, and where to find prior bundle URLs in
  Blob's UI.

### 1.3 NaN/Infinity guards inside scoring

`scoreLottery` / `scoreSilentBoom` today coerce input fields blindly. After:

- A pure helper `sanitizeScoringInputs(row)` in `api/_lib/takeit-detect.ts`
  validates every numeric feature: `Number.isFinite(value)` required, else
  return `{ prob: null, version: bundle.version, features: null }` without
  invoking the model. Sentry-warn at INFO level with the row's
  `option_chain_id` so we can backtrack what's emitting bad data.
- Categorical features (`score_tier`, `mode`, etc.) validated against the
  bundle's known categories; unknown category → same null-prob fallback.

### Files (Phase 1)

- Create: `api/_lib/takeit-bundle-schema.ts`
- Modify: `api/_lib/takeit-bundle-loader.ts`, `api/_lib/takeit-detect.ts`,
  `api/_lib/takeit-score.ts`
- Test: `api/__tests__/takeit-bundle-loader.test.ts` (extend),
  `api/__tests__/takeit-detect-sanitize.test.ts` (new)
- Create: `scripts/takeit-rollback.mjs` (the Node script the Makefile invokes)
- Modify: the project `Makefile` — add `takeit-rollback` target
- Create: `docs/runbooks/takeit-rollback.md`

---

## Phase 2 — Operational health monitor (TS cron + Sentry)

A new daily cron makes Phase 1's defenses visible. Ships second.

### 2.1 New cron: `cron/audit-takeit-health`

- Schedule: once per day at 23:30 UTC (18:30 CT, after EOD settles).
- Reads yesterday's `lottery_finder_fires` + `silent_boom_alerts`.
- Per feed, computes:
  - `null_rate_pct` — % rows with `takeit_prob IS NULL`
  - `prob_p10, prob_p50, prob_p90, prob_p99` — score distribution percentiles
  - `bundle_versions_seen` — distinct `takeit_model_version` values
  - `rows_scored` — denominator for the above
- Compares each to a trailing 30-day baseline. Alerts to Sentry if:
  - `null_rate_pct > 5%` AND > 2σ above baseline (catches Blob/bundle issues)
  - `prob_p50` shifts > 0.05 from baseline (catches distribution drift)
  - `bundle_versions_seen > 1` (catches mid-day model swaps that shouldn't happen)
- Writes a row to `takeit_health_daily` for trend tracking.

### 2.2 New table: `takeit_health_daily`

```sql
CREATE TABLE takeit_health_daily (
  id              SERIAL PRIMARY KEY,
  date            DATE NOT NULL,
  feed            VARCHAR(20) NOT NULL CHECK (feed IN ('lottery', 'silent_boom')),
  metric_name     VARCHAR(60) NOT NULL,
  metric_value    NUMERIC,
  baseline_value  NUMERIC,
  threshold       NUMERIC,
  alert_fired     BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (date, feed, metric_name)
);
CREATE INDEX takeit_health_daily_date_idx ON takeit_health_daily(date DESC);
```

Owned by Phase 2 + 3 (both write to it). One row per (date, feed, metric).

### Files (Phase 2)

- Create: `api/cron/audit-takeit-health.ts`
- Create: `api/__tests__/audit-takeit-health.test.ts`
- Modify: `api/_lib/db-migrations.ts` (add the new table migration)
- Modify: `api/__tests__/db.test.ts` (mock the new migration)
- Modify: `vercel.json` (register the cron)

---

## Phase 3 — ML drift + validation (Python, folded into `make nightly-update`)

The deeper analytical layer. Ships last; depends on Phase 2's
`takeit_health_daily` table existing. NOT a standalone cron — folded into
the user's existing `make nightly-update` workflow so outputs commit
alongside the other nightly artifacts (lottery score-weights, ML plots).

### 3.1 New module: `ml/src/takeit_drift_monitor.py`

Invoked from `make nightly-update` (the existing target the user runs each
night). Queries Neon directly via psycopg2 (the same pattern `ml/` already
uses for its other steps).

For each feed, computes:

- **Rolling AUC** — 7d and 30d AUC of `takeit_prob` vs the training target
  (`peak_ceiling_pct >= 20`). Captures gradual decay. Also computes 7d/30d
  AUC vs `realized_trail30_10_pct >= 0` as a secondary signal (this is what
  the gate exemption ultimately cares about; informs the deferred
  realized-target retrain decision). The peak-vs-realized AUC divergence
  is itself a tracked metric — when those two AUCs separate by more than
  ~0.05 sustained over 30 days, that's the empirical case for revisiting
  the realized-target retrain.
- **Calibration / reliability** — bin predictions into deciles, compare
  predicted vs actual rate per bin. Plot as a reliability diagram saved to
  `ml/plots/takeit-drift/reliability_<feed>_<date>.png` (tracked in git per
  repo convention).
- **Per-segment AUC** — break out by ticker_class (ETF / mega_cap /
  single_stock), DTE bucket (0DTE / 1–3 / 4+), mode (A / B), TOD, and
  cluster_member (suspiciousCluster true/false). Alert if any segment's
  30d AUC < 0.55 over a sample size > N=100.
- **Feature distribution z-scores** — for each input feature, mean/std/
  null-rate vs trailing 30d baseline. Alert on |z| > 3.
- **Top-K SHAP feature stability** — top-5 SHAP features for the current
  bundle scored on a recent sample; alert if top-3 changes ≥ 2 positions
  month-over-month.

Outputs (all committed by the existing `make nightly-update` git step):

- A daily markdown report `ml/output/takeit-drift/<date>.md` — one row per
  metric per feed, with prior-baseline + delta + threshold + pass/fail.
- A rolling summary `ml/output/takeit-drift/_rolling.md` — last 30 days at
  a glance; replaces in place each run.
- Reliability diagram PNGs in `ml/plots/takeit-drift/`.
- Threshold-breach rows appended to `takeit_health_daily` (same table as
  Phase 2; metric_name prefixed with `ml_`). The script writes to Neon
  using the same psycopg2 connection it already opens for reads.
- Sentry alerts on any breach, fired directly from the Python script via
  the existing Sentry SDK already used in the `ml/` pipeline.

### 3.2 Makefile integration

Add the script to the existing `nightly-update` target (or whatever the
user's current Make target is named — re-read the project `Makefile`
before adding). Position AFTER the retrain step (so the drift monitor
scores against the freshly-promoted bundle) but BEFORE the git-commit
step (so the outputs end up in the same commit as the other nightly
artifacts).

If the user has separate Make targets for the different ML steps, the
drift monitor gets its own target (`make takeit-drift`) AND a call from
`nightly-update`. That way it can be re-run standalone if needed without
re-doing the full nightly cycle.

### Files (Phase 3)

- Create: `ml/src/takeit_drift_monitor.py`
- Modify: the project `Makefile` — add (or fold into) the nightly target
- Output dirs (committed alongside other nightly artifacts):
  `ml/output/takeit-drift/`, `ml/plots/takeit-drift/`

---

---

## Phase 4 — Backfill historical TAKE-IT scores (one-shot tool)

Independent of Phases 2/3 but depends on Phase 1's defensive scoring (so
the backfill doesn't crash mid-run on a NaN feature). Re-runnable
whenever a meaningfully-different bundle ships and you want consistent
historical scores against it.

### 4.1 Why

The `takeit_prob` column was added in a Phase-3c migration; rows inserted
before TAKE-IT went live have `takeit_prob IS NULL`. ML training and
retrospective analysis (cohort comparisons, threshold validation, the
eventual realized-target retrain experiments) need a consistent score
across the full history, not just rows that happened to be inserted
after the column landed.

### 4.2 Approach

- **Snapshot-time bundle, not as-of bundle.** Score every NULL-takeit row
  with the CURRENTLY-active bundle (whatever `bundles/active.json` points
  to). This gives a consistent baseline across history — "what today's
  model would have predicted on past data." An as-of approach (different
  bundle per row's date) is more historically faithful but much more
  complex and doesn't actually help ML training, which wants a consistent
  prediction series.
- **TS implementation, not Python.** Reuses `scoreLottery` /
  `scoreSilentBoom` from `api/_lib/takeit-detect.ts` directly. Same code
  path as production; eliminates the parity-drift risk that a second
  Python implementation would introduce (the existing
  `takeit-score.parity.test.ts` exists for exactly this concern).
- **Idempotent + resumable.** `WHERE takeit_prob IS NULL` makes it safe
  to re-run after interruption. Batches of 1000–5000 rows with COMMIT
  between batches so a crash doesn't lose all progress.
- **Off-hours.** Run outside market hours to avoid sharing DB capacity
  with the detect crons (no row contention either way since backfill
  only touches historical rows, but Neon connection pressure is
  considerate).
- **Genuinely-unscoreable rows stay NULL.** Pre-migration rows missing
  required features (gex_*, spot_at_trigger, etc.) trip the Phase 1.3
  NaN/null guard and produce `prob: null`. Those stay NULL and are
  tallied in the run summary. No Sentry flood — write counts to a local
  log file, summarize at end.
- **Bundle version stamped.** `takeit_model_version` gets written
  alongside `takeit_prob` so future queries can tell which model
  produced each historical score.

### 4.3 Files

- Create: `scripts/backfill-takeit-scores.mjs` (Node, uses the production
  scoring helpers + `@neondatabase/serverless`)
- Modify: the project `Makefile` — add `takeit-backfill` target. Support
  optional flags: `FEED=lottery|silent_boom|both`, `SINCE=YYYY-MM-DD`,
  `LIMIT=N` (for testing).
- Output: `scripts/output/backfill-takeit-<run-id>.log` — per-batch row
  counts, NULL-result tallies, total runtime, bundle version used.

### 4.4 Time / cost estimate

- ~660k lottery fires + ~65k silent-boom alerts ≈ 725k rows total. Subset
  with `takeit_prob IS NULL` is probably 200k–400k depending on when the
  Phase-3c migration landed.
- Per-row cost: ~5ms scoring + ~1ms DB round-trip in batches. With 2000
  per batch and per-batch overhead, ballpark 30–90 minutes total for a
  full backfill.
- Idempotent re-runs against the same bundle: ~0 (everything has
  `takeit_prob` set, predicate short-circuits the WHERE).

---

## Data dependencies

- One new table: `takeit_health_daily` (Phase 2 migration; Phase 3 writes
  to the same table).
- One new Blob file: `bundles/active.json` (pointer for rollback; Phase 1).
- No new env vars. No new external APIs.

## Thresholds / constants

Starting values; refine after the first 30 days of live `takeit_health_daily`
data. Defined as constants in one place per phase:

- `NULL_RATE_ALERT_PCT = 5.0`
- `PROB_P50_DRIFT_MAX = 0.05` (score median shift vs 30d baseline)
- `BUNDLE_VERSION_MAX_PER_DAY = 1`
- `ROLLING_AUC_DROP_MAX = 0.05` (alert if 30d AUC < training AUC − 0.05)
- `PER_SEGMENT_AUC_MIN = 0.55` (with sample size > 100)
- `FEATURE_Z_ALERT = 3.0`
- `SHAP_RESHUFFLE_TOP3_MAX = 1` (positions changed month-over-month)
- Bundle-load retries: `2`, backoff `200ms / 800ms`.

## Decisions resolved (was: open questions)

1. **Rollback mechanism — Makefile target.** A `make takeit-rollback`
   target wrapping a Node script `scripts/takeit-rollback.mjs` (uses
   `@vercel/blob`). Matches the project's existing `make`-driven workflow.
2. **NaN-guard reject rate as a tracked metric — yes.** Recorded as
   `sanitize_rejected_pct` per feed per day in `takeit_health_daily` by
   the Phase 2 cron.
3. **Calibration target for Phase 3 — both peak AND realized.** Track 7d/
   30d AUC against both `peak_ceiling_pct >= 20` (the training target)
   and `realized_trail30_10_pct >= 0` (the trade-worthiness target).
   Their divergence is itself a tracked metric and the empirical case
   for revisiting the realized-target retrain later.
4. **Phase 3 cadence — folded into `make nightly-update`, not GH Actions.**
   Outputs commit alongside the other nightly ML artifacts. No standalone
   workflow.

## Remaining open questions

1. **Does Phase 2 cron need its own CRON_SECRET path?** Default: yes,
   reuse `CRON_SECRET` like the other crons.

## Non-goals

- No change to the trained TAKE-IT model.
- No change to the gate-exemption logic.
- No frontend changes (the health-monitor output is back-office only).
- No new env vars or external integrations.
