# Exit-Engine A2/A3 at Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the rule baseline (A2) and upside-remaining model (A3) over the full 686K-fire / ~220M-row greek-enriched dataset, with vectorized exit simulation, same-basis (mid) baselines, and sample-train/full-eval — fast enough to actually run and honest enough to trust.

**Architecture:** Replace the per-fire Python loops with **numpy-vectorized** exit simulation (correctness pinned by property tests against the existing scalar functions). Baselines are recomputed on our mid paths (same basis as the engine); stored trade-price `realized_*` columns are a labeled reference only. A3 trains on a stratified fire subsample and evaluates realized R on all fires, chunked to bound memory.

**Tech Stack:** Python 3.14 in `ml/.venv`, pandas 3.0.2, numpy, xgboost, shap, matplotlib; pytest. Worktree `feature/exit-timing-engine`.

**Specs:** `exit-engine-greeks-and-scale-2026-06-09.md` (parent), `exit-timing-engine-2026-05-29.md` (root).

**Prerequisite:** the greek-enriched `decision_dataset.parquet` (A1.5 Task 4 rebuild) must exist. Dataset feature columns (17): `minutes_since_entry, minutes_to_close, ret_from_entry_pct, running_peak_pct, drawdown_from_peak_pct, spread_pct, slope_3m, slope_5m, slope_10m, realized_vol_5m, iv_level, iv_change_5m, iv_change_10m, delta, gamma, otm_distance_pct, underlying_ret_from_entry` + `mid, minute, forward_ratio, y_has_upside, y_log_upside, fire_id, date, mode, entry_price`.

## Conventions
- Run tests: `ml/.venv/bin/python -m pytest <path> -v`. Subagents: **do NOT run git** (controller commits) and **do NOT run the drivers** (operational, controller runs after the rebuild; need DATABASE_URL + the 6.6 GB dataset).
- Every long pass: per-unit progress (`flush=True`), chunked over fold/row-group to bound memory, `caffeinate -i`. No pure-Python per-fire loop on a hot path.

## File structure
- `ml/src/exit_engine/rule_family.py` — add `decide_exit_index_vec(ret, mse, ...)` (numpy); keep scalar `decide_exit_index` as the reference oracle for the property test.
- `ml/src/exit_engine/onpath_policies.py` — NEW: same-basis baseline returns (trail-30/10, hard-30m, tier-50, hold-EOD) on a mid path.
- `ml/src/exit_engine/sampling.py` — NEW: stratified fire subsampler.
- `ml/src/exit_engine/model.py` — add `score_and_stop_vec(...)` batch path.
- Drivers (`run_a2_rule_baseline.py`, `run_a3_model.py`, `run_a4_frontier.py`) — rewire to the vectorized/chunked harness + on-path baselines.
- Tests: `ml/tests/test_exit_rule_family.py`, `test_exit_onpath_policies.py` (new), `test_exit_sampling.py` (new), `test_exit_model.py`.

---

## Phase A2 — vectorized rule baseline

### Task 1: Vectorized `decide_exit_index_vec` (pinned to the scalar by a property test)

**Files:**
- Modify: `ml/src/exit_engine/rule_family.py`
- Test: `ml/tests/test_exit_rule_family.py`

- [ ] **Step 1: Write the property test** (append; file imports `pandas as pd`, `exit_engine.rule_family as rf`; add `import numpy as np`):

```python
def test_vec_matches_scalar_decide_exit_index():
    rng = np.random.default_rng(7)
    knobs = [(20.0, 10.0, 30), (30.0, 10.0, 100000), (50.0, 25.0, 60), (75.0, 40.0, 120)]
    for _ in range(300):
        n = int(rng.integers(1, 60))
        ret = np.cumsum(rng.normal(0, 25, size=n)).astype("float64")  # random walk in pp
        mse = np.arange(n, dtype="float64")
        rows = pd.DataFrame({"ret_from_entry_pct": ret, "minutes_since_entry": mse})
        for a, g, h in knobs:
            scalar = rf.decide_exit_index(rows, activate_pct=a, giveback_pct=g, hard_stop_min=h)
            vec = rf.decide_exit_index_vec(ret, mse, activate_pct=a, giveback_pct=g, hard_stop_min=h)
            assert vec == scalar, f"mismatch n={n} knob={(a,g,h)} scalar={scalar} vec={vec}"
```

