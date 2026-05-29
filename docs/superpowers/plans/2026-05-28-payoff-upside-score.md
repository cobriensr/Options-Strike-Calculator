# Payoff / "Upside" Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Upside" score — a regression model predicting trade magnitude (`log1p(peak_ceiling_pct)`) plus a P90 moonshot head — that complements the take-it `P(win)` classifier, surfaced as a PRIME/MOONSHOT/GRIND/SKIP quadrant + "expected peak" chip on Lottery and Silent Boom alerts.

**Architecture:** Mirror the take-it pipeline exactly: XGBoost trained in `ml/`, exported as a JSON bundle to Vercel Blob, scored in pure TypeScript via tree traversal with a build-blocking parity gate, computed inline in the detect crons, stored on the fire tables, retrained weekly via GH Actions. The only model-level difference from take-it is the activation: take-it does `sigmoid → isotonic`; payoff does raw `Σtrees` in log1p space → `expm1`. Two independent models (Lottery + Silent Boom). Feature engineering is reused wholesale from take-it — payoff sees the identical point-in-time vector.

**Tech Stack:** Python 3 + XGBoost + scikit-learn (`ml/.venv`), TypeScript (Vercel Functions, Node 24), Neon Postgres, Vercel Blob, React 19 + Tailwind 4, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-05-28-payoff-upside-score-design.md`

**Canonical files to clone/mirror** (read these before starting each phase — they are the source of truth for the pattern):
- `ml/src/takeit/{config,build_training_set,train,export_model,generate_parity_fixture}.py`
- `api/_lib/{takeit-score,takeit-features,takeit-bundle-loader,takeit-bundle-schema}.ts`
- `api/__tests__/takeit-score.parity.test.ts`
- `api/cron/{detect-lottery-fires,detect-silent-boom,audit-takeit-calibration,audit-takeit-health}.ts`
- `src/components/TakeItScore/{TakeItScore.tsx,takeit-prob-class.ts}`
- `api/_lib/db-migrations.ts` (latest migration id) + `api/__tests__/db.test.ts`
- `scripts/{upload_takeit_bundles.mjs,backfill-takeit-scores.mjs}`

---

## ⛔ Phase 0 — Re-probe gate (GO/NO-GO; ~mid-June 2026, batch with 2026-06-16 GexBot re-probe)

Do NOT start Phase 1 until this passes. The 2026-05-28 EDA rested on ~8 days of `takeit_features`; this phase confirms the model is strong on a real window.

### Task 0: Re-run the payoff EDA probe on 30+ days of features

**Files:**
- Modify: `ml/src/payoff_eda_probe.py` (already exists from the 2026-05-28 probe)

- [ ] **Step 1: Run the probe against current data**

Run: `ml/.venv/bin/python ml/src/payoff_eda_probe.py`
Expected: same report sections A–E as the 2026-05-28 run, now over ≥30 days of `takeit_features` history with a proper time-ordered walk-forward split.

- [ ] **Step 2: Apply the go/no-go gate**

GO criteria (all must hold):
- Lottery `log1p(peak)` out-of-sample **Spearman > 0.35** on the walk-forward test split.
- Orthogonality holds: take-it eta² on peak still ≤ ~15% (i.e. payoff still mostly residual).
- Feature-driver split still distinct (structure/time for payoff vs flow/macro for take-it).

If GO: record the observed quadrant cutoffs (trailing-cohort median predicted peak per table) and proceed to Task 1.
If NO-GO: stop, write findings to `docs/tmp/`, and update `memory/project_payoff_orthogonal_to_takeit.md`.

- [ ] **Step 3: Commit the re-probe results**

```bash
git add ml/src/payoff_eda_probe.py ml/plots/payoff_eda_*.png
git commit -m "chore(payoff): re-probe on 30+ day feature window — GO/NO-GO gate"
```

---

## Phase 1 — ML training pipeline (`ml/` only — no review subagent required per CLAUDE.md)

Clone `ml/src/takeit/` → `ml/src/payoff/`. Each file is the take-it equivalent with the label and objective changed. Tests mirror `ml/tests/test_takeit_*.py`.

### Task 1: Payoff config

**Files:**
- Create: `ml/src/payoff/config.py`
- Create: `ml/src/payoff/__init__.py` (empty)
- Test: `ml/tests/test_payoff_config.py`

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_payoff_config.py
from payoff import config

def test_target_is_log1p_peak():
    assert config.TARGET_COLUMN == "peak_ceiling_pct"
    assert config.TARGET_TRANSFORM == "log1p"

def test_two_model_keys():
    assert set(config.MODEL_KEYS) == {"lottery", "silent_boom"}

def test_quantile_head_alpha():
    assert config.P90_QUANTILE_ALPHA == 0.9

def test_objective_is_regression():
    assert config.MEAN_PARAMS["objective"] == "reg:squarederror"
    assert config.P90_PARAMS["objective"] == "reg:quantileerror"
    assert config.P90_PARAMS["quantile_alpha"] == 0.9
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'payoff'`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/payoff/config.py
"""Shared constants for the payoff (Upside) regression model.

Mirrors ml/src/takeit/config.py. Only the label/objective differ:
take-it classifies P(peak >= 20%); payoff regresses log1p(peak).
"""

