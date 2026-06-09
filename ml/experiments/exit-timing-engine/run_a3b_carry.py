# ml/experiments/exit-timing-engine/run_a3b_carry.py
"""A3b: mode-B end-of-day carry/flatten model evaluation.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a3b_carry.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.carry_model import (
    EOD_FEATURES,
    build_eod_decision_row,
    train_carry_model,
)
from exit_engine.dataset import assign_walkforward_folds

def main() -> int:
    ds = pd.read_parquet(cfg.DATASET_PARQUET)
    b = ds[ds["mode"] == cfg.MODE_MULTIDAY].copy()
    if b.empty:
        print("No mode-B fires in dataset.")
        return 0

    rows = []
    for fid, g in b.groupby("fire_id"):
        g = g.sort_values("minutes_since_entry").reset_index(drop=True)
        first_session = g[g["minutes_since_entry"] <= cfg.SESSION_MINUTES]
        later = g[g["minutes_since_entry"] > cfg.SESSION_MINUTES]
        if first_session.empty or later.empty:
            continue
        close = first_session.iloc[-1]
        rows.append({
            **build_eod_decision_row(
                fire_id=int(fid),
                close_mid=float(close["mid"]),
                next_session_forward_max=float(later["mid"].max()),
                days_of_life_left=float(max(1, later["minute"].dt.tz_convert("America/Chicago").dt.normalize().nunique())),
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

    eod["fold"] = assign_walkforward_folds(eod["date"], cfg.N_TRAIN_DAYS, cfg.TEST_BLOCK_DAYS)
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
