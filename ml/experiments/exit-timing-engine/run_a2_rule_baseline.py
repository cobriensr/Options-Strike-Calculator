# ml/experiments/exit-timing-engine/run_a2_rule_baseline.py
"""A2: walk-forward parametric-rule baseline + same-basis (mid) on-path benchmark.

Reads the partitioned decision dataset (cfg.DATASET_DIR/part-*.parquet). Uses the
vectorized exit sim; baselines are recomputed on our own mid paths so the
comparison is like-for-like (the stored trade-price realized_* columns are NOT
used here — they're a different basis).

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a2_rule_baseline.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.costs import apply_costs
from exit_engine.dataset import assign_walkforward_folds
from exit_engine.onpath_policies import onpath_baselines
from exit_engine.rule_family import decide_exit_index_vec, grid


# Rule baseline only needs price-path + identity (NOT the 17 features) — read just
# these to keep memory sane at scale (8 cols vs 26 ≈ 3x less RAM).
_A2_COLS = ["fire_id", "date", "mode", "entry_price", "mid",
            "ret_from_entry_pct", "minutes_since_entry", "spread_pct"]


def _load_dataset() -> pd.DataFrame:
    parts = sorted(cfg.DATASET_DIR.glob("part-*.parquet"))
    if not parts:
        print("No dataset parts found — run A1 first.", file=sys.stderr)
        sys.exit(1)
    print(f"loading {len(parts)} parts (cols={len(_A2_COLS)}): {[p.name for p in parts]}", flush=True)
    return pd.concat([pd.read_parquet(p, columns=_A2_COLS) for p in parts], ignore_index=True)


def main() -> int:
    ds = _load_dataset()
    ds["fold"] = assign_walkforward_folds(ds["date"], cfg.N_TRAIN_DAYS, cfg.TEST_BLOCK_DAYS)
    print(f"rows={len(ds):,}  fires={ds['fire_id'].nunique():,}  "
          f"test_folds={sorted(f for f in ds['fold'].unique() if f >= 0)}", flush=True)

    # One pass: per-fire numpy arrays + metadata.
    fids: list[int] = []
    arrs: dict[int, tuple] = {}
    fold_of: dict[int, int] = {}
    for fid, g in ds.groupby("fire_id", sort=False):
        g = g.sort_values("minutes_since_entry")
        fids.append(int(fid))
        arrs[int(fid)] = (
            g["ret_from_entry_pct"].to_numpy("float64"),
            g["minutes_since_entry"].to_numpy("float64"),
            float(g["entry_price"].iloc[0]),
            float(g["spread_pct"].iloc[0]),
            g["mid"].to_numpy("float64"),
        )
        fold_of[int(fid)] = int(g["fold"].iloc[0])

    knobs = grid()
    folds_arr = np.array([fold_of[f] for f in fids])

    # Realized %-return matrix: n_fires x n_knobs (vectorized exit per knob, cost-netted).
    realized = np.zeros((len(fids), len(knobs)), dtype="float64")
    for i, fid in enumerate(fids):
        ret, mse, entry, spread0, mid = arrs[fid]
        for j, kn in enumerate(knobs):
            idx = decide_exit_index_vec(ret, mse, kn["activate_pct"], kn["giveback_pct"], kn["hard_stop_min"])
            gross = (mid[idx] - entry) / entry * 100.0
            realized[i, j] = apply_costs(gross, entry, spread0)
        if i and i % 20000 == 0:
            print(f"  rule-sim {i:,}/{len(fids):,}", flush=True)

    # Walk-forward: per test fold, pick the knob with the best TRAIN-fold mean, apply OOS.
    engine = np.full(len(fids), np.nan)
    for f in sorted(set(folds_arr[folds_arr >= 0].tolist())):
        train = folds_arr < f
        test = folds_arr == f
        if not train.any() or not test.any():
            continue
        train_means = realized[train].mean(axis=0)
        best = int(np.argmax(train_means))
        engine[test] = realized[test, best]
        print(f"fold {f}: best={knobs[best]} train_mean={train_means[best]:+.1f} n_test={int(test.sum())}", flush=True)

    test_mask = folds_arr >= 0
    oos = engine[test_mask & ~np.isnan(engine)]

    # On-path baselines (same mid basis) on the SAME OOS test population.
    test_fids = [fids[i] for i in range(len(fids)) if test_mask[i]]
    base = {"trail30_10": [], "hard30m": [], "tier50_holdeod": [], "eod": []}
    for fid in test_fids:
        ret, mse, entry, spread0, mid = arrs[fid]
        rows = pd.DataFrame({
            "mid": mid, "entry_price": entry, "spread_pct": spread0,
            "ret_from_entry_pct": ret, "minutes_since_entry": mse,
        })
        b = onpath_baselines(rows)
        for k in base:
            base[k].append(b[k])

    lines = ["# A2 — Rule Baseline vs On-Path Benchmark (same mid basis)", ""]
    lines.append(f"- dataset rows: {len(ds):,}   fires: {len(fids):,}   OOS test fires: {len(oos):,}")
    lines.append("")
    lines.append("| policy | equal-weight mean realized % |")
    lines.append("| --- | ---: |")
    lines.append(f"| **ENGINE-RULE (walk-forward OOS)** | **{oos.mean():+.1f}** |")
    for k, v in base.items():
        lines.append(f"| {k} | {np.mean(v):+.1f} |")
    report = "\n".join(lines)
    print("\n" + report, flush=True)
    out = Path(__file__).parent / "a2_rule_baseline.md"
    out.write_text(report + "\n")
    print(f"\nwrote {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