TARGET_COLUMN = "peak_ceiling_pct"
TARGET_TRANSFORM = "log1p"  # train on log1p(peak); back-transform with expm1 at serve time
MODEL_KEYS = ("lottery", "silent_boom")
P90_QUANTILE_ALPHA = 0.9

# Clone take-it hyperparameters (ml/src/takeit/config.py); swap objective.
MEAN_PARAMS = {
    "objective": "reg:squarederror",
    "n_estimators": 300,
    "max_depth": 5,
    "learning_rate": 0.05,
    "min_child_weight": 50,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
}

P90_PARAMS = {
    **MEAN_PARAMS,
    "objective": "reg:quantileerror",
    "quantile_alpha": 0.9,
}

# GO gate from Phase 0 re-probe (spec §Thresholds).
MIN_SPEARMAN_TO_SHIP = 0.35
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_config.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/payoff/config.py ml/src/payoff/__init__.py ml/tests/test_payoff_config.py
git commit -m "feat(payoff-ml): config — log1p(peak) target + reg objectives"
```

### Task 2: Training-set builder

**Files:**
- Create: `ml/src/payoff/build_training_set.py`
- Test: `ml/tests/test_payoff_build_training_set.py`

- [ ] **Step 1: Read the take-it builder**

Read `ml/src/takeit/build_training_set.py` in full. It: connects to Neon via `DATABASE_URL`, loads enriched alert rows + their `takeit_features` JSONB, derives the feature matrix `X`, and computes the binary label `y = (peak_ceiling_pct >= 20)`.

- [ ] **Step 2: Write the failing test**

```python
# ml/tests/test_payoff_build_training_set.py
import numpy as np
import pandas as pd
from payoff import build_training_set as bts

def test_target_is_log1p_of_peak():
    df = pd.DataFrame({"peak_ceiling_pct": [0.0, 20.0, 100.0]})
    y = bts.compute_target(df)
    np.testing.assert_allclose(y, np.log1p([0.0, 20.0, 100.0]))

def test_drops_rows_with_null_peak():
    df = pd.DataFrame({"peak_ceiling_pct": [10.0, None, 30.0]})
    kept = bts.filter_trainable(df)
    assert len(kept) == 2

def test_features_exclude_any_outcome_column():
    # No realized/peak/minutes_to_peak column may appear in the feature matrix.
    cols = bts.feature_columns()
    banned = ("peak_ceiling_pct", "minutes_to_peak", "realized")
    assert not any(b in c for c in cols for b in banned)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_build_training_set.py -v`
Expected: FAIL — module/functions not defined.

- [ ] **Step 4: Implement by cloning the take-it builder**

Clone `ml/src/takeit/build_training_set.py`. Make exactly these changes:
- Replace the binary label with `compute_target(df) -> np.ndarray` returning `np.log1p(df[config.TARGET_COLUMN].to_numpy())`.
- Add `filter_trainable(df)` dropping rows where `peak_ceiling_pct` is null (it is non-null for enriched rows, but guard anyway).
- Reuse the take-it feature assembly verbatim (`feature_columns()` and the JSONB parsing) — payoff uses the **same** `takeit_features` vector. Re-export or import the take-it feature list rather than copying it, to stay DRY.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_build_training_set.py -v`
Expected: PASS (3 passed)

- [ ] **Step 6: Commit**

```bash
git add ml/src/payoff/build_training_set.py ml/tests/test_payoff_build_training_set.py
git commit -m "feat(payoff-ml): training-set builder on log1p(peak)"
```

### Task 3: Trainer (mean + P90 heads, walk-forward)

