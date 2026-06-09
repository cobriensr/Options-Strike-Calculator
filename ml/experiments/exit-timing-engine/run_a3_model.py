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

    lift_df = meta.set_index("fire_id").assign(engine=decision_pct)
    lift_df["lift"] = lift_df["engine"] - pd.to_numeric(lift_df["realized_trail30_10_pct"], errors="coerce")
    strat = stratify_lift(lift_df.reset_index(), by="mode")
    print(f"\nleakage stratification by mode: {strat}")
    if strat["uniform_flag"]:
        print("WARNING: near-uniform lift across modes — possible leakage. Investigate before trusting.")

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