- [ ] **Step 2: Run, expect FAIL** (`AttributeError: module ... has no attribute 'decide_exit_index_vec'`): `ml/.venv/bin/python -m pytest ml/tests/test_exit_rule_family.py::test_vec_matches_scalar_decide_exit_index -v`

- [ ] **Step 3: Implement** `decide_exit_index_vec` in `rule_family.py` (mirrors the scalar loop's semantics: hard stop fires at iteration `first_over` returning `first_over-1`; trail fires at its trigger iteration; earliest iteration wins; else last index):

```python
import numpy as np


def decide_exit_index_vec(
    ret: np.ndarray, mse: np.ndarray,
    activate_pct: float, giveback_pct: float, hard_stop_min: float,
) -> int:
    n = ret.shape[0]
    if n == 0:
        return 0
    # hard stop: first row whose minute exceeds the limit -> loop returns (i-1)
    over = np.nonzero(mse > hard_stop_min)[0]
    hard_iter = int(over[0]) if over.size else n  # iteration at which hard fires (n = never)
    # trail: activate at first ret>=A, then exit when ret <= running_peak - W
    act = np.nonzero(ret >= activate_pct)[0]
    trail_iter = n
    if act.size:
        a = int(act[0])
        sub = ret[a:]
        peak = np.maximum.accumulate(sub)
        trig = np.nonzero(sub <= peak - giveback_pct)[0]
        if trig.size:
            trail_iter = a + int(trig[0])
    if hard_iter == n and trail_iter == n:
        return n - 1
    if hard_iter < trail_iter:
        return max(0, hard_iter - 1)
    return trail_iter
```

- [ ] **Step 4: Run, expect PASS** (property test green over 300×4 random cases): `ml/.venv/bin/python -m pytest ml/tests/test_exit_rule_family.py -v`

- [ ] **Step 5: Report DONE** with pytest count. (Controller commits.)

---

### Task 2: On-path (mid-basis) baseline policies

**Files:**
- Create: `ml/src/exit_engine/onpath_policies.py`
- Test: `ml/tests/test_exit_onpath_policies.py`

These recompute the shipped policies on OUR mid path so the benchmark is same-basis. Each returns a cost-netted realized %, reusing `backtest.realized_return_for_exit` (which costs on the entry-minute spread).

- [ ] **Step 1: Write the failing test:**

```python
import pandas as pd

import exit_engine.onpath_policies as op


def _rows(mids, mse, entry=1.0, spread_pct=10.0):
    ret = [(m - entry) / entry * 100.0 for m in mids]
    return pd.DataFrame({
        "mid": mids, "entry_price": entry, "spread_pct": spread_pct,
        "ret_from_entry_pct": ret, "minutes_since_entry": mse,
    })


def test_onpath_trail_and_hard_and_eod_indices():
    # +0,+100,+200,+150% ; trail act30/give10 exits idx3; hard30m(min<=30) at last<=30; eod last
    rows = _rows([1.0, 2.0, 3.0, 2.5], [0.0, 1.0, 2.0, 3.0])
    out = op.onpath_baselines(rows)
    assert set(out) == {"trail30_10", "hard30m", "tier50_holdeod", "eod"}
    # trail exits at idx3 (mid 2.5 -> +150%) cost-netted; eod also idx3 here
    assert out["trail30_10"] == out["eod"]  # both land on the last row for this path
    # hard30m: all minutes <= 30 -> last row
    assert out["hard30m"] == out["eod"]


def test_onpath_tier50_is_average_of_two_legs():
    # first +50% at idx1 (mid 1.5), hold to last idx2 (mid 3.0). tier = avg(realized(idx1), realized(idx2))
    rows = _rows([1.0, 1.5, 3.0], [0.0, 1.0, 2.0])
    out = op.onpath_baselines(rows)
    # leg1 exits idx1, leg2 exits idx2; tier is their cost-netted average
    import exit_engine.backtest as bt
    leg1 = bt.realized_return_for_exit(rows, 1)
    leg2 = bt.realized_return_for_exit(rows, 2)
    assert out["tier50_holdeod"] == (leg1 + leg2) / 2.0
```

- [ ] **Step 2: Run, expect FAIL** (`ModuleNotFoundError`).

- [ ] **Step 3: Implement `ml/src/exit_engine/onpath_policies.py`:**

```python
"""Same-basis (mid) baseline exit policies recomputed on the engine's own paths,
so the benchmark compares like-for-like (the stored realized_* columns are
trade-price basis)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from exit_engine.backtest import realized_return_for_exit
from exit_engine.rule_family import decide_exit_index_vec


def onpath_baselines(rows: pd.DataFrame) -> dict:
    """Cost-netted realized % for trail-30/10, hard-30m, tier-50-hold-EOD, hold-EOD
    on this fire's mid path."""
    rows = rows.reset_index(drop=True)
    ret = rows["ret_from_entry_pct"].to_numpy(dtype="float64")
    mse = rows["minutes_since_entry"].to_numpy(dtype="float64")
    n = len(rows)
    last = n - 1

    trail_idx = decide_exit_index_vec(ret, mse, 30.0, 10.0, 100000)
    # hard-30m: last row within 30 minutes
    in_time = np.nonzero(mse <= 30.0)[0]
    hard_idx = int(in_time[-1]) if in_time.size else 0
    # tier-50: half out at first +50%, half held to EOD; average of the two legs
    fifty = np.nonzero(ret >= 50.0)[0]
    if fifty.size:
        leg1 = realized_return_for_exit(rows, int(fifty[0]))
        leg2 = realized_return_for_exit(rows, last)
        tier = (leg1 + leg2) / 2.0
    else:
        tier = realized_return_for_exit(rows, last)

    return {
        "trail30_10": realized_return_for_exit(rows, trail_idx),
        "hard30m": realized_return_for_exit(rows, hard_idx),
        "tier50_holdeod": tier,
        "eod": realized_return_for_exit(rows, last),
    }
```

- [ ] **Step 4: Run, expect PASS.** `ml/.venv/bin/python -m pytest ml/tests/test_exit_onpath_policies.py -v`

- [ ] **Step 5: Report DONE.** (Controller commits.)

---

### Task 3: A2 driver — vectorized walk-forward rule baseline (operational, controller-run)

**Files:** Modify `ml/experiments/exit-timing-engine/run_a2_rule_baseline.py`.

Rewrite the per-fold grid search to **precompute once** then select per fold:

- Load dataset, assign folds (`cfg.N_TRAIN_DAYS`/`TEST_BLOCK_DAYS`).
- Build per-fire numpy arrays `(ret, mse)` once: `per_fire = {fid: (ret_arr, mse_arr, entry, spread0)}` from a single `groupby('fire_id')` pass (iterate row-groups / chunk to bound memory; log progress every ~50K fires).
- For each knob in `rule_family.grid()`, compute each fire's exit index via `decide_exit_index_vec` and realized % (vectorized cost-netting). Store an `(n_fires × n_knobs)` float32 realized matrix once (686K × 64 × 4 bytes ≈ 176 MB — fine).
- Walk-forward: for each test fold, pick the knob column maximizing **train-fold** mean realized; apply to the test fold. Collect OOS realized per fire.
- Compute **on-path baselines** (`onpath_baselines`) per fire (vectorized, once) for trail/hard/tier/eod; aggregate equal-weight mean per fold-set.
- Benchmark table: engine-rule + on-path baselines (PRIMARY) and the stored `realized_*` columns labeled "(stored, trade-price ref)". Print + write `a2_rule_baseline.md`.

Acceptance: runs to completion in **minutes** (not days); prints the OOS rule mean and the same-basis benchmark table. Smoke first with a fold/row cap if needed.

- [ ] Implement; `py_compile`; controller runs after rebuild and records results.

---

## Phase A3 — model at scale

### Task 4: Stratified fire subsampler

**Files:**
- Create: `ml/src/exit_engine/sampling.py`
- Test: `ml/tests/test_exit_sampling.py`

- [ ] **Step 1: Failing test:**

```python
import pandas as pd

import exit_engine.sampling as sm


def test_stratified_fire_sample_is_proportional_and_capped():
    # 100 fires across 2 dates x 2 modes (25 each)
    meta = pd.DataFrame({
        "fire_id": range(100),
        "date": (["2026-01-02"] * 50) + (["2026-01-03"] * 50),
        "mode": (["A_intraday_0DTE"] * 25 + ["B_multi_day_DTE1_3"] * 25) * 2,
    })
    ids = sm.stratified_fire_sample(meta, target=40, seed=1)
    assert len(ids) == 40
    assert set(ids).issubset(set(meta["fire_id"]))
    sub = meta[meta["fire_id"].isin(ids)]
    # each (date,mode) stratum ~ 10 (40/4), within rounding
    counts = sub.groupby(["date", "mode"]).size()
    assert counts.min() >= 8 and counts.max() <= 12


def test_target_ge_population_returns_all():
    meta = pd.DataFrame({"fire_id": range(10), "date": ["d"] * 10, "mode": ["A_intraday_0DTE"] * 10})
    assert sorted(sm.stratified_fire_sample(meta, target=50, seed=1)) == list(range(10))
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `ml/src/exit_engine/sampling.py`:**

```python
"""Stratified fire subsampling for model training (sample-train / full-eval)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def stratified_fire_sample(fire_meta: pd.DataFrame, target: int, seed: int = 13) -> list[int]:
    """Sample ~target fire_ids, proportionally across (date, mode) strata. Returns
    all fire_ids if target >= population."""
    fire_meta = fire_meta.drop_duplicates("fire_id")
    n = len(fire_meta)
    if target >= n:
        return fire_meta["fire_id"].tolist()
    rng = np.random.default_rng(seed)
    frac = target / n
    out: list[int] = []
    for _, grp in fire_meta.groupby(["date", "mode"], observed=True):
        k = int(round(len(grp) * frac))
        k = max(1, min(k, len(grp)))
        out.extend(rng.choice(grp["fire_id"].to_numpy(), size=k, replace=False).tolist())
    return out
```

- [ ] **Step 4: Run, expect PASS.** (Strata counts ~proportional; total ≈ target within rounding — the test allows the 8–12 band.)

- [ ] **Step 5: Report DONE.** (Controller commits.)

---

### Task 5: Vectorized score-and-stop

**Files:**
- Modify: `ml/src/exit_engine/model.py`
- Test: `ml/tests/test_exit_model.py`

`greedy_stop_index` already exists (scalar over one fire's score array). Add a thin helper that, given a fire's already-computed `p_upside` array + `mse`, returns the stop index — so the driver can batch `predict_proba` once over all rows and then vectorize the stop per fire without rebuilding DataFrames.

- [ ] **Step 1: Failing test:**

```python
def test_greedy_stop_from_arrays_matches_dataframe_version():
    import numpy as np
    mse = np.array([0.0, 1.0, 2.0, 3.0])
    p = np.array([0.9, 0.8, 0.2, 0.1])
    # arrays version
    idx_arr = m.greedy_stop_index_arr(mse, p, exit_threshold=0.5, arm_after_min=1.0)
    # dataframe version (existing)
    rows = pd.DataFrame({"minutes_since_entry": mse, "p_upside": p})
    idx_df = m.greedy_stop_index(rows, exit_threshold=0.5, arm_after_min=1.0)
    assert idx_arr == idx_df == 2
```

- [ ] **Step 2: Run, expect FAIL** (`greedy_stop_index_arr` missing).

- [ ] **Step 3: Implement** in `model.py`:

```python
def greedy_stop_index_arr(
    mse: np.ndarray, score: np.ndarray, exit_threshold: float, arm_after_min: float
) -> int:
    """Array form of greedy_stop_index: first armed minute below threshold, else last."""
    armed_low = (mse > arm_after_min) & (score < exit_threshold)
    hit = np.nonzero(armed_low)[0]
    return int(hit[0]) if hit.size else len(mse) - 1
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Report DONE.** (Controller commits.)

---

### Task 6: A3 driver — sample-train / full-eval model (operational, controller-run)

**Files:** Modify `ml/experiments/exit-timing-engine/run_a3_model.py`.

- Walk-forward by date. For each test fold: **train on a stratified sample** of the fires whose rows have `fold < current` (`sampling.stratified_fire_sample`, target ~75K fires; record the size), using `train_classifier` on those rows only. (`fold` already excluded from features via `_NON_FEATURE`.)
- **Full-eval:** batch `model.predict_proba` over ALL test-fold rows at once (chunked by row-group to bound memory), then per fire compute the stop via `greedy_stop_index_arr` and realized % via the vectorized cost-net. Tune `exit_threshold` on a held-out slice of the train sample (NOT the same rows the model trained on — use a date-based validation split inside the train window to avoid in-sample threshold bias).
- Benchmark vs **on-path baselines** (primary) + stored (reference). Leakage stratification by mode (must be non-uniform). SHAP on a train-sample slice. Write `a3_model.md` + verdict (model vs rule vs trail).
- Progress logs (`flush=True`); `caffeinate -i`.

Acceptance: completes in reasonable wall-clock (model trains in minutes on the sample; full-eval is vectorized + chunked); reports OOS model mean, same-basis benchmark, clean leakage flag.

- [ ] Implement; `py_compile`; controller runs after rebuild + A2.

---

### Task 7: A4 frontier on the enriched dataset (operational)

`run_a4_frontier.py` already uses current-mark giveback and is dataset-shape-agnostic. Re-run on the enriched dataset; only change needed: ensure it imports `cfg.N_TRAIN_DAYS`/`TEST_BLOCK_DAYS` (done) and uses chunking if memory-bound. Mostly a re-run.

- [ ] Verify compile + controller re-run; record frontier.

---

## Self-review
- **Spec coverage:** vectorized exit sim (T1, property-pinned), on-path same-basis baselines (T2 + wired in T3/T6), sample-train/full-eval (T4 sampler, T6 driver), vectorized full-eval scoring (T5), leakage + SHAP + θ-sweep-on-validation (T6), frontier (T7). Scale guardrails (chunking, progress, caffeinate, no per-fire Python on hot paths) stated.
- **Type consistency:** `decide_exit_index_vec(ret, mse, activate_pct, giveback_pct, hard_stop_min)` and `greedy_stop_index_arr(mse, score, exit_threshold, arm_after_min)` signatures used identically in tests + drivers; `onpath_baselines(rows)->dict` keys (`trail30_10/hard30m/tier50_holdeod/eod`) match the benchmark table.
- **No placeholders** in the TDD tasks (1,2,4,5). Driver tasks (3,6,7) are operational specs with concrete acceptance criteria, run by the controller after the rebuild — their exact glue is finalized against the real dataset, consistent with how A1's driver was handled.

## Out of scope
Project B (live), Project C (Schwab), theta/vega/rho features, RL stopping.