**Files:**
- Create: `ml/src/payoff/train.py`
- Test: `ml/tests/test_payoff_train.py`

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_payoff_train.py
import numpy as np
from payoff import train

def _toy():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(400, 6))
    # target correlated with X[:,0] so the model can learn something
    y = np.log1p(np.clip(50 + 40 * X[:, 0] + rng.normal(size=400) * 5, 0, None))
    return X, y

def test_mean_head_beats_mean_baseline_spearman():
    X, y = _toy()
    res = train.fit_and_eval(X, y, alpha=None)  # mean head
    assert res["test_spearman"] > 0.3

def test_p90_head_trains_and_predicts_above_mean():
    X, y = _toy()
    res = train.fit_and_eval(X, y, alpha=0.9)  # quantile head
    assert res["predictions"].shape[0] > 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_train.py -v`
Expected: FAIL — `train.fit_and_eval` not defined.

- [ ] **Step 3: Implement by cloning the take-it trainer**

Clone `ml/src/takeit/train.py`. Changes:
- Use `XGBRegressor` (not classifier). `fit_and_eval(X, y, alpha)` returns `{"model", "predictions", "test_spearman", "test_pinball"}` — use `config.MEAN_PARAMS` when `alpha is None`, else `config.P90_PARAMS`.
- Replace AUC/Brier reporting with `scipy.stats.spearmanr` on the test split and `sklearn.metrics.mean_pinball_loss` for the quantile head.
- Keep the take-it time-ordered walk-forward split logic (split by date, not random).
- Drop isotonic calibration entirely (regression needs none).
- Train **both** heads per model key; persist both for export.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_train.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/payoff/train.py ml/tests/test_payoff_train.py
git commit -m "feat(payoff-ml): trainer — mean + P90 quantile heads, walk-forward Spearman/pinball"
```

### Task 4: Bundle exporter + parity fixture

**Files:**
- Create: `ml/src/payoff/export_model.py`
- Create: `ml/src/payoff/generate_parity_fixture.py`
- Test: `ml/tests/test_payoff_export.py`

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_payoff_export.py
import numpy as np
from payoff import train, export_model

def test_bundle_roundtrip_matches_python():
    rng = np.random.default_rng(1)
    X = rng.normal(size=(300, 6))
    y = np.log1p(np.clip(50 + 30 * X[:, 0] + rng.normal(size=300) * 5, 0, None))
    mean = train.fit_and_eval(X, y, alpha=None)["model"]
    bundle = export_model.to_bundle(mean_model=mean, p90_model=mean, feature_names=[f"f{i}" for i in range(6)])
    # Re-scoring via the bundle's own predictor must match XGBoost to 1e-12 (Python-side)
    py = mean.predict(X)
    rt = export_model.score_bundle(bundle, X)
    np.testing.assert_allclose(rt, py, atol=1e-12)

def test_bundle_has_both_heads_and_no_isotonic():
    bundle = export_model.empty_bundle()
    assert "mean_trees" in bundle and "p90_trees" in bundle
    assert "isotonic" not in bundle
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_export.py -v`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement by cloning the take-it exporter**

Clone `ml/src/takeit/export_model.py`. Changes:
- Bundle schema: `{ model_version, feature_names, mean_base, mean_trees, p90_base, p90_trees }`. **No** `isotonic` block.
- `score_bundle(bundle, X)` = `mean_base + Σ tree.predict` (raw, log1p space) — used by the round-trip parity test.
- `generate_parity_fixture.py`: clone the take-it fixture generator; emit 50 rows + expected raw `mean_pred` and `p90_pred` to `ml/fixtures/payoff_parity.json` (consumed by the TS parity gate in Task 6).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ml && .venv/bin/python -m pytest tests/test_payoff_export.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/payoff/export_model.py ml/src/payoff/generate_parity_fixture.py ml/tests/test_payoff_export.py
git commit -m "feat(payoff-ml): bundle export (mean+P90, no isotonic) + parity fixture"
```

---

## Phase 2 — TypeScript scorer + quadrant (api/_lib) — full Get It Right loop

### Task 5: Bundle schema + loader

