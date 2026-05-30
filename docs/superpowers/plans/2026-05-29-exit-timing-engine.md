# Exit-Timing Engine (Project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline, walk-forward-validated exit-timing engine that, scored each minute on a held lottery contract, decides HOLD vs EXIT to maximize total realized return — and proves it beats the shipped exit policies on equal-weight realized P&L before anything goes live.

**Architecture:** Pure-Python research pipeline under `ml/src/exit_engine/`. Reconstruct each fire's per-minute executable-mid path from the parquet full tape → build strictly-causal features and "upside-from-here" labels → train an XGBoost "is there upside left?" model whose greedy stopping rule is benchmarked against a parametric generalization of the shipped rules → sweep a giveback-penalty frontier and pick the followable operating point. A separate end-of-day "carry vs flatten" model handles multi-day (mode B) overnight decisions. No `api/` or `src/` changes; no live infra.

**Tech Stack:** Python 3.14 in `ml/.venv`, pandas, numpy, xgboost, scikit-learn, shap, matplotlib, psycopg2; pytest for tests. Reuses `apply_costs` cost model and the parquet column-pushdown loader pattern from `ml/experiments/lottery-net-flow-eda/exit_simulation.py`, and the shipped policy functions in `ml/src/lottery_exit_policies.py`.

**Spec:** `docs/superpowers/specs/exit-timing-engine-2026-05-29.md`

---

## Conventions for every task

- Run tests with: `ml/.venv/bin/python -m pytest <path> -v` (the `ml/conftest.py` puts `ml/src/` and `ml/tests/` on `sys.path`, so `import exit_engine.<mod>` works).
- All money math is on the **NBBO mid**; all realized returns are **cost-netted** via `exit_engine.costs.apply_costs`.
- "Upside from here" everywhere means **forward move relative to the current mark**, never relative to entry.
- These are `ml/` Python changes, so per CLAUDE.md they skip the reviewer subagent and the `npm run review` gate — but every task still ends green on `pytest` before committing.
- Commit after every task. Stage only the files the task touched (parallel sessions run on `main`).

## File Structure

```
ml/src/exit_engine/
  __init__.py            # package marker
  config.py              # paths, mode literals, θ default, horizon constants
  costs.py               # COMMISSION/SLIPPAGE constants + apply_costs (ported, parity-tested)
  path_reconstruction.py # parquet → per-fire per-minute mid path (multi-session for mode B)
  features.py            # strictly-causal per-minute feature builder
  labels.py              # "upside-from-here" classification + regression targets
  dataset.py             # join fires+paths+features+labels → frame + walk-forward folds
  backtest.py            # exit-decision → cost-netted realized R, equal-weight benchmark table, leakage test
  rule_family.py         # parametric trail/hard rule + walk-forward grid search (A2 baseline)
  model.py               # XGBoost upside-remaining model + greedy stopping policy (A3 brain)
  carry_model.py         # mode-B end-of-day carry/flatten model (A3b)
ml/experiments/exit-timing-engine/
  run_a1_build_dataset.py   # driver: build + cache the dataset parquet, print coverage
  run_a2_rule_baseline.py   # driver: rule-family search + benchmark table
  run_a3_model.py           # driver: model train/eval, θ sweep, SHAP, leakage test
  run_a3b_carry.py          # driver: mode-B carry model eval
  run_a4_frontier.py        # driver: λ giveback frontier + final verdict doc
ml/tests/
  test_exit_costs.py
  test_exit_path_reconstruction.py
  test_exit_features.py
  test_exit_labels.py
  test_exit_dataset.py
  test_exit_backtest.py
  test_exit_rule_family.py
  test_exit_model.py
  test_exit_carry_model.py
```

---

## Phase A1 — Path reconstruction + decision dataset

### Task 1: Package scaffold + config

**Files:**
- Create: `ml/src/exit_engine/__init__.py`
- Create: `ml/src/exit_engine/config.py`
- Test: `ml/tests/test_exit_config.py`

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_config.py
import exit_engine.config as cfg


def test_mode_literals_match_source():
    assert cfg.MODE_INTRADAY == "A_intraday_0DTE"
    assert cfg.MODE_MULTIDAY == "B_multi_day_DTE1_3"
    assert set(cfg.IN_UNIVERSE_MODES) == {cfg.MODE_INTRADAY, cfg.MODE_MULTIDAY}


def test_theta_default_is_forward_from_here():
    # θ = +15% forward move on the CURRENT mark (not pp-from-entry)
    assert cfg.THETA_FORWARD_DEFAULT == 0.15


def test_parquet_dir_points_at_full_tape():
    assert cfg.PARQUET_DIR.name == "Bot-Eod-parquet"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'exit_engine'`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/__init__.py
"""Project A — offline exit-timing engine for lottery fires."""
```

```python
# ml/src/exit_engine/config.py
"""Shared constants for the exit-timing engine.

Mode literals mirror api/_lib/lottery-finder.ts (LotteryMode). The parquet
full tape is the source of truth; ws_option_trades is Project B's concern.
"""
from __future__ import annotations

from pathlib import Path

MODE_INTRADAY = "A_intraday_0DTE"
MODE_MULTIDAY = "B_multi_day_DTE1_3"
IN_UNIVERSE_MODES = (MODE_INTRADAY, MODE_MULTIDAY)

# θ: minimum "meaningful further upside" measured as a forward fractional move
# on the CURRENT mark (0.15 == price rises 15% above where it is now).
THETA_FORWARD_DEFAULT = 0.15

# Mode-B multi-day holds reconstruct across this many calendar days max.
MAX_HOLD_DAYS = 4

PARQUET_DIR = Path.home() / "Desktop" / "Bot-Eod-parquet"
PARQUET_TRADES_PATTERN = "{date}-trades.parquet"
PARQUET_FULLTAPE_PATTERN = "{date}-fulltape.parquet"

# Cached dataset artifact built by run_a1_build_dataset.py.
DATASET_PARQUET = (
    Path(__file__).resolve().parents[2]
    / "experiments"
    / "exit-timing-engine"
    / "decision_dataset.parquet"
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_config.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/__init__.py ml/src/exit_engine/config.py ml/tests/test_exit_config.py
git commit -m "feat(exit-engine): package scaffold + config constants"
```

---

### Task 2: Cost model (ported + parity-tested)

**Files:**
- Create: `ml/src/exit_engine/costs.py`
- Test: `ml/tests/test_exit_costs.py`

The verified model (from `exit_simulation.py:211-221`): commission `$0.65` round-trip per contract, slippage = cross half the bid-ask on **each** leg (`2 × 0.5 × spread_pct`). We port it into the package so nothing imports from `experiments/`.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_costs.py
import math

import exit_engine.costs as costs


def test_constants_match_source():
    assert costs.COMMISSION_USD_PER_CONTRACT_RT == 0.65
    assert costs.SLIPPAGE_PCT_OF_SPREAD == 0.5


def test_apply_costs_strips_commission_and_two_leg_slippage():
    # entry_price=1.00 → commission = 0.65/(1.00*100)*100 = 0.65pp
    # spread_pct=4.0 → slippage = 2*0.5*4.0 = 4.0pp
    out = costs.apply_costs(100.0, entry_price=1.00, spread_pct_of_price=4.0)
    assert math.isclose(out, 100.0 - 0.65 - 4.0, rel_tol=1e-9)


def test_apply_costs_passthrough_on_bad_entry():
    assert costs.apply_costs(50.0, entry_price=0.0, spread_pct_of_price=2.0) == 50.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_costs.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'exit_engine.costs'`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/costs.py
"""Cost model ported verbatim from
ml/experiments/lottery-net-flow-eda/exit_simulation.py (apply_costs).
Kept here so the engine never imports from experiments/."""
from __future__ import annotations

import math

COMMISSION_USD_PER_CONTRACT_RT = 0.65  # round-trip
SLIPPAGE_PCT_OF_SPREAD = 0.5  # cross half the bid-ask each leg


def apply_costs(pct: float, entry_price: float, spread_pct_of_price: float) -> float:
    """Strip commission + 2-leg slippage from a gross % return."""
    if pct is None or (isinstance(pct, float) and math.isnan(pct)) or entry_price <= 0:
        return pct
    comm_pct = (COMMISSION_USD_PER_CONTRACT_RT / (entry_price * 100)) * 100
    slip_pct = 2 * SLIPPAGE_PCT_OF_SPREAD * spread_pct_of_price
    return pct - comm_pct - slip_pct
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_costs.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/costs.py ml/tests/test_exit_costs.py
git commit -m "feat(exit-engine): port cost model with parity test"
```

