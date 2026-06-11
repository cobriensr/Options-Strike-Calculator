# ml/experiments/exit-timing-engine/run_a3_model.py
"""A3 (first-read): upside-remaining model vs on-path baselines on the partitioned
dataset. Memory-careful — reads only needed columns, samples train fires, and
runs the full-eval ONE part at a time. Single early/late split (via walk-forward
folds) for the first read; full walk-forward comes once the dataset is complete.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a3_model.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.costs import apply_costs
from exit_engine.dataset import assign_walkforward_folds
from exit_engine.model import feature_columns, greedy_stop_index_arr, train_classifier
from exit_engine.onpath_policies import onpath_baselines
from exit_engine.sampling import stratified_fire_sample

ARM_AFTER_MIN = 1.0
EXIT_THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7]
TRAIN_SAMPLE_FIRES = 60000
PRICE_COLS = ["fire_id", "entry_price", "mid", "ret_from_entry_pct", "minutes_since_entry", "spread_pct"]


def _parts() -> list[Path]:
    ps = sorted(cfg.DATASET_DIR.glob("part-*.parquet"))
    if not ps:
        print("No dataset parts — run A1 first.", file=sys.stderr)
        sys.exit(1)
    return ps


def _stats(x: list[float]) -> str:
    a = np.asarray(x, dtype="float64")
    return f"mean={a.mean():+6.1f}  median={np.median(a):+6.1f}  win%={(a > 0).mean() * 100:4.1f}"


def main() -> int:
    parts = _parts()
    print(f"parts: {[p.name for p in parts]}", flush=True)
    fcols = feature_columns(pq.read_schema(parts[0]).names)
    read_cols = list(dict.fromkeys(fcols + PRICE_COLS + ["y_has_upside"]))
    print(f"features: {len(fcols)}  read_cols: {len(read_cols)}", flush=True)

    # 1) fold map from cheap cols
    meta = pd.concat([pd.read_parquet(p, columns=["fire_id", "date", "mode"]) for p in parts], ignore_index=True)
    meta["fold"] = assign_walkforward_folds(meta["date"], cfg.N_TRAIN_DAYS, cfg.TEST_BLOCK_DAYS)
    fmeta = meta.groupby("fire_id").agg(date=("date", "first"), mode=("mode", "first"), fold=("fold", "first")).reset_index()
    del meta
    max_fold = int(fmeta["fold"].max())
    split = max(0, max_fold // 2)
    train_pool = fmeta[(fmeta["fold"] >= -1) & (fmeta["fold"] <= split)]
    test_pool = fmeta[fmeta["fold"] > split]
    print(f"folds -1..{max_fold}  split={split}  train_fires={len(train_pool):,}  test_fires={len(test_pool):,}", flush=True)
    if train_pool.empty or test_pool.empty:
        print("Not enough folds for a train/test split.", file=sys.stderr)
        return 1
    train_sample = set(stratified_fire_sample(train_pool, target=TRAIN_SAMPLE_FIRES, seed=13))
    test_fids = set(test_pool["fire_id"].tolist())
    print(f"train sample: {len(train_sample):,} fires", flush=True)

    # 2) build train matrix (read features one part at a time, keep sampled-train rows)
    train_rows: list[pd.DataFrame] = []
    for p in parts:
        df = pd.read_parquet(p, columns=fcols + ["fire_id", "y_has_upside"])
        sub = df[df["fire_id"].isin(train_sample)]
        if not sub.empty:
            train_rows.append(sub.drop(columns=["fire_id"]).copy())
        del df, sub
        print(f"  train-scan {p.name} (cum {sum(len(x) for x in train_rows):,} rows)", flush=True)
    train_df = pd.concat(train_rows, ignore_index=True)
    del train_rows
    print(f"training xgb on {len(train_df):,} rows x {len(fcols)} feats...", flush=True)
    model = train_classifier(train_df, fcols)
    del train_df

    # 3) full-eval per part: predict, greedy-stop at each threshold, on-path baselines
    model_real = {t: [] for t in EXIT_THRESHOLDS}
    base = {"eod": [], "trail30_10": [], "hard30m": [], "tier50_holdeod": []}
    for p in parts:
        df = pd.read_parquet(p, columns=read_cols)
        df = df[df["fire_id"].isin(test_fids)]
        if df.empty:
            del df
            continue
        df["p"] = model.predict_proba(df[fcols])[:, 1]
        df = df[PRICE_COLS + ["p"]]
        for _fid, g in df.groupby("fire_id", sort=False):
            g = g.sort_values("minutes_since_entry")
            mse = g["minutes_since_entry"].to_numpy("float64")
            mid = g["mid"].to_numpy("float64")
            ret = g["ret_from_entry_pct"].to_numpy("float64")
            entry = float(g["entry_price"].iloc[0])
            sp = float(g["spread_pct"].iloc[0])
            pp = g["p"].to_numpy("float64")
            for t in EXIT_THRESHOLDS:
                idx = greedy_stop_index_arr(mse, pp, t, ARM_AFTER_MIN)
                model_real[t].append(apply_costs((mid[idx] - entry) / entry * 100.0, entry, sp))
            rows = pd.DataFrame({"mid": mid, "entry_price": entry, "spread_pct": sp,
                                 "ret_from_entry_pct": ret, "minutes_since_entry": mse})
            b = onpath_baselines(rows)
            for k in base:
                base[k].append(b[k])
        del df
        print(f"  eval {p.name} done (cum {len(base['eod']):,} test fires)", flush=True)

    best_t = max(EXIT_THRESHOLDS, key=lambda t: np.mean(model_real[t]))
    lines = ["# A3 (first read) — model vs on-path baselines (OOS test fires, mid basis)", ""]
    lines.append(f"- test fires: {len(base['eod']):,}   train sample: {len(train_sample):,}")
    lines.append("")
    lines.append("| policy | stats |")
    lines.append("| --- | --- |")
    for t in EXIT_THRESHOLDS:
        tag = " (best)" if t == best_t else ""
        lines.append(f"| MODEL thr={t}{tag} | {_stats(model_real[t])} |")
    for k, v in base.items():
        lines.append(f"| {k} | {_stats(v)} |")
    report = "\n".join(lines)
    print("\n" + report, flush=True)
    (Path(__file__).parent / "a3_model.md").write_text(report + "\n")
    print(f"\nwrote {Path(__file__).parent / 'a3_model.md'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