**Files:**
- Create: `api/_lib/payoff-bundle-schema.ts`
- Create: `api/_lib/payoff-bundle-loader.ts`
- Test: `api/__tests__/payoff-bundle-schema.test.ts`, `api/__tests__/payoff-bundle-loader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/__tests__/payoff-bundle-schema.test.ts
import { describe, it, expect } from 'vitest';
import { parsePayoffBundle } from '../_lib/payoff-bundle-schema';

describe('parsePayoffBundle', () => {
  it('accepts a bundle with both heads', () => {
    const b = parsePayoffBundle({
      model_version: 'p1',
      feature_names: ['a'],
      mean_base: 0.1,
      mean_trees: [],
      p90_base: 0.2,
      p90_trees: [],
    });
    expect(b.model_version).toBe('p1');
  });

  it('rejects a bundle missing the p90 head', () => {
    expect(() =>
      parsePayoffBundle({ model_version: 'p1', feature_names: ['a'], mean_base: 0, mean_trees: [] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/payoff-bundle-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement by cloning the take-it schema + loader**

Clone `api/_lib/takeit-bundle-schema.ts` → `payoff-bundle-schema.ts`: a Zod schema with `mean_base/mean_trees/p90_base/p90_trees`, **no** isotonic block. Export `parsePayoffBundle` AND the inferred `export type PayoffBundle = z.infer<typeof ...>` (imported by `payoff-score.ts` in Task 6).
Clone `api/_lib/takeit-bundle-loader.ts` → `payoff-bundle-loader.ts`: same Vercel Blob fetch + in-process cache; point at the payoff Blob keys (`payoff/lottery.json`, `payoff/silent_boom.json`). Fail-open: loader returns `null` if the fetch fails (caller stores NULL columns).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/payoff-bundle-schema.test.ts api/__tests__/payoff-bundle-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/_lib/payoff-bundle-schema.ts api/_lib/payoff-bundle-loader.ts api/__tests__/payoff-bundle-schema.test.ts api/__tests__/payoff-bundle-loader.test.ts
git commit -m "feat(payoff): bundle schema + Blob loader (fail-open)"
```

### Task 6: TS scorer + parity gate (the critical task)

**Files:**
- Create: `api/_lib/payoff-features.ts`
- Create: `api/_lib/payoff-score.ts`
- Test: `api/__tests__/payoff-score.parity.test.ts`

- [ ] **Step 1: Write the failing parity test (the build-blocking gate)**

```typescript
// api/__tests__/payoff-score.parity.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { computePayoffRaw } from '../_lib/payoff-score';

// Fixture emitted by ml/src/payoff/generate_parity_fixture.py
const fixture = JSON.parse(readFileSync('ml/fixtures/payoff_parity.json', 'utf8')) as {
  bundle: unknown;
  rows: { features: Record<string, number>; mean_pred: number; p90_pred: number }[];
};

describe('payoff scorer parity with Python', () => {
  it('matches mean + p90 predictions to 1e-6', () => {
    for (const row of fixture.rows) {
      const out = computePayoffRaw(fixture.bundle as never, row.features);
      expect(Math.abs(out.meanRaw - row.mean_pred)).toBeLessThan(1e-6);
      expect(Math.abs(out.p90Raw - row.p90_pred)).toBeLessThan(1e-6);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/payoff-score.parity.test.ts`
Expected: FAIL — `computePayoffRaw` not defined (and fixture must exist from Task 4).

- [ ] **Step 3: Implement the scorer**

`api/_lib/payoff-features.ts` — re-export the take-it feature builder so the vectors are identical:

```typescript
// api/_lib/payoff-features.ts
// Payoff uses the IDENTICAL point-in-time feature vector as take-it.
// Re-export to guarantee they never drift apart.
export {
  buildLotteryFeatures,
  buildSilentBoomFeatures,
  type LotteryAlertRow,
  type SilentBoomAlertRow,
} from './takeit-features.js';
```

`api/_lib/payoff-score.ts` — clone the tree-traversal core from `api/_lib/takeit-score.ts` (the `predictTree`, `default_left` NaN routing, and `Math.fround` float32 quantization are copied **verbatim** — they must byte-match). The ONLY differences:
- Two ensembles (`mean_trees`, `p90_trees`) instead of one.
- **No sigmoid, no isotonic.** Raw output stays in log1p space.

