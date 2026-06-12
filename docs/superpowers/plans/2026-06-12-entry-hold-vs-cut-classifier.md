# At-Entry Hold-vs-Cut Classifier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-fire model that predicts at entry whether a lottery/SB fire is a tail winner worth holding to close (`P(hold_eod_ret > trail30_10_ret)`), and a walk-forward policy backtest proving whether gating hold-vs-cut on that prediction beats always-hold and always-cut.

**Architecture:** One new feature module (`entry_features.py`) builds a one-row-per-fire dataset by collapsing the already-built per-minute path datasets (`decision_dataset/`, `decision_dataset_sb/`) to their entry tick + an on-path `hold`/`cut` label, then joining entry-known DB metadata. Two experiment drivers build the dataset (B1) and run the month walk-forward classifier + policy backtest (B2). Reuses `onpath_baselines`, `train_classifier`, `costs`, and the A2/A3 walk-forward pattern.

**Tech Stack:** Python 3.14, pandas, pyarrow, xgboost, scikit-learn (AUC), psycopg2 (DB metadata). Run via `ml/.venv/bin/python`.

---

### Task 1: `entry_features.py` — allow-lists, leakage guard, per-fire builder

**Files:**
- Create: `ml/src/exit_engine/entry_features.py`
- Test: `ml/tests/test_entry_features.py`

The module owns: (a) per-source entry-known feature allow-lists (verified against the live 84/62-col schemas), (b) a hard leakage assertion, (c) `build_entry_rows()` which collapses a path dataset to one row per fire with `hold_eod_ret`, `cut_ret`, `should_have_held`, entry-tick greeks, then joins DB metadata.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_entry_features.py
import numpy as np
import pandas as pd
import pytest

from exit_engine.entry_features import (
    assert_no_leakage,
    label_should_have_held,
    LEAKAGE_PATTERNS,
    build_entry_rows_from_path,
)


def _fire_path(fire_id, rets, entry_price=1.0, spread_pct=5.0):
    """Minimal per-minute path frame for one fire (mid derived from ret)."""
    rets = np.asarray(rets, dtype="float64")
    mid = entry_price * (1 + rets / 100.0)
    n = len(rets)
    return pd.DataFrame({
        "fire_id": fire_id,
        "date": "2026-02-03",
        "mode": "A_intraday_0DTE",
        "minutes_since_entry": np.arange(n, dtype="float64"),
        "ret_from_entry_pct": rets,
        "mid": mid,
        "entry_price": entry_price,
        "spread_pct": spread_pct,
        "iv_level": 0.5, "delta": 0.4, "gamma": 0.1,
        "otm_distance_pct": 2.0, "minutes_to_close": 300.0,
    })


def test_label_pop_then_fade_should_cut():
    # pops to +60 (trail arms at +30, exits ~+45 after 10pp giveback) then fades to +2 at EOD.
    path = _fire_path(1, [0, 60, 45, 2])
    out = label_should_have_held(path)
    assert out["cut_ret"] > out["hold_eod_ret"]
    assert out["should_have_held"] == 0


def test_label_monotonic_runner_should_hold():
    # rises straight to +200 at EOD; holding beats the trail giveback.
    path = _fire_path(2, [0, 40, 120, 200])
    out = label_should_have_held(path)
    assert out["hold_eod_ret"] > out["cut_ret"]
    assert out["should_have_held"] == 1


def test_label_tie_defaults_to_cut():
    # never arms (+30 never hit): hold == cut -> tie -> label 0.
    path = _fire_path(3, [0, 5, 10, 8])
    out = label_should_have_held(path)
    assert out["hold_eod_ret"] == pytest.approx(out["cut_ret"])
    assert out["should_have_held"] == 0


def test_assert_no_leakage_rejects_outcome_column():
    df = pd.DataFrame({"iv_level": [0.5], "realized_eod_pct": [12.0]})
    with pytest.raises(ValueError, match="leakage"):
        assert_no_leakage(df.columns.tolist())


def test_assert_no_leakage_passes_clean_frame():
    df = pd.DataFrame({"iv_level": [0.5], "score": [12], "should_have_held": [1]})
    assert_no_leakage(df.columns.tolist()) is None


