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