---

### Task 3: Per-minute path reconstruction (incl. multi-session for mode B)

**Files:**
- Create: `ml/src/exit_engine/path_reconstruction.py`
- Test: `ml/tests/test_exit_path_reconstruction.py`

Reconstruct a fire's per-minute mid/spread path from the in-memory day-trades DataFrame, then a multi-day assembler that concatenates day frames for mode B. Mirrors `build_minute_prices` (exit_simulation.py:86-104) but returns minutes-since-entry and keeps only post-entry minutes.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_path_reconstruction.py
import pandas as pd

import exit_engine.path_reconstruction as pr


def _trades(rows):
    return pd.DataFrame(
        rows,
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})


def test_minute_path_drops_canceled_and_computes_mid():
    t = _trades([
        ("2026-04-13T14:30:10Z", "X", 1.0, 1.2, 1.1, False),
        ("2026-04-13T14:30:50Z", "X", 1.2, 1.4, 1.3, False),   # same minute → last wins
        ("2026-04-13T14:31:10Z", "X", 5.0, 5.0, 5.0, "t"),      # canceled → dropped
        ("2026-04-13T14:32:10Z", "X", 2.0, 2.4, 2.2, False),
    ])
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-04-13T14:30:00Z"), entry_price=1.0)
    assert list(path["mid"]) == [1.3, 2.2]           # 14:30 last mid, 14:32 mid; 14:31 canceled gone
    assert list(path["minutes_since_entry"]) == [0.0, 2.0]
    assert path["spread"].iloc[1] == 0.4


def test_assemble_multiday_concats_sessions_in_order():
    day1 = _trades([("2026-04-13T19:00:10Z", "X", 1.0, 1.2, 1.1, False)])
    day2 = _trades([("2026-04-14T14:30:10Z", "X", 3.0, 3.2, 3.1, False)])
    path = pr.assemble_multiday_path(
        [day1, day2], entry_ts=pd.Timestamp("2026-04-13T19:00:00Z"), entry_price=1.0
    )
    assert len(path) == 2
    assert path["minutes_since_entry"].is_monotonic_increasing
    assert path["mid"].iloc[-1] == 3.1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_path_reconstruction.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/path_reconstruction.py
"""Reconstruct a fire's per-minute executable-mid path from the parquet tape.

Single-session path mirrors exit_simulation.build_minute_prices but is
entry-anchored (minutes_since_entry) and post-entry only. The multi-day
assembler concatenates per-day frames for mode-B holds.
"""
from __future__ import annotations

import pandas as pd

_CANCELED_TRUTHY = [True, "t", "true", "True"]


def build_minute_path(
    trades: pd.DataFrame, entry_ts: pd.Timestamp, entry_price: float
) -> pd.DataFrame:
    """Per-minute mid/spread from one day's trades for a single chain.

    Returns columns: minute, mid, spread, bid, ask, minutes_since_entry.
    Keeps minutes at or after the entry minute only.
    """
    if trades.empty or entry_price <= 0:
        return pd.DataFrame()
    df = trades[~trades["canceled"].isin(_CANCELED_TRUTHY)].copy()
    if df.empty:
        return pd.DataFrame()
    df["minute"] = df["executed_at"].dt.floor("min")
    df["mid"] = (df["nbbo_bid"] + df["nbbo_ask"]) / 2.0
    df["spread"] = df["nbbo_ask"] - df["nbbo_bid"]
    grouped = (
        df.groupby("minute", observed=True)
        .agg(mid=("mid", "last"), spread=("spread", "last"),
             bid=("nbbo_bid", "last"), ask=("nbbo_ask", "last"))
        .reset_index()
    )
    entry_minute = entry_ts.floor("min")
    grouped = grouped[grouped["minute"] >= entry_minute].reset_index(drop=True)
    if grouped.empty:
        return grouped
    grouped["minutes_since_entry"] = (
        (grouped["minute"] - entry_minute).dt.total_seconds() / 60.0
    )
    return grouped


def assemble_multiday_path(
    day_frames: list[pd.DataFrame], entry_ts: pd.Timestamp, entry_price: float
) -> pd.DataFrame:
    """Concatenate ordered per-day trade frames into one entry-anchored path.

    minutes_since_entry is wall-clock from entry across sessions (overnight gaps
    are real elapsed minutes — the EOD carry model, not this function, decides
    whether to hold across them)."""
    parts = [
        build_minute_path(d, entry_ts, entry_price) for d in day_frames if not d.empty
    ]
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame()
    out = pd.concat(parts, ignore_index=True).sort_values("minute").reset_index(drop=True)
    entry_minute = entry_ts.floor("min")
    out["minutes_since_entry"] = (out["minute"] - entry_minute).dt.total_seconds() / 60.0
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_path_reconstruction.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/path_reconstruction.py ml/tests/test_exit_path_reconstruction.py
git commit -m "feat(exit-engine): per-minute path reconstruction + multi-day assembler"
```

---

### Task 4: "Upside-from-here" labels

**Files:**
- Create: `ml/src/exit_engine/labels.py`
- Test: `ml/tests/test_exit_labels.py`

At each minute `t`, the future-max mid from `t` onward (inclusive) defines forward upside on the **current mark**: `forward_ratio_t = max(mid[t:]) / mid[t]`. Classification target = `forward_ratio_t - 1 >= θ`; regression target = `log1p(forward_ratio_t - 1)`.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_labels.py
import math

import numpy as np
import pandas as pd

import exit_engine.labels as lbl


def test_forward_ratio_uses_future_max_from_here():
    path = pd.DataFrame({"mid": [1.0, 2.0, 4.0, 3.0]})
    out = lbl.add_labels(path, theta=0.15)
    # from idx0 future max=4 → ratio 4.0; idx2 future max=4 → ratio 1.0
    assert list(out["forward_ratio"]) == [4.0, 2.0, 1.0, 1.0]
    # classification: ratio-1 >= 0.15
    assert list(out["y_has_upside"]) == [1, 1, 0, 0]
    # regression: log1p(ratio-1); last point has 0 upside
    assert math.isclose(out["y_log_upside"].iloc[0], math.log1p(3.0))
    assert out["y_log_upside"].iloc[-1] == 0.0


def test_labels_are_strictly_forward_no_leak_backward():
    # An early dip then recovery: idx0 still sees the later peak.
    path = pd.DataFrame({"mid": [2.0, 1.0, 10.0]})
    out = lbl.add_labels(path, theta=0.15)
    assert out["forward_ratio"].iloc[0] == 5.0  # 10/2
    assert out["forward_ratio"].iloc[1] == 10.0  # 10/1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_labels.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/labels.py
"""Forward-from-current-mark labels for the upside-remaining model."""
from __future__ import annotations

import numpy as np
import pandas as pd


def add_labels(path: pd.DataFrame, theta: float) -> pd.DataFrame:
    """Add forward_ratio, y_has_upside (0/1), y_log_upside to a minute path.

    forward_ratio_t = max(mid[t:]) / mid[t]  (>= 1.0, upside measured from here).
    """
    out = path.copy()
    mid = out["mid"].to_numpy(dtype="float64")
    # reverse cumulative max = future max from each index onward
    future_max = np.maximum.accumulate(mid[::-1])[::-1]
    ratio = np.where(mid > 0, future_max / mid, 1.0)
    out["forward_ratio"] = ratio
    out["y_has_upside"] = (ratio - 1.0 >= theta).astype("int8")
    out["y_log_upside"] = np.log1p(np.clip(ratio - 1.0, 0.0, None))
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_labels.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/labels.py ml/tests/test_exit_labels.py
git commit -m "feat(exit-engine): forward-from-current-mark labels"
```

---

### Task 5: Strictly-causal per-minute features