def test_build_entry_rows_takes_entry_tick_greeks():
    # two fires; entry-tick (minutes_since_entry==0) greeks must be the row used.
    p1 = _fire_path(1, [0, 60, 45, 2]); p1.loc[0, "iv_level"] = 0.11
    p2 = _fire_path(2, [0, 40, 120, 200]); p2.loc[0, "iv_level"] = 0.22
    rows = build_entry_rows_from_path(pd.concat([p1, p2], ignore_index=True))
    by_id = rows.set_index("fire_id")
    assert by_id.loc[1, "iv_level"] == pytest.approx(0.11)
    assert by_id.loc[2, "iv_level"] == pytest.approx(0.22)
    assert by_id.loc[1, "should_have_held"] == 0
    assert by_id.loc[2, "should_have_held"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && ml/.venv/bin/python -m pytest ml/tests/test_entry_features.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'exit_engine.entry_features'`

- [ ] **Step 3: Write minimal implementation**

```python
# ml/src/exit_engine/entry_features.py
"""Build the one-row-per-fire entry dataset for the hold-vs-cut classifier.

Label is computed from the per-minute path (the on-path hold vs trail-30/10 returns,
mid basis, costs); features are entry-known only. See
docs/superpowers/specs/2026-06-12-entry-hold-vs-cut-classifier-design.md.
"""
from __future__ import annotations

import re

import pandas as pd

from exit_engine.onpath_policies import onpath_baselines

# Entry-tick feature columns carried from the path dataset (greeks/spread/context).
ENTRY_TICK_COLS = [
    "iv_level", "delta", "gamma", "otm_distance_pct", "spread_pct",
    "minutes_to_close", "entry_price",
]

# Entry-KNOWN DB metadata, verified against the live schema (no realized_/peak/forward cols).
LOTTERY_META_COLS = [
    "dte", "trigger_vol_to_oi_window", "trigger_vol_to_oi_cum", "trigger_iv",
    "trigger_delta", "trigger_ask_pct", "trigger_window_size", "trigger_window_prints",
    "open_interest", "spot_at_first", "alert_seq", "minutes_since_prev_fire",
    "burst_ratio_vs_prev", "entry_drop_pct_vs_prev", "mkt_tide_ncp", "mkt_tide_npp",
    "mkt_tide_diff", "mkt_tide_otm_diff", "spx_flow_diff", "spy_etf_diff", "qqq_etf_diff",
    "zero_dte_diff", "spx_spot_gamma_oi", "spx_spot_gamma_vol", "spx_spot_charm_oi",
    "spx_spot_vanna_oi", "gex_strike_call_minus_put", "gex_strike_call_ask_minus_bid",
    "gex_strike_put_ask_minus_bid", "range_pos_at_trigger", "cum_ncp_at_fire",
    "cum_npp_at_fire", "gamma_at_trigger", "score", "combined_score",
    "fire_count_score_adjustment", "cluster_bonus", "takeit_prob", "direction_gated",
    "reload_tagged", "cheap_call_pm_tagged", "flow_quad", "tod",
    "gex_one_cvroflow", "gex_net_put_dex", "gex_one_dexoflow", "gex_one_gexoflow",
    "gex_zcvr", "gex_zero_gamma", "gex_spot",
]
SB_META_COLS = [
    "dte", "spike_volume", "baseline_volume", "spike_ratio", "ask_pct", "vol_oi",
    "open_interest", "score", "score_tier", "combined_score", "mkt_tide_diff",
    "zero_dte_diff", "spx_spot_gamma_oi", "multi_leg_share", "mkt_tide_otm_diff",
    "direction_gated", "underlying_price_at_spike", "takeit_prob", "cum_ncp_at_fire",
    "cum_npp_at_fire", "gamma_at_trigger", "pre_trade_count", "adj_cofire",
    "first_min_share", "spread_in_bucket", "gex_one_cvroflow", "gex_net_put_dex",
    "gex_one_dexoflow", "gex_one_gexoflow", "gex_zcvr", "gex_zero_gamma", "gex_spot",
]

# Any column matching these is an outcome / look-ahead and must never be a feature.
LEAKAGE_PATTERNS = [
    r"^realized_", r"^peak_ceiling", r"^minutes_to_peak$", r"^enriched_at$",
    r"^round_trip_", r"^wave2_", r"^y_has_upside$", r"^y_log_upside$",
    r"^forward_ratio$", r"^running_peak", r"^drawdown_from_peak", r"^slope_",
    r"^realized_vol_", r"^minutes_since_entry$", r"^ret_from_entry_pct$",
    r"^p_upside$", r"^fold$", r"^takeit_top_features$", r"^takeit_features$",
    r"^inferred_structure$", r"^is_isolated_leg$", r"^match_confidence$",
    r"^pattern_group_id$",
]

_LEAKAGE_RE = [re.compile(p) for p in LEAKAGE_PATTERNS]


def assert_no_leakage(columns: list[str]) -> None:
    """Raise if any column is an outcome / forward-looking field."""
    bad = [c for c in columns if any(rx.match(c) for rx in _LEAKAGE_RE)]
    if bad:
        raise ValueError(f"leakage columns present in feature frame: {bad}")


def label_should_have_held(fire_path: pd.DataFrame) -> dict:
    """hold_eod_ret, cut_ret (trail30_10), should_have_held for one fire's path."""
    b = onpath_baselines(fire_path)
    hold_eod = float(b["eod"])
    cut = float(b["trail30_10"])
    return {
        "hold_eod_ret": hold_eod,
        "cut_ret": cut,
        "should_have_held": int(hold_eod > cut),  # tie -> 0 (don't hold)
    }


def build_entry_rows_from_path(path_df: pd.DataFrame) -> pd.DataFrame:
    """Collapse a per-minute path frame to one entry row per fire (tick0 greeks + label)."""
    out = []
    for fid, g in path_df.groupby("fire_id", sort=False):
        g = g.sort_values("minutes_since_entry").reset_index(drop=True)
        rec = {"fire_id": fid, "date": g["date"].iloc[0], "mode": g["mode"].iloc[0]}
        for c in ENTRY_TICK_COLS:
            if c in g.columns:
                rec[c] = float(g[c].iloc[0])
        rec.update(label_should_have_held(g))
        out.append(rec)
    return pd.DataFrame(out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_entry_features.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/entry_features.py ml/tests/test_entry_features.py
git commit -m "feat(exit-engine): entry-feature builder + leakage guard for hold-vs-cut model"
```

---

### Task 2: add `label_col` param to `train_classifier`

**Files:**
- Modify: `ml/src/exit_engine/model.py:18-26`
- Test: `ml/tests/test_model.py` (add one test; create file if absent)

`train_classifier` is hardcoded to `train_df["y_has_upside"]`. The entry model needs `should_have_held`. Add a backward-compatible `label_col` param.

- [ ] **Step 1: Write the failing test**

```python
# ml/tests/test_model.py  (append; create with imports if missing)
import numpy as np
import pandas as pd
from exit_engine.model import train_classifier


def test_train_classifier_honors_label_col():
    rng = np.random.default_rng(0)
    df = pd.DataFrame({
        "f1": rng.normal(size=200),
        "f2": rng.normal(size=200),
        "should_have_held": rng.integers(0, 2, size=200),
    })
    model = train_classifier(df, ["f1", "f2"], label_col="should_have_held")
    p = model.predict_proba(df[["f1", "f2"]])[:, 1]
    assert p.shape == (200,)
    assert ((p >= 0) & (p <= 1)).all()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_model.py::test_train_classifier_honors_label_col -v`
Expected: FAIL with `TypeError: train_classifier() got an unexpected keyword argument 'label_col'`

- [ ] **Step 3: Write minimal implementation**

Modify `train_classifier` in `ml/src/exit_engine/model.py`:

```python
def train_classifier(
    train_df: pd.DataFrame, feature_cols: list[str], label_col: str = "y_has_upside"
) -> xgb.XGBClassifier:
    model = xgb.XGBClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, eval_metric="logloss",
        n_jobs=-1, random_state=13,
    )
    model.fit(train_df[feature_cols], train_df[label_col])
    return model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_model.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ml/src/exit_engine/model.py ml/tests/test_model.py
git commit -m "feat(exit-engine): train_classifier label_col param (backward compatible)"
```

---

### Task 3: `run_b1_entry_dataset.py` — build the per-fire entry dataset

**Files:**
- Create: `ml/experiments/exit-timing-engine/run_b1_entry_dataset.py`

Reads each path-dataset part, builds entry rows (Task 1), joins DB metadata for the source, asserts no leakage, writes `entry_dataset[_sb].parquet`. Honors `EXIT_SOURCE` (lottery|silentboom), `EXIT_DATASET_DIR` (path dataset to collapse), `DATABASE_URL`.

- [ ] **Step 1: Write the driver**

```python
# ml/experiments/exit-timing-engine/run_b1_entry_dataset.py
"""B1: build the one-row-per-fire entry dataset (features + hold-vs-cut label).

Run: EXIT_SOURCE=lottery|silentboom EXIT_DATASET_DIR=<path-dataset-dir> \
     ml/.venv/bin/python ml/experiments/exit-timing-engine/run_b1_entry_dataset.py
Env: DATABASE_URL required (DB metadata join).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.entry_features import (
    LOTTERY_META_COLS, SB_META_COLS, assert_no_leakage, build_entry_rows_from_path,
)

PATH_LABEL_COLS = [
    "fire_id", "date", "mode", "minutes_since_entry", "ret_from_entry_pct", "mid",
    "entry_price", "spread_pct", "iv_level", "delta", "gamma", "otm_distance_pct",
    "minutes_to_close",
]


def _meta(source: str):
    if source == "silentboom":
        return "silent_boom_alerts", SB_META_COLS
    return "lottery_finder_fires", LOTTERY_META_COLS


def main() -> int:
    source = os.environ.get("EXIT_SOURCE", "lottery")
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Missing DATABASE_URL", file=sys.stderr)
        return 1
    parts = sorted(cfg.DATASET_DIR.glob("part-*.parquet"))
    if not parts:
        print(f"No path-dataset parts in {cfg.DATASET_DIR}", file=sys.stderr)
        return 1

    entry_parts = []
    for p in parts:
        df = pd.read_parquet(p, columns=PATH_LABEL_COLS)
        entry_parts.append(build_entry_rows_from_path(df))
        del df
        print(f"  collapsed {p.name}: cum fires {sum(len(e) for e in entry_parts):,}", flush=True)
    entry = pd.concat(entry_parts, ignore_index=True)

    table, meta_cols = _meta(source)
    with psycopg2.connect(db_url) as conn:
        meta = pd.read_sql(f"SELECT id, {', '.join(meta_cols)} FROM {table}", conn)
    meta = meta.rename(columns={"id": "fire_id"})
    merged = entry.merge(meta, on="fire_id", how="left")

    # Boolean/categorical -> numeric/codes so XGBoost can consume them.
    for c in merged.columns:
        if merged[c].dtype == bool:
            merged[c] = merged[c].astype("float64")
    for c in ("mode", "option_type", "flow_quad", "tod", "score_tier"):
        if c in merged.columns:
            merged[c] = merged[c].astype("category").cat.codes.astype("float64")

    feature_like = [c for c in merged.columns if c not in
                    ("fire_id", "date", "hold_eod_ret", "cut_ret", "should_have_held")]
    assert_no_leakage(feature_like)

    out = cfg.DATASET_DIR.parent / f"entry_dataset{'_sb' if source == 'silentboom' else ''}.parquet"
    merged.to_parquet(out, index=False)
    pos = int(merged["should_have_held"].sum())
    print(f"SOURCE={source} fires={len(merged):,} should_have_held={pos:,} "
          f"({pos / len(merged) * 100:.1f}%) -> {out.name}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Smoke-run on SB (smaller) to verify shape + no leakage**

Run:
```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator && set -a && source .env.local && set +a
cd <worktree>
EXIT_SOURCE=silentboom \
EXIT_DATASET_DIR=<worktree>/ml/experiments/exit-timing-engine/decision_dataset_sb \
  ml/.venv/bin/python ml/experiments/exit-timing-engine/run_b1_entry_dataset.py
```
Expected: prints `SOURCE=silentboom fires=67,130 should_have_held=… (…%) -> entry_dataset_sb.parquet`, no `ValueError: leakage`.

- [ ] **Step 3: Commit**

```bash
git add ml/experiments/exit-timing-engine/run_b1_entry_dataset.py
git commit -m "feat(exit-engine): B1 entry-dataset builder (path collapse + DB metadata join)"
```

---

### Task 4: `run_b2_entry_model.py` — walk-forward classifier + policy backtest

**Files:**
- Create: `ml/experiments/exit-timing-engine/run_b2_entry_model.py`

Month walk-forward over the entry dataset (train prior months on `should_have_held`, predict test month), gate hold-vs-cut on `p_hold >= threshold`, compare MODEL-GATED vs always-hold / always-cut / ORACLE, sweep thresholds, OOS AUC, per-stratum lift. Writes `b2_entry_model[_sb].md`.

- [ ] **Step 1: Write the driver**

```python
# ml/experiments/exit-timing-engine/run_b2_entry_model.py
"""B2: at-entry hold-vs-cut classifier + policy backtest (month walk-forward).

Run: EXIT_SOURCE=lottery|silentboom \
     ml/.venv/bin/python ml/experiments/exit-timing-engine/run_b2_entry_model.py
Reads entry_dataset[_sb].parquet written by B1 (path-dataset parent dir).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.entry_features import assert_no_leakage
from exit_engine.model import train_classifier

THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7]
NON_FEATURE = {"fire_id", "date", "hold_eod_ret", "cut_ret", "should_have_held", "ym"}