```typescript
// api/_lib/payoff-score.ts (new public surface; tree-walk internals copied from takeit-score.ts)
import type { PayoffBundle } from './payoff-bundle-schema.js';

export interface PayoffRaw {
  meanRaw: number; // log1p space
  p90Raw: number; // log1p space
}

export interface PayoffScore {
  expectedPeakPct: number; // expm1(meanRaw)
  p90PeakPct: number; // expm1(p90Raw)
  modelVersion: string;
}

// computePayoffRaw walks both ensembles using the SAME tree-traversal helper
// copied verbatim from takeit-score.ts (float32 fround + default_left routing).
export function computePayoffRaw(bundle: PayoffBundle, features: Record<string, number>): PayoffRaw {
  const meanRaw = bundle.mean_base + sumTrees(bundle.mean_trees, bundle.feature_names, features);
  const p90Raw = bundle.p90_base + sumTrees(bundle.p90_trees, bundle.feature_names, features);
  return { meanRaw, p90Raw };
}

export function computePayoffScore(bundle: PayoffBundle, features: Record<string, number>): PayoffScore {
  const { meanRaw, p90Raw } = computePayoffRaw(bundle, features);
  return {
    expectedPeakPct: Math.expm1(meanRaw),
    p90PeakPct: Math.expm1(p90Raw),
    modelVersion: bundle.model_version,
  };
}

// sumTrees + predictTree: copy verbatim from api/_lib/takeit-score.ts (do NOT re-derive).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/payoff-score.parity.test.ts`
Expected: PASS — all 50 fixture rows within 1e-6.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/payoff-features.ts api/_lib/payoff-score.ts api/__tests__/payoff-score.parity.test.ts
git commit -m "feat(payoff): TS regression scorer + parity gate (1e-6 vs Python)"
```

### Task 7: Quadrant mapping

**Files:**
- Create: `api/_lib/payoff-quadrant.ts`
- Test: `api/__tests__/payoff-quadrant.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/__tests__/payoff-quadrant.test.ts
import { describe, it, expect } from 'vitest';
import { classifyQuadrant } from '../_lib/payoff-quadrant';

const cuts = { probHigh: 0.55, payoffHighPct: 50 };