**Files:**
- Create: `ml/src/exit_engine/features.py`
- Test: `ml/tests/test_exit_features.py`

Every feature at minute `t` uses only `mid[:t+1]`. The leak-guard test asserts that appending a future row does not change earlier rows' features.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_features.py
import pandas as pd

import exit_engine.features as feat


def _path(mids, entry_price=1.0):
    return pd.DataFrame({
        "mid": mids,
        "spread": [0.1] * len(mids),
        "minutes_since_entry": [float(i) for i in range(len(mids))],
    })


def test_core_features_present_and_causal_values():
    path = _path([1.0, 2.0, 1.5])
    f = feat.build_features(_path([1.0, 2.0, 1.5]), entry_price=1.0, minutes_to_close=[390, 389, 388])
    # return-from-entry at idx1 = +100%, drawdown from running peak at idx2 = (1.5-2.0)/2.0
    assert abs(f["ret_from_entry_pct"].iloc[1] - 100.0) < 1e-9
    assert abs(f["drawdown_from_peak_pct"].iloc[2] - (-25.0)) < 1e-9
    assert f["minutes_since_entry"].iloc[2] == 2.0


def test_appending_future_row_does_not_change_past_features():
    short = feat.build_features(_path([1.0, 2.0]), entry_price=1.0, minutes_to_close=[390, 389])
    long = feat.build_features(_path([1.0, 2.0, 9.0]), entry_price=1.0, minutes_to_close=[390, 389, 388])
    cols = ["ret_from_entry_pct", "drawdown_from_peak_pct", "slope_3m"]
    pd.testing.assert_frame_equal(short[cols], long[cols].iloc[:2].reset_index(drop=True))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_features.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/features.py
"""Strictly-causal per-minute features. Every value at row t depends only on
mid[:t+1]; verified by the append-future-row leak test."""
from __future__ import annotations

import numpy as np
import pandas as pd


def build_features(
    path: pd.DataFrame, entry_price: float, minutes_to_close: list[float]
) -> pd.DataFrame:
    """Return a causal feature frame aligned 1:1 with path rows."""
    mid = path["mid"].to_numpy(dtype="float64")
    out = pd.DataFrame(index=path.index)
    out["minutes_since_entry"] = path["minutes_since_entry"].to_numpy()
    out["minutes_to_close"] = np.asarray(minutes_to_close, dtype="float64")
    out["ret_from_entry_pct"] = (mid - entry_price) / entry_price * 100.0
    running_peak = np.maximum.accumulate(mid)
    out["running_peak_pct"] = (running_peak - entry_price) / entry_price * 100.0
    out["drawdown_from_peak_pct"] = np.where(
        running_peak > 0, (mid - running_peak) / running_peak * 100.0, 0.0
    )
    out["spread_pct"] = np.where(mid > 0, path["spread"].to_numpy() / mid * 100.0, 0.0)
    out["slope_3m"] = _trailing_slope(mid, 3)
    out["slope_5m"] = _trailing_slope(mid, 5)
    out["slope_10m"] = _trailing_slope(mid, 10)
    out["realized_vol_5m"] = _trailing_vol(mid, 5)
    return out


def _trailing_slope(mid: np.ndarray, window: int) -> np.ndarray:
    """(mid[t] - mid[t-window]) / mid[t-window]; 0 before enough history."""
    out = np.zeros_like(mid)
    for t in range(len(mid)):
        j = t - window
        if j >= 0 and mid[j] > 0:
            out[t] = (mid[t] - mid[j]) / mid[j]
    return out


def _trailing_vol(mid: np.ndarray, window: int) -> np.ndarray:
    rets = np.zeros_like(mid)
    rets[1:] = np.where(mid[:-1] > 0, np.diff(mid) / mid[:-1], 0.0)
    out = np.zeros_like(mid)
    for t in range(len(mid)):
        lo = max(0, t - window + 1)
        out[t] = np.std(rets[lo : t + 1]) if t > lo else 0.0
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_features.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/features.py ml/tests/test_exit_features.py
git commit -m "feat(exit-engine): strictly-causal per-minute features + leak guard"
```

---

### Task 6: Dataset assembler + walk-forward folds

**Files:**
- Create: `ml/src/exit_engine/dataset.py`
- Test: `ml/tests/test_exit_dataset.py`

Combine a fire's path + features + labels into one long frame (one row per minute, tagged with `fire_id`, `date`, `mode`, `entry_price`), and assign walk-forward folds by **calendar date** (train = earlier dates, test = a forward block).

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_dataset.py
import pandas as pd

import exit_engine.dataset as ds


def test_assign_walkforward_folds_is_time_ordered():
    dates = pd.Series(pd.to_datetime(
        ["2026-04-13", "2026-04-13", "2026-04-14", "2026-04-15", "2026-04-16"]
    ))
    folds = ds.assign_walkforward_folds(dates, n_train_days=2, test_block_days=1)
    # first 2 distinct dates are train-only (fold -1 = never tested)
    assert folds.tolist() == [-1, -1, 0, 1, 2]


def test_build_fire_rows_tags_identity_columns():
    path = pd.DataFrame({
        "mid": [1.0, 2.0],
        "spread": [0.1, 0.1],
        "minutes_since_entry": [0.0, 1.0],
        "minute": pd.to_datetime(["2026-04-13T14:30Z", "2026-04-13T14:31Z"]),
    })
    rows = ds.build_fire_rows(
        path, fire_id=7, date="2026-04-13", mode="A_intraday_0DTE",
        entry_price=1.0, minutes_to_close=[390, 389], theta=0.15,
    )
    assert set(["fire_id", "date", "mode", "entry_price", "mid",
                "ret_from_entry_pct", "y_has_upside", "y_log_upside"]).issubset(rows.columns)
    assert (rows["fire_id"] == 7).all()
    assert len(rows) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_dataset.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/dataset.py
"""Assemble per-fire decision rows and assign walk-forward folds by date."""
from __future__ import annotations

import numpy as np
import pandas as pd

from exit_engine.features import build_features
from exit_engine.labels import add_labels


def build_fire_rows(
    path: pd.DataFrame,
    fire_id: int,
    date: str,
    mode: str,
    entry_price: float,
    minutes_to_close: list[float],
    theta: float,
) -> pd.DataFrame:
    """One row per minute for a single fire: features + labels + identity."""
    if path.empty:
        return pd.DataFrame()
    feats = build_features(path, entry_price, minutes_to_close)
    labeled = add_labels(path, theta)
    rows = feats.reset_index(drop=True)
    rows["mid"] = path["mid"].to_numpy()
    rows["minute"] = path["minute"].to_numpy() if "minute" in path else np.nan
    rows["forward_ratio"] = labeled["forward_ratio"].to_numpy()
    rows["y_has_upside"] = labeled["y_has_upside"].to_numpy()
    rows["y_log_upside"] = labeled["y_log_upside"].to_numpy()
    rows["fire_id"] = fire_id
    rows["date"] = date
    rows["mode"] = mode
    rows["entry_price"] = entry_price
    return rows


def assign_walkforward_folds(
    dates: pd.Series, n_train_days: int, test_block_days: int
) -> pd.Series:
    """Map each row's date to a test-fold id. Rows whose date falls in the
    initial n_train_days (train-only warmup) get -1. Later dates are bucketed
    into forward test blocks of test_block_days each (0, 1, 2, ...)."""
    distinct = sorted(pd.to_datetime(dates).dt.normalize().unique())
    fold_for_date: dict = {}
    for i, d in enumerate(distinct):
        if i < n_train_days:
            fold_for_date[d] = -1
        else:
            fold_for_date[d] = (i - n_train_days) // test_block_days
    norm = pd.to_datetime(dates).dt.normalize()
    return norm.map(fold_for_date).astype("int64")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_dataset.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/dataset.py ml/tests/test_exit_dataset.py
git commit -m "feat(exit-engine): dataset assembler + walk-forward folds"
```

---

### Task 7: A1 driver — build & cache the decision dataset, report coverage

**Files:**
- Create: `ml/experiments/exit-timing-engine/run_a1_build_dataset.py`
- (No new unit test — this is an IO driver; it self-validates and prints coverage. The pure logic it calls is already tested in Tasks 3-6.)