def _mean(x) -> float:
    return float(np.asarray(x, dtype="float64").mean())


def main() -> int:
    source = os.environ.get("EXIT_SOURCE", "lottery")
    path = cfg.DATASET_DIR.parent / f"entry_dataset{'_sb' if source == 'silentboom' else ''}.parquet"
    df = pd.read_parquet(path)
    df["ym"] = pd.PeriodIndex(pd.to_datetime(df["date"]), freq="M").astype(str)
    feats = [c for c in df.columns if c not in NON_FEATURE]
    assert_no_leakage(feats)
    months = sorted(df["ym"].unique())

    gated = {t: [] for t in THRESHOLDS}
    hold, cut, oracle, aucs = [], [], [], []
    for k in range(1, len(months)):
        tr = df[df["ym"].isin(months[:k])]
        te = df[df["ym"] == months[k]]
        if tr["should_have_held"].nunique() < 2 or te.empty:
            continue
        model = train_classifier(tr, feats, label_col="should_have_held")
        p = model.predict_proba(te[feats])[:, 1]
        h = te["hold_eod_ret"].to_numpy("float64")
        c = te["cut_ret"].to_numpy("float64")
        hold.extend(h); cut.extend(c); oracle.extend(np.maximum(h, c))
        if te["should_have_held"].nunique() == 2:
            aucs.append(roc_auc_score(te["should_have_held"], p))
        for t in THRESHOLDS:
            gated[t].extend(np.where(p >= t, h, c))
        print(f"WF test={months[k]} n={len(te):,} pos%={te['should_have_held'].mean()*100:.1f}",
              flush=True)

    best_t = max(THRESHOLDS, key=lambda t: _mean(gated[t]))
    lines = [f"# B2 — at-entry hold-vs-cut ({source}, month walk-forward, OOS)", ""]
    lines.append(f"- OOS fires: {len(hold):,}   mean OOS AUC: {(_mean(aucs) if aucs else float('nan')):.3f}")
    lines.append("")
    lines.append("| policy | mean realized % |")
    lines.append("| --- | ---: |")
    for t in THRESHOLDS:
        tag = " (best)" if t == best_t else ""
        lines.append(f"| MODEL-GATED thr={t}{tag} | {_mean(gated[t]):+.1f} |")
    lines.append(f"| always-hold | {_mean(hold):+.1f} |")
    lines.append(f"| always-cut | {_mean(cut):+.1f} |")
    lines.append(f"| ORACLE (max per fire) | {_mean(oracle):+.1f} |")
    better = max(_mean(hold), _mean(cut))
    gap = _mean(oracle) - better
    closed = (_mean(gated[best_t]) - better) / gap * 100 if gap > 0 else float("nan")
    lines.append("")
    lines.append(f"- better-of-baselines: {better:+.1f}   oracle gap closed by best: {closed:.0f}%")
    report = "\n".join(lines)
    print("\n" + report, flush=True)
    out = Path(__file__).parent / f"b2_entry_model{'_sb' if source == 'silentboom' else ''}.md"
    out.write_text(report + "\n")
    print(f"\nwrote {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run on SB then lottery**

Run:
```bash
cd <worktree>
EXIT_SOURCE=silentboom EXIT_DATASET_DIR=<worktree>/ml/experiments/exit-timing-engine/decision_dataset_sb \
  ml/.venv/bin/python ml/experiments/exit-timing-engine/run_b2_entry_model.py
EXIT_SOURCE=lottery EXIT_DATASET_DIR=<worktree>/ml/experiments/exit-timing-engine/decision_dataset \
  ml/.venv/bin/python ml/experiments/exit-timing-engine/run_b2_entry_model.py
```
Expected: each prints the policy table + AUC + oracle-gap-closed and writes `b2_entry_model[_sb].md`.

- [ ] **Step 3: Commit**

```bash
git add ml/experiments/exit-timing-engine/run_b2_entry_model.py \
        ml/experiments/exit-timing-engine/b2_entry_model.md \
        ml/experiments/exit-timing-engine/b2_entry_model_sb.md
git commit -m "feat(exit-engine): B2 at-entry hold-vs-cut model + policy backtest (both sources)"
```

---

### Task 5: Verdict + memory

**Files:**
- Modify: `docs/tmp/exit-engine-6month-verdict.md` (append a B2 section, both detectors)
- Modify: `<repo>/.../memory/MEMORY.md` + a project memory file if signal is found

- [ ] **Step 1:** Read both `b2_entry_model*.md`. Append a section to the verdict doc with the two policy tables and a one-line read against the pre-registered criteria (beat both baselines? ≥15% oracle gap closed? AUC>0.55?).

- [ ] **Step 2:** Evaluate the per-stratum/uniform-lift smell test before declaring signal: if model-gated lift is uniform across score-tier/mode/DTE strata, flag possible leakage and do NOT claim edge.

- [ ] **Step 3:** If a detector passes all three criteria, write a project memory (entry hold-vs-cut has OOS edge for <detector>, with the numbers). If neither passes, write the negative result. Commit.

```bash
git add docs/tmp/exit-engine-6month-verdict.md
git commit -m "docs(exit-engine): B2 at-entry hold-vs-cut verdict (both detectors)"
```

---

## Self-Review

- **Spec coverage:** label (Task 1) ✓; policy backtest vs hold/cut/oracle (Task 4) ✓; rich entry features + per-source lists (Task 1/3) ✓; leakage allow-list + assertion (Task 1) ✓; uniform-lift check (Task 5 step 2) ✓; three modules (Tasks 1,3,4) ✓; tests (Tasks 1,2) ✓; success criteria (Task 5) ✓. **Gap:** spec named a `build_entry_rows(source, conn)` single entry point; plan splits into `build_entry_rows_from_path` (pure, tested) + DB join in the B1 driver — cleaner separation, same behavior. Acceptable deviation, noted.
- **Placeholder scan:** none — all code blocks concrete; `<worktree>` is a path the executor substitutes.
- **Type consistency:** `label_should_have_held` returns dict with `hold_eod_ret`/`cut_ret`/`should_have_held` used identically in Tasks 1/3/4; `train_classifier(..., label_col=)` defined in Task 2, used in Task 4; `assert_no_leakage(list[str])` defined Task 1, used Tasks 3/4; feature exclusion set consistent (`fire_id,date,hold_eod_ret,cut_ret,should_have_held`).
