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

LAMBDAS = [0.0, 0.1, 0.25, 0.5, 1.0, 2.0]
PLOTS_DIR = Path(__file__).resolve().parents[2] / "plots" / "exit-timing-engine"


def _best_exit_under_lambda(rows: pd.DataFrame, lam: float) -> int:
    """Oracle-on-path exit maximizing realized% − λ*(giveback from peak MARK, %).
    Giveback is fractional drop from the running-peak mid (scale-invariant, matching
    the engine's forward-from-current-mark convention), not pp-from-entry."""
    mid = rows["mid"].to_numpy(dtype="float64")
    entry = float(rows["entry_price"].iloc[0])
    ret = (mid - entry) / entry * 100.0
    peak_mid = np.maximum.accumulate(mid)
    frac_giveback = np.where(peak_mid > 0, (peak_mid - mid) / peak_mid, 0.0) * 100.0
    score = ret - lam * frac_giveback
    return int(np.argmax(score))


def main() -> int:
    ds = pd.read_parquet(cfg.DATASET_PARQUET)
    ds["fold"] = assign_walkforward_folds(ds["date"], cfg.N_TRAIN_DAYS, cfg.TEST_BLOCK_DAYS)
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
            mid = rows["mid"].to_numpy(dtype="float64")
            peak_mid = np.maximum.accumulate(mid)
            gb = (peak_mid[idx] - mid[idx]) / peak_mid[idx] * 100.0 if peak_mid[idx] > 0 else 0.0
            givebacks.append(float(gb))
        frontier.append({
            "lambda": lam,
            "oos_mean_realized": float(np.mean(realized)),
            "oos_median_giveback": float(np.median(givebacks)),
        })
        print(f"λ={lam}: mean realized={np.mean(realized):+.1f}%  median giveback={np.median(givebacks):.1f}%")

    fdf = pd.DataFrame(frontier)
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(7, 5))
    ax.plot(fdf["oos_median_giveback"], fdf["oos_mean_realized"], "o-")
    for _, r in fdf.iterrows():
        ax.annotate(f"λ={r['lambda']}", (r["oos_median_giveback"], r["oos_mean_realized"]))
    ax.set_xlabel("OOS median giveback from peak mark (%)")
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
        + "\n\nλ=0 is pure expectancy (highest total R, highest giveback-from-peak-mark). Higher λ "
        "protects gains by penalizing fractional drop from the running-peak mid, at a measurable "
        "cost in mean realized R. Pick the operating point you can actually follow. See a4_frontier.png.\n\n"
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