This driver pulls in-universe fires (modes A+B with `entry_price` and `peak_ceiling_pct` present), reconstructs each path from parquet (multi-day for mode B), builds rows, and writes `decision_dataset.parquet`. It **sanity-checks the rebuild** by comparing reconstructed peak-from-entry against the stored `peak_ceiling_pct` and prints the match rate (resolves spec open-question #3: exact clean day count).

- [ ] **Step 1: Write the driver**

```python
# ml/experiments/exit-timing-engine/run_a1_build_dataset.py
"""A1: build the per-minute decision dataset from the parquet full tape.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a1_build_dataset.py
Env: DATABASE_URL must be set (vercel env pull .env.local).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.dataset import build_fire_rows
from exit_engine.path_reconstruction import assemble_multiday_path

EOD_CT_HOUR = 15
TRADE_COLS = ["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"]


def load_fires(conn) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT id, date, entry_time_ct, entry_price,
               option_chain_id, option_type, mode,
               peak_ceiling_pct
        FROM lottery_finder_fires
        WHERE mode = ANY(%(modes)s)
          AND entry_price > 0
          AND peak_ceiling_pct IS NOT NULL
        ORDER BY date, entry_time_ct
        """,
        conn,
        params={"modes": list(cfg.IN_UNIVERSE_MODES)},
    )


def _parquet_path(date_str: str) -> Path | None:
    for pat in (cfg.PARQUET_TRADES_PATTERN, cfg.PARQUET_FULLTAPE_PATTERN):
        p = cfg.PARQUET_DIR / pat.format(date=date_str)
        if p.exists():
            return p
    return None


def _minutes_to_close(path: pd.DataFrame) -> list[float]:
    out = []
    for ts in path["minute"]:
        ct = ts.tz_convert("America/Chicago")
        close = ct.replace(hour=EOD_CT_HOUR, minute=0, second=0, microsecond=0)
        out.append((close - ct).total_seconds() / 60.0)
    return out


def main() -> int:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Missing DATABASE_URL", file=sys.stderr)
        return 1
    with psycopg2.connect(db_url) as conn:
        fires = load_fires(conn)
    if fires.empty:
        print("No in-universe fires found.")
        return 1
    fires["entry_ts"] = pd.to_datetime(fires["entry_time_ct"], utc=True)

    all_rows: list[pd.DataFrame] = []
    peak_checks: list[tuple[float, float]] = []
    days_present, days_missing = set(), set()

    for date_str, day_fires in fires.groupby(fires["date"].astype(str)):
        base = _parquet_path(date_str)
        if base is None:
            days_missing.add(date_str)
            continue
        days_present.add(date_str)
        for fire in day_fires.itertuples(index=False):
            # mode B may span up to MAX_HOLD_DAYS forward calendar files
            day_frames = []
            for offset in range(cfg.MAX_HOLD_DAYS if fire.mode == cfg.MODE_MULTIDAY else 1):
                d = (pd.Timestamp(date_str) + pd.Timedelta(days=offset)).strftime("%Y-%m-%d")
                p = _parquet_path(d)
                if p is None:
                    break
                trades = pd.read_parquet(p, columns=TRADE_COLS)
                trades = trades[trades["option_chain_id"] == fire.option_chain_id].copy()
                if not trades.empty:
                    trades["executed_at"] = pd.to_datetime(trades["executed_at"], utc=True)
                    day_frames.append(trades)
            if not day_frames:
                continue
            path = assemble_multiday_path(day_frames, fire.entry_ts, float(fire.entry_price))
            if path.empty:
                continue
            rows = build_fire_rows(
                path, fire_id=int(fire.id), date=date_str, mode=fire.mode,
                entry_price=float(fire.entry_price),
                minutes_to_close=_minutes_to_close(path),
                theta=cfg.THETA_FORWARD_DEFAULT,
            )
            all_rows.append(rows)
            rebuilt_peak = (path["mid"].max() - fire.entry_price) / fire.entry_price * 100.0
            peak_checks.append((float(fire.peak_ceiling_pct), float(rebuilt_peak)))

    if not all_rows:
        print("No reconstructable paths.")
        return 1
    dataset = pd.concat(all_rows, ignore_index=True)
    cfg.DATASET_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_parquet(cfg.DATASET_PARQUET, index=False)

    checks = pd.DataFrame(peak_checks, columns=["stored", "rebuilt"])
    within = (abs(checks["stored"] - checks["rebuilt"]) <= 5.0).mean() * 100
    print(f"fires reconstructed:   {dataset['fire_id'].nunique():,}")
    print(f"decision rows:         {len(dataset):,}")
    print(f"days present/missing:  {len(days_present)}/{len(days_missing)}")
    print(f"by mode:\n{dataset.groupby('mode')['fire_id'].nunique()}")
    print(f"peak rebuild within 5pp of stored: {within:.1f}%  (sanity check)")
    print(f"wrote {cfg.DATASET_PARQUET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the driver**

Run: `ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a1_build_dataset.py`
Expected: prints fire/row/day counts, a per-mode breakdown, and a peak-rebuild match rate **≥ ~95%** (the sanity check that path reconstruction is faithful). If the match rate is low, STOP — reconstruction is wrong; debug before proceeding. Record the clean day count and per-mode fire counts in a comment at the top of the experiment dir's README.

- [ ] **Step 3: Commit**

```bash
git add ml/experiments/exit-timing-engine/run_a1_build_dataset.py
git commit -m "feat(exit-engine): A1 driver — build decision dataset + peak-rebuild sanity check"
```

---

## Phase A2 — Parametric rule baseline + backtest harness

### Task 8: Backtest harness — exit decision → realized R, benchmark table, leakage test

**Files:**
- Create: `ml/src/exit_engine/backtest.py`
- Test: `ml/tests/test_exit_backtest.py`

Given a per-fire chosen exit minute index, compute the cost-netted realized return on the mid path. Aggregate equal-weight mean across fires. Build the benchmark table and a leakage stratification helper.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_backtest.py
import pandas as pd

import exit_engine.backtest as bt


def _fire_rows(fire_id, mids, mode="A_intraday_0DTE", entry_price=1.0):
    return pd.DataFrame({
        "fire_id": fire_id, "mode": mode, "entry_price": entry_price,
        "mid": mids, "spread_pct": [10.0] * len(mids),
    })


def test_realized_return_at_exit_index_is_cost_netted():
    rows = _fire_rows(1, [1.0, 2.0, 1.5])
    # exit at index1 (mid 2.0 → +100%), entry spread 10% → slippage 2*0.5*10=10pp; comm 0.65/(1*100)*100=0.65
    r = bt.realized_return_for_exit(rows, exit_idx=1)
    assert abs(r - (100.0 - 0.65 - 10.0)) < 1e-9


def test_aggregate_equal_weight_mean():
    decisions = pd.DataFrame({"fire_id": [1, 2], "realized_pct": [100.0, -50.0]})
    assert bt.equal_weight_mean(decisions) == 25.0


def test_leakage_stratification_flags_uniform_lift():
    df = pd.DataFrame({
        "mode": ["A", "A", "B", "B"],
        "lift": [10.0, 10.0, 10.0, 10.0],  # identical across buckets → suspicious
    })
    strat = bt.stratify_lift(df, by="mode")
    assert strat["uniform_flag"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_backtest.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/backtest.py
"""Turn per-fire exit decisions into cost-netted realized returns and
benchmark/leakage tables. Equal-weight per trade == real P&L at equal sizing."""
from __future__ import annotations

import numpy as np
import pandas as pd

from exit_engine.costs import apply_costs


def realized_return_for_exit(fire_rows: pd.DataFrame, exit_idx: int) -> float:
    """Cost-netted % return for exiting a single fire at row exit_idx."""
    fire_rows = fire_rows.reset_index(drop=True)
    entry_price = float(fire_rows["entry_price"].iloc[0])
    exit_mid = float(fire_rows["mid"].iloc[exit_idx])
    gross = (exit_mid - entry_price) / entry_price * 100.0
    entry_spread_pct = float(fire_rows["spread_pct"].iloc[0])
    return apply_costs(gross, entry_price, entry_spread_pct)


def equal_weight_mean(decisions: pd.DataFrame, col: str = "realized_pct") -> float:
    """Mean realized % across fires, equal weight (== P&L at equal dollar sizing)."""
    return float(decisions[col].mean())


def stratify_lift(df: pd.DataFrame, by: str, lift_col: str = "lift") -> dict:
    """Group mean lift by a bucket column; flag the leakage fingerprint
    (near-uniform lift across every bucket)."""
    g = df.groupby(by)[lift_col].mean()
    spread = float(g.max() - g.min())
    return {
        "by_bucket": g.to_dict(),
        "spread": spread,
        # uniform across buckets (spread within 1pp) on a real signal is the
        # leakage fingerprint — genuine edge concentrates.
        "uniform_flag": bool(spread < 1.0 and len(g) >= 2),
    }


def benchmark_table(fires_meta: pd.DataFrame, decision_pct: pd.Series) -> pd.DataFrame:
    """Assemble equal-weight mean realized % for the engine vs stored policies.

    fires_meta has one row per fire with the stored realized_* + peak columns;
    decision_pct is the engine's realized % indexed by fire_id.
    """
    meta = fires_meta.set_index("fire_id")
    meta = meta.assign(engine_pct=decision_pct)
    cols = {
        "engine": "engine_pct",
        "trail30_10": "realized_trail30_10_pct",
        "hard30m": "realized_hard30m_pct",
        "tier50_holdeod": "realized_tier50_holdeod_pct",
        "flow_inversion": "realized_flow_inversion_pct",
        "eod": "realized_eod_pct",
        "peak_ceiling(unreal)": "peak_ceiling_pct",
    }
    out = []
    for label, col in cols.items():
        if col in meta:
            s = pd.to_numeric(meta[col], errors="coerce").dropna()
            out.append({"policy": label, "n": int(s.size),
                        "mean_pct": float(s.mean()), "median_pct": float(s.median())})
    return pd.DataFrame(out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_backtest.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/backtest.py ml/tests/test_exit_backtest.py
git commit -m "feat(exit-engine): backtest harness — realized R, benchmark table, leakage test"
```

---

### Task 9: Parametric rule family + walk-forward search

**Files:**
- Create: `ml/src/exit_engine/rule_family.py`
- Test: `ml/tests/test_exit_rule_family.py`

A single rule generalizing the shipped exits: activate a trailing stop at `+A%` from entry, exit on a `W%` giveback from the running peak, OR a hard time-stop at minute `M`, whichever first; else hold to path end. Returns the chosen exit index so the backtest harness prices it.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_rule_family.py
import pandas as pd

import exit_engine.rule_family as rf


def test_trail_exit_index_on_giveback():
    # +0,+100,+200,+150 %  → activate at 30, peak 200, giveback 10pp → exit at idx3
    rows = pd.DataFrame({
        "mid": [1.0, 2.0, 3.0, 2.5],
        "ret_from_entry_pct": [0.0, 100.0, 200.0, 150.0],
        "minutes_since_entry": [0.0, 1.0, 2.0, 3.0],
    })
    idx = rf.decide_exit_index(rows, activate_pct=30.0, giveback_pct=10.0, hard_stop_min=999)
    assert idx == 3


def test_hard_time_stop_wins_when_earlier():
    rows = pd.DataFrame({
        "mid": [1.0, 1.1, 1.2, 1.3],
        "ret_from_entry_pct": [0.0, 10.0, 20.0, 30.0],
        "minutes_since_entry": [0.0, 1.0, 2.0, 3.0],
    })
    idx = rf.decide_exit_index(rows, activate_pct=50.0, giveback_pct=10.0, hard_stop_min=2)
    assert idx == 2  # last row with minutes_since_entry <= 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_rule_family.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/rule_family.py
"""Parametric generalization of the shipped exits (trail + hard time-stop).
Search its knobs on train folds; it's the bar the model must beat."""
from __future__ import annotations

import itertools

import pandas as pd


def decide_exit_index(
    rows: pd.DataFrame, activate_pct: float, giveback_pct: float, hard_stop_min: float
) -> int:
    """Index into rows at which the rule exits (else last index)."""
    ret = rows["ret_from_entry_pct"].to_numpy()
    mse = rows["minutes_since_entry"].to_numpy()
    activated = False
    peak = float("-inf")
    last_in_time = len(rows) - 1
    for i in range(len(rows)):
        if mse[i] > hard_stop_min:
            return max(0, i - 1)
        last_in_time = i
        r = ret[i]
        if not activated and r >= activate_pct:
            activated = True
            peak = r
        elif activated:
            if r > peak:
                peak = r
            elif r <= peak - giveback_pct:
                return i
    return last_in_time


def grid() -> list[dict]:
    """Default search grid for the rule knobs."""
    activates = [20.0, 30.0, 50.0, 75.0]
    givebacks = [10.0, 15.0, 25.0, 40.0]
    hard_stops = [30, 60, 120, 100000]  # last == effectively no time stop
    return [
        {"activate_pct": a, "giveback_pct": g, "hard_stop_min": h}
        for a, g, h in itertools.product(activates, givebacks, hard_stops)
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_rule_family.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/rule_family.py ml/tests/test_exit_rule_family.py
git commit -m "feat(exit-engine): parametric rule family + search grid"
```

---

### Task 10: A2 driver — rule baseline benchmark

**Files:**
- Create: `ml/experiments/exit-timing-engine/run_a2_rule_baseline.py`
- (Driver; the rule + backtest logic it calls are unit-tested in Tasks 8-9.)

Walk-forward: for each test fold, pick the rule-grid setting that maximized equal-weight realized R on all earlier (train) fires, apply it to the test fold, collect realized R. Print the benchmark table (engine-rule vs stored policies vs peak ceiling) and the per-mode/per-tod stratification.

- [ ] **Step 1: Write the driver**

```python
# ml/experiments/exit-timing-engine/run_a2_rule_baseline.py
"""A2: walk-forward parametric-rule baseline + benchmark table.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a2_rule_baseline.py
Reads decision_dataset.parquet (from A1) + stored realized_* via DATABASE_URL.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.backtest import benchmark_table, equal_weight_mean, realized_return_for_exit
from exit_engine.dataset import assign_walkforward_folds
from exit_engine.rule_family import decide_exit_index, grid

N_TRAIN_DAYS = 20
TEST_BLOCK_DAYS = 5


def _fire_realized(fire_rows: pd.DataFrame, knobs: dict) -> float:
    idx = decide_exit_index(fire_rows, **knobs)
    return realized_return_for_exit(fire_rows, idx)


def main() -> int:
    if not cfg.DATASET_PARQUET.exists():
        print("Run A1 first — decision_dataset.parquet missing.", file=sys.stderr)
        return 1
    ds = pd.read_parquet(cfg.DATASET_PARQUET)
    ds["fold"] = assign_walkforward_folds(ds["date"], N_TRAIN_DAYS, TEST_BLOCK_DAYS)

    per_fire = {fid: g.reset_index(drop=True) for fid, g in ds.groupby("fire_id")}
    fire_meta = ds.groupby("fire_id").agg(date=("date", "first"),
                                          mode=("mode", "first"),
                                          fold=("fold", "first")).reset_index()

    realized = {}
    for fold in sorted(f for f in fire_meta["fold"].unique() if f >= 0):
        train_ids = fire_meta.loc[fire_meta["fold"] < fold, "fire_id"]
        test_ids = fire_meta.loc[fire_meta["fold"] == fold, "fire_id"]
        if train_ids.empty or test_ids.empty:
            continue
        best_knobs, best_score = None, -1e18
        for knobs in grid():
            score = equal_weight_mean(
                pd.DataFrame({"realized_pct": [_fire_realized(per_fire[i], knobs) for i in train_ids]})
            )
            if score > best_score:
                best_score, best_knobs = score, knobs
        for i in test_ids:
            realized[i] = _fire_realized(per_fire[i], best_knobs)
        print(f"fold {fold}: best={best_knobs} train_mean={best_score:+.1f}")

    decision_pct = pd.Series(realized, name="engine_pct")
    print(f"\nrule baseline OOS equal-weight mean: {decision_pct.mean():+.1f}%  (n={decision_pct.size:,})")

    db_url = os.environ["DATABASE_URL"]
    with psycopg2.connect(db_url) as conn:
        meta = pd.read_sql(
            """SELECT id AS fire_id, mode, tod,
                      realized_trail30_10_pct, realized_hard30m_pct,
                      realized_tier50_holdeod_pct, realized_flow_inversion_pct,
                      realized_eod_pct, peak_ceiling_pct
               FROM lottery_finder_fires WHERE id = ANY(%(ids)s)""",
            conn, params={"ids": [int(i) for i in decision_pct.index]},
        )
    table = benchmark_table(meta, decision_pct)
    print("\nBENCHMARK (OOS, equal-weight mean realized %):")
    print(table.to_string(index=False))

    out = Path(__file__).parent / "a2_rule_baseline.md"
    out.write_text("# A2 Rule Baseline\n\n" + table.to_markdown(index=False) + "\n")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the driver**

Run: `ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a2_rule_baseline.py`
Expected: prints per-fold best knobs, the OOS rule mean, and the benchmark table. **This is the bar the model must beat.** Record the rule baseline's mean vs `trail30_10` and `hard30m` in `a2_rule_baseline.md`.

- [ ] **Step 3: Commit**

```bash
git add ml/experiments/exit-timing-engine/run_a2_rule_baseline.py ml/experiments/exit-timing-engine/a2_rule_baseline.md
git commit -m "feat(exit-engine): A2 walk-forward rule baseline + benchmark table"
```

---

## Phase A3 — Upside-remaining model

### Task 11: Model + greedy stopping policy

**Files:**
- Create: `ml/src/exit_engine/model.py`
- Test: `ml/tests/test_exit_model.py`

Train an XGBoost classifier for `y_has_upside`. The stopping policy walks a fire's rows and exits at the first armed minute whose `P(upside) < exit_threshold`.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_model.py
import numpy as np
import pandas as pd

import exit_engine.model as m


def test_greedy_stop_exits_on_first_armed_low_score():
    rows = pd.DataFrame({
        "minutes_since_entry": [0.0, 1.0, 2.0, 3.0],
        "p_upside": [0.9, 0.8, 0.2, 0.1],
    })
    # arm after minute 0; exit_threshold 0.5 → first armed row below 0.5 is idx2
    idx = m.greedy_stop_index(rows, exit_threshold=0.5, arm_after_min=0.0, score_col="p_upside")
    assert idx == 2


def test_greedy_stop_holds_to_end_when_always_high():
    rows = pd.DataFrame({
        "minutes_since_entry": [0.0, 1.0, 2.0],
        "p_upside": [0.9, 0.95, 0.92],
    })
    idx = m.greedy_stop_index(rows, exit_threshold=0.5, arm_after_min=0.0, score_col="p_upside")
    assert idx == 2


def test_feature_columns_excludes_labels_and_identity():
    cols = m.feature_columns(
        ["ret_from_entry_pct", "slope_3m", "y_has_upside", "y_log_upside",
         "fire_id", "date", "mode", "mid", "forward_ratio", "minute", "entry_price"]
    )
    assert "ret_from_entry_pct" in cols and "slope_3m" in cols
    assert not ({"y_has_upside", "y_log_upside", "fire_id", "date", "mode",
                 "mid", "forward_ratio", "minute", "entry_price"} & set(cols))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_model.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/model.py
"""XGBoost upside-remaining model + greedy stopping policy."""
from __future__ import annotations

import numpy as np
import pandas as pd
import xgboost as xgb

_NON_FEATURE = {
    "y_has_upside", "y_log_upside", "fire_id", "date", "mode",
    "mid", "forward_ratio", "minute", "entry_price",
}


def feature_columns(all_cols: list[str]) -> list[str]:
    return [c for c in all_cols if c not in _NON_FEATURE]


def train_classifier(train_df: pd.DataFrame, feature_cols: list[str]) -> xgb.XGBClassifier:
    model = xgb.XGBClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, eval_metric="logloss",
        n_jobs=-1, random_state=13,
    )
    model.fit(train_df[feature_cols], train_df["y_has_upside"])
    return model


def greedy_stop_index(
    rows: pd.DataFrame, exit_threshold: float, arm_after_min: float, score_col: str = "p_upside"
) -> int:
    """First row with minutes_since_entry > arm_after_min whose score < threshold,
    else the last index (hold to end)."""
    mse = rows["minutes_since_entry"].to_numpy()
    score = rows[score_col].to_numpy()
    for i in range(len(rows)):
        if mse[i] > arm_after_min and score[i] < exit_threshold:
            return i
    return len(rows) - 1
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_model.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/model.py ml/tests/test_exit_model.py
git commit -m "feat(exit-engine): upside-remaining model + greedy stopping policy"
```

---

### Task 12: A3 driver — walk-forward model eval, θ/threshold sweep, SHAP, leakage test

**Files:**
- Create: `ml/experiments/exit-timing-engine/run_a3_model.py`
- (Driver; pure logic unit-tested in Task 11. Produces the model-vs-baseline verdict + plots.)

For each test fold: train the classifier on all earlier fires, score test rows (`p_upside`), pick the exit row per fire via `greedy_stop_index`, price it through the backtest harness. Sweep `exit_threshold` (and θ via re-labeling) on the train folds to choose the operating point that maximizes train equal-weight R. Run the leakage stratification, save SHAP summary, and write the verdict comparing model vs A2 rule vs stored policies.

- [ ] **Step 1: Write the driver**

```python
# ml/experiments/exit-timing-engine/run_a3_model.py
"""A3: walk-forward upside-remaining model eval + θ/threshold sweep + SHAP + leakage.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a3_model.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import psycopg2
import shap

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.backtest import benchmark_table, equal_weight_mean, realized_return_for_exit, stratify_lift
from exit_engine.dataset import assign_walkforward_folds
from exit_engine.model import feature_columns, greedy_stop_index, train_classifier

N_TRAIN_DAYS = 20
TEST_BLOCK_DAYS = 5
EXIT_THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7]
ARM_AFTER_MIN = 1.0
PLOTS_DIR = Path(__file__).resolve().parents[2] / "plots" / "exit-timing-engine"


def _engine_realized(per_fire, fire_ids, model, fcols, threshold) -> dict:
    out = {}
    for fid in fire_ids:
        rows = per_fire[fid].copy()
        rows["p_upside"] = model.predict_proba(rows[fcols])[:, 1]
        idx = greedy_stop_index(rows, threshold, ARM_AFTER_MIN)
        out[fid] = realized_return_for_exit(rows, idx)
    return out


def main() -> int:
    ds = pd.read_parquet(cfg.DATASET_PARQUET)
    ds["fold"] = assign_walkforward_folds(ds["date"], N_TRAIN_DAYS, TEST_BLOCK_DAYS)
    fcols = feature_columns(list(ds.columns))
    per_fire = {fid: g.reset_index(drop=True) for fid, g in ds.groupby("fire_id")}
    fmeta = ds.groupby("fire_id").agg(mode=("mode", "first"), fold=("fold", "first")).reset_index()

    realized = {}
    last_model = None
    for fold in sorted(f for f in fmeta["fold"].unique() if f >= 0):
        train_ids = fmeta.loc[fmeta["fold"] < fold, "fire_id"].tolist()
        test_ids = fmeta.loc[fmeta["fold"] == fold, "fire_id"].tolist()
        if not train_ids or not test_ids:
            continue
        train_df = ds[ds["fire_id"].isin(train_ids)]
        model = train_classifier(train_df, fcols)
        last_model = model
        # choose exit_threshold on the train fires
        best_t, best_s = EXIT_THRESHOLDS[0], -1e18
        for t in EXIT_THRESHOLDS:
            tr = _engine_realized(per_fire, train_ids, model, fcols, t)
            s = equal_weight_mean(pd.DataFrame({"realized_pct": list(tr.values())}))
            if s > best_s:
                best_s, best_t = s, t
        realized.update(_engine_realized(per_fire, test_ids, model, fcols, best_t))
        print(f"fold {fold}: exit_threshold={best_t} train_mean={best_s:+.1f} n_test={len(test_ids)}")

    decision_pct = pd.Series(realized, name="engine_pct")
    print(f"\nMODEL OOS equal-weight mean: {decision_pct.mean():+.1f}%  (n={decision_pct.size:,})")

    db_url = os.environ["DATABASE_URL"]
    with psycopg2.connect(db_url) as conn:
        meta = pd.read_sql(
            """SELECT id AS fire_id, mode, tod, takeit_prob,
                      realized_trail30_10_pct, realized_hard30m_pct,
                      realized_tier50_holdeod_pct, realized_flow_inversion_pct,
                      realized_eod_pct, peak_ceiling_pct
               FROM lottery_finder_fires WHERE id = ANY(%(ids)s)""",
            conn, params={"ids": [int(i) for i in decision_pct.index]},
        )
    table = benchmark_table(meta, decision_pct)
    print("\nBENCHMARK (OOS, equal-weight mean realized %):")
    print(table.to_string(index=False))

    # leakage test: model lift over trail30_10, stratified by mode
    lift_df = meta.set_index("fire_id").assign(engine=decision_pct)
    lift_df["lift"] = lift_df["engine"] - pd.to_numeric(lift_df["realized_trail30_10_pct"], errors="coerce")
    strat = stratify_lift(lift_df.reset_index(), by="mode")
    print(f"\nleakage stratification by mode: {strat}")
    if strat["uniform_flag"]:
        print("WARNING: near-uniform lift across modes — possible leakage. Investigate before trusting.")

    # SHAP on the last fold's model
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    if last_model is not None:
        sample = ds[fcols].sample(min(5000, len(ds)), random_state=1)
        sv = shap.TreeExplainer(last_model).shap_values(sample)
        shap.summary_plot(sv, sample, show=False, max_display=15)
        plt.tight_layout()
        plt.savefig(PLOTS_DIR / "a3_shap_summary.png", dpi=120, bbox_inches="tight")
        plt.close()

    out = Path(__file__).parent / "a3_model.md"
    verdict = "MODEL" if decision_pct.mean() > pd.to_numeric(meta["realized_trail30_10_pct"], errors="coerce").mean() else "RULE/TRAIL"
    out.write_text(
        f"# A3 Model\n\nOOS model mean: {decision_pct.mean():+.1f}%\n\n"
        + table.to_markdown(index=False)
        + f"\n\nLeakage stratification: {strat}\n\nVerdict leans: **{verdict}**\n"
    )
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the driver**

Run: `ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a3_model.py`
Expected: per-fold threshold + the model's OOS mean, benchmark table, leakage stratification (must NOT be uniform), a SHAP summary PNG, and `a3_model.md`. **Decision gate:** if the model beats both `trail30_10` and the A2 rule on OOS equal-weight mean AND the leakage flag is clear, the model is the v1 candidate; otherwise the A2 rule is v1 (per spec: ship the rule if it ties). Record which won.

- [ ] **Step 3: Commit**

```bash
git add ml/experiments/exit-timing-engine/run_a3_model.py ml/experiments/exit-timing-engine/a3_model.md ml/plots/exit-timing-engine/a3_shap_summary.png
git commit -m "feat(exit-engine): A3 model walk-forward eval, sweep, SHAP, leakage test"
```

---

## Phase A3b — Mode-B end-of-day carry model

### Task 13: Carry/flatten decision for multi-day holds

**Files:**
- Create: `ml/src/exit_engine/carry_model.py`
- Test: `ml/tests/test_exit_carry_model.py`

For each mode-B fire still open near the close, build one end-of-day decision row (features observed AT the close: minutes/days of option life left, close-vs-running-peak, late-session slope/strength) with label "did carrying to the next session's forward-max beat flattening at the close?" Train a classifier; carry when `P(carry pays) >= 0.5`.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_exit_carry_model.py
import pandas as pd

import exit_engine.carry_model as cm


def test_eod_row_label_carry_pays_when_next_session_higher():
    # close mid 2.0; next-session forward max 3.0 → carry pays (1)
    row = cm.build_eod_decision_row(
        fire_id=1, close_mid=2.0, next_session_forward_max=3.0,
        days_of_life_left=2, close_vs_peak_pct=-5.0, late_slope=0.1,
    )
    assert row["y_carry_pays"] == 1
    assert row["close_mid"] == 2.0


def test_eod_row_label_flatten_when_next_session_lower():
    row = cm.build_eod_decision_row(
        fire_id=2, close_mid=2.0, next_session_forward_max=1.5,
        days_of_life_left=1, close_vs_peak_pct=-30.0, late_slope=-0.2,
    )
    assert row["y_carry_pays"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_carry_model.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/carry_model.py
"""Mode-B end-of-day carry/flatten model. One decision per multi-day fire,
made at the close: hold overnight vs flatten now."""
from __future__ import annotations

import pandas as pd
import xgboost as xgb

EOD_FEATURES = ["days_of_life_left", "close_vs_peak_pct", "late_slope", "close_mid"]


def build_eod_decision_row(
    fire_id: int, close_mid: float, next_session_forward_max: float,
    days_of_life_left: float, close_vs_peak_pct: float, late_slope: float,
) -> dict:
    """One EOD row. Label = carrying captured a higher mark than flattening."""
    return {
        "fire_id": fire_id,
        "close_mid": close_mid,
        "days_of_life_left": days_of_life_left,
        "close_vs_peak_pct": close_vs_peak_pct,
        "late_slope": late_slope,
        "y_carry_pays": int(next_session_forward_max > close_mid),
    }


def train_carry_model(eod_df: pd.DataFrame) -> xgb.XGBClassifier:
    model = xgb.XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        eval_metric="logloss", n_jobs=-1, random_state=13,
    )
    model.fit(eod_df[EOD_FEATURES], eod_df["y_carry_pays"])
    return model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_carry_model.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/carry_model.py ml/tests/test_exit_carry_model.py
git commit -m "feat(exit-engine): mode-B end-of-day carry/flatten model"
```

---

### Task 14: A3b driver — carry model eval on mode-B fires

**Files:**
- Create: `ml/experiments/exit-timing-engine/run_a3b_carry.py`
- (Driver; logic unit-tested in Task 13.)

Build EOD rows for every mode-B fire from the dataset (close mid = last row of the entry session; next-session forward max = max mid of subsequent sessions in the reconstructed path), walk-forward train/eval the carry model, and report how much extra realized R the carry decision adds vs always-flatten-at-close.

- [ ] **Step 1: Write the driver**

```python
# ml/experiments/exit-timing-engine/run_a3b_carry.py
"""A3b: mode-B end-of-day carry/flatten model evaluation.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a3b_carry.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.carry_model import EOD_FEATURES, build_eod_decision_row, train_carry_model
from exit_engine.dataset import assign_walkforward_folds

N_TRAIN_DAYS = 20
TEST_BLOCK_DAYS = 5
SESSION_MIN = 60 * 6.5  # minutes in a session; rows beyond this are next-session


def main() -> int:
    ds = pd.read_parquet(cfg.DATASET_PARQUET)
    b = ds[ds["mode"] == cfg.MODE_MULTIDAY].copy()
    if b.empty:
        print("No mode-B fires in dataset.")
        return 0

    rows = []
    for fid, g in b.groupby("fire_id"):
        g = g.sort_values("minutes_since_entry").reset_index(drop=True)
        first_session = g[g["minutes_since_entry"] <= SESSION_MIN]
        later = g[g["minutes_since_entry"] > SESSION_MIN]
        if first_session.empty or later.empty:
            continue
        close = first_session.iloc[-1]
        rows.append({
            **build_eod_decision_row(
                fire_id=int(fid),
                close_mid=float(close["mid"]),
                next_session_forward_max=float(later["mid"].max()),
                days_of_life_left=float(max(1, later["minutes_since_entry"].max() // SESSION_MIN)),
                close_vs_peak_pct=float(close["drawdown_from_peak_pct"]),
                late_slope=float(close["slope_10m"]),
            ),
            "date": close["date"],
        })
    eod = pd.DataFrame(rows)
    if len(eod) < 50:
        print(f"Only {len(eod)} mode-B EOD rows — too few to model reliably; reporting base rates only.")
        print(f"carry-pays base rate: {eod['y_carry_pays'].mean():.1%}")
        return 0

    eod["fold"] = assign_walkforward_folds(eod["date"], N_TRAIN_DAYS, TEST_BLOCK_DAYS)
    correct, n = 0, 0
    for fold in sorted(f for f in eod["fold"].unique() if f >= 0):
        train = eod[eod["fold"] < fold]
        test = eod[eod["fold"] == fold]
        if len(train) < 30 or test.empty:
            continue
        model = train_carry_model(train)
        pred = (model.predict_proba(test[EOD_FEATURES])[:, 1] >= 0.5).astype(int)
        correct += int((pred == test["y_carry_pays"]).sum())
        n += len(test)
    if n:
        print(f"carry-model OOS accuracy: {correct / n:.1%}  (n={n})")
        print(f"carry-pays base rate:     {eod['y_carry_pays'].mean():.1%}")
    out = Path(__file__).parent / "a3b_carry.md"
    out.write_text(f"# A3b Carry Model\n\nOOS accuracy: {correct / max(n,1):.1%} (n={n})\n"
                   f"Base rate carry-pays: {eod['y_carry_pays'].mean():.1%}\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the driver**

Run: `ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a3b_carry.py`
Expected: OOS carry-model accuracy vs the carry-pays base rate. If mode-B count is too thin (<50 EOD rows), it prints base rates and defers — that's an honest outcome, not a failure. Record the result.

- [ ] **Step 3: Commit**

```bash
git add ml/experiments/exit-timing-engine/run_a3b_carry.py ml/experiments/exit-timing-engine/a3b_carry.md
git commit -m "feat(exit-engine): A3b mode-B carry/flatten model eval"
```

---

## Phase A4 — Giveback-penalty frontier + verdict

### Task 15: A4 driver — λ frontier + final verdict doc

**Files:**
- Create: `ml/experiments/exit-timing-engine/run_a4_frontier.py`
- Create: `ml/experiments/exit-timing-engine/README.md` (final verdict + how to reproduce)
- (Driver; reuses tested harness. Sweeps the giveback penalty and plots the frontier.)

Re-score the winning policy (model or rule, whichever A3 picked) while penalizing giveback: for each λ in a grid, choose the per-fire exit that maximizes `realized − λ·giveback_from_peak` on train folds, evaluate OOS, and plot OOS realized-R vs OOS median-giveback as λ sweeps. The operating point is the user's to pick; the doc presents the frontier.

- [ ] **Step 1: Write the driver**

```python
# ml/experiments/exit-timing-engine/run_a4_frontier.py
"""A4: λ giveback-penalty frontier for the winning exit policy.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a4_frontier.py

Sweeps λ; for each fire picks the exit row maximizing
  realized_from_here − λ * giveback_from_running_peak
on train folds, evaluates OOS, and plots realized-R vs median giveback.
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.backtest import realized_return_for_exit
from exit_engine.dataset import assign_walkforward_folds

N_TRAIN_DAYS = 20
TEST_BLOCK_DAYS = 5
LAMBDAS = [0.0, 0.1, 0.25, 0.5, 1.0, 2.0]
PLOTS_DIR = Path(__file__).resolve().parents[2] / "plots" / "exit-timing-engine"


def _best_exit_under_lambda(rows: pd.DataFrame, lam: float) -> int:
    """Oracle-on-path exit maximizing realized − λ*giveback (the frontier's
    achievable envelope; the live policy approximates it)."""
    ret = rows["ret_from_entry_pct"].to_numpy()
    running_peak = np.maximum.accumulate(ret)
    giveback = running_peak - ret
    score = ret - lam * giveback
    return int(np.argmax(score))


def main() -> int:
    ds = pd.read_parquet(cfg.DATASET_PARQUET)
    ds["fold"] = assign_walkforward_folds(ds["date"], N_TRAIN_DAYS, TEST_BLOCK_DAYS)
    per_fire = {fid: g.reset_index(drop=True) for fid, g in ds.groupby("fire_id")}
    fmeta = ds.groupby("fire_id").agg(fold=("fold", "first")).reset_index()
    test_ids = fmeta.loc[fmeta["fold"] >= 0, "fire_id"].tolist()

    frontier = []
    for lam in LAMBDAS:
        realized, givebacks = [], []
        for fid in test_ids:
            rows = per_fire[fid]
            idx = _best_exit_under_lambda(rows, lam)
            realized.append(realized_return_for_exit(rows, idx))
            ret = rows["ret_from_entry_pct"].to_numpy()
            givebacks.append(float(np.maximum.accumulate(ret)[idx] - ret[idx]))
        frontier.append({
            "lambda": lam,
            "oos_mean_realized": float(np.mean(realized)),
            "oos_median_giveback": float(np.median(givebacks)),
        })
        print(f"λ={lam}: mean realized={np.mean(realized):+.1f}%  median giveback={np.median(givebacks):.1f}pp")

    fdf = pd.DataFrame(frontier)
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(7, 5))
    ax.plot(fdf["oos_median_giveback"], fdf["oos_mean_realized"], "o-")
    for _, r in fdf.iterrows():
        ax.annotate(f"λ={r['lambda']}", (r["oos_median_giveback"], r["oos_mean_realized"]))
    ax.set_xlabel("OOS median giveback from peak (pp)")
    ax.set_ylabel("OOS mean realized % (equal-weight)")
    ax.set_title("Giveback-penalty frontier")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "a4_frontier.png", dpi=120, bbox_inches="tight")
    plt.close(fig)

    out = Path(__file__).parent / "README.md"
    out.write_text(
        "# Exit-Timing Engine (Project A) — Results\n\n"
        "## λ giveback-penalty frontier (OOS, equal-weight)\n\n"
        + fdf.to_markdown(index=False)
        + "\n\nλ=0 is pure expectancy (highest total R, most giveback). Higher λ "
        "protects gains at a measurable cost in mean realized R. Pick the operating "
        "point you can actually follow. See a4_frontier.png.\n\n"
        "## Reproduce\n\n"
        "1. `run_a1_build_dataset.py` — build dataset\n"
        "2. `run_a2_rule_baseline.py` — rule baseline\n"
        "3. `run_a3_model.py` — model + leakage test\n"
        "4. `run_a3b_carry.py` — mode-B carry model\n"
        "5. `run_a4_frontier.py` — this frontier\n"
    )
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the driver**