describe('classifyQuadrant', () => {
  it('PRIME = high prob + high payoff', () => {
    expect(classifyQuadrant(0.8, 120, cuts)).toBe('PRIME');
  });
  it('MOONSHOT = low prob + high payoff', () => {
    expect(classifyQuadrant(0.3, 120, cuts)).toBe('MOONSHOT');
  });
  it('GRIND = high prob + low payoff', () => {
    expect(classifyQuadrant(0.8, 20, cuts)).toBe('GRIND');
  });
  it('SKIP = low prob + low payoff', () => {
    expect(classifyQuadrant(0.3, 20, cuts)).toBe('SKIP');
  });
  it('returns null when either input is null', () => {
    expect(classifyQuadrant(null, 120, cuts)).toBeNull();
    expect(classifyQuadrant(0.8, null, cuts)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/payoff-quadrant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// api/_lib/payoff-quadrant.ts
export type Quadrant = 'PRIME' | 'MOONSHOT' | 'GRIND' | 'SKIP';

export interface QuadrantCuts {
  probHigh: number; // take-it prob split (provisional 0.55; tuned at re-probe)
  payoffHighPct: number; // expected-peak split = trailing-cohort median (provisional 50)
}

export function classifyQuadrant(
  takeitProb: number | null,
  expectedPeakPct: number | null,
  cuts: QuadrantCuts,
): Quadrant | null {
  if (takeitProb == null || expectedPeakPct == null) return null;
  const highProb = takeitProb >= cuts.probHigh;
  const highPayoff = expectedPeakPct >= cuts.payoffHighPct;
  if (highProb && highPayoff) return 'PRIME';
  if (!highProb && highPayoff) return 'MOONSHOT';
  if (highProb && !highPayoff) return 'GRIND';
  return 'SKIP';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/payoff-quadrant.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add api/_lib/payoff-quadrant.ts api/__tests__/payoff-quadrant.test.ts
git commit -m "feat(payoff): quadrant mapping (PRIME/MOONSHOT/GRIND/SKIP)"
```

### Task 8: Phase 2 review

- [ ] **Step 1: Run the full pipeline**

Run: `npm run review`
Expected: tsc + eslint + prettier + vitest all green. Fix any failures.

- [ ] **Step 2: Code-reviewer subagent**

Launch the `code-reviewer` agent on the Phase 2 diff. Apply `continue`/`refactor` feedback, re-run review, commit.

---

## Phase 3 — DB migration + detect-cron wiring — full Get It Right loop

### Task 9: Migration adding payoff columns

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append next sequential migration id — read the file to find it)
- Modify: `api/__tests__/db.test.ts` (add `{ id: N }` to applied mock, add to expected list, bump SQL call count per CLAUDE.md)

- [ ] **Step 1: Write the failing migration test update**

In `api/__tests__/db.test.ts`, add the new migration `{ id: N }` to the applied-migrations mock and expected-output list, and bump the SQL call count (each migration = 1 DDL + 1 INSERT into `schema_migrations`; this migration runs multiple `statements()` — count each).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/db.test.ts`
Expected: FAIL — call-count / expected-list mismatch.

- [ ] **Step 3: Implement the migration**

Append to `migrateDb()` via `db-migrations.ts` (use `statements()` for atomicity, matching the take-it migration #154 pattern):

```sql
-- both tables
ALTER TABLE lottery_finder_fires ADD COLUMN IF NOT EXISTS payoff_pred_log NUMERIC;
ALTER TABLE lottery_finder_fires ADD COLUMN IF NOT EXISTS payoff_expected_peak_pct NUMERIC;
ALTER TABLE lottery_finder_fires ADD COLUMN IF NOT EXISTS payoff_p90_pct NUMERIC;
ALTER TABLE lottery_finder_fires ADD COLUMN IF NOT EXISTS payoff_model_version TEXT;
CREATE INDEX IF NOT EXISTS lottery_finder_fires_payoff_idx
  ON lottery_finder_fires (date DESC, payoff_expected_peak_pct DESC)
  WHERE payoff_expected_peak_pct IS NOT NULL;

ALTER TABLE silent_boom_alerts ADD COLUMN IF NOT EXISTS payoff_pred_log NUMERIC;
ALTER TABLE silent_boom_alerts ADD COLUMN IF NOT EXISTS payoff_expected_peak_pct NUMERIC;
ALTER TABLE silent_boom_alerts ADD COLUMN IF NOT EXISTS payoff_p90_pct NUMERIC;
ALTER TABLE silent_boom_alerts ADD COLUMN IF NOT EXISTS payoff_model_version TEXT;
CREATE INDEX IF NOT EXISTS silent_boom_alerts_payoff_idx
  ON silent_boom_alerts (date DESC, payoff_expected_peak_pct DESC)
  WHERE payoff_expected_peak_pct IS NOT NULL;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db-migrations.ts api/__tests__/db.test.ts
git commit -m "feat(payoff): migration — payoff columns on lottery + silent boom"
```

### Task 10: Wire payoff scoring into both detect crons

**Files:**
- Modify: `api/cron/detect-lottery-fires.ts` (where `computeTakeitScore` is called)
- Modify: `api/cron/detect-silent-boom.ts` (same)
- Test: `api/__tests__/payoff-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/__tests__/payoff-detect.test.ts
import { describe, it, expect, vi } from 'vitest';
import { scorePayoffForInsert } from '../cron/detect-lottery-fires';

describe('scorePayoffForInsert', () => {
  it('returns null columns when the bundle is unavailable (fail-open)', async () => {
    const out = await scorePayoffForInsert(null /* bundle */, { dte: 0 } as never);
    expect(out).toEqual({ payoffPredLog: null, payoffExpectedPeakPct: null, payoffP90Pct: null, payoffModelVersion: null });
  });
  it('returns expm1-transformed values when scored', async () => {
    const bundle = { model_version: 'p1', feature_names: ['dte'], mean_base: 0, mean_trees: [], p90_base: 0, p90_trees: [] };
    const out = await scorePayoffForInsert(bundle as never, { dte: 0 } as never);
    expect(out.payoffExpectedPeakPct).toBeCloseTo(0); // expm1(0) = 0
    expect(out.payoffModelVersion).toBe('p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/payoff-detect.test.ts`
Expected: FAIL — `scorePayoffForInsert` not exported.

- [ ] **Step 3: Implement**

In each detect cron, load the payoff bundle via `payoff-bundle-loader` (cached), build features via `payoff-features` (already built for take-it — reuse the same vector object), and add an exported helper `scorePayoffForInsert(bundle, featureRow)` that returns the 4 columns (fail-open to nulls on missing bundle or throw). Add the 4 values to the INSERT column list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/payoff-detect.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/cron/detect-lottery-fires.ts api/cron/detect-silent-boom.ts api/__tests__/payoff-detect.test.ts
git commit -m "feat(payoff): compute + store payoff score inline in detect crons (fail-open)"
```

### Task 11: Backfill script + bundle upload

**Files:**
- Create: `scripts/upload_payoff_bundles.mjs` (clone `scripts/upload_takeit_bundles.mjs`)
- Create: `scripts/backfill-payoff-scores.mjs` (clone `scripts/backfill-takeit-scores.mjs`)

- [ ] **Step 1: Clone the upload script**

Clone `scripts/upload_takeit_bundles.mjs`, point at `payoff/lottery.json` + `payoff/silent_boom.json` Blob keys.

- [ ] **Step 2: Clone the backfill script**

Clone `scripts/backfill-takeit-scores.mjs`. Backfill all enriched rows with non-null `takeit_features` (per spec open-question default), writing the 4 payoff columns in batched UPDATEs (500/query per `feedback_batched_inserts`).

- [ ] **Step 3: Commit**

```bash
git add scripts/upload_payoff_bundles.mjs scripts/backfill-payoff-scores.mjs
git commit -m "feat(payoff): bundle upload + historical backfill scripts"
```

### Task 12: Phase 3 review

- [ ] `npm run review` green, then `code-reviewer` subagent on the Phase 3 diff; apply feedback; commit.

---

## Phase 4 — UI: quadrant badge + expected-peak chip — full Get It Right loop

### Task 13: UpsideChip + QuadrantBadge components

**Files:**
- Create: `src/components/PayoffScore/UpsideChip.tsx`
- Create: `src/components/PayoffScore/QuadrantBadge.tsx`
- Create: `src/components/PayoffScore/payoff-quadrant-class.ts` (color + emoji map, mirrors `takeit-prob-class.ts`)
- Test: `src/__tests__/PayoffScore.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/PayoffScore.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { UpsideChip } from '../components/PayoffScore/UpsideChip';
import { QuadrantBadge } from '../components/PayoffScore/QuadrantBadge';

describe('UpsideChip', () => {
  it('renders expected peak rounded to whole %', () => {
    render(<UpsideChip expectedPeakPct={122.4} p90PeakPct={279} />);
    expect(screen.getByText(/exp\. peak ~\+122%/)).toBeInTheDocument();
    expect(screen.getByText(/P90 ~\+279%/)).toBeInTheDocument();
  });
  it('renders nothing when expectedPeakPct is null', () => {
    const { container } = render(<UpsideChip expectedPeakPct={null} p90PeakPct={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('QuadrantBadge', () => {
  it('renders the PRIME label + emoji', () => {
    render(<QuadrantBadge quadrant="PRIME" />);
    expect(screen.getByText(/PRIME/)).toBeInTheDocument();
  });
  it('renders nothing when quadrant is null', () => {
    const { container } = render(<QuadrantBadge quadrant={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/PayoffScore.test.tsx`
Expected: FAIL — components not found.

- [ ] **Step 3: Implement**

`payoff-quadrant-class.ts`: map quadrant → `{ label, emoji, className }` (PRIME 💎 deep-green, MOONSHOT 🌙 purple, GRIND ⚙ amber, SKIP ✕ grey), mirroring the Tailwind band classes in `takeit-prob-class.ts`.
`UpsideChip.tsx`: render `exp. peak ~+{Math.round(expectedPeakPct)}%` and a secondary `P90 ~+{Math.round(p90PeakPct)}%`; return `null` if `expectedPeakPct == null`.
`QuadrantBadge.tsx`: render the label + emoji with the mapped className; return `null` if `quadrant == null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/PayoffScore.test.tsx`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add src/components/PayoffScore/ src/__tests__/PayoffScore.test.tsx
git commit -m "feat(payoff-ui): UpsideChip + QuadrantBadge components"
```

### Task 14: Wire into Lottery + Silent Boom rows, EV sort, filters

**Files:**
- Modify: `src/components/LotteryFinder/LotteryRow.tsx`, its types (`src/components/LotteryFinder/types.ts`)
- Modify: `src/components/SilentBoom/SilentBoomRow.tsx`, `src/components/SilentBoom/types.ts`
- Modify: feed serializers `api/lottery-finder.ts`, `api/silent-boom-feed.ts` (emit the payoff fields + computed quadrant)
- Modify: filter/sort schemas `api/_lib/validation/lottery.ts` + the silent-boom feed filters
- Test: extend the row render tests for the new chip/badge presence

- [ ] **Step 1: Write the failing test** — assert a fire row with payoff fields renders `QuadrantBadge` + `UpsideChip`, and that `sort=ev` orders by `takeit_prob × payoff_expected_peak_pct`.

- [ ] **Step 2: Run → fail.** `npx vitest run src/__tests__ api/__tests__` (targeted to the touched specs).

- [ ] **Step 3: Implement** — add `payoffExpectedPeakPct`, `payoffP90Pct`, `quadrant` to both row types + feed responses (server computes `classifyQuadrant` with the Phase-0 cuts); render `<QuadrantBadge>` + `<UpsideChip>` in each row; add `sort: 'ev'` and a `minExpectedPeak` filter mirroring the existing `minTakeitProb` floor.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add src/components/LotteryFinder/ src/components/SilentBoom/ api/lottery-finder.ts api/silent-boom-feed.ts api/_lib/validation/lottery.ts
git commit -m "feat(payoff-ui): quadrant + upside chip on rows, EV sort, expected-peak filter"
```

### Task 15: Phase 4 review

- [ ] `npm run review` green; `code-reviewer` subagent on the Phase 4 diff; apply feedback; commit. Spot-check the rows render in `npm run dev`.

---

## Phase 5 — Monitoring + weekly retrain — full Get It Right loop

### Task 16: Payoff drift + health audit crons

**Files:**
- Create: `api/cron/audit-payoff-drift.ts` (clone `audit-takeit-calibration.ts`: rolling test-set Spearman + pinball instead of Brier/reliability)
- Create: `api/cron/audit-payoff-health.ts` (clone `audit-takeit-health.ts`: null-rate, pred distribution percentiles)
- Modify: `vercel.json` (register both crons with `CRON_SECRET`; weekly for drift, daily for health — match the take-it cadence)
- Test: `api/__tests__/audit-payoff-drift.test.ts`, `api/__tests__/audit-payoff-health.test.ts` (clone the take-it audit tests; mock `getDb`, provide `CRON_SECRET`)

- [ ] **Step 1–4:** TDD each cron (auth-guard test + happy-path test first), clone the take-it audit logic with regression metrics.

- [ ] **Step 5: Commit**

```bash
git add api/cron/audit-payoff-drift.ts api/cron/audit-payoff-health.ts vercel.json api/__tests__/audit-payoff-*.test.ts
git commit -m "feat(payoff): drift + health audit crons (Spearman/pinball)"
```

### Task 17: Weekly retrain GH Actions + runbook

**Files:**
- Create/modify: the GH Actions workflow that retrains take-it weekly — add a payoff job (or clone the workflow) that runs `ml/src/payoff/{build_training_set,train,export_model}.py`, regenerates the parity fixture, and uploads bundles via `scripts/upload_payoff_bundles.mjs`.
- Create: `docs/runbooks/payoff-rollback.md` (clone `docs/runbooks/takeit-rollback.md`; add `scripts/payoff-rollback.mjs` if a rollback path is wanted).

- [ ] **Step 1:** Add the retrain job; ensure the parity gate (`payoff-score.parity.test.ts`) runs in CI so a model/scorer drift blocks the deploy.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ docs/runbooks/payoff-rollback.md
git commit -m "feat(payoff): weekly retrain workflow + rollback runbook"
```

### Task 18: Final review + ship gate

- [ ] `npm run review` green; `code-reviewer` subagent on the full feature; apply feedback.
- [ ] Confirm the GO gate from Phase 0 still holds on the freshly-trained production bundle (Lottery log1p Spearman > 0.35) before enabling the UI display.
- [ ] Update `memory/project_payoff_orthogonal_to_takeit.md` to "shipped" with the production metrics.

---

## Notes for the implementer

- **DRY:** payoff reuses the take-it feature vector — never re-derive features. `payoff-features.ts` re-exports `takeit-features.ts`.
- **The parity gate (Task 6) is the load-bearing test.** Copy the tree-traversal helper from `takeit-score.ts` verbatim; the only legitimate difference is the activation (`expm1`, no sigmoid/isotonic).
- **Fail-open everywhere:** a missing/broken bundle stores NULL payoff columns and renders no chip — never block a fire.
- **All cutoffs are provisional** until tuned in Phase 0. The quadrant `payoffHighPct` should be the trailing-cohort median predicted peak per table, not a hardcoded constant — wire it from a small lookup, not a literal.
- **`.js` extensions:** any `src/` module imported by `api/` (e.g. shared quadrant types) needs explicit `.js` on relative imports per CLAUDE.md.
- **Commit directly to main** (per project convention); use targeted `git add` of only payoff files since concurrent sessions touch the sidecar.
```
