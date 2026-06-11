# ml/experiments/exit-timing-engine/run_a3_model.py
"""A3: upside-remaining model vs on-path baselines — MONTH-LEVEL expanding
walk-forward. The dataset parts are months; for the k-th month we train on all
prior months (stratified fire sample) and test on month k. Memory-careful: read
only needed columns, one part at a time. Train→test are adjacent (no regime gap).

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
    if len(parts) < 2:
        print("Need >=2 month-parts for walk-forward.", file=sys.stderr)
        return 1
    print(f"parts: {[p.name for p in parts]}", flush=True)
    fcols = feature_columns(pq.read_schema(parts[0]).names)
    read_cols = list(dict.fromkeys(fcols + PRICE_COLS + ["y_has_upside"]))
    print(f"features: {len(fcols)}  read_cols: {len(read_cols)}", flush=True)

    model_real: dict[float, list] = {t: [] for t in EXIT_THRESHOLDS}
    base = {"eod": [], "trail30_10": [], "hard30m": [], "tier50_holdeod": []}

    for k in range(1, len(parts)):
        train_parts, test_part = parts[:k], parts[k]

        # train fire universe (from prior months) -> stratified sample
        tm = pd.concat([pd.read_parquet(p, columns=["fire_id", "date", "mode"]) for p in train_parts], ignore_index=True)
        tf = tm.groupby("fire_id").agg(date=("date", "first"), mode=("mode", "first")).reset_index()
        del tm
        train_sample = set(stratified_fire_sample(tf, target=TRAIN_SAMPLE_FIRES, seed=13))
        del tf

        # build train matrix (one prior part at a time)
        train_rows: list[pd.DataFrame] = []
        for p in train_parts:
            df = pd.read_parquet(p, columns=fcols + ["fire_id", "y_has_upside"])
            sub = df[df["fire_id"].isin(train_sample)]
            if not sub.empty:
                train_rows.append(sub.drop(columns=["fire_id"]).copy())
            del df, sub
        train_df = pd.concat(train_rows, ignore_index=True)
        del train_rows
        model = train_classifier(train_df, fcols)
        n_train = len(train_df)
        del train_df

        # eval on the test month
        df = pd.read_parquet(test_part, columns=read_cols)
        df["p"] = model.predict_proba(df[fcols])[:, 1]
        df = df[PRICE_COLS + ["p"]]
        n_test_fires = 0
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
            for kk in base:
                base[kk].append(b[kk])
            n_test_fires += 1
        del df, model
        print(f"WF train={[p.name[5:12] for p in train_parts]} (n_rows={n_train:,}) "
              f"-> test={test_part.name[5:12]} ({n_test_fires:,} fires)  cum_test={len(base['eod']):,}", flush=True)

    best_t = max(EXIT_THRESHOLDS, key=lambda t: np.mean(model_real[t]))
    lines = ["# A3 — model vs on-path baselines (month walk-forward, OOS, mid basis)", ""]
    lines.append(f"- OOS test fires: {len(base['eod']):,}  (train sample/fold: {TRAIN_SAMPLE_FIRES:,})")
    lines.append("")
    lines.append("| policy | stats |")
    lines.append("| --- | --- |")
    for t in EXIT_THRESHOLDS:
        tag = " (best)" if t == best_t else ""
        lines.append(f"| MODEL thr={t}{tag} | {_stats(model_real[t])} |")
    for kk, v in base.items():
        lines.append(f"| {kk} | {_stats(v)} |")
    report = "\n".join(lines)
    print("\n" + report, flush=True)
    (Path(__file__).parent / "a3_model.md").write_text(report + "\n")
    print(f"\nwrote {Path(__file__).parent / 'a3_model.md'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