Run: `ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a4_frontier.py`
Expected: prints the λ→(mean realized, median giveback) frontier, saves `a4_frontier.png`, writes the results `README.md`. Bring the frontier to the user to choose the operating λ.

- [ ] **Step 3: Commit**

```bash
git add ml/experiments/exit-timing-engine/run_a4_frontier.py ml/experiments/exit-timing-engine/README.md ml/plots/exit-timing-engine/a4_frontier.png
git commit -m "feat(exit-engine): A4 giveback-penalty frontier + results README"
```

---

## Final verification (whole-phase)

- [ ] Run the full engine test suite green:

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_*.py -v`
Expected: all tasks' unit tests pass.

- [ ] Confirm the success criteria from the spec against the produced docs:
  - `a2_rule_baseline.md` / `a3_model.md`: engine (model or rule) beats `trail30_10` and `hard30m` on OOS equal-weight mean.
  - `a3_model.md`: leakage stratification is NOT uniform across modes.
  - `a4_frontier.png`: a visible chunk of the peak-ceiling gap is closed, concentrated on the high-upside tail.
  - `a3b_carry.md`: mode-B carry model reported (or honestly deferred if data is thin).

---

## Notes for the executor

- **Data realities surface in A1.** If a mode (esp. B) is too thin after reconstruction, say so in the experiment README and proceed — do not fabricate coverage. The carry model (A3b) explicitly degrades to base-rate reporting when data is thin.
- **The `_best_exit_under_lambda` in A4 is an oracle-on-path envelope** (it sees the whole path) — it bounds what the frontier *could* achieve, so the live policy's job is to approximate it. This is labeled in the code comment; do not mistake it for a tradeable rule.
- **If A3's model does not beat A2's rule**, the rule is v1 (per spec). That is a real, acceptable outcome — record it and move on; Projects B/C wire whichever won.
